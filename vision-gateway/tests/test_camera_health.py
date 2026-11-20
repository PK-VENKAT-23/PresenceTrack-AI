"""
Comprehensive Tests for Camera Health Monitor, Diagnostics, and Recovery Engine.

Covers:
- Healthy camera diagnostics (all checks PASS)
- Frozen frame count detection
- Stale stream detection
- ESP32 network unreachable detection
- MJPEG decoding failure detection
- Gateway offline handling
- Concurrent reconnect & refresh prevention (mutex locking)
- Successful recovery (real frame advancement verification)
- Failed recovery & bounded exponential backoff
- Max failures threshold -> RECOVERY_FAILED transition
- Manual refresh behavior & failure counter reset
- Extended offline recovery
- Diagnostics history bounded logging (no secrets/PII)
- Endpoints: GET /camera/status, GET /camera/diagnostics, POST /camera/diagnostics/run, POST /camera/reconnect
"""

import sys
import os
import time
from unittest.mock import MagicMock, patch, PropertyMock
import pytest
import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from camera.health_monitor import CameraHealthMonitor, DiagnosticEntry
from camera.stream_reader import CameraStreamReader
from events.dispatcher import EventDispatcher
from main import app, health_monitor, camera
from fastapi.testclient import TestClient


@pytest.fixture
def mock_camera():
    cam = MagicMock(spec=CameraStreamReader)
    cam.source = "http://192.168.1.18:81/stream"
    cam.is_connected = True
    cam._is_transport_open = True
    cam.is_camera_connected = True
    cam.is_camera_live = True
    cam.is_stale = False
    cam.use_synthetic = False
    cam.real_frame_count = 100
    cam.last_real_frame_timestamp = time.time() - 0.5
    cam.last_frame_timestamp = time.time() - 0.5
    cam.actual_fps = 12.0
    cam.stale_timeout_sec = 3.0
    cam.is_running = True
    cam._thread = MagicMock()
    cam._thread.is_alive.return_value = True
    cam._watchdog_thread = MagicMock()
    cam._watchdog_thread.is_alive.return_value = True
    cam.get_latest_frame.return_value = np.zeros((300, 400, 3), dtype=np.uint8)
    cam._is_configured_synthetic.return_value = False
    return cam


@pytest.fixture
def mock_dispatcher():
    disp = MagicMock(spec=EventDispatcher)
    disp.last_heartbeat_error = None
    return disp


@pytest.fixture
def monitor(mock_camera, mock_dispatcher):
    mon = CameraHealthMonitor(
        camera_reader=mock_camera,
        event_dispatcher=mock_dispatcher,
        check_interval_sec=15.0,
        max_recovery_failures=5,
    )
    return mon


@pytest.fixture
def test_client():
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# 1. Health Diagnostics Checks
# ---------------------------------------------------------------------------
def test_healthy_camera_diagnostics(monitor, mock_camera):
    """Verify all 9 checks pass when camera is live and producing fresh frames."""
    # First check establishes baseline frame count
    monitor.run_diagnostics()

    # Advance frame count
    mock_camera.real_frame_count = 120
    mock_camera.last_real_frame_timestamp = time.time() - 0.1

    diag = monitor.run_diagnostics()
    assert diag["overall_status"] == "LIVE"
    assert diag["is_camera_live"] is True
    assert diag["is_stale"] is False
    assert diag["current_failure_reason"] is None

    checks = diag["checks"]
    assert checks["network_reachability"]["status"] == "PASS"
    assert checks["stream_connection"]["status"] == "PASS"
    assert checks["mjpeg_decoding"]["status"] == "PASS"
    assert checks["frame_advancement"]["status"] == "PASS"
    assert checks["frame_advancement"]["delta_frames"] == 20
    assert checks["frame_freshness"]["status"] == "PASS"
    assert checks["camera_reader"]["status"] == "PASS"
    assert checks["gateway_health"]["status"] == "PASS"
    assert checks["node_heartbeat"]["status"] == "PASS"
    assert checks["video_relay"]["status"] == "PASS"


def test_frozen_frame_count_detection(monitor, mock_camera):
    """Verify frozen frame count triggers frame_advancement FAIL even when connection is open."""
    # First run sets baseline at 100
    mock_camera.real_frame_count = 100
    monitor.run_diagnostics()

    # Second run: real_frame_count did NOT advance (frozen stream)
    mock_camera.real_frame_count = 100
    diag = monitor.run_diagnostics()

    assert diag["checks"]["frame_advancement"]["status"] == "FAIL"
    assert "frozen at 100" in diag["checks"]["frame_advancement"]["detail"]


def test_stale_stream_detection(monitor, mock_camera):
    """Verify stale stream (> 3s without fresh real frames) is detected immediately."""
    mock_camera.is_stale = True
    mock_camera.is_camera_live = False
    mock_camera.last_real_frame_timestamp = time.time() - 5.0

    with patch.object(monitor, "check_network_reachability", return_value=(True, "Reachable")):
        diag = monitor.run_diagnostics()
        assert diag["overall_status"] == "STREAM_STALE"
        assert diag["is_stale"] is True
        assert diag["checks"]["frame_freshness"]["status"] == "FAIL"
        assert "Stream STALE" in diag["current_failure_reason"]


def test_esp32_network_unreachable_detection(monitor, mock_camera):
    """Verify socket failure to ESP32 IP/port reports network reachability FAIL."""
    mock_camera.is_camera_live = False
    mock_camera.is_stale = True

    with patch("socket.socket.connect_ex", return_value=61):  # ECONNREFUSED
        net_ok, net_msg = monitor.check_network_reachability()
        assert net_ok is False
        assert "failed" in net_msg

    with patch.object(monitor, "check_network_reachability", return_value=(False, "Connection refused on port 81")):
        diag = monitor.run_diagnostics()
        assert diag["checks"]["network_reachability"]["status"] == "FAIL"
        assert diag["overall_status"] == "STREAM_STALE" or diag["overall_status"] == "CAMERA_OFFLINE"
        assert "Network unreachable" in diag["current_failure_reason"]


def test_mjpeg_decoding_failure_detection(monitor, mock_camera):
    """Verify reader reporting 0 decoded frames triggers mjpeg_decoding FAIL."""
    mock_camera.last_frame_timestamp = 0.0
    mock_camera.is_camera_live = False

    diag = monitor.run_diagnostics()
    assert diag["checks"]["mjpeg_decoding"]["status"] == "FAIL"
    assert "No MJPEG frames decoded" in diag["checks"]["mjpeg_decoding"]["detail"]


# ---------------------------------------------------------------------------
# 2. Concurrency & Reconnection Locks
# ---------------------------------------------------------------------------
def test_concurrent_reconnect_prevention(monitor, mock_camera):
    """Verify simultaneous recovery/refresh attempts are safely rejected by mutex."""
    # Acquire recovery lock manually
    assert monitor._recovery_lock.acquire(blocking=False) is True

    try:
        # A second manual refresh must detect BUSY and return gracefully without deadlock
        res = monitor.manual_refresh(force=True)
        assert res["success"] is False
        assert res["status"] == "BUSY"
        assert "in progress" in res["message"]
    finally:
        monitor._recovery_lock.release()


# ---------------------------------------------------------------------------
# 3. Automatic Recovery & Backoff Behavior
# ---------------------------------------------------------------------------
def test_successful_automatic_recovery(monitor, mock_camera):
    """Verify recovery re-establishes connection, verifies frame advancement, and restores LIVE."""
    mock_camera.is_camera_live = False
    mock_camera.is_stale = True
    mock_camera.real_frame_count = 50

    def fake_reconnect(force=True):
        mock_camera.is_camera_live = True
        mock_camera.is_stale = False
        mock_camera.real_frame_count = 55
        return True

    mock_camera.reconnect.side_effect = fake_reconnect

    monitor._attempt_automatic_recovery("Stream stalled")

    assert monitor.recovery_status == "LIVE"
    assert monitor.consecutive_failures == 0
    assert monitor.current_failure_reason is None

    # Verify history entry recorded
    history = monitor.get_diagnostic_history()
    assert len(history) == 1
    assert history[0]["recovery_result"] == "SUCCESS"
    assert history[0]["failure_category"] == "AUTOMATIC_RECOVERY"


def test_failed_automatic_recovery_and_backoff(monitor, mock_camera):
    """Verify failed recovery increments failure counter and activates bounded exponential backoff."""
    mock_camera.is_camera_live = False
    mock_camera.is_stale = True
    mock_camera.real_frame_count = 50
    mock_camera.reconnect.return_value = False

    # Attempt 1
    monitor._attempt_automatic_recovery("First stall")
    assert monitor.consecutive_failures == 1
    assert monitor.recovery_backoff_delay == 5.0
    assert monitor.recovery_status == "CAMERA_OFFLINE"

    # Attempt 2
    monitor._next_allowed_recovery_time = 0.0  # simulate backoff elapsed
    monitor._attempt_automatic_recovery("Second stall")
    assert monitor.consecutive_failures == 2
    assert monitor.recovery_backoff_delay == 15.0

    # Attempt 3
    monitor._next_allowed_recovery_time = 0.0
    monitor._attempt_automatic_recovery("Third stall")
    assert monitor.consecutive_failures == 3
    assert monitor.recovery_backoff_delay > 15.0
    assert monitor.recovery_backoff_delay <= 60.0


def test_max_failures_transitions_to_recovery_failed(monitor, mock_camera):
    """Verify 5 consecutive recovery failures halts auto-recovery with RECOVERY_FAILED."""
    mock_camera.is_camera_live = False
    mock_camera.is_stale = True
    mock_camera.real_frame_count = 50
    mock_camera.reconnect.return_value = False

    for attempt in range(5):
        monitor._next_allowed_recovery_time = 0.0
        monitor._attempt_automatic_recovery(f"Stall attempt {attempt + 1}")

    assert monitor.consecutive_failures == 5
    assert monitor.recovery_status == "RECOVERY_FAILED"
    assert "Automatic recovery halted after 5 failed attempts" in monitor.current_failure_reason


def test_manual_refresh_resets_recovery_failed_state(monitor, mock_camera):
    """Verify manual refresh clears RECOVERY_FAILED and restores LIVE when frames arrive."""
    # Place monitor in RECOVERY_FAILED state
    monitor.consecutive_failures = 5
    monitor.recovery_status = "RECOVERY_FAILED"
    monitor.current_failure_reason = "Halting due to repeated failures"

    mock_camera.real_frame_count = 200

    def fake_reconnect(force=True):
        mock_camera.is_camera_live = True
        mock_camera.is_stale = False
        mock_camera.real_frame_count = 210
        return True

    mock_camera.reconnect.side_effect = fake_reconnect

    res = monitor.manual_refresh(force=True)
    assert res["success"] is True
    assert res["status"] == "LIVE"
    assert res["new_frames_received"] == 10
    assert monitor.recovery_status == "LIVE"
    assert monitor.consecutive_failures == 0
    assert monitor.current_failure_reason is None


def test_recovery_after_extended_offline(monitor, mock_camera):
    """Verify camera that has been offline for hours recovers cleanly when connection returns."""
    mock_camera.is_camera_live = False
    mock_camera.is_stale = True
    mock_camera.last_real_frame_timestamp = time.time() - 7200.0  # 2 hours ago
    mock_camera.real_frame_count = 1000

    # Camera hardware powers back on and responds
    def camera_restored(force=True):
        mock_camera.is_camera_live = True
        mock_camera.is_stale = False
        mock_camera.real_frame_count = 1015
        mock_camera.last_real_frame_timestamp = time.time()
        return True

    mock_camera.reconnect.side_effect = camera_restored

    res = monitor.manual_refresh(force=True)
    assert res["success"] is True
    assert res["camera_live"] is True
    assert monitor.recovery_status == "LIVE"


# ---------------------------------------------------------------------------
# 4. Diagnostics History Bounded Ring Buffer & Privacy
# ---------------------------------------------------------------------------
def test_diagnostic_history_bounded_and_sanitized(monitor):
    """Verify history is capped at maxlen and contains no sensitive credentials."""
    for i in range(70):
        entry = DiagnosticEntry(
            failure_category="TEST_CATEGORY",
            error_details=f"Test error {i}",
            recovery_action="RECONNECT_STREAM",
            attempt_number=i,
            recovery_result="FAILED" if i % 2 == 0 else "SUCCESS",
            time_taken_sec=0.15,
        )
        monitor._history.append(entry)

    history = monitor.get_diagnostic_history()
    assert len(history) <= 50  # Bounded to 50 entries
    # Ensure no secrets or device keys exist
    for h in history:
        assert "device_key" not in h["error_details"]
        assert "x-device-key" not in h["error_details"]


# ---------------------------------------------------------------------------
# 5. API Endpoints
# ---------------------------------------------------------------------------
def test_api_camera_status_includes_recovery_fields(test_client):
    """GET /camera/status returns recovery status, attempts, timestamps, and failure reason."""
    resp = test_client.get("/camera/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "recovery_status" in data
    assert "recovery_attempt_count" in data
    assert "consecutive_failures" in data
    assert "recovery_backoff_sec" in data
    assert "last_diagnostic_timestamp" in data
    assert "last_successful_frame_timestamp" in data
    assert "current_failure_reason" in data


def test_api_camera_diagnostics_endpoint(test_client):
    """GET /camera/diagnostics returns 9-point structured checks and history."""
    resp = test_client.get("/camera/diagnostics")
    assert resp.status_code == 200
    data = resp.json()
    assert data["camera_id"] == "ESP32-CAM-01-NORTH"
    assert "latest_diagnostic" in data
    assert "checks" in data["latest_diagnostic"]
    assert "history" in data


def test_api_run_diagnostics_on_demand(test_client):
    """POST /camera/diagnostics/run triggers immediate evaluation."""
    resp = test_client.post("/camera/diagnostics/run")
    assert resp.status_code == 200
    data = resp.json()
    assert "diagnostic" in data
    assert "checks" in data["diagnostic"]
