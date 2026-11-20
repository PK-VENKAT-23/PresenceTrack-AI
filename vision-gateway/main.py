"""
PresenceTrack Edge Vision Gateway.

FastAPI service integrating camera capture, lightweight face/person detection,
multi-object tracking, boundary crossing tripwires, consent-gated biometric
recognition, and authenticated transit event dispatching to the PresenceTrack backend.
"""

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import asyncio
import base64
import hmac
import logging
import threading
import time
from typing import Any, Dict, List, Optional
import cv2
from fastapi import FastAPI, HTTPException, status, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import uvicorn
import numpy as np

from config import config
from camera.stream_reader import CameraStreamReader
from camera.health_monitor import CameraHealthMonitor
from detection.detector import Detection, LightweightDetector
from tracking.boundary import VirtualBoundary, CrossingDirection
from tracking.tracker import ObjectTracker
from recognition.matcher import BiometricMatcher, MatchResult, MatchStatus, SFaceModel, FallbackRecognitionAdapter
from events.dispatcher import EventDispatcher
from security.memory import zeroize_buffer

logger = logging.getLogger("uvicorn.error")


# Pydantic schemas for API
class HealthResponse(BaseModel):
    status: str
    camera_id: str
    camera_connected: bool
    frames_processed: int
    active_tracks: int
    transits_emitted: int
    unknown_alerts_emitted: int
    uptime_seconds: float
    auto_biometric_attendance_enabled: bool
    recognition_model: str
    embedding_dimension: int
    is_synthetic: bool = False
    is_stale: bool = False
    real_frame_count: int = 0
    recovery_status: Optional[str] = None
    consecutive_failures: int = 0
    current_failure_reason: Optional[str] = None
    last_real_frame_timestamp: Optional[float] = None


class CameraReconnectResponse(BaseModel):
    status: str
    camera_connected: bool
    is_synthetic: bool
    is_stale: bool = False
    camera_id: str
    source: str
    real_frame_count: int = 0
    message: str
    new_frames_received: int = 0
    time_taken_sec: float = 0.0
    failure_reason: Optional[str] = None
    recovery_status: Optional[str] = None


class CameraDiagnosticsResponse(BaseModel):
    camera_id: str
    latest_diagnostic: Dict[str, Any]
    history: List[Dict[str, Any]]


class LiveDetectionResponse(BaseModel):
    camera_id: str
    is_live: bool
    face_detected: bool
    face_bounding_box: Optional[Dict[str, int]] = None
    sc_score: float = 0.0
    confidence_category: str = "UNKNOWN"
    matched_name: Optional[str] = None
    matched_person_id: Optional[str] = None
    consent_revoked: bool = False
    person_count: int = 0
    active_tracks: int = 0
    last_event: Optional[str] = None
    timestamp: str
    auto_attendance_enabled: bool = False
    is_synthetic: bool = False
    is_stale: bool = False
    real_frame_count: int = 0
    recovery_status: Optional[str] = None
    consecutive_failures: int = 0
    current_failure_reason: Optional[str] = None


class SimulateCrossingRequest(BaseModel):
    direction: str = Field(..., description="ZONE_ENTER or ZONE_EXIT")
    user_id: Optional[str] = Field(None, description="Enrolled employee UUID")
    cosine_score: float = Field(0.925, ge=0.0, le=1.0)
    zone_from: Optional[str] = None
    zone_to: Optional[str] = None


class ExtractEmbeddingRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 encoded JPEG/PNG frame")


class EnrollEmployeeRequest(BaseModel):
    employee_id: str
    name: str
    badge_id: str
    embedding: Optional[List[float]] = None
    consent_revoked: bool = False
    is_active: bool = True


# Initialize Gateway Components
camera = CameraStreamReader(
    source=config.camera_source,
    target_fps=config.target_fps,
)
detector = LightweightDetector(
    face_min_confidence=config.face_min_confidence,
    person_min_confidence=config.person_min_confidence,
)
boundary = VirtualBoundary(
    p1=(config.boundary_coords[0], config.boundary_coords[1]),
    p2=(config.boundary_coords[2], config.boundary_coords[3]),
    zone_a=config.zone_a,
    zone_b=config.zone_b,
    frame_width=config.frame_width,
    frame_height=config.frame_height,
)
tracker = ObjectTracker(virtual_boundary=boundary)

# Initialize biometric model
if config.recognition_backend == "sface":
    model = SFaceModel(config.sface_model_path)
else:
    model = FallbackRecognitionAdapter()

matcher = BiometricMatcher(
    match_threshold=config.cosine_match_threshold,
    uncertain_threshold=config.cosine_uncertain_threshold,
    model=model,
    auto_attendance_enabled=config.auto_biometric_attendance_enabled,
)

dispatcher = EventDispatcher(
    backend_url=config.backend_api_url,
    device_key=config.device_key,
    camera_id=config.camera_id,
    debounce_seconds=config.debounce_seconds,
)

health_monitor = CameraHealthMonitor(
    camera_reader=camera,
    event_dispatcher=dispatcher,
    check_interval_sec=15.0,
)

# Pipeline State
class GatewayState:
    def __init__(self):
        self.start_time = time.time()
        self.frames_processed = 0
        self.transits_emitted = 0
        self.unknown_alerts_emitted = 0
        self.last_detection: Dict[str, Any] = {
            "camera_id": config.camera_id,
            "is_live": False,
            "face_detected": False,
            "face_bounding_box": None,
            "sc_score": 0.0,
            "confidence_category": "UNKNOWN",
            "matched_name": None,
            "matched_person_id": None,
            "consent_revoked": False,
            "person_count": 0,
            "active_tracks": 0,
            "last_event": None,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "auto_attendance_enabled": config.auto_biometric_attendance_enabled,
            "is_synthetic": False,
            "is_stale": False,
            "real_frame_count": 0,
        }
        self.is_running = False
        self._thread: Optional[threading.Thread] = None


state = GatewayState()


def _attach_face_matches_to_tracks(faces, face_results, active_tracks):
    """
    Attach a face identity only when its face center maps unambiguously
    to exactly one current track, and exactly one face maps to that track.

    Return only associations successfully attached to their tracks.
    """
    eligible_statuses = {
        MatchStatus.MATCHED,
        MatchStatus.DISABLED_FOR_REVIEW,
        MatchStatus.CONSENT_REVOKED,
    }

    track_candidates = {}

    for face_index, (face, result) in enumerate(face_results):
        if result.status not in eligible_statuses or not result.employee_id:
            continue

        fx, fy = face.center
        candidates = []

        for track in active_tracks:
            if getattr(track, "disappeared", 0) != 0:
                continue

            x, y, width, height = track.bbox
            if x <= fx <= x + width and y <= fy <= y + height:
                candidates.append(track)

        # More than one containing track means the association is ambiguous.
        if len(candidates) == 1:
            track_candidates[face_index] = candidates[0]

    # Enforce one face per track.
    candidate_counts = {}
    for track in track_candidates.values():
        candidate_counts[track.track_id] = (
            candidate_counts.get(track.track_id, 0) + 1
        )

    attached_matches = []

    for face_index, track in track_candidates.items():
        if candidate_counts[track.track_id] != 1:
            continue

        face, result = face_results[face_index]

        if track.matched_person_id is not None:
            # Preserve an existing identity; report it only if it agrees.
            if track.matched_person_id == result.employee_id:
                attached_matches.append((face, result, track))
            continue

        track.matched_person_id = result.employee_id
        track.matched_name = result.name
        track.matched_cosine = result.cosine_score
        track.consent_revoked = (
            result.status == MatchStatus.CONSENT_REVOKED
        )

        attached_matches.append((face, result, track))

    return attached_matches


def processing_pipeline_loop():
    """Main CV loop running at target FPS."""
    delay = 1.0 / max(1, config.target_fps)
    last_telemetry_dispatch = 0.0
    heartbeat_timer = 0.0
    template_sync_timer = time.time()
    last_hardware_online: Optional[bool] = None

    while state.is_running:
        t0 = time.time()
        now_sec = time.time()

        # Determine true camera hardware online status
        is_hardware_online = (
            camera.is_camera_live
            if not camera.use_synthetic
            else (camera._is_configured_synthetic() and camera.is_connected)
        )

        # Heartbeat: register on startup, every 15 seconds, or immediately upon connectivity transition
        if (now_sec - heartbeat_timer) >= 15.0 or (is_hardware_online != last_hardware_online):
            heartbeat_timer = now_sec
            last_hardware_online = is_hardware_online
            try:
                reg_ok = dispatcher.register_camera_node(is_online=is_hardware_online)
                if reg_ok:
                    logger.info("Camera node heartbeat succeeded (hardware is_online=%s)", is_hardware_online)
                else:
                    err_reason = getattr(dispatcher, "last_heartbeat_error", "Unknown error")
                    logger.warning(
                        "Camera node heartbeat failed (hardware is_online=%s): %s",
                        is_hardware_online,
                        err_reason,
                    )
            except Exception as e:
                logger.warning("Camera node heartbeat error: %s", e)

        # Periodic template refresh: every 300 seconds (5 minutes)
        if (now_sec - template_sync_timer) >= 300.0:
            template_sync_timer = now_sec
            try:
                synced_count = sync_enrolled_templates()
                logger.info("Periodic background template sync completed (%d active)", synced_count)
            except Exception as e:
                logger.warning("Periodic background template sync error: %s", e)

        frame = camera.get_latest_frame()
        if frame is not None and is_hardware_online:
            state.frames_processed += 1
            h, w = frame.shape[:2]
            if w != boundary.frame_width or h != boundary.frame_height:
                boundary.update_resolution(w, h)

            # 1. Detection
            detections_dict = detector.detect_all(frame)
            faces = detections_dict["faces"]
            persons = detections_dict["persons"]

            # Merge detections for tracking (prioritize persons, use faces if no body)
            tracking_detections = persons if len(persons) > 0 else faces

            # 2. Recognition on detected faces
            face_results = []

            for face in faces:
                if face.face_info is not None:
                    res = matcher.identify_face_crop(
                        face_crop=face.face_crop,
                        face_info=face.face_info,
                        source_frame=frame,
                    )
                elif face.face_crop is not None:
                    res = matcher.identify_face_crop(
                        face_crop=face.face_crop
                    )
                else:
                    continue

                face_results.append((face, res))

            # 3. Object Tracking & Boundary Crossing
            active_tracks, crossing_events = tracker.update(tracking_detections)

            # Attach identities only through unambiguous face-to-track association.
            attached_matches = _attach_face_matches_to_tracks(
                faces=faces,
                face_results=face_results,
                active_tracks=active_tracks,
            )

            # 4. Handle Crossing Events
            last_event_str = None
            for event in crossing_events:
                last_event_str = event.direction.value
                matched_track = next((tr for tr in active_tracks if tr.track_id == event.track_id), None)
                # Never borrow an identity from another face or track.
                user_id = matched_track.matched_person_id if matched_track else None
                score = matched_track.matched_cosine if matched_track else 0.0
                revoked = matched_track.consent_revoked if matched_track else False

                if user_id and not revoked and score >= matcher.match_threshold:
                    if matcher.auto_attendance_enabled:
                        # Verified Employee transit: emit attendance
                        disp_res = dispatcher.dispatch_transit(
                            user_id=user_id,
                            direction=event.direction.value,
                            zone_from=event.zone_from,
                            zone_to=event.zone_to,
                            cosine_score=score,
                            dram_scrub_ms=1.2,
                        )
                        if disp_res.success:
                            state.transits_emitted += 1
                    else:
                        # Auto-attendance safety disabled: log alert for security triage
                        disp_res = dispatcher.dispatch_unknown_crossing(
                            direction=event.direction.value,
                            zone_from=event.zone_from,
                            zone_to=event.zone_to,
                            cosine_score=score,
                        )
                        if disp_res.unknown_logged:
                            state.unknown_alerts_emitted += 1
                elif revoked:
                    # DPDP Consent Revocation gate: discard detection with zero attendance punch
                    pass
                else:
                    # Unknown detection, uncertain, or score below threshold -> alert
                    disp_res = dispatcher.dispatch_unknown_crossing(
                        direction=event.direction.value,
                        zone_from=event.zone_from,
                        zone_to=event.zone_to,
                        cosine_score=score,
                    )
                    if disp_res.unknown_logged:
                        state.unknown_alerts_emitted += 1

            # 5. Update Telemetry State
            face_box = None
            telemetry_score = 0.0
            telemetry_category = "UNKNOWN"
            telemetry_name = None
            telemetry_person_id = None
            telemetry_revoked = False

            if len(faces) == 1:
                face = faces[0]
                fb = face.bbox

                # Validate bounds.
                bx = max(0, min(fb[0], w - 1))
                by = max(0, min(fb[1], h - 1))
                bw = max(1, min(fb[2], w - bx))
                bh = max(1, min(fb[3], h - by))
                face_box = {"x": bx, "y": by, "w": bw, "h": bh}

                matching_results = [
                    result for result_face, result in face_results
                    if result_face is face
                ]

                if len(matching_results) == 1:
                    result = matching_results[0]
                    telemetry_score = round(result.cosine_score, 4)
                    telemetry_category = result.confidence_category

                if len(attached_matches) == 1:
                    attached_face, result, track = attached_matches[0]

                    if attached_face is face:
                        telemetry_name = track.matched_name
                        telemetry_person_id = track.matched_person_id
                        telemetry_revoked = track.consent_revoked

            now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            state.last_detection = {
                "camera_id": config.camera_id,
                "is_live": True,
                "face_detected": len(faces) > 0,
                "face_bounding_box": face_box,
                "sc_score": telemetry_score,
                "confidence_category": telemetry_category,
                "matched_name": telemetry_name,
                "matched_person_id": telemetry_person_id,
                "consent_revoked": telemetry_revoked,
                "person_count": len(persons),
                "active_tracks": len(active_tracks),
                "last_event": last_event_str,
                "timestamp": now_iso,
                "auto_attendance_enabled": matcher.auto_attendance_enabled,
                "is_synthetic": camera.use_synthetic,
                "is_stale": camera.is_stale,
                "real_frame_count": camera.real_frame_count,
                "recovery_status": health_monitor.recovery_status,
                "consecutive_failures": health_monitor.consecutive_failures,
                "current_failure_reason": health_monitor.current_failure_reason,
            }
        else:
            # Camera offline, disconnected, or stale:
            now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            state.last_detection = {
                "camera_id": config.camera_id,
                "is_live": False,
                "face_detected": False,
                "face_bounding_box": None,
                "sc_score": 0.0,
                "confidence_category": "UNKNOWN",
                "matched_name": None,
                "matched_person_id": None,
                "consent_revoked": False,
                "person_count": 0,
                "active_tracks": 0,
                "last_event": None,
                "timestamp": now_iso,
                "auto_attendance_enabled": matcher.auto_attendance_enabled,
                "is_synthetic": camera.use_synthetic,
                "is_stale": camera.is_stale,
                "real_frame_count": camera.real_frame_count,
                "recovery_status": health_monitor.recovery_status,
                "consecutive_failures": health_monitor.consecutive_failures,
                "current_failure_reason": health_monitor.current_failure_reason,
            }

        # Dispatch telemetry at 1 Hz
        if (now_sec - last_telemetry_dispatch) >= 1.0:
            last_telemetry_dispatch = now_sec
            dispatcher.dispatch_telemetry(state.last_detection)

        elapsed = time.time() - t0
        time.sleep(max(0.001, delay - elapsed))


_sync_lock = threading.Lock()


def sync_enrolled_templates() -> int:
    """
    Fetch active biometric templates from backend and synchronize into matcher.
    Thread-safe and non-blocking for concurrent callers.
    Removes deactivated or deleted templates from volatile matcher memory.
    """
    acquired = _sync_lock.acquire(blocking=False)
    if not acquired:
        logger.info("Template sync already in progress; skipping duplicate task")
        return len(matcher.enrolled)

    try:
        try:
            templates = dispatcher.fetch_enrolled_templates()
        except Exception as e:
            logger.warning("Failed to fetch enrolled templates from backend: %s", e)
            return len(matcher.enrolled)

        if templates is None:
            logger.warning("Template sync aborted: backend unreachable or error response")
            return len(matcher.enrolled)

        active_employee_ids = set()

        for t in templates:
            emp_id = t.get("employee_id")
            if not emp_id:
                continue

            is_active = t.get("is_active", True)
            consent_revoked = t.get("consent_revoked", False)

            # Inactive employees are removed from matcher memory
            if not is_active:
                if emp_id in matcher.enrolled:
                    matcher.remove(emp_id)
                continue

            # Consent revoked employees: enroll with revoked flag or update flag
            if consent_revoked:
                if emp_id in matcher.enrolled:
                    matcher.revoke_consent(emp_id)
                else:
                    matcher.enroll(
                        employee_id=emp_id,
                        name=t.get("name", "Unknown"),
                        badge_id=t.get("badge_id", "UNKNOWN"),
                        embedding=t.get("encrypted_envelope"),
                        consent_revoked=True,
                        is_active=True,
                    )
                active_employee_ids.add(emp_id)
                continue

            # Active, consented employee: load into matcher
            if matcher.enroll(
                employee_id=emp_id,
                name=t.get("name", "Unknown"),
                badge_id=t.get("badge_id", "UNKNOWN"),
                embedding=t.get("encrypted_envelope"),
                consent_revoked=False,
                is_active=True,
            ):
                active_employee_ids.add(emp_id)

        # Remove any employees previously enrolled that are no longer returned as active
        current_ids = list(matcher.enrolled.keys())
        for emp_id in current_ids:
            if emp_id not in active_employee_ids:
                matcher.remove(emp_id)

        logger.info("Enrolled templates sync completed: %d active templates in matcher", len(matcher.enrolled))
        return len(matcher.enrolled)
    finally:
        _sync_lock.release()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: sync enrolled templates from backend
    sync_enrolled_templates()
    camera.connect()
    camera.start()
    health_monitor.start()
    state.is_running = True
    state._thread = threading.Thread(target=processing_pipeline_loop, daemon=True)
    state._thread.start()
    yield
    # Shutdown
    state.is_running = False
    if state._thread and state._thread.is_alive():
        state._thread.join(timeout=2.0)
    health_monitor.stop()
    camera.stop()


app = FastAPI(
    title="PresenceTrack Edge Vision Gateway",
    description="Automated Person Detection, Tracking, Virtual Tripwire, and Consent-Gated Attendance Gateway",
    version="1.1.0",
    lifespan=lifespan,
)

# CORS for local React development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", tags=["General"])
def index():
    return {
        "service": "PresenceTrack Edge Vision Gateway",
        "camera_id": config.camera_id,
        "version": "1.1.0",
        "docs": "/docs",
        "recognition_model": matcher.model.model_name,
        "auto_biometric_attendance_enabled": matcher.auto_attendance_enabled,
    }


@app.get("/health", response_model=HealthResponse, tags=["Diagnostics"])
def health():
    is_online = (
        camera.is_camera_live
        if not camera.use_synthetic
        else (camera._is_configured_synthetic() and camera.is_connected)
    )

    if is_online:
        health_status = "healthy"
    elif camera.is_stale:
        health_status = "stale_stream"
    elif camera.use_synthetic:
        health_status = "synthetic_fallback"
    else:
        health_status = "camera_disconnected"

    return HealthResponse(
        status=health_status,
        camera_id=config.camera_id,
        camera_connected=is_online,
        frames_processed=state.frames_processed,
        active_tracks=len(tracker.tracks),
        transits_emitted=state.transits_emitted,
        unknown_alerts_emitted=state.unknown_alerts_emitted,
        uptime_seconds=round(time.time() - state.start_time, 1),
        auto_biometric_attendance_enabled=matcher.auto_attendance_enabled,
        recognition_model=matcher.model.model_name,
        embedding_dimension=matcher.model.embedding_dim,
        is_synthetic=camera.use_synthetic,
        is_stale=camera.is_stale,
        real_frame_count=camera.real_frame_count,
        last_real_frame_timestamp=camera.last_real_frame_timestamp,
    )


@app.get("/camera/status", tags=["Diagnostics"])
def camera_status():
    status = camera.get_status()
    status["camera_id"] = config.camera_id
    status["boundary_coords"] = config.boundary_coords
    status["zones"] = {"zone_a": config.zone_a, "zone_b": config.zone_b}
    status["recovery_status"] = health_monitor.recovery_status
    status["recovery_attempt_count"] = health_monitor.recovery_attempt_count
    status["consecutive_failures"] = health_monitor.consecutive_failures
    status["recovery_backoff_sec"] = round(health_monitor.recovery_backoff_delay, 1)
    status["last_diagnostic_timestamp"] = health_monitor.last_diagnostic_timestamp
    status["last_successful_frame_timestamp"] = health_monitor.last_successful_frame_timestamp
    status["current_failure_reason"] = health_monitor.current_failure_reason
    return status


@app.get("/camera/diagnostics", response_model=CameraDiagnosticsResponse, tags=["Diagnostics"])
def get_camera_diagnostics():
    """
    Returns latest structured camera health diagnostic evaluation
    and bounded diagnostic history.
    """
    return CameraDiagnosticsResponse(
        camera_id=config.camera_id,
        latest_diagnostic=health_monitor.run_diagnostics(),
        history=health_monitor.get_diagnostic_history(),
    )


@app.post("/camera/diagnostics/run", tags=["Diagnostics"])
def run_camera_diagnostics(
    x_device_key: Optional[str] = Header(None, alias="x-device-key"),
):
    """
    Execute on-demand diagnostic evaluation across all camera health checks.
    """
    if x_device_key and not hmac.compare_digest(x_device_key, config.device_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: Valid device key required to run diagnostics",
        )
    diag = health_monitor.run_diagnostics()
    return {
        "camera_id": config.camera_id,
        "diagnostic": diag,
    }


@app.post("/camera/reconnect", response_model=CameraReconnectResponse, tags=["Camera Control"])
def camera_reconnect(
    force: bool = False,
    x_device_key: Optional[str] = Header(None, alias="x-device-key"),
):
    """
    Trigger manual reconnection to the configured camera source.
    Reuses the existing CameraStreamReader instance.
    If healthy and fresh, skips reconnect unless force=True.
    """
    if x_device_key and not hmac.compare_digest(x_device_key, config.device_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: Valid device key required for camera reconnection",
        )

    res = health_monitor.manual_refresh(force=force)
    success = res["success"]

    return CameraReconnectResponse(
        status="reconnected" if success else "failed",
        camera_connected=camera.is_camera_connected and not camera.is_stale,
        is_synthetic=camera.use_synthetic,
        is_stale=camera.is_stale,
        camera_id=config.camera_id,
        source=str(camera.source),
        real_frame_count=camera.real_frame_count,
        message=res["message"],
        new_frames_received=res.get("new_frames_received", 0),
        time_taken_sec=res.get("time_taken_sec", 0.0),
        failure_reason=health_monitor.current_failure_reason,
        recovery_status=health_monitor.recovery_status,
    )


@app.post("/camera/simulate-interruption", tags=["Testing"])
def simulate_camera_interruption():
    """Simulate network interruption / camera stall by forcibly aborting stream socket."""
    camera._abort_dead_stream()
    return {"status": "interrupted", "message": "Camera stream aborted to simulate interruption"}


def encode_mjpeg_chunk(frame: Optional[np.ndarray], quality: int = 80) -> Optional[bytes]:
    """
    Encode an image frame into a standardized multipart MJPEG chunk.
    Returns None if frame is None or encoding fails.
    """
    if frame is None:
        return None
    ret, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ret or jpeg is None:
        return None
    jpg_bytes = jpeg.tobytes()
    return (
        b"--frame\r\n"
        b"Content-Type: image/jpeg\r\n"
        b"Content-Length: "
        + str(len(jpg_bytes)).encode("ascii")
        + b"\r\n\r\n"
        + jpg_bytes
        + b"\r\n"
    )


async def generate_mjpeg_stream(
    max_frames: Optional[int] = None,
    max_consecutive_empty: Optional[int] = None,
):
    """
    Yields multipart MJPEG chunks for each fresh frame retrieved from
    the camera reader's thread-safe latest-frame buffer.
    Terminates or safely interrupts when stream stalls or goes offline
    so clients detect disconnect and can auto-reconnect.
    """
    delay = 1.0 / max(1, config.target_fps)
    frames_yielded = 0
    empty_count = 0
    stale_duration = 0.0

    try:
        while True:
            frame = camera.get_latest_frame()

            if frame is not None:
                stale_duration = 0.0
                empty_count = 0
                chunk = encode_mjpeg_chunk(frame)
                if chunk:
                    yield chunk
                    frames_yielded += 1
                    if max_frames is not None and frames_yielded >= max_frames:
                        break
            else:
                empty_count += 1
                stale_duration += delay
                if (
                    max_consecutive_empty is not None
                    and empty_count >= max_consecutive_empty
                ):
                    break

                # Interrupt relay stream if offline or stale for longer than 15.0s (allows smooth auto-reconnect without breaking active clients)
                if max_frames is None and stale_duration >= 15.0:
                    logger.info("Camera stream offline/stale for %.1fs; interrupting /video_feed relay", stale_duration)
                    break

            await asyncio.sleep(delay)
    except (asyncio.CancelledError, GeneratorExit):
        logger.debug("MJPEG client disconnected from /video_feed")
        raise
    except Exception as exc:
        logger.warning("Error in /video_feed stream generator: %s", exc)


@app.get("/video_feed", tags=["Video Relay"])
async def video_feed(max_frames: Optional[int] = None):
    """
    MJPEG video relay endpoint for browser consumption.
    Reads latest frames from the single CameraStreamReader instance,
    encodes them as JPEG, and streams multipart/x-mixed-replace chunks.
    Allows multiple browser clients to view the camera simultaneously
    without creating additional connections to the ESP32-CAM.
    If the camera is offline/disconnected, returns 503 Service Unavailable
    so the browser immediately knows the stream is not active.
    """
    frame = camera.get_latest_frame()
    if frame is None and not camera.is_camera_live and not camera.use_synthetic and max_frames is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Camera stream offline, disconnected, or stale",
        )

    headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "Access-Control-Allow-Origin": "*",
    }
    return StreamingResponse(
        generate_mjpeg_stream(max_frames=max_frames),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers=headers,
    )


@app.get("/api/live-detection", response_model=LiveDetectionResponse, tags=["Telemetry"])
def live_detection():
    """
    Returns latest detection frame coordinates and match results
    for consumption by the React Security Dashboard overlay.
    """
    return LiveDetectionResponse(**state.last_detection)


@app.post("/api/simulate-crossing", tags=["Testing"])
def simulate_crossing(req: SimulateCrossingRequest):
    """
    Simulates a boundary crossing transit event. Useful for testing the
    gateway-to-backend ingestion pipeline without physical video feed.
    """
    zone_from = req.zone_from or (config.zone_a if req.direction == "ZONE_ENTER" else config.zone_b)
    zone_to = req.zone_to or (config.zone_b if req.direction == "ZONE_ENTER" else config.zone_a)

    if req.user_id:
        # Check consent if enrolled in gateway
        emp = matcher.enrolled.get(req.user_id)
        if emp and emp.consent_revoked:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Consent has been revoked for this employee",
            )

        res = dispatcher.dispatch_transit(
            user_id=req.user_id,
            direction=req.direction,
            zone_from=zone_from,
            zone_to=zone_to,
            cosine_score=req.cosine_score,
        )
    else:
        # Unknown crossing
        res = dispatcher.dispatch_unknown_crossing(
            direction=req.direction,
            zone_from=zone_from,
            zone_to=zone_to,
            cosine_score=req.cosine_score,
        )

    return {
        "success": res.success,
        "status_code": res.status_code,
        "transit_id": res.transit_id,
        "unknown_logged": res.unknown_logged,
        "debounced": res.debounced,
        "error": res.error,
    }


@app.post("/api/enroll-test-employee", tags=["Testing"])
def enroll_test_employee(req: EnrollEmployeeRequest):
    """Enroll or update test employee biometric embedding (128-d for SFace)."""
    dim = matcher.model.embedding_dim
    if req.embedding and len(req.embedding) == dim:
        emb = np.array(req.embedding, dtype=np.float32)
    else:
        # Generate deterministic normalized unit vector for testing
        np.random.seed(abs(hash(req.employee_id)) % (2**32))
        emb = np.random.randn(dim).astype(np.float32)
        emb /= np.linalg.norm(emb)

    success = matcher.enroll(
        employee_id=req.employee_id,
        name=req.name,
        badge_id=req.badge_id,
        embedding=emb,
        consent_revoked=req.consent_revoked,
        is_active=req.is_active,
    )
    if not success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to enroll employee template. Expected {dim}-d normalized vector.",
        )
    return {"success": True, "message": f"Employee {req.name} enrolled with {dim}-d template"}


@app.post("/api/revoke-consent/{employee_id}", tags=["Testing"])
def revoke_consent(employee_id: str):
    """Test DPDP consent revocation gate."""
    if employee_id in matcher.enrolled:
        matcher.revoke_consent(employee_id)
        return {"success": True, "message": f"Consent revoked for employee {employee_id}"}
    return {"success": False, "message": "Employee not found"}


@app.post("/api/sync-templates", tags=["Biometrics"])
def trigger_sync_templates(x_device_key: Optional[str] = Header(None, alias="x-device-key")):
    """Trigger template synchronization from backend enrolled-templates endpoint. Protected by device key."""
    if not x_device_key or not hmac.compare_digest(x_device_key, config.device_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: Valid device key required to sync templates",
        )
    synced = sync_enrolled_templates()
    return {
        "success": True,
        "enrolled_count": synced,
        "synced_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


@app.post("/api/extract-face-embedding", tags=["Biometrics"])
def extract_face_embedding(
    req: ExtractEmbeddingRequest,
    x_device_key: Optional[str] = Header(None, alias="x-device-key"),
):
    """
    Extract a normalized learned identity embedding (128-d float32) from an uploaded image.
    Complies with DPDP Act 2023:
    - Raw image bytes are processed exclusively in volatile memory.
    - Zeroizes image buffer immediately after inference.
    - Rejects images without exactly 1 detected face.
    """
    if not x_device_key or not hmac.compare_digest(x_device_key, config.device_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: Valid device key required for biometric extraction",
        )

    raw_b64 = req.image_base64.strip()
    if "," in raw_b64:
        raw_b64 = raw_b64.split(",", 1)[1]

    try:
        image_bytes = base64.b64decode(raw_b64)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid base64 encoding",
        )

    if len(image_bytes) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty image payload",
        )

    nparr = np.frombuffer(image_bytes, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if frame is None or frame.size == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not decode image from supplied bytes. Valid JPEG/PNG required.",
        )

    try:
        faces = detector.detect_faces(frame)
        if len(faces) == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No face detected. Please ensure your face is clearly visible, well-lit, and positioned within the alignment guide.",
            )
        if len(faces) > 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Multiple faces detected ({len(faces)}). Please ensure only the employee being enrolled is visible in the frame.",
            )

        face = faces[0]
        emb = None
        if face.face_info is not None:
            emb = matcher.model.extract_embedding(frame, face.face_info)
        elif face.face_crop is not None:
            emb = matcher.model.extract_embedding(face.face_crop)

        if emb is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Face alignment or feature extraction failed. Ensure frontal orientation and avoid face coverings.",
            )

        return {
            "success": True,
            "embedding_dim": len(emb),
            "embedding": emb.tolist(),
            "confidence": float(face.confidence),
            "bbox": {
                "x": int(face.bbox[0]),
                "y": int(face.bbox[1]),
                "w": int(face.bbox[2]),
                "h": int(face.bbox[3]),
            },
            "model": matcher.model.model_name,
        }
    finally:
        zeroize_buffer(frame)



if __name__ == "__main__":
    uvicorn.run(app, host=config.host, port=config.port)
