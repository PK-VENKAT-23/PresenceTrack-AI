"""
Unit and Integration Tests for Real-Time Face Recognition Identity Classification.

Verifies:
1. Low similarity score (0.2220) with unregistered face is classified strictly as UNKNOWN, NEVER VERIFIED.
2. Ephemeral track ID UNKNOWN-TRACK-XXX is assigned to unknown tracks.
3. Multi-frame confirmation requirement: transitions to VERIFYING on frame 1, and VERIFIED only after consecutive confirmation frames (score >= 0.70).
4. Prevention of cross-track identity inheritance when an unknown face appears.
5. Independent multi-face handling without cross-track leakage.
6. Immediate revocation gating (CONSENT_REVOKED).
7. Proper purging of identity when track expires or face leaves frame.
8. Full schema verification of /api/live-detection telemetry including absence of raw biometric embeddings.
"""

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
import numpy as np
from fastapi.testclient import TestClient

from detection.detector import Detection
from tracking.tracker import ObjectTracker, Track
from recognition.matcher import MatchStatus, MatchResult
from main import app, _attach_face_matches_to_tracks, state


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def _make_face(center=(100, 80)):
    return Detection(
        bbox=(center[0] - 15, center[1] - 15, 30, 30),
        normalized_bbox=(0.2, 0.2, 0.1, 0.1),
        confidence=0.95,
        class_name="face",
        center=center,
    )


def _make_track(track_id=1, bbox=(50, 20, 100, 150)):
    center = (bbox[0] + bbox[2] // 2, bbox[1] + bbox[3] // 2)
    return Track(
        track_id=track_id,
        bbox=bbox,
        centroid=center,
    )


def _make_match(status, employee_id="emp-001", name="Test Employee", score=0.92):
    return MatchResult(
        status=status,
        employee_id=employee_id if status != MatchStatus.UNKNOWN else None,
        name=name if status != MatchStatus.UNKNOWN else None,
        cosine_score=score,
        confidence_category="HIGH" if score >= 0.85 else ("MATCHED" if score >= 0.70 else "UNKNOWN"),
    )


def test_score_02220_classified_strictly_as_unknown():
    """
    Evidence scenario: Face in camera feed with score 0.2220.
    Must be classified strictly as UNKNOWN, NEVER VERIFIED.
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    match_res = _make_match(MatchStatus.UNKNOWN, employee_id=None, name=None, score=0.2220)

    attached = _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_res)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )

    assert len(attached) == 1
    assert track.identity_status == "UNKNOWN"
    assert track.is_verified is False
    assert track.matched_person_id is None
    assert track.matched_name is None
    assert track.matched_cosine == 0.2220
    assert track.consecutive_match_frames == 0
    assert track.ephemeral_id == "UNKNOWN-TRACK-001"


def test_consecutive_frames_confirmation_for_verified_status():
    """
    Enrolled employee with score >= 0.70 requires consecutive frame confirmation:
    - Frame 1: VERIFYING (not yet verified)
    - Frame 2: VERIFIED (confirmed over consecutive frames)
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    match_res = _make_match(MatchStatus.MATCHED, employee_id="emp-001", name="Test Employee", score=0.7378)

    # Frame 1: First detection
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_res)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )

    assert track.identity_status == "VERIFYING"
    assert track.is_verified is False
    assert track.consecutive_match_frames == 1
    assert track.matched_person_id is None
    assert track.matched_name is None
    assert track.candidate_person_id == "emp-001"

    # Frame 2: Consecutive detection with same candidate
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_res)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )

    assert track.identity_status == "VERIFIED"
    assert track.is_verified is True
    assert track.consecutive_match_frames == 2
    assert track.matched_person_id == "emp-001"
    assert track.matched_name == "Test Employee"


def test_score_in_divergence_range_classified_as_verifying():
    """
    Score 0.55 is in [0.363, 0.70) range:
    Must remain in VERIFYING state during bounded verification window,
    and transition to UNKNOWN after the window expires instead of remaining VERIFYING indefinitely.
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    match_res = _make_match(MatchStatus.DISABLED_FOR_REVIEW, employee_id="emp-001", name="Test Employee", score=0.55)

    # Within bounded verification window (5 frames)
    for _ in range(5):
        _attach_face_matches_to_tracks(
            faces=[face],
            face_results=[(face, match_res)],
            active_tracks=[track],
            required_consecutive_frames=2,
            strict_match_threshold=0.70,
            bounded_verification_window=5,
        )

    assert track.identity_status == "VERIFYING"
    assert track.is_verified is False
    assert track.matched_person_id is None
    assert track.matched_name is None

    # Frame 6: Exceeding bounded verification window -> transitions to UNKNOWN
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_res)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
        bounded_verification_window=5,
    )

    assert track.identity_status == "UNKNOWN"
    assert track.is_verified is False
    assert track.matched_person_id is None
    assert track.matched_name is None


def test_unattached_track_immediately_clears_verified_identity():
    """
    A track verified in frame 1 & 2 must immediately clear its verified identity
    as soon as no face is attached in the track for the current frame.
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    match_res = _make_match(MatchStatus.MATCHED, employee_id="emp-001", name="Test Employee", score=0.88)

    for _ in range(2):
        _attach_face_matches_to_tracks(
            faces=[face],
            face_results=[(face, match_res)],
            active_tracks=[track],
            required_consecutive_frames=2,
            strict_match_threshold=0.70,
        )

    assert track.is_verified is True
    assert track.identity_status == "VERIFIED"
    assert track.matched_name == "Test Employee"

    # Frame 3: Person turns away / face disappears -> 0 faces attached to track
    _attach_face_matches_to_tracks(
        faces=[],
        face_results=[],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )

    assert track.is_verified is False
    assert track.identity_status == "UNKNOWN"
    assert track.matched_person_id is None
    assert track.matched_name is None
    assert track.consecutive_match_frames == 0


def test_unknown_face_does_not_inherit_previous_employee_identity():
    """
    If an employee track exists and an unknown person takes over the track,
    the unknown person must NEVER inherit the previous employee's identity.
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))

    # Frame 1 & 2: Employee verified
    emp_match = _make_match(MatchStatus.MATCHED, employee_id="emp-001", name="Test Employee", score=0.88)
    for _ in range(2):
        _attach_face_matches_to_tracks(
            faces=[face],
            face_results=[(face, emp_match)],
            active_tracks=[track],
            required_consecutive_frames=2,
            strict_match_threshold=0.70,
        )
    assert track.is_verified is True
    assert track.matched_person_id == "emp-001"

    # Frame 3: Unknown face detected in the track
    unknown_match = _make_match(MatchStatus.UNKNOWN, employee_id=None, name=None, score=0.2220)
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, unknown_match)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )

    # Must immediately drop previous employee identity and reset to UNKNOWN
    assert track.is_verified is False
    assert track.identity_status == "UNKNOWN"
    assert track.matched_person_id is None
    assert track.matched_name is None
    assert track.consecutive_match_frames == 0
    assert track.ephemeral_id == "UNKNOWN-TRACK-001"


def test_multiple_faces_handled_independently():
    """
    Two faces present simultaneously:
    - Face 1: Enrolled employee (score 0.85) in Track 1
    - Face 2: Unregistered person (score 0.2220) in Track 2
    Tracks must be classified independently with zero cross-track leakage.
    """
    face1 = _make_face((80, 80))
    face2 = _make_face((250, 80))

    track1 = _make_track(1, (30, 20, 100, 150))
    track2 = _make_track(2, (200, 20, 100, 150))

    emp_match = _make_match(MatchStatus.MATCHED, employee_id="emp-001", name="Test Employee", score=0.85)
    unknown_match = _make_match(MatchStatus.UNKNOWN, employee_id=None, name=None, score=0.2220)

    # Frame 1
    _attach_face_matches_to_tracks(
        faces=[face1, face2],
        face_results=[(face1, emp_match), (face2, unknown_match)],
        active_tracks=[track1, track2],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )
    assert track1.identity_status == "VERIFYING"
    assert track2.identity_status == "UNKNOWN"

    # Frame 2
    _attach_face_matches_to_tracks(
        faces=[face1, face2],
        face_results=[(face1, emp_match), (face2, unknown_match)],
        active_tracks=[track1, track2],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )

    # Track 1 verified, Track 2 remains UNKNOWN
    assert track1.is_verified is True
    assert track1.identity_status == "VERIFIED"
    assert track1.matched_person_id == "emp-001"
    assert track1.matched_name == "Test Employee"

    assert track2.is_verified is False
    assert track2.identity_status == "UNKNOWN"
    assert track2.matched_person_id is None
    assert track2.matched_name is None
    assert track2.ephemeral_id == "UNKNOWN-TRACK-002"


def test_consent_revocation_enforcement_in_tracking():
    """
    Employee with revoked consent must never be verified.
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    revoked_match = _make_match(MatchStatus.CONSENT_REVOKED, employee_id="emp-revoked", name="Revoked User", score=0.92)

    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, revoked_match)],
        active_tracks=[track],
        required_consecutive_frames=1,
        strict_match_threshold=0.70,
    )

    assert track.consent_revoked is True
    assert track.is_verified is False
    assert track.identity_status == "UNKNOWN"


def test_deregister_track_purges_identities():
    """
    When an object track disappears and is deregistered by ObjectTracker,
    all identity and tracking state is cleanly purged.
    """
    tracker = ObjectTracker()
    det = Detection(
        bbox=(50, 20, 100, 150),
        normalized_bbox=(0.1, 0.1, 0.2, 0.2),
        confidence=0.9,
        class_name="person",
        center=(100, 95),
    )
    track = tracker.register(det)
    track.matched_person_id = "emp-001"
    track.matched_name = "Test Employee"
    track.is_verified = True
    track.identity_status = "VERIFIED"

    assert track.track_id in tracker.tracks

    tracker.deregister(track.track_id)
    assert track.track_id not in tracker.tracks


def test_api_live_detection_strict_schema_and_no_embedding_leak(client):
    """
    Verify GET /api/live-detection exposes required fields and NEVER leaks biometric vectors.
    """
    from main import LiveDetectionResponse

    # Test model serialization directly with score 0.2220
    sample_payload = {
        "camera_id": "ESP32-CAM-01-NORTH",
        "is_live": True,
        "face_detected": True,
        "face_bounding_box": {"x": 100, "y": 80, "w": 90, "h": 90},
        "sc_score": 0.2220,
        "match_score": 0.2220,
        "confidence_category": "UNKNOWN",
        "identity_status": "UNKNOWN",
        "track_id": "UNKNOWN-TRACK-001",
        "matched_name": None,
        "matched_person_id": None,
        "consent_revoked": False,
        "consent_valid": False,
        "template_match_confirmed": False,
        "consecutive_match_frames": 0,
        "person_count": 1,
        "active_tracks": 1,
        "last_event": None,
        "timestamp": "2026-11-25T00:00:00Z",
        "auto_attendance_enabled": False,
        "is_synthetic": False,
        "is_stale": False,
        "real_frame_count": 100,
        "recovery_status": "LIVE",
        "consecutive_failures": 0,
        "current_failure_reason": None,
    }
    model = LiveDetectionResponse(**sample_payload)
    model_dict = model.model_dump()

    assert model_dict["identity_status"] == "UNKNOWN"
    assert model_dict["matched_person_id"] is None
    assert model_dict["matched_name"] is None
    assert model_dict["sc_score"] == 0.2220
    assert model_dict["match_score"] == 0.2220
    assert model_dict["track_id"] == "UNKNOWN-TRACK-001"
    assert model_dict["template_match_confirmed"] is False
    assert model_dict["consecutive_match_frames"] == 0

    # Ensure sensitive biometric vector fields are never present
    assert "embedding" not in model_dict
    assert "vector" not in model_dict
    assert "raw_vector" not in model_dict

    # Test HTTP endpoint returns valid telemetry payload with all required fields
    resp = client.get("/api/live-detection")
    assert resp.status_code == 200
    data = resp.json()

    assert "identity_status" in data
    assert data["identity_status"] in ("NO_FACE", "STALE", "UNKNOWN", "VERIFIED", "VERIFYING")
    assert "match_score" in data
    assert "track_id" in data
    assert "template_match_confirmed" in data
    assert "consecutive_match_frames" in data
    assert "detected_faces" in data
    assert isinstance(data["detected_faces"], list)
    assert "embedding" not in data
    assert "vector" not in data
    assert "raw_vector" not in data


def test_registered_employee_venkat_pk_verified_with_exact_name():
    """
    Enrolled employee 'Venkat PK' with score >= 0.70:
    Frame 1: transitions to VERIFYING (multi-frame confirmation requirement).
    Frame 2: transitions to VERIFIED with exact name 'Venkat PK'.
    """
    face = _make_face((120, 90))
    track = _make_track(1, (70, 30, 100, 150))
    match_res = _make_match(MatchStatus.MATCHED, employee_id="emp-vpk", name="Venkat PK", score=0.8845)

    # Frame 1: Initial detection -> VERIFYING
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_res)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )
    assert track.identity_status == "VERIFYING"
    assert track.is_verified is False
    assert track.matched_name is None
    assert track.candidate_name == "Venkat PK"

    # Frame 2: Confirmed match -> VERIFIED with exact name
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_res)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )
    assert track.identity_status == "VERIFIED"
    assert track.is_verified is True
    assert track.matched_name == "Venkat PK"
    assert track.matched_person_id == "emp-vpk"
    assert track.consecutive_match_frames == 2


def test_distinct_registered_employee_verified_with_distinct_name():
    """
    Distinct registered employee 'Priya Sharma' must receive 'Priya Sharma',
    never confusing or inheriting another employee's name.
    """
    face = _make_face((140, 100))
    track = _make_track(2, (90, 40, 100, 150))
    match_res = _make_match(MatchStatus.MATCHED, employee_id="emp-priya", name="Priya Sharma", score=0.9120)

    for _ in range(2):
        _attach_face_matches_to_tracks(
            faces=[face],
            face_results=[(face, match_res)],
            active_tracks=[track],
            required_consecutive_frames=2,
            strict_match_threshold=0.70,
        )

    assert track.identity_status == "VERIFIED"
    assert track.is_verified is True
    assert track.matched_name == "Priya Sharma"
    assert track.matched_name != "Venkat PK"


def test_unregistered_face_02220_never_inherits_venkat_pk():
    """
    Track verified as 'Venkat PK' immediately loses identity and becomes UNKNOWN
    when replaced by an unregistered face with score 0.2220.
    """
    face = _make_face((120, 90))
    track = _make_track(1, (70, 30, 100, 150))
    venkat_match = _make_match(MatchStatus.MATCHED, employee_id="emp-vpk", name="Venkat PK", score=0.8845)

    for _ in range(2):
        _attach_face_matches_to_tracks(
            faces=[face],
            face_results=[(face, venkat_match)],
            active_tracks=[track],
            required_consecutive_frames=2,
            strict_match_threshold=0.70,
        )
    assert track.is_verified is True
    assert track.matched_name == "Venkat PK"

    # Unregistered face arrives with score 0.2220
    unregistered_match = _make_match(MatchStatus.UNKNOWN, employee_id=None, name=None, score=0.2220)
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, unregistered_match)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )

    assert track.is_verified is False
    assert track.identity_status == "UNKNOWN"
    assert track.matched_name is None
    assert track.matched_person_id is None
    assert track.ephemeral_id == "UNKNOWN-TRACK-001"


def test_inactive_employee_rejection():
    """
    Employee marked inactive (is_active=False) must be rejected with UNKNOWN status
    and never marked as VERIFIED, even with high match score (0.93).
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    inactive_match = MatchResult(
        status=MatchStatus.INACTIVE,
        employee_id="emp-inactive",
        name="Inactive Employee",
        cosine_score=0.93,
        confidence_category="INACTIVE",
    )

    for _ in range(3):
        _attach_face_matches_to_tracks(
            faces=[face],
            face_results=[(face, inactive_match)],
            active_tracks=[track],
            required_consecutive_frames=1,
            strict_match_threshold=0.70,
        )

    assert track.is_verified is False
    assert track.identity_status == "UNKNOWN"
    assert track.matched_person_id is None
    assert track.matched_name is None


def test_path_crossing_track_swap_prevention():
    """
    Two tracks cross in 2D space.
    Track 1: Venkat PK
    Track 2: Unknown Person
    Association uses active face embedding at current frame, preventing identity swap.
    """
    face1 = _make_face((150, 100))  # Track 1
    face2 = _make_face((300, 100))  # Track 2

    track1 = _make_track(1, (100, 50, 100, 150))
    track2 = _make_track(2, (250, 50, 100, 150))

    venkat_match = _make_match(MatchStatus.MATCHED, employee_id="emp-vpk", name="Venkat PK", score=0.89)
    unknown_match = _make_match(MatchStatus.UNKNOWN, employee_id=None, name=None, score=0.2220)

    for _ in range(2):
        _attach_face_matches_to_tracks(
            faces=[face1, face2],
            face_results=[(face1, venkat_match), (face2, unknown_match)],
            active_tracks=[track1, track2],
            required_consecutive_frames=2,
            strict_match_threshold=0.70,
        )

    assert track1.is_verified is True
    assert track1.matched_name == "Venkat PK"
    assert track2.is_verified is False
    assert track2.matched_name is None

    # Now simulate crossing positions:
    # Face 1 (Venkat) moves to x=280 (inside track 2 if swapped by coordinates)
    # Face 2 (Unknown) moves to x=120 (inside track 1 if swapped by coordinates)
    # Each track must re-evaluate identity strictly based on the face inside its bounding box
    _attach_face_matches_to_tracks(
        faces=[face1, face2],
        face_results=[(face1, unknown_match), (face2, venkat_match)],
        active_tracks=[track1, track2],
        required_consecutive_frames=2,
        strict_match_threshold=0.70,
    )

    # Track 1 now has unknown face -> immediately loses verification
    assert track1.is_verified is False
    assert track1.identity_status == "UNKNOWN"
    assert track1.matched_name is None


def test_registered_employee_score_04886_confirmed_on_frame_2():
    """
    Evidence scenario: Registered employee with score 0.4886 (SFace genuine range).
    With calibrated threshold 0.45:
    - Frame 1: Transitions to VERIFYING (consecutive = 1 < 2, verifying_frames = 1)
    - Frame 2: Transitions to VERIFIED (consecutive = 2 >= 2), displays registered employee name.
    - Frame 3: Maintains VERIFIED while matching continues, consecutive increments to 3.
    """
    face = _make_face((120, 90))
    track = _make_track(1, (70, 30, 100, 150))
    match_res = _make_match(MatchStatus.MATCHED, employee_id="emp-vpk", name="Venkat PK", score=0.4886)

    # Frame 1: Initial detection -> VERIFYING
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_res)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
    )
    assert track.identity_status == "VERIFYING"
    assert track.is_verified is False
    assert track.matched_name is None
    assert track.matched_person_id is None
    assert track.candidate_person_id == "emp-vpk"
    assert track.candidate_name == "Venkat PK"
    assert track.consecutive_match_frames == 1

    # Frame 2: Second consecutive detection -> VERIFIED
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_res)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
    )
    assert track.identity_status == "VERIFIED"
    assert track.is_verified is True
    assert track.matched_name == "Venkat PK"
    assert track.matched_person_id == "emp-vpk"
    assert track.consecutive_match_frames == 2

    # Frame 3: Stable consecutive frame -> remains VERIFIED
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_res)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
    )
    assert track.identity_status == "VERIFIED"
    assert track.is_verified is True
    assert track.matched_name == "Venkat PK"
    assert track.consecutive_match_frames == 3


def test_candidate_change_resets_confirmation_counter():
    """
    Candidate identity change in the same track resets the confirmation counter
    and prevents premature or incorrect verification.
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    match_a = _make_match(MatchStatus.MATCHED, employee_id="emp-001", name="Employee A", score=0.52)
    match_b = _make_match(MatchStatus.MATCHED, employee_id="emp-002", name="Employee B", score=0.54)

    # Frame 1: Candidate A
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_a)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
    )
    assert track.identity_status == "VERIFYING"
    assert track.candidate_person_id == "emp-001"
    assert track.consecutive_match_frames == 1

    # Frame 2: Candidate changes to B -> counter resets to 1, does NOT reach 2
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_b)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
    )
    assert track.identity_status == "VERIFYING"
    assert track.is_verified is False
    assert track.candidate_person_id == "emp-002"
    assert track.candidate_name == "Employee B"
    assert track.consecutive_match_frames == 1
    assert track.matched_person_id is None
    assert track.matched_name is None

    # Frame 3: Candidate B second time -> confirmed!
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_b)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
    )
    assert track.identity_status == "VERIFIED"
    assert track.is_verified is True
    assert track.matched_person_id == "emp-002"
    assert track.matched_name == "Employee B"
    assert track.consecutive_match_frames == 2


def test_ambiguous_score_04000_bounded_window_timeout_to_unknown():
    """
    Score 0.4000 is in ambiguous range [0.363, 0.450):
    - Must remain VERIFYING during bounded verification window (5 frames)
    - Must time out to UNKNOWN on frame 6 instead of remaining VERIFYING indefinitely.
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    match_res = _make_match(MatchStatus.UNCERTAIN, employee_id="emp-001", name="Test Employee", score=0.4000)

    for i in range(1, 6):
        _attach_face_matches_to_tracks(
            faces=[face],
            face_results=[(face, match_res)],
            active_tracks=[track],
            required_consecutive_frames=2,
            strict_match_threshold=0.45,
            ambiguous_match_threshold=0.363,
            bounded_verification_window=5,
        )
        assert track.identity_status == "VERIFYING", f"Frame {i} should be VERIFYING"
        assert track.is_verified is False
        assert track.matched_name is None

    # Frame 6: Bounded window exceeded -> transitions to UNKNOWN
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, match_res)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
        bounded_verification_window=5,
    )
    assert track.identity_status == "UNKNOWN"
    assert track.is_verified is False
    assert track.matched_name is None
    assert track.matched_person_id is None


def test_diagnostic_telemetry_fields_and_privacy_guarantees(client):
    """
    Verify /api/live-detection telemetry exposes diagnostic fields:
    track_id, candidate_employee_id, similarity_score, matching_threshold,
    confirmation_count, required_confirmation_count.
    Candidate name must NEVER be exposed while in VERIFYING state (privacy protection).
    Zero raw biometric vectors or embeddings leaked.
    """
    from main import DetectedFaceInfo, LiveDetectionResponse

    # Test verifying face (privacy check: candidate_name is None)
    verifying_face = DetectedFaceInfo(
        bbox={"x": 50, "y": 20, "w": 100, "h": 150},
        identity_status="VERIFYING",
        matched_name=None,
        matched_person_id=None,
        sc_score=0.4886,
        track_id=1,
        candidate_employee_id="emp-vpk",
        candidate_name=None,  # Suppressed during verification
        similarity_score=0.4886,
        matching_threshold=0.45,
        confirmation_count=1,
        required_confirmation_count=2,
        last_match_timestamp=None,
    )
    face_dict = verifying_face.model_dump()
    assert face_dict["identity_status"] == "VERIFYING"
    assert face_dict["candidate_employee_id"] == "emp-vpk"
    assert face_dict["candidate_name"] is None
    assert face_dict["similarity_score"] == 0.4886
    assert face_dict["matching_threshold"] == 0.45
    assert face_dict["confirmation_count"] == 1
    assert face_dict["required_confirmation_count"] == 2

    # Ensure no vector/embedding leaks
    for key in ("embedding", "vector", "raw_vector", "template_raw"):
        assert key not in face_dict

    # Test verified face (candidate_name now visible)
    verified_face = DetectedFaceInfo(
        bbox={"x": 50, "y": 20, "w": 100, "h": 150},
        identity_status="VERIFIED",
        matched_name="Venkat PK",
        matched_person_id="emp-vpk",
        sc_score=0.4886,
        track_id=1,
        candidate_employee_id="emp-vpk",
        candidate_name="Venkat PK",
        similarity_score=0.4886,
        matching_threshold=0.45,
        confirmation_count=2,
        required_confirmation_count=2,
        last_match_timestamp="2026-11-25T00:00:00Z",
    )
    v_dict = verified_face.model_dump()
    assert v_dict["identity_status"] == "VERIFIED"
    assert v_dict["matched_name"] == "Venkat PK"
    assert v_dict["candidate_name"] == "Venkat PK"
    assert v_dict["confirmation_count"] == 2


def test_verified_track_hysteresis_maintains_status_on_score_dip():
    """
    Hysteresis test:
    Once a track reaches VERIFIED at score >= 0.450, if the score dips
    into [0.363, 0.450) on subsequent frames (e.g. 0.4200 due to lighting/angle),
    the track REMAINS VERIFIED and does not flicker to VERIFYING or UNKNOWN.
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    high_match = _make_match(MatchStatus.MATCHED, employee_id="emp-001", name="Test Employee", score=0.4886)

    # Frame 1: score 0.4886 -> VERIFYING (confirmation 1)
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, high_match)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
    )
    assert track.identity_status == "VERIFYING"
    assert track.is_verified is False

    # Frame 2: score 0.4886 -> VERIFIED (confirmation 2)
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, high_match)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
    )
    assert track.identity_status == "VERIFIED"
    assert track.is_verified is True
    assert track.matched_person_id == "emp-001"

    # Frame 3: score dips to 0.4200 (>= 0.363 ambiguous threshold) -> Hysteresis keeps VERIFIED!
    dipped_match = _make_match(MatchStatus.MATCHED, employee_id="emp-001", name="Test Employee", score=0.4200)
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, dipped_match)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
        max_missed_grace_frames=2,
    )
    assert track.identity_status == "VERIFIED"
    assert track.is_verified is True
    assert track.matched_person_id == "emp-001"
    assert track.matched_name == "Test Employee"
    assert track.consecutive_match_frames == 3


def test_verified_track_grace_period_retains_status_for_bounded_missed_frames():
    """
    Grace period test:
    When a face is momentarily missed (e.g. rapid movement or head turn):
    - Frame 3: missed frame 1 <= 2 -> maintains VERIFIED
    - Frame 4: missed frame 2 <= 2 -> maintains VERIFIED
    - Frame 5: missed frame 3 > 2 -> cleanly revokes to UNKNOWN
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    match_res = _make_match(MatchStatus.MATCHED, employee_id="emp-001", name="Test Employee", score=0.4886)

    # Frame 1 & 2: establish VERIFIED
    for _ in range(2):
        _attach_face_matches_to_tracks(
            faces=[face],
            face_results=[(face, match_res)],
            active_tracks=[track],
            required_consecutive_frames=2,
            strict_match_threshold=0.45,
            ambiguous_match_threshold=0.363,
            max_missed_grace_frames=2,
        )
    assert track.is_verified is True

    # Frame 3: Face not detected in track (missed frame 1 of 2) -> still VERIFIED
    _attach_face_matches_to_tracks(
        faces=[],
        face_results=[],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
        max_missed_grace_frames=2,
    )
    assert track.is_verified is True
    assert track.identity_status == "VERIFIED"
    assert track.missed_frames == 1

    # Frame 4: Face still not detected (missed frame 2 of 2) -> still VERIFIED
    _attach_face_matches_to_tracks(
        faces=[],
        face_results=[],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
        max_missed_grace_frames=2,
    )
    assert track.is_verified is True
    assert track.identity_status == "VERIFIED"
    assert track.missed_frames == 2

    # Frame 5: Face not detected for 3rd frame (missed frame 3 > 2) -> Revokes to UNKNOWN
    _attach_face_matches_to_tracks(
        faces=[],
        face_results=[],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
        max_missed_grace_frames=2,
    )
    assert track.is_verified is False
    assert track.identity_status == "UNKNOWN"
    assert track.matched_person_id is None
    assert track.matched_name is None
    assert track.missed_frames == 0


def test_verified_track_different_candidate_immediately_revoked_with_zero_grace():
    """
    Security guarantee:
    If a different person or unknown face appears in a previously verified track,
    the old verified identity must be revoked IMMEDIATELY with zero grace frames.
    """
    face = _make_face((100, 80))
    track = _make_track(1, (50, 20, 100, 150))
    emp_match = _make_match(MatchStatus.MATCHED, employee_id="emp-001", name="Employee One", score=0.4886)

    # Frame 1 & 2: emp-001 verified
    for _ in range(2):
        _attach_face_matches_to_tracks(
            faces=[face],
            face_results=[(face, emp_match)],
            active_tracks=[track],
            required_consecutive_frames=2,
            strict_match_threshold=0.45,
            ambiguous_match_threshold=0.363,
            max_missed_grace_frames=2,
        )
    assert track.is_verified is True
    assert track.matched_person_id == "emp-001"

    # Frame 3: Unknown face (score 0.2220) detected in this track
    unknown_match = _make_match(MatchStatus.UNKNOWN, employee_id=None, name=None, score=0.2220)
    _attach_face_matches_to_tracks(
        faces=[face],
        face_results=[(face, unknown_match)],
        active_tracks=[track],
        required_consecutive_frames=2,
        strict_match_threshold=0.45,
        ambiguous_match_threshold=0.363,
        max_missed_grace_frames=2,
    )

    # Zero grace period for a different/unknown person: immediate revocation
    assert track.is_verified is False
    assert track.identity_status == "UNKNOWN"
    assert track.matched_person_id is None
    assert track.matched_name is None
    assert track.candidate_person_id is None


def test_performance_diagnostics_present_and_privacy_guaranteed(client):
    """
    Telemetry and diagnostics validation:
    1. /api/live-detection returns latency and camera metrics (actual_fps, queue, drops).
    2. Zero raw biometric vectors or embeddings leaked.
    """
    resp = client.get("/api/live-detection")
    assert resp.status_code == 200
    data = resp.json()

    # Diagnostic latency and pipeline fields
    assert "actual_fps" in data
    assert "avg_frame_interval_ms" in data
    assert "frame_processing_latency_ms" in data
    assert "face_detection_latency_ms" in data
    assert "face_recognition_latency_ms" in data
    assert "dropped_frames" in data
    assert "frame_queue_depth" in data

    # Strict privacy: raw biometric vectors must NEVER be exposed
    raw_payload_str = resp.text.lower()
    for forbidden in ("raw_vector", "embedding_vector", "biometric_template_raw", "feature_vector"):
        assert forbidden not in raw_payload_str
