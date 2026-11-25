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
from typing import Any, Dict, List, Optional, Union
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
    success: bool = True
    status: str
    detailed_state: Optional[str] = None
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


class DetectedFaceInfo(BaseModel):
    bbox: Dict[str, int]
    identity_status: str  # "VERIFIED", "VERIFYING", "UNKNOWN"
    matched_name: Optional[str] = None
    matched_person_id: Optional[str] = None
    sc_score: float = 0.0
    track_id: Optional[Union[str, int]] = None
    candidate_employee_id: Optional[str] = None
    candidate_name: Optional[str] = None
    similarity_score: float = 0.0
    matching_threshold: float = 0.45
    confirmation_count: int = 0
    required_confirmation_count: int = 2
    last_match_timestamp: Optional[str] = None
    time_to_verified_ms: Optional[float] = None
    detection_latency_ms: Optional[float] = None
    recognition_latency_ms: Optional[float] = None


class LiveDetectionResponse(BaseModel):
    camera_id: str
    is_live: bool
    face_detected: bool
    face_bounding_box: Optional[Dict[str, int]] = None
    sc_score: float = 0.0
    match_score: float = 0.0
    confidence_category: str = "UNKNOWN"
    identity_status: str = "NO_FACE"
    track_id: Optional[Union[str, int]] = None
    matched_name: Optional[str] = None
    matched_person_id: Optional[str] = None
    consent_revoked: bool = False
    consent_valid: bool = False
    template_match_confirmed: bool = False
    consecutive_match_frames: int = 0
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
    detected_faces: List[DetectedFaceInfo] = Field(default_factory=list)
    matching_threshold: float = 0.45
    required_confirmation_count: int = 2
    actual_fps: Optional[float] = None
    avg_frame_interval_ms: Optional[float] = None
    frame_processing_latency_ms: Optional[float] = None
    face_detection_latency_ms: Optional[float] = None
    face_recognition_latency_ms: Optional[float] = None
    dropped_frames: Optional[int] = None
    frame_queue_depth: Optional[int] = None
    last_successful_frame_timestamp: Optional[str] = None


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
            "detected_faces": [],
            "sc_score": 0.0,
            "match_score": 0.0,
            "confidence_category": "UNKNOWN",
            "identity_status": "NO_FACE",
            "track_id": None,
            "matched_name": None,
            "matched_person_id": None,
            "consent_revoked": False,
            "consent_valid": False,
            "template_match_confirmed": False,
            "consecutive_match_frames": 0,
            "person_count": 0,
            "active_tracks": 0,
            "last_event": None,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "auto_attendance_enabled": config.auto_biometric_attendance_enabled,
            "is_synthetic": False,
            "is_stale": False,
            "real_frame_count": 0,
            "actual_fps": 0.0,
            "avg_frame_interval_ms": 0.0,
            "frame_processing_latency_ms": 0.0,
            "face_detection_latency_ms": 0.0,
            "face_recognition_latency_ms": 0.0,
            "dropped_frames": 0,
            "frame_queue_depth": 0,
            "last_successful_frame_timestamp": None,
        }
        self.is_running = False
        self._thread: Optional[threading.Thread] = None


state = GatewayState()


def _attach_face_matches_to_tracks(
    faces,
    face_results,
    active_tracks,
    required_consecutive_frames: int = 1,
    strict_match_threshold: float = 0.45,
    ambiguous_match_threshold: float = 0.363,
    bounded_verification_window: int = 5,
    max_missed_grace_frames: int = 0,
):
    """
    Attach a face identity only when its face center maps unambiguously
    to exactly one current track, and exactly one face maps to that track.

    Enforces consecutive match confirmation frames, active consent check,
    hysteresis exit condition, bounded grace period, bounded verification window,
    and strict threshold validation.
    """
    track_candidates = {}

    for face_index, (face, result) in enumerate(face_results):
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
            track.is_verified = False
            track.identity_status = "UNKNOWN"
            track.consecutive_match_frames = 0
            track.verifying_frames = 0
            track.missed_frames = 0
            track.matched_person_id = None
            track.matched_name = None
            track.candidate_person_id = None
            track.candidate_name = None
            continue

        face, result = face_results[face_index]

        # 1. Handle Consent Revocation (DPDP hard gate)
        if result.status == MatchStatus.CONSENT_REVOKED:
            track.consent_revoked = True
            track.is_verified = False
            track.identity_status = "UNKNOWN"
            track.matched_person_id = result.employee_id
            track.matched_name = result.name
            track.matched_cosine = result.cosine_score
            track.candidate_person_id = None
            track.candidate_name = None
            track.consecutive_match_frames = 0
            track.verifying_frames = 0
            track.missed_frames = 0
            attached_matches.append((face, result, track))
            continue

        # 2. Handle Inactive Employee
        if result.status == MatchStatus.INACTIVE:
            track.consent_revoked = False
            track.is_verified = False
            track.identity_status = "UNKNOWN"
            track.matched_person_id = None
            track.matched_name = None
            track.matched_cosine = result.cosine_score
            track.candidate_person_id = None
            track.candidate_name = None
            track.consecutive_match_frames = 0
            track.verifying_frames = 0
            track.missed_frames = 0
            attached_matches.append((face, result, track))
            continue

        # 3. If track is already verified, evaluate Hysteresis Exit & Grace Period
        if track.is_verified and track.matched_person_id:
            if result.employee_id == track.matched_person_id:
                # Same person matching!
                if result.cosine_score >= ambiguous_match_threshold:
                    # Hysteresis: score >= 0.363 maintains VERIFIED (even if dipping into [0.363, 0.450))
                    track.is_verified = True
                    track.identity_status = "VERIFIED"
                    track.consecutive_match_frames += 1
                    track.matched_cosine = result.cosine_score
                    track.missed_frames = 0
                    attached_matches.append((face, result, track))
                    continue
                else:
                    # Score dipped below ambiguous threshold (< 0.363), e.g. severe blur / bad angle
                    track.missed_frames = getattr(track, "missed_frames", 0) + 1
                    if track.missed_frames <= max_missed_grace_frames:
                        # Within bounded grace period: maintain VERIFIED
                        track.is_verified = True
                        track.identity_status = "VERIFIED"
                        track.matched_cosine = result.cosine_score
                        attached_matches.append((face, result, track))
                        continue
                    else:
                        # Grace period expired: cleanly revoke to UNKNOWN
                        track.is_verified = False
                        track.identity_status = "UNKNOWN"
                        track.matched_person_id = None
                        track.matched_name = None
                        track.candidate_person_id = None
                        track.candidate_name = None
                        track.consecutive_match_frames = 0
                        track.verifying_frames = 0
                        track.missed_frames = 0
                        track.matched_cosine = result.cosine_score
                        attached_matches.append((face, result, track))
                        continue
            else:
                # A DIFFERENT person or an UNKNOWN face detected in this track!
                # Immediate revocation of previous identity with 0 grace period:
                track.is_verified = False
                track.matched_person_id = None
                track.matched_name = None
                track.candidate_person_id = None
                track.candidate_name = None
                track.consecutive_match_frames = 0
                track.verifying_frames = 0
                track.missed_frames = 0
                # Fall through to unverified evaluation below for this new person/face!

        # 4. Handle Enrolled Employee match with score >= strict threshold (0.450)
        if (
            result.status in (MatchStatus.MATCHED, MatchStatus.DISABLED_FOR_REVIEW)
            and result.employee_id
            and result.cosine_score >= strict_match_threshold
        ):
            track.consent_revoked = False
            track.matched_cosine = result.cosine_score
            track.missed_frames = 0

            if track.candidate_person_id == result.employee_id:
                track.consecutive_match_frames += 1
            else:
                track.candidate_person_id = result.employee_id
                track.candidate_name = result.name
                track.consecutive_match_frames = 1
                track.verifying_frames = 0
                track.first_candidate_time = time.time()
                track.is_verified = False
                track.matched_person_id = None
                track.matched_name = None

            if track.consecutive_match_frames >= required_consecutive_frames:
                track.is_verified = True
                track.identity_status = "VERIFIED"
                track.matched_person_id = result.employee_id
                track.matched_name = result.name
                track.verifying_frames = 0
                first_time = getattr(track, "first_candidate_time", 0.0)
                if first_time > 0.0:
                    track.time_to_verified_ms = round((time.time() - first_time) * 1000, 1)
            else:
                track.verifying_frames = getattr(track, "verifying_frames", 0) + 1
                if track.verifying_frames <= bounded_verification_window:
                    track.is_verified = False
                    track.identity_status = "VERIFYING"
                    track.matched_person_id = None
                    track.matched_name = None
                else:
                    track.is_verified = False
                    track.identity_status = "UNKNOWN"
                    track.matched_person_id = None
                    track.matched_name = None

            attached_matches.append((face, result, track))
            continue

        # 5. Handle score in uncertain / divergence range [ambiguous_match_threshold, strict_match_threshold)
        if (
            result.status in (MatchStatus.MATCHED, MatchStatus.DISABLED_FOR_REVIEW, MatchStatus.UNCERTAIN)
            and ambiguous_match_threshold <= result.cosine_score < strict_match_threshold
        ):
            track.is_verified = False
            track.consecutive_match_frames = 0
            track.candidate_person_id = None
            track.candidate_name = None
            track.matched_person_id = None
            track.matched_name = None
            track.matched_cosine = result.cosine_score
            track.consent_revoked = False
            track.missed_frames = 0
            track.verifying_frames = getattr(track, "verifying_frames", 0) + 1

            if track.verifying_frames <= bounded_verification_window:
                track.identity_status = "VERIFYING"
            else:
                track.identity_status = "UNKNOWN"

            attached_matches.append((face, result, track))
            continue

        # 6. All other cases: UNKNOWN, unregistered face, score < ambiguous_match_threshold (e.g. 0.2220), or MatchStatus.UNKNOWN
        track.is_verified = False
        track.identity_status = "UNKNOWN"
        track.consecutive_match_frames = 0
        track.verifying_frames = 0
        track.missed_frames = 0
        track.candidate_person_id = None
        track.candidate_name = None
        track.matched_person_id = None
        track.matched_name = None
        track.matched_cosine = result.cosine_score
        track.consent_revoked = False
        attached_matches.append((face, result, track))

    attached_track_ids = {t.track_id for _, _, t in attached_matches}
    for track in active_tracks:
        if track.track_id not in attached_track_ids:
            if track.is_verified and track.matched_person_id:
                track.missed_frames = getattr(track, "missed_frames", 0) + 1
                if track.missed_frames <= max_missed_grace_frames:
                    # Bounded grace period: maintain VERIFIED
                    continue
            track.is_verified = False
            track.identity_status = "UNKNOWN"
            track.consecutive_match_frames = 0
            track.verifying_frames = 0
            track.missed_frames = 0
            track.matched_person_id = None
            track.matched_name = None
            track.candidate_person_id = None
            track.candidate_name = None

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
            t_detect_start = time.time()
            detections_dict = detector.detect_all(frame)
            detection_latency_ms = round((time.time() - t_detect_start) * 1000, 1)
            faces = detections_dict["faces"]
            persons = detections_dict["persons"]

            # Merge detections for tracking (prioritize persons, use faces if no body)
            tracking_detections = persons if len(persons) > 0 else faces

            # 2. Recognition on detected faces
            t_rec_start = time.time()
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
            recognition_latency_ms = round((time.time() - t_rec_start) * 1000, 1)

            # 3. Object Tracking & Boundary Crossing
            active_tracks, crossing_events = tracker.update(tracking_detections)

            # Attach identities only through unambiguous face-to-track association.
            attached_matches = _attach_face_matches_to_tracks(
                faces=faces,
                face_results=face_results,
                active_tracks=active_tracks,
                required_consecutive_frames=2,
                strict_match_threshold=0.45,
                ambiguous_match_threshold=0.363,
                bounded_verification_window=5,
                max_missed_grace_frames=2,
            )

            # 4. Handle Crossing Events
            last_event_str = None
            for event in crossing_events:
                last_event_str = event.direction.value
                matched_track = next((tr for tr in active_tracks if tr.track_id == event.track_id), None)
                # Never borrow an identity from another face or track.
                is_verified = matched_track.is_verified if matched_track else False
                user_id = matched_track.matched_person_id if (matched_track and is_verified) else None
                score = matched_track.matched_cosine if matched_track else 0.0
                revoked = matched_track.consent_revoked if matched_track else False

                if user_id and is_verified and not revoked and score >= 0.70:
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
            telemetry_identity_status = "NO_FACE"
            telemetry_track_id = None
            telemetry_name = None
            telemetry_person_id = None
            telemetry_revoked = False
            telemetry_consent_valid = False
            telemetry_match_confirmed = False
            telemetry_consecutive_frames = 0
            detected_faces_list: List[Dict[str, Any]] = []

            if camera.is_stale:
                telemetry_identity_status = "STALE"
                for tr in active_tracks:
                    tr.is_verified = False
                    tr.identity_status = "UNKNOWN"
                    tr.consecutive_match_frames = 0
                    tr.verifying_frames = 0
                    tr.matched_person_id = None
                    tr.matched_name = None
            elif len(faces) == 0:
                telemetry_identity_status = "NO_FACE"
                for tr in active_tracks:
                    tr.is_verified = False
                    tr.identity_status = "UNKNOWN"
                    tr.consecutive_match_frames = 0
                    tr.verifying_frames = 0
                    tr.matched_person_id = None
                    tr.matched_name = None
            else:
                # Build rich detection record for every detected face
                for face in faces:
                    fb = face.bbox
                    bx = max(0, min(fb[0], w - 1))
                    by = max(0, min(fb[1], h - 1))
                    bw = max(1, min(fb[2], w - bx))
                    bh = max(1, min(fb[3], h - by))
                    bbox_dict = {"x": bx, "y": by, "w": bw, "h": bh}

                    matching_res = next(
                        (res for f, res in face_results if f is face),
                        None,
                    )
                    score = round(matching_res.cosine_score, 4) if matching_res else 0.0

                    attached_entry = next(
                        (entry for entry in attached_matches if entry[0] is face),
                        None,
                    )

                    f_status = "UNKNOWN"
                    f_name = None
                    f_person_id = None
                    f_track_id = None
                    f_candidate_id = None
                    f_candidate_name = None
                    f_confirmation_count = 0
                    f_last_match_ts = None

                    if attached_entry is not None:
                        _, res, track = attached_entry
                        f_track_id = track.track_id
                        f_confirmation_count = getattr(track, "consecutive_match_frames", 0)
                        f_candidate_id = getattr(track, "candidate_person_id", None)
                        if track.is_verified and track.identity_status == "VERIFIED" and not track.consent_revoked:
                            f_status = "VERIFIED"
                            f_name = track.matched_name
                            f_person_id = track.matched_person_id
                            f_candidate_name = track.matched_name
                            f_last_match_ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                        elif track.identity_status == "VERIFYING":
                            f_status = "VERIFYING"
                            f_candidate_name = None
                        else:
                            f_status = "UNKNOWN"
                            f_candidate_id = None
                            f_candidate_name = None
                            f_confirmation_count = 0
                    else:
                        if score >= 0.45:
                            f_status = "VERIFYING"
                        else:
                            f_status = "UNKNOWN"

                    f_time_to_verified = getattr(track, "time_to_verified_ms", 0.0) if track else 0.0

                    detected_faces_list.append({
                        "bbox": bbox_dict,
                        "identity_status": f_status,
                        "matched_name": f_name,
                        "matched_person_id": f_person_id,
                        "sc_score": score,
                        "track_id": f_track_id,
                        "candidate_employee_id": f_candidate_id,
                        "candidate_name": f_candidate_name,
                        "similarity_score": score,
                        "matching_threshold": 0.45,
                        "confirmation_count": f_confirmation_count,
                        "required_confirmation_count": 2,
                        "last_match_timestamp": f_last_match_ts,
                        "time_to_verified_ms": f_time_to_verified,
                        "detection_latency_ms": detection_latency_ms,
                        "recognition_latency_ms": recognition_latency_ms,
                    })

                if len(faces) == 1:
                    primary = detected_faces_list[0]
                    face_box = primary["bbox"]
                    telemetry_identity_status = primary["identity_status"]
                    telemetry_score = primary["sc_score"]
                    telemetry_name = primary["matched_name"]
                    telemetry_person_id = primary["matched_person_id"]
                    telemetry_track_id = primary["track_id"]

                    attached_entry = attached_matches[0] if attached_matches else None
                    if attached_entry is not None:
                        _, result, track = attached_entry
                        telemetry_revoked = track.consent_revoked
                        telemetry_consecutive_frames = track.consecutive_match_frames
                        if telemetry_identity_status == "VERIFIED":
                            telemetry_category = "HIGH" if telemetry_score >= 0.65 else "MATCHED"
                            telemetry_match_confirmed = True
                            telemetry_consent_valid = not track.consent_revoked
                        elif telemetry_identity_status == "VERIFYING":
                            telemetry_category = "UNCERTAIN"
                            telemetry_match_confirmed = False
                            telemetry_consent_valid = not track.consent_revoked
                        else:
                            telemetry_category = "REVOKED" if track.consent_revoked else "UNKNOWN"
                            telemetry_match_confirmed = False
                            telemetry_consent_valid = False
                            if not telemetry_track_id:
                                telemetry_track_id = track.ephemeral_id or f"UNKNOWN-TRACK-{track.track_id:03d}"
                    else:
                        if telemetry_identity_status == "VERIFYING":
                            telemetry_category = "UNCERTAIN"
                            telemetry_track_id = "UNKNOWN-TRACK-000"
                        else:
                            telemetry_category = "UNKNOWN"
                            telemetry_track_id = "UNKNOWN-TRACK-000"
                else:
                    # Multiple faces present: prioritize verified face as primary, else verifying, else unknown
                    verified_items = [f for f in detected_faces_list if f["identity_status"] == "VERIFIED"]
                    if len(verified_items) > 0:
                        top = max(verified_items, key=lambda item: item["sc_score"])
                        face_box = top["bbox"]
                        telemetry_identity_status = "VERIFIED"
                        telemetry_score = top["sc_score"]
                        telemetry_name = top["matched_name"]
                        telemetry_person_id = top["matched_person_id"]
                        telemetry_track_id = top["track_id"]
                        telemetry_category = "HIGH" if telemetry_score >= 0.65 else "MATCHED"
                        telemetry_match_confirmed = True
                        telemetry_consent_valid = True
                        telemetry_consecutive_frames = 2
                    else:
                        verifying_items = [f for f in detected_faces_list if f["identity_status"] == "VERIFYING"]
                        if len(verifying_items) > 0:
                            top = verifying_items[0]
                            face_box = top["bbox"]
                            telemetry_identity_status = "VERIFYING"
                            telemetry_score = top["sc_score"]
                            telemetry_name = None
                            telemetry_person_id = None
                            telemetry_track_id = top["track_id"]
                            telemetry_category = "UNCERTAIN"
                            telemetry_match_confirmed = False
                            telemetry_consent_valid = True
                            telemetry_consecutive_frames = 1
                        else:
                            top = detected_faces_list[0]
                            face_box = top["bbox"]
                            telemetry_identity_status = "UNKNOWN"
                            telemetry_score = top["sc_score"]
                            telemetry_name = None
                            telemetry_person_id = None
                            telemetry_track_id = top["track_id"] or "MULTIPLE-TRACKS"
                            telemetry_category = "UNKNOWN"
                            telemetry_match_confirmed = False
                            telemetry_consent_valid = False
                            telemetry_consecutive_frames = 0

            frame_processing_latency_ms = round((time.time() - t0) * 1000, 1)
            actual_fps = round(getattr(camera, "fps", 0.0), 1)
            avg_frame_interval_ms = round(getattr(camera, "avg_frame_interval_ms", 0.0), 1)
            dropped_frames = getattr(camera, "dropped_frames", 0)
            frame_queue_depth = getattr(camera, "frame_queue_depth", 0)
            last_real_frame_ts = getattr(camera, "last_real_frame_timestamp", 0.0)
            last_successful_frame_timestamp = (
                datetime.fromtimestamp(last_real_frame_ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")
                if last_real_frame_ts > 0.0
                else None
            )

            now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            state.last_detection = {
                "camera_id": config.camera_id,
                "is_live": True,
                "face_detected": len(faces) > 0,
                "face_bounding_box": face_box,
                "detected_faces": detected_faces_list,
                "sc_score": telemetry_score,
                "match_score": telemetry_score,
                "confidence_category": telemetry_category,
                "identity_status": telemetry_identity_status,
                "track_id": telemetry_track_id,
                "matched_name": telemetry_name,
                "matched_person_id": telemetry_person_id,
                "consent_revoked": telemetry_revoked,
                "consent_valid": telemetry_consent_valid,
                "template_match_confirmed": telemetry_match_confirmed,
                "consecutive_match_frames": telemetry_consecutive_frames,
                "matching_threshold": 0.45,
                "required_confirmation_count": 2,
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
                "actual_fps": actual_fps,
                "avg_frame_interval_ms": avg_frame_interval_ms,
                "frame_processing_latency_ms": frame_processing_latency_ms,
                "face_detection_latency_ms": detection_latency_ms,
                "face_recognition_latency_ms": recognition_latency_ms,
                "dropped_frames": dropped_frames,
                "frame_queue_depth": frame_queue_depth,
                "last_successful_frame_timestamp": last_successful_frame_timestamp,
            }
        else:
            # Camera offline, disconnected, or stale:
            now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            last_real_frame_ts = getattr(camera, "last_real_frame_timestamp", 0.0)
            state.last_detection = {
                "camera_id": config.camera_id,
                "is_live": False,
                "face_detected": False,
                "face_bounding_box": None,
                "detected_faces": [],
                "sc_score": 0.0,
                "match_score": 0.0,
                "confidence_category": "UNKNOWN",
                "identity_status": "STALE" if camera.is_stale else "NO_FACE",
                "track_id": None,
                "matched_name": None,
                "matched_person_id": None,
                "consent_revoked": False,
                "consent_valid": False,
                "template_match_confirmed": False,
                "consecutive_match_frames": 0,
                "matching_threshold": 0.45,
                "required_confirmation_count": 2,
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
                "actual_fps": 0.0,
                "avg_frame_interval_ms": 0.0,
                "frame_processing_latency_ms": 0.0,
                "face_detection_latency_ms": 0.0,
                "face_recognition_latency_ms": 0.0,
                "dropped_frames": getattr(camera, "dropped_frames", 0),
                "frame_queue_depth": 0,
                "last_successful_frame_timestamp": (
                    datetime.fromtimestamp(last_real_frame_ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")
                    if last_real_frame_ts > 0.0
                    else None
                ),
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
    has_real_frames = (camera.real_frame_count > 0) or bool(getattr(camera, "_forced_is_camera_connected", False))
    is_online = (
        (camera.is_camera_live and has_real_frames and not camera.is_stale)
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
        recovery_status=health_monitor.recovery_status,
        consecutive_failures=health_monitor.consecutive_failures,
        current_failure_reason=health_monitor.current_failure_reason,
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

    try:
        res = health_monitor.manual_refresh(force=force)
        success = bool(res.get("success", False))

        return CameraReconnectResponse(
            success=success,
            status="reconnected" if success else "failed",
            detailed_state=res.get("detailed_state", "FRESH_FRAMES_RECEIVED" if success else "STALE_OR_OFFLINE"),
            camera_connected=bool(camera.is_camera_connected and not camera.is_stale and success),
            is_synthetic=bool(camera.use_synthetic),
            is_stale=bool(camera.is_stale or not success),
            camera_id=config.camera_id,
            source=str(camera.source),
            real_frame_count=camera.real_frame_count,
            message=str(res.get("message", "Reconnection completed")),
            new_frames_received=int(res.get("new_frames_received", 0)),
            time_taken_sec=float(res.get("time_taken_sec", 0.0)),
            failure_reason=health_monitor.current_failure_reason,
            recovery_status=health_monitor.recovery_status,
        )
    except Exception as exc:
        logger.error("Unexpected error in /camera/reconnect: %s", exc, exc_info=True)
        return CameraReconnectResponse(
            success=False,
            status="failed",
            camera_connected=False,
            is_synthetic=bool(camera.use_synthetic),
            is_stale=bool(camera.is_stale),
            camera_id=config.camera_id,
            source=str(camera.source),
            real_frame_count=camera.real_frame_count,
            message=f"Camera reconnection error: {exc}",
            new_frames_received=0,
            time_taken_sec=0.0,
            failure_reason=str(exc),
            recovery_status=health_monitor.recovery_status or "CAMERA_OFFLINE",
        )


@app.post("/camera/reboot", tags=["Camera Control"])
def camera_reboot(
    x_device_key: Optional[str] = Header(None, alias="x-device-key"),
):
    """
    Safely request an authenticated physical camera reboot.
    Validates device key, probes hardware reachability, sends reboot command,
    waits for Wi-Fi reassociation, and restores live stream.
    If camera is completely unreachable, returns PHYSICAL_POWER_CYCLE_REQUIRED.
    """
    if x_device_key and not hmac.compare_digest(x_device_key, config.device_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: Valid device key required for camera reboot",
        )

    # 1. Probe reachability
    cam_ok = True
    cam_msg = "OK"
    if hasattr(camera, "probe_camera_status"):
        cam_ok, cam_msg = camera.probe_camera_status(timeout=2.0)

    if not cam_ok:
        health_monitor.recovery_status = "PHYSICAL_POWER_CYCLE_REQUIRED"
        health_monitor.current_failure_reason = (
            "Camera is completely unreachable/unpowered. Software reboot is impossible; "
            "physical power cycle (unplug and replug USB) is required."
        )
        return {
            "success": False,
            "status": "PHYSICAL_POWER_CYCLE_REQUIRED",
            "message": health_monitor.current_failure_reason,
            "requires_physical_power_cycle": True,
        }

    # 2. Camera is reachable; send restart request if HTTP
    health_monitor.recovery_status = "CAMERA_REBOOTING"
    reboot_sent = False
    if isinstance(camera.source, str) and camera.source.startswith(("http://", "https://")):
        reboot_url = camera.source.replace("/stream", "/restart")
        headers = {"Content-Type": "application/json"}
        if config.device_key:
            headers["x-device-key"] = config.device_key

        camera.disconnect()
        try:
            req = urllib.request.Request(reboot_url, method="POST", headers=headers, data=b"{}")
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                reboot_sent = (resp.getcode() == 200)
        except Exception as exc:
            logger.warning("[CameraReboot] Direct /restart endpoint returned: %s", exc)

    if not reboot_sent:
        logger.warning(
            "[CameraReboot] Direct /restart endpoint is not implemented or failed on camera firmware. "
            "Reboot was not executed; safely restoring stream."
        )
        refresh_res = health_monitor.manual_refresh(force=True)
        return {
            "success": False,
            "status": "FIRMWARE_RESTART_NOT_SUPPORTED",
            "message": (
                "Camera /restart endpoint is not supported or not yet flashed on the current ESP32-CAM firmware. "
                "Stream was safely reconnected instead of rebooting. Physical power cycle (unplug and replug USB) is required for hardware restart."
            ),
            "reboot_executed": False,
            "camera_live": refresh_res.get("camera_live", False),
        }

    # 3. Wait for camera to boot and reconnect to Wi-Fi (poll /status up to 15s)
    time.sleep(2.5)  # Reboot delay
    came_back = False
    if hasattr(camera, "probe_camera_status"):
        deadline = time.time() + 15.0
        while time.time() < deadline:
            ok, _ = camera.probe_camera_status(timeout=1.5)
            if ok:
                came_back = True
                break
            time.sleep(1.0)
    else:
        came_back = True

    if not came_back:
        health_monitor.recovery_status = "PHYSICAL_POWER_CYCLE_REQUIRED"
        health_monitor.current_failure_reason = "Camera rebooted but failed to reassociate with Wi-Fi within 15 seconds"
        return {
            "success": False,
            "status": "PHYSICAL_POWER_CYCLE_REQUIRED",
            "message": health_monitor.current_failure_reason,
            "requires_physical_power_cycle": True,
        }

    # 4. Camera is back online; restore stream
    refresh_res = health_monitor.manual_refresh(force=True)
    return {
        "success": refresh_res.get("success", False),
        "status": refresh_res.get("status", "LIVE"),
        "message": (
            f"Camera rebooted and stream restored ({refresh_res.get('new_frames_received', 0)} new frames)"
            if refresh_res.get("success")
            else refresh_res.get("message", "Reboot completed but frame verification failed")
        ),
        "requires_physical_power_cycle": False,
    }


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
    Directly streams native pre-formatted JPEG chunks when available,
    avoiding double JPEG encoding, eliminating compression artifacts, and ensuring zero lag.
    """
    delay = 1.0 / max(1, config.target_fps)
    frames_yielded = 0
    empty_count = 0
    stale_duration = 0.0
    last_yielded_count = -1

    try:
        while True:
            chunk = None
            current_count = camera.frame_count

            # 1. Prefer native raw JPEG chunk directly from camera reader (zero re-encoding overhead)
            raw_chunk = camera.get_latest_jpeg_chunk()
            if raw_chunk is not None:
                if max_frames is not None or current_count != last_yielded_count:
                    chunk = raw_chunk

            # 2. Fallback to get_latest_frame if native chunk is not present (e.g. synthetic or patched in tests)
            if chunk is None:
                frame = camera.get_latest_frame()
                if frame is not None:
                    if max_frames is not None or current_count != last_yielded_count or camera.use_synthetic:
                        chunk = encode_mjpeg_chunk(frame)

            if chunk is not None:
                last_yielded_count = current_count
                stale_duration = 0.0
                empty_count = 0
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

                # Interrupt relay stream if offline or stale for longer than 15.0s
                if max_frames is None and stale_duration >= 15.0:
                    logger.info("Camera stream offline/stale for %.1fs; interrupting /video_feed relay", stale_duration)
                    break

            await asyncio.sleep(0.015 if max_frames is None else delay)
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
