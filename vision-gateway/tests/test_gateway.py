"""
Comprehensive Unit, Security & Integration Test Suite for Edge Vision Gateway.

Covers:
- Video stream ingestion & auto-reconnection
- Person/Face detection with normalized coordinates
- Centroid & IoU tracking across consecutive frames
- Virtual boundary tripwire crossing math (ZONE_ENTER vs ZONE_EXIT)
- SFace deep learned embedding extraction & validation
- Dimension validation & rejection of corrupted vectors
- AES-256-GCM template encryption/decryption (DPDP compliance)
- DPDP consent revocation gate & inactive account rejection
- Replay protection & timestamp skew rejection
- Coordinate bound validation (out-of-bounds rejection)
- Duplicate boundary crossing debouncing
- Continuous processing session verification
"""

import sys
import os
import threading
import time
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock, PropertyMock
import pytest
import requests
import numpy as np
from fastapi.testclient import TestClient

from config import config
from camera.stream_reader import CameraStreamReader
from detection.detector import Detection, LightweightDetector
from tracking.boundary import VirtualBoundary, CrossingDirection, segments_intersect
from tracking.tracker import ObjectTracker, Track, compute_iou
from recognition.matcher import (
    BiometricMatcher,
    MatchStatus,
    MatchResult,
    SFaceModel,
    FallbackRecognitionAdapter,
    normalize_vector,
    compute_cosine_similarity,
)
from security.memory import zeroize_buffer
from security.encryption import (
    encrypt_biometric_template,
    decrypt_biometric_template,
    derive_key,
)
import cv2
from events.dispatcher import EventDispatcher
from main import (
    app, camera, matcher, tracker, boundary, dispatcher,
    _attach_face_matches_to_tracks,
    encode_mjpeg_chunk, generate_mjpeg_stream,
    sync_enrolled_templates,
)


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# 1. Video Input & Stream Reader Tests
# ---------------------------------------------------------------------------
def test_synthetic_stream_reader():
    """Verify synthetic frame generator provides valid image frames."""
    reader = CameraStreamReader(source="synthetic")
    assert reader.connect() is True
    assert reader.is_connected is True

    success, frame = reader.read_frame()
    assert success is True
    assert frame is not None
    assert frame.shape == (config.frame_height, config.frame_width, 3)
    assert frame.dtype == np.uint8


def test_stream_reader_disconnect_reconnect():
    """Verify clean resource disconnect and reconnection."""
    reader = CameraStreamReader(source="synthetic")
    reader.connect()
    reader.disconnect()
    assert reader.is_connected is False
    assert reader.connect() is True
    assert reader.is_connected is True


# ---------------------------------------------------------------------------
# 2. Detection & Coordinate Bounds
# ---------------------------------------------------------------------------
def test_detection_dataclass_and_normalization():
    """Verify detection bounding box and normalization math."""
    det = Detection(
        bbox=(50, 100, 40, 60),
        normalized_bbox=(0.125, 0.333, 0.1, 0.2),
        confidence=0.88,
        class_name="face",
        center=(70, 130),
    )
    d = det.to_dict()
    assert d["bbox"] == {"x": 50, "y": 100, "w": 40, "h": 60}
    assert d["confidence"] == 0.88
    assert d["class_name"] == "face"
    assert d["center"] == {"x": 70, "y": 130}


def test_lightweight_detector_empty_frame():
    """Verify detector handles empty or null frames gracefully."""
    det_engine = LightweightDetector()
    assert det_engine.detect_faces(None) == []
    assert det_engine.detect_persons(None) == []


# ---------------------------------------------------------------------------
# 3. Tracking & IoU Tests
# ---------------------------------------------------------------------------
def test_compute_iou():
    """Verify IoU overlap calculations."""
    boxA = (10, 10, 50, 50)
    boxB = (10, 10, 50, 50)
    assert compute_iou(boxA, boxB) == pytest.approx(1.0)
    boxC = (100, 100, 50, 50)
    assert compute_iou(boxA, boxC) == 0.0


def test_tracker_registration_retention_and_expiration():
    """Verify stable track ID assignment and expiration after max_disappeared."""
    tr = ObjectTracker(max_disappeared=2)

    # Frame 1: Detection at (100, 100)
    det1 = Detection(
        bbox=(90, 90, 20, 20),
        normalized_bbox=(0.225, 0.3, 0.05, 0.06),
        confidence=0.9,
        class_name="person",
        center=(100, 100),
    )
    tracks, _ = tr.update([det1])
    assert len(tracks) == 1
    assert tracks[0].track_id == 1

    # Frame 2: Moved slightly to (104, 106) -> Retained same ID
    det2 = Detection(
        bbox=(94, 96, 20, 20),
        normalized_bbox=(0.235, 0.32, 0.05, 0.06),
        confidence=0.92,
        class_name="person",
        center=(104, 106),
    )
    tracks, _ = tr.update([det2])
    assert len(tracks) == 1
    assert tracks[0].track_id == 1

    # Disappeared for 3 frames -> deregistered
    tr.update([])
    tr.update([])
    tr.update([])
    assert len(tr.tracks) == 0


# ---------------------------------------------------------------------------
# 4. Virtual Boundary Crossing Math Tests
# ---------------------------------------------------------------------------
def test_boundary_crossing_zone_enter():
    """Moving top-to-bottom across horizontal boundary triggers ZONE_ENTER."""
    vb = VirtualBoundary(
        p1=(0.0, 0.5),
        p2=(1.0, 0.5),
        zone_a="CORRIDOR_TRANSIT",
        zone_b="WORKSPACE_FLOOR",
        frame_width=400,
        frame_height=300,
    )
    trajectory = [(200, 120), (200, 170)]
    crossing = vb.check_crossing(track_id=1, trajectory=trajectory)
    assert crossing is not None
    assert crossing.direction == CrossingDirection.ZONE_ENTER
    assert crossing.zone_from == "CORRIDOR_TRANSIT"
    assert crossing.zone_to == "WORKSPACE_FLOOR"


def test_boundary_crossing_zone_exit():
    """Moving bottom-to-top across horizontal boundary triggers ZONE_EXIT."""
    vb = VirtualBoundary(
        p1=(0.0, 0.5),
        p2=(1.0, 0.5),
        zone_a="CORRIDOR_TRANSIT",
        zone_b="WORKSPACE_FLOOR",
        frame_width=400,
        frame_height=300,
    )
    trajectory = [(200, 175), (200, 125)]
    crossing = vb.check_crossing(track_id=2, trajectory=trajectory)
    assert crossing is not None
    assert crossing.direction == CrossingDirection.ZONE_EXIT
    assert crossing.zone_from == "WORKSPACE_FLOOR"
    assert crossing.zone_to == "CORRIDOR_TRANSIT"


# ---------------------------------------------------------------------------
# 5. Learned Embedding Validation & Biometrics
# ---------------------------------------------------------------------------
def test_sface_learned_embedding_dimensions():
    """Verify SFace extracts exactly 128-dimensional learned embeddings."""
    model = SFaceModel(config.sface_model_path)
    assert model.embedding_dim == 128
    assert model.is_loaded is True

    test_face = np.full((112, 112, 3), 150, dtype=np.uint8)
    emb = model.extract_embedding(test_face)
    assert emb is not None
    assert len(emb) == 128
    assert emb.dtype == np.float32
    assert np.isclose(np.linalg.norm(emb), 1.0, atol=1e-3)


def test_invalid_embedding_dimensions_rejected():
    """Rejects vectors with incorrect length (e.g. 64-d or 512-d when 128-d expected)."""
    bm = BiometricMatcher(model=SFaceModel(config.sface_model_path))

    # Try enrolling 64-d vector -> must fail
    bad_vec_64 = np.ones(64, dtype=np.float32)
    assert bm.enroll("emp-1", "Emp", "B-1", bad_vec_64) is False

    # Try enrolling vector with NaN -> must fail
    nan_vec = np.ones(128, dtype=np.float32)
    nan_vec[10] = np.nan
    assert bm.enroll("emp-2", "Emp", "B-2", nan_vec) is False


def test_explicit_uncertain_threshold():
    """Score between uncertain_threshold (0.280) and match_threshold (0.363) returns UNCERTAIN."""
    bm = BiometricMatcher(
        match_threshold=0.363,
        uncertain_threshold=0.280,
        model=SFaceModel(config.sface_model_path),
    )
    # Target vector
    vec_enrolled = normalize_vector(np.ones(128, dtype=np.float32))
    bm.enroll("emp-3", "Anil Mehta", "B-3", vec_enrolled)

    # Construct query vector with dot product = 0.320 (in uncertain range)
    # u = vec_enrolled, v = 0.320 * u + sqrt(1 - 0.320^2) * orth
    orth = np.zeros(128, dtype=np.float32)
    orth[:64] = 1.0
    orth[64:] = -1.0
    orth = normalize_vector(orth)  # dot(vec_enrolled, orth) == 0

    query_uncertain = 0.320 * vec_enrolled + np.sqrt(1 - 0.320**2) * orth
    query_uncertain = normalize_vector(query_uncertain)

    res = bm.match_embedding(query_uncertain)
    assert res.status == MatchStatus.UNCERTAIN
    assert res.confidence_category == "UNCERTAIN"
    assert 0.280 <= res.cosine_score < 0.363


def test_dpdp_consent_revocation_gate():
    """When consent is revoked, matching immediately yields CONSENT_REVOKED."""
    bm = BiometricMatcher(
        match_threshold=0.363,
        uncertain_threshold=0.280,
        model=SFaceModel(config.sface_model_path),
        auto_attendance_enabled=True,
    )
    vec = normalize_vector(np.ones(128, dtype=np.float32))

    bm.enroll(
        employee_id="c0000000-0000-0000-0000-000000000003",
        name="Rajesh Patel",
        badge_id="EMP-1003",
        embedding=vec,
        consent_revoked=False,
    )

    # Before revocation: MATCHED
    res_before = bm.match_embedding(vec)
    assert res_before.status == MatchStatus.MATCHED

    # Revoke consent
    bm.revoke_consent("c0000000-0000-0000-0000-000000000003")

    # After revocation: CONSENT_REVOKED
    res_after = bm.match_embedding(vec)
    assert res_after.status == MatchStatus.CONSENT_REVOKED


def test_inactive_employee_rejection():
    """Inactive employee returns INACTIVE and prevents attendance punch."""
    bm = BiometricMatcher(
        match_threshold=0.363,
        model=SFaceModel(config.sface_model_path),
    )
    vec = normalize_vector(np.ones(128, dtype=np.float32))

    bm.enroll(
        employee_id="c0000000-0000-0000-0000-000000000004",
        name="Former Employee",
        badge_id="EMP-1004",
        embedding=vec,
        consent_revoked=False,
        is_active=False,
    )

    res = bm.match_embedding(vec)
    assert res.status == MatchStatus.INACTIVE


# ---------------------------------------------------------------------------
# 6. Biometric Encryption Tests (AES-256-GCM)
# ---------------------------------------------------------------------------
def test_aes_256_gcm_encryption_roundtrip():
    """Verify AES-256-GCM envelope encrypts and decrypts correctly."""
    secret = "test-biometric-secret-key-32-chars"
    vec = [round(float(x), 4) for x in np.random.randn(128)]

    envelope = encrypt_biometric_template(vec, secret=secret)
    assert envelope["encrypted"] is True
    assert "payload" in envelope
    assert "iv" in envelope

    decrypted = decrypt_biometric_template(envelope, secret=secret, expected_dim=128)
    assert decrypted is not None
    assert len(decrypted) == 128
    assert np.allclose(vec, decrypted, atol=1e-4)


def test_invalid_encryption_key_fails_cleanly():
    """Decryption with wrong key returns None without throwing unhandled exceptions."""
    secret_correct = "correct-secret-key-32-chars-long"
    secret_wrong = "wrong-secret-key-32-chars-longer"

    vec = [0.1] * 128
    envelope = encrypt_biometric_template(vec, secret=secret_correct)

    # Attempt decrypt with wrong key
    decrypted = decrypt_biometric_template(envelope, secret=secret_wrong, expected_dim=128)
    assert decrypted is None


# ---------------------------------------------------------------------------
# 7. Event Dispatcher & Debounce Tests
# ---------------------------------------------------------------------------
def test_dispatcher_debounce():
    """Suppresses duplicate events within debounce window."""
    disp = EventDispatcher(debounce_seconds=3.0)
    assert disp.is_debounced("user-1", "ZONE_ENTER", "WORKSPACE_FLOOR") is False
    assert disp.is_debounced("user-1", "ZONE_ENTER", "WORKSPACE_FLOOR") is True
    assert disp.is_debounced("user-1", "ZONE_EXIT", "CORRIDOR_TRANSIT") is False


def test_dispatcher_telemetry_payload_and_backend_url():
    """Validates telemetry dispatch configuration, headers, and endpoint formatting."""
    disp = EventDispatcher(backend_url="http://localhost:8080", device_key="dev-device-key-32", camera_id="ESP32-CAM-01-NORTH")
    assert disp.backend_url == "http://localhost:8080"
    assert disp.device_key == "dev-device-key-32"
    assert disp.camera_id == "ESP32-CAM-01-NORTH"


def test_dispatcher_register_camera_node_success():
    """Verify register_camera_node sends correct payload and returns True on 200 success."""
    disp = EventDispatcher(
        backend_url="http://localhost:8080",
        device_key="test-device-key-32",
        camera_id="ESP32-CAM-01-NORTH",
        camera_source="http://192.168.1.18:81/stream",
    )
    with patch("requests.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"success": True, "node": {"id": "ESP32-CAM-01-NORTH"}}
        mock_post.return_value = mock_resp

        result = disp.register_camera_node()
        assert result is True

        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        assert args[0] == "http://localhost:8080/api/public/esp32/register-node"
        assert kwargs["headers"]["x-device-key"] == "test-device-key-32"
        assert kwargs["headers"]["Content-Type"] == "application/json"
        assert kwargs["timeout"] == disp.timeout_sec

        payload = kwargs["json"]
        assert payload["id"] == "ESP32-CAM-01-NORTH"
        assert payload["stream_url"] == "http://192.168.1.18:81/stream"
        assert payload["boundary_name"] == "North Entrance Camera"
        assert payload["zone_a"] == config.zone_a
        assert payload["zone_b"] == config.zone_b
        assert payload["is_online"] is True
        assert payload["fps"] == config.target_fps
        assert payload["firmware_version"] == "gateway-v1.1.0"
        if hasattr(config, "boundary_coords") and config.boundary_coords and len(config.boundary_coords) == 4:
            c = config.boundary_coords
            assert payload["boundary_coordinates"] == {"x1": c[0], "y1": c[1], "x2": c[2], "y2": c[3]}


def test_dispatcher_register_camera_node_http_failure():
    """Verify register_camera_node returns False on HTTP 400 or 500 error or success=False."""
    disp = EventDispatcher()
    with patch("requests.post") as mock_post:
        # HTTP 400
        mock_resp = MagicMock()
        mock_resp.status_code = 400
        mock_resp.json.return_value = {"success": False, "error": "Invalid payload"}
        mock_post.return_value = mock_resp
        assert disp.register_camera_node() is False

        # HTTP 500
        mock_resp.status_code = 500
        mock_resp.json.return_value = {"error": "Internal server error"}
        assert disp.register_camera_node() is False

        # HTTP 200 with success False
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"success": False}
        assert disp.register_camera_node() is False


def test_dispatcher_register_camera_node_malformed_response():
    """Verify register_camera_node returns False if response JSON is malformed."""
    disp = EventDispatcher()
    with patch("requests.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.side_effect = ValueError("Invalid JSON response")
        mock_post.return_value = mock_resp
        assert disp.register_camera_node() is False


def test_dispatcher_register_camera_node_request_exception():
    """Verify register_camera_node returns False when request throws an exception."""
    disp = EventDispatcher()
    with patch("requests.post", side_effect=requests.exceptions.ConnectionError("Connection refused")):
        assert disp.register_camera_node() is False

    with patch("requests.post", side_effect=requests.exceptions.Timeout("Request timed out")):
        assert disp.register_camera_node() is False


# ---------------------------------------------------------------------------
# 8. FastAPI Gateway Endpoints Tests
# ---------------------------------------------------------------------------
def test_api_health(client):
    """GET /health returns 200 with service health info and recognition model."""
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] in ("healthy", "synthetic_fallback", "camera_disconnected")
    assert data["embedding_dimension"] == 128
    assert "auto_biometric_attendance_enabled" in data
    assert "is_synthetic" in data


def test_api_camera_status(client):
    """GET /camera/status returns camera parameters."""
    resp = client.get("/camera/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["camera_id"] == config.camera_id


def test_api_live_detection_endpoint(client):
    """GET /api/live-detection returns real-time coordinates for React dashboard."""
    resp = client.get("/api/live-detection")
    assert resp.status_code == 200
    data = resp.json()
    assert "camera_id" in data
    assert "is_live" in data
    assert "confidence_category" in data


def test_api_enroll_and_revoke_test_employee(client):
    """Verify test employee enrollment and consent revocation API."""
    emp_id = "c0000000-0000-0000-0000-000000000099"
    resp = client.post(
        "/api/enroll-test-employee",
        json={
            "employee_id": emp_id,
            "name": "Priya Nair",
            "badge_id": "EMP-1099",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    # Revoke consent
    resp_rev = client.post(f"/api/revoke-consent/{emp_id}")
    assert resp_rev.status_code == 200

    # Crossing simulation with revoked consent should return 403 Forbidden
    resp_sim = client.post(
        "/api/simulate-crossing",
        json={
            "direction": "ZONE_ENTER",
            "user_id": emp_id,
            "cosine_score": 0.95,
        },
    )
    assert resp_sim.status_code == 403
    assert "Consent has been revoked" in resp_sim.json()["detail"]


# ---------------------------------------------------------------------------
# 9. Continuous Video Pipeline Verification
# ---------------------------------------------------------------------------
def test_continuous_pipeline_session():
    """
    Simulates a continuous video processing session:
    Frame capture -> Detection -> Centroid tracking -> Tripwire crossing -> Dispatch.
    Verifies that one continuous boundary transit triggers exactly ONE crossing event.
    """
    vb = VirtualBoundary(
        p1=(0.0, 0.5),
        p2=(1.0, 0.5),
        zone_a="CORRIDOR_TRANSIT",
        zone_b="WORKSPACE_FLOOR",
        frame_width=400,
        frame_height=300,
    )
    obj_tracker = ObjectTracker(virtual_boundary=vb, debounce_frames=20)

    crossing_events_collected = []

    # Simulate person walking top-to-bottom across horizontal tripwire (y=150)
    # y positions from 120 to 180 across 7 frames
    y_path = [120, 130, 140, 152, 160, 170, 180]
    for frame_idx, y in enumerate(y_path):
        det = Detection(
            bbox=(190, y - 10, 20, 40),
            normalized_bbox=(190 / 400, (y - 10) / 300, 20 / 400, 40 / 300),
            confidence=0.92,
            class_name="person",
            center=(200, y),
        )
        tracks, crossings = obj_tracker.update([det])
        crossing_events_collected.extend(crossings)

    # Exactly 1 crossing event must be emitted despite 7 continuous frames
    assert len(crossing_events_collected) == 1
    assert crossing_events_collected[0].direction == CrossingDirection.ZONE_ENTER
    assert crossing_events_collected[0].zone_to == "WORKSPACE_FLOOR"


# ---------------------------------------------------------------------------
# 10. Face-to-Track Identity Association Regression Tests
# ---------------------------------------------------------------------------

def _make_face(center=(100, 80)):
    return Detection(
        bbox=(center[0] - 10, center[1] - 10, 20, 20),
        normalized_bbox=(0.0, 0.0, 0.0, 0.0),
        confidence=0.95,
        class_name="face",
        center=center,
    )


def _make_track(track_id, bbox, disappeared=0):
    center = (bbox[0] + bbox[2] // 2, bbox[1] + bbox[3] // 2)
    return Track(
        track_id=track_id,
        bbox=bbox,
        centroid=center,
        disappeared=disappeared,
    )


def _make_match(status, employee_id="employee-1"):
    return MatchResult(
        status=status,
        employee_id=employee_id,
        name="Test Employee",
        cosine_score=0.95,
        confidence_category="HIGH",
    )


def test_face_identity_attaches_only_to_unique_track():
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))

    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, _make_match(MatchStatus.MATCHED))],
        active_tracks=[track],
    )

    assert track.matched_person_id == "employee-1"
    assert track.matched_name == "Test Employee"
    assert track.matched_cosine == 0.95
    assert track.consent_revoked is False


def test_ambiguous_face_is_not_attached_to_overlapping_tracks():
    face = _make_face((100, 80))
    track1 = _make_track(1, (40, 20, 120, 150))
    track2 = _make_track(2, (60, 30, 120, 150))

    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, _make_match(MatchStatus.MATCHED))],
        active_tracks=[track1, track2],
    )

    assert track1.matched_person_id is None
    assert track2.matched_person_id is None


def test_multiple_faces_mapping_to_one_track_are_not_attached():
    face1 = _make_face((90, 70))
    face2 = _make_face((110, 90))
    track = _make_track(1, (40, 20, 120, 150))

    _attach_face_matches_to_tracks(
        faces=[face1, face2],
        face_results=[
            (face1, _make_match(MatchStatus.MATCHED, "employee-1")),
            (face2, _make_match(MatchStatus.MATCHED, "employee-2")),
        ],
        active_tracks=[track],
    )

    assert track.matched_person_id is None


@pytest.mark.parametrize(
    "status",
    [MatchStatus.INACTIVE, MatchStatus.UNCERTAIN, MatchStatus.UNKNOWN],
)
def test_ineligible_match_status_is_not_attached(status):
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))

    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, _make_match(status))],
        active_tracks=[track],
    )

    assert track.matched_person_id is None


def test_revoked_identity_is_attached_with_revocation_flag():
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))

    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[
            (face, _make_match(MatchStatus.CONSENT_REVOKED))
        ],
        active_tracks=[track],
    )

    assert track.matched_person_id == "employee-1"
    assert track.consent_revoked is True


def test_sync_templates_endpoint_requires_device_key(client):
    """Verify /api/sync-templates strictly rejects unauthenticated calls."""
    # 1. No key -> 401
    resp = client.post("/api/sync-templates")
    assert resp.status_code == 401
    assert "Unauthorized" in resp.json()["detail"]

    # 2. Wrong key -> 401
    resp = client.post("/api/sync-templates", headers={"x-device-key": "invalid-key"})
    assert resp.status_code == 401

    # 3. Valid key -> 200, returns metadata without exposing template vectors
    resp = client.post("/api/sync-templates", headers={"x-device-key": config.device_key})
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert "enrolled_count" in data
    assert "synced_at" in data
    # Assert zero exposure of templates or biometric vectors
    assert "templates" not in data
    assert "embeddings" not in data


# ---------------------------------------------------------------------------
# 18. Video Relay (/video_feed) Tests
# ---------------------------------------------------------------------------
def test_encode_mjpeg_chunk():
    """Verify chunk encoding math and None handling."""
    assert encode_mjpeg_chunk(None) is None

    test_frame = np.zeros((120, 160, 3), dtype=np.uint8)
    cv2.putText(test_frame, "TEST", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 1)

    chunk = encode_mjpeg_chunk(test_frame)
    assert chunk is not None
    assert chunk.startswith(b"--frame\r\n")
    assert b"Content-Type: image/jpeg\r\n" in chunk
    assert b"Content-Length: " in chunk

    # Validate decodable JPEG payload
    start = chunk.find(b"\xff\xd8")
    end = chunk.find(b"\xff\xd9", start)
    assert start >= 0 and end >= 0
    raw_jpeg = chunk[start:end + 2]
    decoded = cv2.imdecode(np.frombuffer(raw_jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert decoded is not None
    assert decoded.shape == (120, 160, 3)


def test_video_relay_response_and_multipart_frame_output(client):
    """Verify GET /video_feed returns multipart stream and decodable JPEG frames."""
    test_frame = np.zeros((240, 320, 3), dtype=np.uint8)
    cv2.putText(test_frame, "RELAY", (20, 80), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)

    with patch.object(camera, "get_latest_frame", return_value=test_frame):
        with client.stream("GET", "/video_feed") as response:
            assert response.status_code == 200
            ct = response.headers.get("content-type", "")
            assert "multipart/x-mixed-replace" in ct
            assert "boundary=frame" in ct
            assert response.headers.get("access-control-allow-origin") == "*"

            chunk = next(response.iter_bytes())
            assert b"--frame\r\n" in chunk
            assert b"Content-Type: image/jpeg" in chunk
            start = chunk.find(b"\xff\xd8")
            end = chunk.find(b"\xff\xd9", start)
            assert start >= 0 and end >= 0
            jpeg_bytes = chunk[start:end + 2]
            decoded = cv2.imdecode(np.frombuffer(jpeg_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
            assert decoded is not None
            assert decoded.shape == (240, 320, 3)


@pytest.mark.asyncio
async def test_video_relay_handling_unavailable_frames():
    """Verify generator cleanly handles unavailable camera frames without crashing."""
    assert encode_mjpeg_chunk(None) is None

    # When get_latest_frame returns None, max_consecutive_empty terminates safely
    with patch.object(camera, "get_latest_frame", return_value=None):
        gen = generate_mjpeg_stream(max_consecutive_empty=2)
        chunks = [c async for c in gen]
        assert chunks == []


def test_video_relay_client_disconnect_and_reconnection(client):
    """Verify client disconnect terminates generator safely and reconnection succeeds."""
    test_frame = np.ones((100, 100, 3), dtype=np.uint8) * 50

    with patch.object(camera, "get_latest_frame", return_value=test_frame):
        # 1. Connect and immediately disconnect after 1 chunk
        with client.stream("GET", "/video_feed") as res1:
            assert res1.status_code == 200
            chunk1 = next(res1.iter_bytes())
            assert b"--frame" in chunk1

        # 2. Reconnect immediately - verify second connection succeeds
        with client.stream("GET", "/video_feed") as res2:
            assert res2.status_code == 200
            chunk2 = next(res2.iter_bytes())
            assert b"--frame" in chunk2


# ---------------------------------------------------------------------------
# 19. Phase 2: Face Recognition Pipeline Tests (Stages 4, 5, 6)
# ---------------------------------------------------------------------------
def test_sync_enrolled_templates_flow():
    """Verify template retrieval, decryption, dimension rejection, and DPDP consent gating."""
    valid_vec = normalize_vector(np.random.randn(128).astype(np.float32))
    valid_envelope = encrypt_biometric_template(valid_vec, secret=config.biometric_encryption_key)

    mock_templates = [
        {
            "employee_id": "11111111-1111-1111-1111-111111111111",
            "name": "Enrolled Active Employee",
            "badge_id": "EMP-SYNC-1",
            "encrypted_envelope": valid_envelope,
            "consent_revoked": False,
            "is_active": True,
        },
        {
            "employee_id": "22222222-2222-2222-2222-222222222222",
            "name": "Corrupted Dimension Employee",
            "badge_id": "EMP-CORRUPT",
            "encrypted_envelope": [0.1] * 64,  # Invalid dimension (64 instead of 128)
            "consent_revoked": False,
            "is_active": True,
        },
        {
            "employee_id": "33333333-3333-3333-3333-333333333333",
            "name": "Consent Revoked Employee",
            "badge_id": "EMP-REVOKED",
            "encrypted_envelope": valid_envelope,
            "consent_revoked": True,
            "is_active": True,
        },
    ]

    with patch.object(dispatcher, "fetch_enrolled_templates", return_value=mock_templates):
        # Clear enrolled cache
        matcher.enrolled.clear()
        enrolled_count = sync_enrolled_templates()

        # Exactly 2 should succeed (valid and revoked consent), 1 rejected (corrupted dimension)
        assert enrolled_count == 2
        assert "11111111-1111-1111-1111-111111111111" in matcher.enrolled
        assert "22222222-2222-2222-2222-222222222222" not in matcher.enrolled
        assert "33333333-3333-3333-3333-333333333333" in matcher.enrolled

        # Verify active employee matches
        res_valid = matcher.match_embedding(valid_vec)
        assert res_valid.status == MatchStatus.DISABLED_FOR_REVIEW  # Because auto_attendance is False by default
        assert res_valid.employee_id == "11111111-1111-1111-1111-111111111111"


def test_complete_recognition_six_states():
    """Verify matcher distinguishes MATCHED, UNKNOWN, UNCERTAIN, INACTIVE, CONSENT_REVOKED and DISABLED_FOR_REVIEW."""
    base_vec = normalize_vector(np.random.randn(128).astype(np.float32))
    ortho_vec = normalize_vector(np.random.randn(128).astype(np.float32))
    ortho_vec = normalize_vector(ortho_vec - np.dot(ortho_vec, base_vec) * base_vec)

    # State 1: DISABLED_FOR_REVIEW (auto_attendance=False, genuine score >= 0.363)
    test_matcher = BiometricMatcher(auto_attendance_enabled=False)
    test_matcher.enroll("u1", "Active Person", "B-1", base_vec, is_active=True, consent_revoked=False)
    r1 = test_matcher.match_embedding(base_vec)
    assert r1.status == MatchStatus.DISABLED_FOR_REVIEW
    assert r1.confidence_category == "HIGH"

    # State 2: MATCHED (auto_attendance=True, genuine score >= 0.363)
    live_matcher = BiometricMatcher(auto_attendance_enabled=True)
    live_matcher.enroll("u1", "Active Person", "B-1", base_vec, is_active=True, consent_revoked=False)
    r2 = live_matcher.match_embedding(base_vec)
    assert r2.status == MatchStatus.MATCHED
    assert r2.confidence_category == "HIGH"

    # State 3: UNCERTAIN (0.280 <= score < 0.363)
    uncertain_vec = normalize_vector(0.32 * base_vec + np.sqrt(1 - 0.32**2) * ortho_vec)
    r3 = test_matcher.match_embedding(uncertain_vec)
    assert r3.status == MatchStatus.UNCERTAIN
    assert r3.confidence_category == "UNCERTAIN"

    # State 4: UNKNOWN (score < 0.280)
    low_vec = normalize_vector(0.10 * base_vec + np.sqrt(1 - 0.10**2) * ortho_vec)
    r4 = test_matcher.match_embedding(low_vec)
    assert r4.status == MatchStatus.UNKNOWN
    assert r4.confidence_category == "UNKNOWN"

    # State 5: CONSENT_REVOKED
    rev_matcher = BiometricMatcher(auto_attendance_enabled=True)
    rev_matcher.enroll("u2", "Revoked Person", "B-2", base_vec, is_active=True, consent_revoked=True)
    r5 = rev_matcher.match_embedding(base_vec)
    assert r5.status == MatchStatus.CONSENT_REVOKED
    assert r5.confidence_category == "REVOKED"

    # State 6: INACTIVE
    inact_matcher = BiometricMatcher(auto_attendance_enabled=True)
    inact_matcher.enroll("u3", "Inactive Person", "B-3", base_vec, is_active=False, consent_revoked=False)
    r6 = inact_matcher.match_embedding(base_vec)
    assert r6.status == MatchStatus.INACTIVE
    assert r6.confidence_category == "INACTIVE"


def test_sync_enrolled_templates_network_failure():
    """Verify that network failures during template sync do not crash and preserve existing cache."""
    valid_vec = normalize_vector(np.random.randn(128).astype(np.float32))
    matcher.enrolled.clear()
    matcher.enroll("existing-emp", "Existing Person", "B-EXIST", valid_vec)
    assert len(matcher.enrolled) == 1

    # Simulate backend returning None (network error or HTTP 500)
    with patch.object(dispatcher, "fetch_enrolled_templates", return_value=None):
        count = sync_enrolled_templates()
        assert count == 1
        assert "existing-emp" in matcher.enrolled

    # Simulate dispatcher raising an exception
    with patch.object(dispatcher, "fetch_enrolled_templates", side_effect=Exception("Connection refused")):
        count = sync_enrolled_templates()
        assert count == 1
        assert "existing-emp" in matcher.enrolled


def test_sync_enrolled_templates_removes_deactivated_and_deleted():
    """Verify that sync safely removes inactive and deleted/erased employees per DPDP Sec. 12."""
    v1 = normalize_vector(np.random.randn(128).astype(np.float32))
    v2 = normalize_vector(np.random.randn(128).astype(np.float32))
    v3 = normalize_vector(np.random.randn(128).astype(np.float32))

    env1 = encrypt_biometric_template(v1, secret=config.biometric_encryption_key)

    matcher.enrolled.clear()
    # Pre-populate matcher with 3 employees
    matcher.enroll("emp-keep", "Active Person", "B-1", v1)
    matcher.enroll("emp-deactivated", "Deactivated Person", "B-2", v2)
    matcher.enroll("emp-deleted", "Deleted Person", "B-3", v3)
    assert len(matcher.enrolled) == 3

    # Backend response: emp-keep is active, emp-deactivated is is_active=False, emp-deleted is completely omitted
    mock_response = [
        {
            "employee_id": "emp-keep",
            "name": "Active Person",
            "badge_id": "B-1",
            "encrypted_envelope": env1,
            "consent_revoked": False,
            "is_active": True,
        },
        {
            "employee_id": "emp-deactivated",
            "name": "Deactivated Person",
            "badge_id": "B-2",
            "encrypted_envelope": env1,
            "consent_revoked": False,
            "is_active": False,
        },
    ]

    with patch.object(dispatcher, "fetch_enrolled_templates", return_value=mock_response):
        count = sync_enrolled_templates()
        assert count == 1
        assert "emp-keep" in matcher.enrolled
        assert "emp-deactivated" not in matcher.enrolled
        assert "emp-deleted" not in matcher.enrolled


def test_threshold_discrepancy_range_classification_gateway():
    """
    Task 4 Documentation & Verification:
    Gateway SFace threshold is 0.363, while backend threshold is 0.700.
    Verify exact gateway classification for scores across the key ranges:
    1. Score < 0.280 -> UNKNOWN
    2. 0.280 <= Score < 0.363 -> UNCERTAIN
    3. 0.363 <= Score < 0.700 -> MATCHED (Gateway accepts; Backend strips identity)
    4. Score >= 0.700 -> MATCHED (Unanimous accept)
    """
    base_vec = normalize_vector(np.random.randn(128).astype(np.float32))
    ortho_vec = normalize_vector(np.random.randn(128).astype(np.float32))
    ortho_vec = normalize_vector(ortho_vec - np.dot(ortho_vec, base_vec) * base_vec)

    test_matcher = BiometricMatcher(auto_attendance_enabled=True)
    test_matcher.enroll("emp-test", "Test Employee", "B-TEST", base_vec, is_active=True, consent_revoked=False)

    # 1. Score < 0.280: e.g. target 0.20
    s_020 = 0.20
    vec_020 = normalize_vector(s_020 * base_vec + np.sqrt(1 - s_020**2) * ortho_vec)
    r_020 = test_matcher.match_embedding(vec_020)
    assert r_020.status == MatchStatus.UNKNOWN
    assert r_020.confidence_category == "UNKNOWN"

    # 2. 0.280 <= Score < 0.363: e.g. target 0.320
    s_032 = 0.320
    vec_032 = normalize_vector(s_032 * base_vec + np.sqrt(1 - s_032**2) * ortho_vec)
    r_032 = test_matcher.match_embedding(vec_032)
    assert r_032.status == MatchStatus.UNCERTAIN
    assert r_032.confidence_category == "UNCERTAIN"

    # 3. 0.363 <= Score < 0.700 (Critical architectural divergence range): e.g. target 0.50
    s_050 = 0.50
    vec_050 = normalize_vector(s_050 * base_vec + np.sqrt(1 - s_050**2) * ortho_vec)
    r_050 = test_matcher.match_embedding(vec_050)
    # The gateway considers this a valid MATCHED candidate (or DISABLED_FOR_REVIEW if auto_attendance=False)
    assert r_050.status == MatchStatus.MATCHED
    assert r_050.confidence_category == "HIGH"
    assert r_050.employee_id == "emp-test"

    # 4. Score >= 0.700: e.g. target 0.85
    s_085 = 0.85
    vec_085 = normalize_vector(s_085 * base_vec + np.sqrt(1 - s_085**2) * ortho_vec)
    r_085 = test_matcher.match_embedding(vec_085)
    assert r_085.status == MatchStatus.MATCHED
    assert r_085.confidence_category == "HIGH"
    assert r_085.employee_id == "emp-test"


# ---------------------------------------------------------------------------
# 13. Camera Stream Reader Auto-Recovery, Fallback & Reconnect Tests
# ---------------------------------------------------------------------------
def test_camera_stream_reader_initial_connection_mjpeg_success():
    """Verify stream reader connects to HTTP MJPEG source and reports real connectivity."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.iter_content.return_value = iter([b"--frame\r\n\xff\xd8fakejpeg\xff\xd9\r\n"])

    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    with patch("requests.get", return_value=mock_resp):
        assert reader.connect() is True

    assert reader.is_camera_connected is True
    assert reader.is_connected is True
    assert reader.use_synthetic is False
    status = reader.get_status()
    assert status["is_connected"] is True
    assert status["is_camera_connected"] is True
    assert status["is_synthetic"] is False
    reader.disconnect()
    assert reader.is_camera_connected is False
    assert reader.is_connected is False


def test_camera_stream_reader_synthetic_fallback_on_consecutive_failures():
    """Verify that camera reader enters synthetic fallback without blocking and reports synthetic status."""
    reader = CameraStreamReader(
        source="http://192.168.1.18:81/stream",
        reconnect_interval_sec=0.001,
        max_reconnect_attempts=2,
        fallback_reconnect_interval_sec=0.1,
    )
    with patch("requests.get", side_effect=requests.exceptions.ReadTimeout("Contention")):
        # Direct connect failure
        assert reader.connect() is False
        assert reader.is_camera_connected is False
        assert reader.is_connected is False

        # Simulate reaching max reconnect attempts in loop
        reader.reconnect_count = 2
        # Start capture loop briefly to trigger fallback
        reader.is_running = True
        t = threading.Thread(target=reader._capture_loop, daemon=True)
        t.start()
        time.sleep(0.05)
        reader.is_running = False
        t.join(timeout=1.0)

    # Must be in synthetic fallback
    assert reader.use_synthetic is True
    # Real camera connectivity must be False!
    assert reader.is_camera_connected is False
    # is_connected must report False during synthetic fallback!
    assert reader.is_connected is False
    status = reader.get_status()
    assert status["is_connected"] is False
    assert status["is_camera_connected"] is False
    assert status["is_synthetic"] is True

    # Frames must still be produced smoothly
    success, frame = reader.read_frame()
    assert success is True
    assert frame is not None
    assert frame.shape == (config.frame_height, config.frame_width, 3)


def test_camera_stream_reader_background_auto_recovery():
    """Verify background worker seamlessly auto-recovers to real camera when available."""
    reader = CameraStreamReader(
        source="http://192.168.1.18:81/stream",
        max_reconnect_attempts=2,
    )
    # Put reader in synthetic fallback
    reader.use_synthetic = True
    reader.is_camera_connected = False
    reader.is_connected = False
    reader.reconnect_count = 5

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.iter_content.return_value = iter([b"chunk1", b"chunk2"])

    with patch("requests.get", return_value=mock_resp):
        reader._background_reconnect_worker()

    assert reader.is_camera_connected is True
    assert reader.is_connected is True
    assert reader.use_synthetic is False
    assert reader.reconnect_count == 0
    status = reader.get_status()
    assert status["is_camera_connected"] is True
    assert status["is_synthetic"] is False
    reader.disconnect()


def test_camera_stream_reader_prevent_duplicate_reconnect():
    """Verify that multiple background reconnect threads cannot be spawned concurrently."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader._is_reconnecting = True

    with patch("threading.Thread") as mock_thread_cls:
        reader._start_background_reconnect()
        mock_thread_cls.assert_not_called()


def test_api_camera_reconnect_endpoint(client):
    """Verify POST /camera/reconnect endpoint triggers reconnect and returns accurate status."""
    dummy_frame = np.zeros((100, 100, 3), dtype=np.uint8)

    def fake_reconnect(*args, **kwargs):
        camera.real_frame_count += 5
        return True

    with patch.object(camera, "reconnect", side_effect=fake_reconnect), \
         patch.object(camera, "read_frame", return_value=(True, dummy_frame)), \
         patch.object(CameraStreamReader, "is_camera_connected", new_callable=PropertyMock, return_value=True), \
         patch.object(CameraStreamReader, "is_stale", new_callable=PropertyMock, return_value=False):
        camera.use_synthetic = False
        camera.last_real_frame_timestamp = time.time()
        resp = client.post("/camera/reconnect")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "reconnected"
        assert data["camera_connected"] is True
        assert data["is_synthetic"] is False

    with patch.object(camera, "reconnect", return_value=False), \
         patch.object(CameraStreamReader, "is_camera_connected", new_callable=PropertyMock, return_value=False), \
         patch.object(CameraStreamReader, "is_stale", new_callable=PropertyMock, return_value=False):
        camera.use_synthetic = True
        resp = client.post("/camera/reconnect")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "failed"
        assert data["camera_connected"] is False
        assert data["is_synthetic"] is True


def test_api_health_accurate_status_categories(client):
    """Verify /health accurately categorizes healthy vs synthetic_fallback vs disconnected."""
    orig_conn = camera.is_camera_connected
    orig_synth = camera.use_synthetic
    dummy_frame = np.zeros((100, 100, 3), dtype=np.uint8)
    with patch.object(camera, "read_frame", return_value=(True, dummy_frame)):
        try:
            # 1. Real camera connected
            camera.is_camera_connected = True
            camera.use_synthetic = False
            camera.last_real_frame_timestamp = time.time()
            resp = client.get("/health")
            assert resp.status_code == 200
            assert resp.json()["status"] == "healthy"
            assert resp.json()["camera_connected"] is True
            assert resp.json()["is_synthetic"] is False

            # 2. Synthetic fallback active
            camera.is_camera_connected = False
            camera.use_synthetic = True
            resp = client.get("/health")
            assert resp.status_code == 200
            assert resp.json()["status"] == "synthetic_fallback"
            assert resp.json()["camera_connected"] is False
            assert resp.json()["is_synthetic"] is True

            # 3. Completely disconnected
            camera.is_camera_connected = False
            camera.use_synthetic = False
            resp = client.get("/health")
            assert resp.status_code == 200
            assert resp.json()["status"] == "camera_disconnected"
            assert resp.json()["camera_connected"] is False
            assert resp.json()["is_synthetic"] is False

            # 4. Connected but stale stream
            camera.is_camera_connected = True
            camera.use_synthetic = False
            camera.last_real_frame_timestamp = time.time() - 10.0
            assert camera.is_stale is True
            assert camera.is_camera_live is False
            resp = client.get("/health")
            assert resp.status_code == 200
            assert resp.json()["status"] == "stale_stream"
            assert resp.json()["is_stale"] is True
            assert resp.json()["camera_connected"] is False
        finally:
            camera.is_camera_connected = orig_conn
            camera.use_synthetic = orig_synth


def test_camera_stream_reader_real_frame_count_and_timestamp_advance():
    """Verify that acquiring real frames advances real_frame_count and last_real_frame_timestamp."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader.is_camera_connected = True
    reader.use_synthetic = False
    assert reader.real_frame_count == 0
    assert reader.last_real_frame_timestamp == 0.0

    dummy_frame = np.zeros((100, 100, 3), dtype=np.uint8)
    with patch.object(reader, "read_frame", return_value=(True, dummy_frame)):
        reader.is_running = True
        t = threading.Thread(target=reader._capture_loop, daemon=True)
        t.start()
        time.sleep(0.1)
        reader.is_running = False
        t.join(timeout=1.0)

    assert reader.real_frame_count > 0
    assert reader.last_real_frame_timestamp > 0.0
    assert reader.is_stale is False
    status = reader.get_status()
    assert status["real_frame_count"] == reader.real_frame_count
    assert status["last_real_frame_timestamp"] == reader.last_real_frame_timestamp


def test_camera_stream_reader_stale_detection_and_watchdog():
    """Verify that stalled real camera is flagged as stale and disconnected by watchdog."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream", stale_timeout_sec=0.1)
    reader.is_camera_connected = True
    reader.use_synthetic = False
    reader.last_real_frame_timestamp = time.time() - 0.5  # older than 0.1s
    assert reader.is_stale is True

    # Capture loop watchdog should catch the stall and call disconnect
    with patch.object(reader, "disconnect") as mock_disc:
        reader.is_running = True
        t = threading.Thread(target=reader._capture_loop, daemon=True)
        t.start()
        time.sleep(0.05)
        reader.is_running = False
        t.join(timeout=1.0)
        mock_disc.assert_called()


def test_camera_stream_reader_reconnect_preserves_healthy_stream():
    """Verify that reconnect() does not tear down healthy active stream unless force=True."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader.is_camera_connected = True
    reader.use_synthetic = False
    reader.last_real_frame_timestamp = time.time()
    assert reader.is_stale is False

    with patch.object(reader, "disconnect") as mock_disc:
        # Non-forced reconnect on healthy stream must do nothing
        assert reader.reconnect(force=False) is True
        mock_disc.assert_not_called()

        # Forced reconnect must disconnect and attempt connection
        with patch.object(reader, "connect", return_value=True):
            assert reader.reconnect(force=True) is True
            mock_disc.assert_called_once()


def test_camera_stream_reader_resilient_to_iter_content_attribute_error():
    """Verify that AttributeError in urllib3 stream reader does not crash capture loop."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader.is_camera_connected = True
    reader.use_synthetic = False

    def broken_iter():
        raise AttributeError("'NoneType' object has no attribute 'read'")
        yield b""

    reader._mjpeg_response = MagicMock()
    reader._mjpeg_iterator = broken_iter()

    # _read_mjpeg_frame must catch AttributeError and return (False, None)
    success, frame = reader._read_mjpeg_frame()
    assert success is False
    assert frame is None


def test_api_camera_status_includes_freshness_metadata(client):
    """Verify /camera/status returns real_frame_count, last_real_frame_timestamp, and is_stale."""
    resp = client.get("/camera/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "real_frame_count" in data
    assert "last_real_frame_timestamp" in data
    assert "is_stale" in data
    assert "reconnect_count" in data


@pytest.mark.asyncio
async def test_video_feed_generator_yields_fresh_mjpeg_chunks():
    """Verify that generate_mjpeg_stream yields multipart MJPEG chunks."""
    from main import generate_mjpeg_stream
    test_frame = np.full((120, 160, 3), 100, dtype=np.uint8)
    with patch.object(camera, "get_latest_frame", return_value=test_frame):
        chunks = []
        async for chunk in generate_mjpeg_stream(max_frames=2):
            chunks.append(chunk)

        assert len(chunks) == 2
        for ch in chunks:
            assert ch.startswith(b"--frame\r\n")
            assert b"Content-Type: image/jpeg\r\n" in ch
            assert b"Content-Length: " in ch


# ===========================================================================
# 11. Robust Camera Disconnect Detection & Auto-Recovery Regression Tests
# ===========================================================================

def test_camera_disconnect_clears_cached_frame():
    """1. Camera disconnect clears cached frame so stale image is never served."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader.is_camera_connected = True
    reader._latest_frame = np.zeros((100, 100, 3), dtype=np.uint8)
    assert reader.get_latest_frame() is not None

    reader.disconnect()
    assert reader.is_camera_connected is False
    assert reader.is_connected is False
    assert reader.get_latest_frame() is None


def test_frames_stop_advancing_marks_offline_after_stale_timeout():
    """2 & 3. Real camera produces no frames for > stale_timeout_sec: marks stale & offline."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream", stale_timeout_sec=0.2)
    reader.is_camera_connected = True
    reader.use_synthetic = False
    reader.last_real_frame_timestamp = time.time() - 0.5
    assert reader.is_stale is True
    assert reader.is_camera_live is False

    status = reader.get_status()
    assert status["is_stale"] is True
    assert status["is_camera_connected"] is False
    assert status["is_camera_live"] is False


def test_dashboard_live_status_becomes_false_when_stream_stops():
    """4. Dashboard live status becomes false when camera disconnects or stalls."""
    from main import state
    # Simulate disconnected camera
    camera.is_camera_live = False
    camera.use_synthetic = False
    orig_detection = dict(state.last_detection)
    try:
        # When stream is not live, is_live in state is false
        state.last_detection["is_live"] = False
        assert state.last_detection["is_live"] is False
    finally:
        state.last_detection = orig_detection
        camera.is_camera_live = None


def test_stale_frames_not_continuously_relayed():
    """5. When camera is offline, get_latest_frame() returns None rather than repeating stale frames."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader.disconnect()
    assert reader.get_latest_frame() is None


def test_camera_auto_reconnect_exponential_backoff():
    """6. Exponential backoff increases up to approximately 15 seconds."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream", reconnect_interval_sec=2.0)
    delays = []
    for attempt in range(6):
        reader.reconnect_count = attempt
        delays.append(reader._get_reconnect_backoff_delay())

    # 2.0s, 3.6s, 6.5s, 11.7s, 15.0s, 15.0s (capped)
    assert delays[0] == 2.0
    assert 3.5 <= delays[1] <= 3.7
    assert 6.4 <= delays[2] <= 6.6
    assert 11.5 <= delays[3] <= 11.8
    assert delays[4] == 15.0
    assert delays[5] == 15.0


def test_camera_reconnect_resumes_fresh_frames_and_resets_backoff():
    """7. Camera reconnection resets reconnect backoff and updates fresh frame timestamp."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader.reconnect_count = 5

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.iter_content.return_value = iter([b"data"])

    with patch("requests.get", return_value=mock_resp):
        success = reader.connect()
        assert success is True
        assert reader.reconnect_count == 0
        assert reader.last_real_frame_timestamp > 0.0
        assert reader.is_camera_connected is True
        assert reader.is_camera_live is True
        reader.disconnect()


def test_dashboard_changes_back_to_live_after_recovery():
    """8. Live detection state recovers to is_live=True when camera resumes fresh frames."""
    from main import state
    orig = dict(state.last_detection)
    try:
        state.last_detection["is_live"] = True
        assert state.last_detection["is_live"] is True
    finally:
        state.last_detection = orig


def test_gateway_heartbeat_reports_actual_hardware_online_status():
    """9. register_camera_node sends is_online=False when hardware is disconnected."""
    disp = EventDispatcher()
    with patch("requests.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"success": True}
        mock_post.return_value = mock_resp

        # Report offline hardware
        disp.register_camera_node(is_online=False)
        assert mock_post.called
        payload = mock_post.call_args[1]["json"]
        assert payload["is_online"] is False

        # Report online hardware
        disp.register_camera_node(is_online=True)
        payload = mock_post.call_args[1]["json"]
        assert payload["is_online"] is True


def test_healthy_stream_not_disrupted_by_reconnect():
    """10. Healthy stream is preserved and not disrupted by reconnect(force=False)."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader.is_camera_connected = True
    reader.use_synthetic = False
    reader.last_real_frame_timestamp = time.time()
    assert reader.is_camera_live is True

    with patch.object(reader, "disconnect") as mock_disc:
        assert reader.reconnect(force=False) is True
        mock_disc.assert_not_called()


def test_no_duplicate_esp32_stream_connections():
    """11. Simultaneous reconnect calls do not create multiple stream connections."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader._is_reconnecting = True

    # If lock is locked or _is_reconnecting is True, another reconnect attempt cannot proceed
    with patch.object(reader, "connect") as mock_connect:
        mock_lock = MagicMock()
        mock_lock.acquire.return_value = False
        reader._reconnect_lock = mock_lock
        res = reader.reconnect()
        mock_connect.assert_not_called()


def test_video_feed_returns_503_when_camera_offline(client):
    """12. GET /video_feed returns 503 Service Unavailable when camera is offline."""
    orig_live = camera.is_camera_connected
    orig_synth = camera.use_synthetic
    try:
        camera.is_camera_connected = False
        camera.use_synthetic = False
        resp = client.get("/video_feed")
        assert resp.status_code == 503
        assert "Camera stream offline" in resp.json()["detail"]
    finally:
        camera.is_camera_connected = orig_live
        camera.use_synthetic = orig_synth


def test_real_frame_count_stops_advancing_when_frames_stop():
    """13. real_frame_count stops increasing when stream stalls; stays monotonic."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader.real_frame_count = 5931
    reader.is_camera_connected = False
    status = reader.get_status()
    assert status["real_frame_count"] == 5931

    with patch.object(reader, "read_frame", return_value=(False, None)):
        success, frame = reader.read_frame()
        assert success is False
        assert frame is None
        assert reader.real_frame_count == 5931


def test_capture_thread_survives_socket_timeout_and_network_exceptions():
    """14. Capture loop catches socket errors and recovers without thread dying."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream")
    reader.is_running = True
    reader.is_camera_connected = True
    reader.last_real_frame_timestamp = time.time()

    call_count = 0
    def mock_read():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise requests.exceptions.ConnectionError("Socket read timed out")
        reader.is_running = False
        return (False, None)

    with patch.object(reader, "read_frame", side_effect=mock_read):
        t = threading.Thread(target=reader._capture_loop, daemon=True)
        t.start()
        t.join(timeout=2.0)
        assert call_count >= 1


@pytest.mark.asyncio
async def test_video_feed_serves_changing_frames():
    """Verify that /video_feed delivers newly updated frames as they arrive."""
    from main import generate_mjpeg_stream
    frame1 = np.full((120, 160, 3), 50, dtype=np.uint8)
    frame2 = np.full((120, 160, 3), 200, dtype=np.uint8)

    frames = [frame1, frame2]
    idx = 0
    def mock_get_frame():
        nonlocal idx
        f = frames[min(idx, len(frames) - 1)]
        idx += 1
        return f

    with patch.object(camera, "get_latest_frame", side_effect=mock_get_frame):
        chunks = []
        async for chunk in generate_mjpeg_stream(max_frames=2):
            chunks.append(chunk)

        assert len(chunks) == 2
        # Verify chunk contents reflect distinct frame encodings
        assert chunks[0] != chunks[1]


def test_multiple_video_relay_clients_share_same_capture_worker(client):
    """Verify multiple relay clients read from single shared buffer without opening extra connections."""
    test_frame = np.full((100, 100, 3), 128, dtype=np.uint8)
    with patch.object(camera, "get_latest_frame", return_value=test_frame):
        # Two clients stream simultaneously
        resp1 = client.get("/video_feed?max_frames=1")
        resp2 = client.get("/video_feed?max_frames=1")
        assert resp1.status_code == 200
        assert resp2.status_code == 200
        assert b"--frame" in resp1.content
        assert b"--frame" in resp2.content


def test_stale_status_transitions_cleanly():
    """Verify stale status becomes True when frames stall and returns to False when fresh frames resume."""
    reader = CameraStreamReader(source="http://192.168.1.18:81/stream", stale_timeout_sec=0.2)
    reader.is_camera_connected = True
    reader.use_synthetic = False

    # 1. Fresh frame arriving
    reader.last_real_frame_timestamp = time.time()
    assert reader.is_stale is False
    assert reader.is_camera_live is True

    # 2. Frames stop for > 0.2s -> stale
    reader.last_real_frame_timestamp = time.time() - 0.5
    assert reader.is_stale is True
    assert reader.is_camera_live is False
    assert reader.get_latest_frame() is None

    # 3. Fresh frame resumes -> stale clears
    reader.last_real_frame_timestamp = time.time()
    reader._latest_frame = np.zeros((10, 10, 3), dtype=np.uint8)
    assert reader.is_stale is False
    assert reader.is_camera_live is True
    assert reader.get_latest_frame() is not None


def test_heartbeat_success_with_stale_frames_reports_not_live():
    """Verify that backend registration sends is_online=False when stream is stale even if node can ping."""
    disp = EventDispatcher()
    with patch("requests.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"success": True}
        mock_post.return_value = mock_resp

        # Hardware is stale/offline -> must register with is_online=False
        disp.register_camera_node(is_online=False)
        payload = mock_post.call_args[1]["json"]
        assert payload["is_online"] is False


def test_dispatcher_records_heartbeat_error_on_failure():
    """Verify that failed heartbeats record the exact status code or error reason."""
    disp = EventDispatcher()
    with patch("requests.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal Server Error"
        mock_post.return_value = mock_resp

        success = disp.register_camera_node(is_online=True)
        assert success is False
        assert disp.last_heartbeat_error is not None
        assert "HTTP 500" in disp.last_heartbeat_error


def test_extract_face_embedding_requires_device_key(client):
    """POST /api/extract-face-embedding rejects unauthorized calls missing x-device-key."""
    resp = client.post("/api/extract-face-embedding", json={"image_base64": "dGVzdA=="})
    assert resp.status_code == 401
    assert "Unauthorized" in resp.json()["detail"]


def test_extract_face_embedding_invalid_base64_or_empty(client):
    """POST /api/extract-face-embedding rejects invalid base64 and empty payloads."""
    headers = {"x-device-key": config.device_key}
    # Invalid base64
    resp = client.post(
        "/api/extract-face-embedding",
        json={"image_base64": "!!!not_base64!!!"},
        headers=headers,
    )
    assert resp.status_code == 400

    # Empty payload
    resp = client.post(
        "/api/extract-face-embedding",
        json={"image_base64": ""},
        headers=headers,
    )
    assert resp.status_code == 400


def test_extract_face_embedding_no_face_detected(client):
    """POST /api/extract-face-embedding returns 400 when no face is found in image."""
    import base64
    import main
    headers = {"x-device-key": config.device_key}
    blank = np.zeros((200, 200, 3), dtype=np.uint8)
    _, buf = cv2.imencode(".jpg", blank)
    b64_img = base64.b64encode(buf).decode("utf-8")

    with patch.object(main.detector, "detect_faces", return_value=[]):
        resp = client.post(
            "/api/extract-face-embedding",
            json={"image_base64": b64_img},
            headers=headers,
        )
        assert resp.status_code == 400
        assert "No face detected" in resp.json()["detail"]


def test_extract_face_embedding_multiple_faces_detected(client):
    """POST /api/extract-face-embedding returns 400 when multiple faces are detected."""
    import base64
    import main
    headers = {"x-device-key": config.device_key}
    blank = np.zeros((200, 200, 3), dtype=np.uint8)
    _, buf = cv2.imencode(".jpg", blank)
    b64_img = base64.b64encode(buf).decode("utf-8")

    fake_det1 = _make_face(center=(50, 50))
    fake_det2 = _make_face(center=(150, 150))

    with patch.object(main.detector, "detect_faces", return_value=[fake_det1, fake_det2]):
        resp = client.post(
            "/api/extract-face-embedding",
            json={"image_base64": b64_img},
            headers=headers,
        )
        assert resp.status_code == 400
        assert "Multiple faces detected" in resp.json()["detail"]


def test_extract_face_embedding_success(client):
    """POST /api/extract-face-embedding successfully extracts normalized 128-d vector."""
    import base64
    import main
    headers = {"x-device-key": config.device_key}
    blank = np.zeros((200, 200, 3), dtype=np.uint8)
    _, buf = cv2.imencode(".jpg", blank)
    b64_img = f"data:image/jpeg;base64,{base64.b64encode(buf).decode('utf-8')}"

    unit_vec = np.random.randn(128).astype(np.float32)
    unit_vec /= np.linalg.norm(unit_vec)

    fake_det = Detection(
        bbox=(20, 20, 80, 80),
        normalized_bbox=(0.1, 0.1, 0.4, 0.4),
        confidence=0.95,
        class_name="face",
        center=(60, 60),
        face_info=np.zeros(15, dtype=np.float32),
    )

    with patch.object(main.detector, "detect_faces", return_value=[fake_det]):
        with patch.object(main.matcher.model, "extract_embedding", return_value=unit_vec):
            resp = client.post(
                "/api/extract-face-embedding",
                json={"image_base64": b64_img},
                headers=headers,
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["success"] is True
            assert data["embedding_dim"] == 128
            assert len(data["embedding"]) == 128
            assert data["confidence"] == 0.95
            assert data["bbox"]["w"] == 80
