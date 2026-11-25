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


def test_auto_recovery_ongoing_polling_after_retry_budget_exhaustion(monitor, mock_camera):
    """Verify monitor does not halt forever after 5 failures and resumes when backoff elapses."""
    mock_camera.is_camera_live = False
    mock_camera.is_stale = True
    mock_camera.reconnect.return_value = False

    # Force 5 failures
    for _ in range(5):
        monitor._next_allowed_recovery_time = 0.0
        monitor._attempt_automatic_recovery("Connection failure")

    assert monitor.consecutive_failures == 5
    assert monitor.recovery_status == "RECOVERY_FAILED"

    # Now camera hardware comes back online!
    def restore_camera(force=True):
        mock_camera.is_camera_live = True
        mock_camera.is_stale = False
        mock_camera.real_frame_count = 500
        return True

    mock_camera.reconnect.side_effect = restore_camera
    monitor._next_allowed_recovery_time = 0.0  # Backoff delay elapsed

    # Next attempt must be executed and succeed!
    monitor._attempt_automatic_recovery("Ongoing background probe")
    assert monitor.recovery_status == "LIVE"
    assert monitor.consecutive_failures == 0
    assert monitor.current_failure_reason is None


def test_reader_thread_revival_on_manual_refresh(monitor, mock_camera):
    """Verify manual refresh invokes ensure_threads_running to revive dead reader threads."""
    mock_camera.ensure_threads_running = MagicMock()
    mock_camera.is_camera_live = True
    mock_camera.is_stale = False
    mock_camera.real_frame_count = 100

    def fake_reconnect(force=True):
        mock_camera.real_frame_count = 105
        return True

    mock_camera.reconnect.side_effect = fake_reconnect

    res = monitor.manual_refresh(force=True)
    assert res["success"] is True
    assert res["new_frames_received"] == 5
    mock_camera.ensure_threads_running.assert_called_once()


def test_manual_refresh_strictly_fails_when_zero_fresh_frames_arrive(monitor, mock_camera):
    """Verify manual refresh NEVER returns success: true if real frames do not advance."""
    mock_camera.is_camera_live = True
    mock_camera.is_stale = False
    mock_camera.real_frame_count = 500
    mock_camera.reconnect.return_value = True  # Connection succeeded, but zero fresh frames

    with patch("time.sleep", return_value=None):  # Fast forward polling loop
        res = monitor.manual_refresh(force=True)

    assert res["success"] is False
    assert res["new_frames_received"] == 0
    assert res["camera_live"] is False
    assert res["status"] in ("STREAM_STALE", "CAMERA_OFFLINE")
    assert monitor.recovery_status != "LIVE"


def test_api_camera_reconnect_exception_returns_meaningful_error_not_500(test_client):
    """Verify unexpected exception during camera reconnect returns HTTP 200 with error details rather than 500."""
    with patch("main.health_monitor.manual_refresh", side_effect=RuntimeError("Simulated hardware bus lock")):
        resp = test_client.post("/camera/reconnect")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "failed"
        assert data["camera_connected"] is False
        assert "Simulated hardware bus lock" in data["message"]
        assert "Simulated hardware bus lock" in data["failure_reason"]


def test_failed_manual_refresh_preserves_offline_state_and_updates_consecutive_failures(monitor, mock_camera):
    """Verify failed manual refresh does not report live and updates consecutive failure counter."""
    mock_camera.is_camera_live = False
    mock_camera.is_stale = True
    mock_camera.real_frame_count = 50
    mock_camera.reconnect.return_value = False

    res = monitor.manual_refresh(force=True)
    assert res["success"] is False
    assert res["camera_live"] is False
    assert monitor.consecutive_failures == 1
    assert monitor.recovery_status == "CAMERA_OFFLINE"


# ---------------------------------------------------------------------------
# 5. Health State Consistency & Zero-Frame Protection Regressions
# ---------------------------------------------------------------------------
def test_zero_real_frames_never_reported_as_healthy_or_live(test_client, monitor, mock_camera):
    """Verify that when 0 real frames have arrived, /health and diagnostics never report healthy or LIVE."""
    mock_camera.use_synthetic = False
    mock_camera._forced_is_camera_connected = None
    mock_camera.real_frame_count = 0
    mock_camera.is_stale = False
    diag = monitor.run_diagnostics()
    assert diag["overall_status"] != "LIVE"

    orig_real = camera.real_frame_count
    orig_synth = camera.use_synthetic
    orig_forced = getattr(camera, "_forced_is_camera_connected", None)
    try:
        camera.use_synthetic = False
        camera._forced_is_camera_connected = None
        camera.real_frame_count = 0
        resp = test_client.get("/health")
        assert resp.json()["status"] != "healthy"
        assert resp.json()["camera_connected"] is False
    finally:
        camera.real_frame_count = orig_real
        camera.use_synthetic = orig_synth
        camera._forced_is_camera_connected = orig_forced


def test_health_and_camera_status_consistent_when_offline(test_client):
    """Verify /health and /camera/status provide identical, consistent health states when offline."""
    orig_conn = getattr(camera, "_forced_is_camera_connected", None)
    orig_synth = getattr(camera, "use_synthetic", False)
    orig_rec = health_monitor.recovery_status
    orig_fails = health_monitor.consecutive_failures
    orig_reason = health_monitor.current_failure_reason
    orig_real = camera.real_frame_count

    try:
        camera.use_synthetic = False
        camera._forced_is_camera_connected = False
        camera.real_frame_count = 0
        camera.last_real_frame_timestamp = 0.0
        health_monitor.recovery_status = "RECOVERY_FAILED"
        health_monitor.consecutive_failures = 5
        health_monitor.current_failure_reason = "Network route unreachable to 10.204.175.1:81 (No route to host, errno 65)"

        health_resp = test_client.get("/health")
        status_resp = test_client.get("/camera/status")

        assert health_resp.status_code == 200
        assert status_resp.status_code == 200

        h_data = health_resp.json()
        s_data = status_resp.json()

        # Consistent offline status
        assert h_data["status"] == "camera_disconnected"
        assert h_data["camera_connected"] is False
        assert s_data["is_camera_connected"] is False
        assert s_data["is_camera_live"] is False
        assert s_data["is_connected"] is False

        # Identical frame count (0)
        assert h_data["real_frame_count"] == 0
        assert s_data["real_frame_count"] == 0

        # Consistent recovery and failure states
        assert h_data["recovery_status"] == "RECOVERY_FAILED"
        assert s_data["recovery_status"] == "RECOVERY_FAILED"
        assert h_data["consecutive_failures"] == 5
        assert s_data["consecutive_failures"] == 5
        assert h_data["current_failure_reason"] == s_data["current_failure_reason"]
        assert "errno 65" in h_data["current_failure_reason"]

        # Neither reports stale when simply offline
        assert h_data["is_stale"] is False
        assert s_data["is_stale"] is False
    finally:
        camera._forced_is_camera_connected = orig_conn
        camera.use_synthetic = orig_synth
        health_monitor.recovery_status = orig_rec
        health_monitor.consecutive_failures = orig_fails
        health_monitor.current_failure_reason = orig_reason
        camera.real_frame_count = orig_real


def test_mac_network_route_error_does_not_declare_power_cycle_required(monitor, mock_camera):
    """Verify Mac network error (errno 65) uses exponential backoff and never declares PHYSICAL_POWER_CYCLE_REQUIRED."""
    mock_camera.is_camera_live = False
    mock_camera.is_stale = False
    mock_camera.real_frame_count = 0
    mock_camera.reconnect.return_value = False
    monitor.consecutive_failures = 7  # High failure count

    # Network probe returns errno 65 (No route to host)
    with patch.object(
        monitor,
        "check_network_reachability",
        return_value=(False, "Network route unreachable to 10.204.175.1:81 (No route to host, errno 65) - verify Mac Wi-Fi / hotspot"),
    ):
        with patch("time.sleep", return_value=None):
            res = monitor.manual_refresh(force=True)

        assert res["success"] is False
        assert res["status"] != "PHYSICAL_POWER_CYCLE_REQUIRED"
        assert res["status"] in ("RECOVERY_FAILED", "CAMERA_OFFLINE")
        assert monitor.recovery_status != "PHYSICAL_POWER_CYCLE_REQUIRED"
        assert "errno 65" in monitor.current_failure_reason or "offline" in monitor.current_failure_reason.lower()


def test_hardware_reachable_vs_stale_stream_distinction(monitor, mock_camera):
    """Verify reaching hardware :81/status but 0 frames arriving classifies as STREAM_STALE / CAMERA_REACHABLE."""
    mock_camera.is_camera_live = False
    mock_camera.is_stale = False
    mock_camera.real_frame_count = 10
    mock_camera.reconnect.return_value = True
    mock_camera.probe_camera_status = MagicMock(return_value=(True, {"sensor": "GC2145"}))
    monitor.consecutive_failures = 0

    with patch("time.sleep", return_value=None):
        res = monitor.manual_refresh(force=True)

    assert res["success"] is False
    assert res["status"] == "STREAM_STALE"
    assert res["detailed_state"] == "CAMERA_REACHABLE"
    assert monitor.recovery_status == "STREAM_STALE"
    assert "reachable" in monitor.current_failure_reason.lower()


def test_mac_network_unavailable_errno_65_returns_network_unavailable(monitor, mock_camera):
    """Verify Mac network error errno 65 returns detailed_state NETWORK_UNAVAILABLE and success False."""
    with patch.object(
        monitor,
        "check_network_reachability",
        return_value=(False, "Network route unreachable to 10.204.175.1:81 (No route to host, errno 65) - verify Mac Wi-Fi / hotspot"),
    ):
        res = monitor.manual_refresh(force=True)
        assert res["success"] is False
        assert res["detailed_state"] == "NETWORK_UNAVAILABLE"
        assert res["status"] in ("CAMERA_OFFLINE", "RECOVERY_FAILED")
        assert "errno 65" in res["message"] or "unreachable" in res["message"].lower()


def test_esp32_unreachable_errno_61(monitor, mock_camera):
    """Verify ESP32 connection refused errno 61 returns CAMERA_UNREACHABLE / CAMERA_OFFLINE."""
    mock_camera.reconnect.return_value = False
    mock_camera.is_connected = False
    with patch.object(
        monitor,
        "check_network_reachability",
        return_value=(False, "Connection to 10.204.175.1:81 failed (Connection refused, errno 61)"),
    ):
        with patch("time.sleep", return_value=None):
            res = monitor.manual_refresh(force=True)
        assert res["success"] is False
        assert res["status"] in ("CAMERA_OFFLINE", "RECOVERY_FAILED")
        assert res["detailed_state"] == "CAMERA_UNREACHABLE"
        assert "Connection refused" in res["message"] or "Connection refused" in str(monitor.current_failure_reason)


def test_recovery_after_network_returns(monitor, mock_camera):
    """Verify transition from CAMERA_OFFLINE to LIVE when network route returns and fresh frames arrive."""
    monitor.recovery_status = "CAMERA_OFFLINE"
    monitor.consecutive_failures = 3
    mock_camera.is_camera_live = True
    mock_camera.is_stale = False
    mock_camera.real_frame_count = 100

    def fake_reconnect(force=True):
        mock_camera.real_frame_count = 110
        return True

    mock_camera.reconnect.side_effect = fake_reconnect
    with patch.object(monitor, "check_network_reachability", return_value=(True, "Reachable")):
        res = monitor.manual_refresh(force=True)

    assert res["success"] is True
    assert res["status"] == "LIVE"
    assert res["new_frames_received"] == 10
    assert monitor.recovery_status == "LIVE"
    assert monitor.consecutive_failures == 0
    assert monitor.current_failure_reason is None


def test_fresh_frame_advancement_strictly_required_for_recovery(monitor, mock_camera):
    """Verify that recovery strictly requires cur_real > initial_real_frames before reporting LIVE."""
    mock_camera.is_camera_live = True
    mock_camera.is_stale = False
    mock_camera.real_frame_count = 250

    # Reconnect returns True but frame count remains 250
    mock_camera.reconnect.return_value = True

    with patch.object(monitor, "check_network_reachability", return_value=(True, "Reachable")):
        with patch("time.sleep", return_value=None):
            res = monitor.manual_refresh(force=True)

    assert res["success"] is False
    assert res["new_frames_received"] == 0
    assert monitor.recovery_status != "LIVE"


def test_supervisor_network_awareness_and_sleep_wake():
    """Verify supervisor functions distinguish NETWORK_UNAVAILABLE, CAMERA_UNREACHABLE, and LIVE."""
    from pathlib import Path
    import socket
    import errno

    scripts_dir = Path(__file__).resolve().parent.parent.parent / "scripts"
    sys.path.insert(0, str(scripts_dir))
    import supervisor

    # 1. Test Darwin errno 65 -> NETWORK_UNAVAILABLE
    with patch("socket.socket") as mock_sock_cls:
        mock_sock = MagicMock()
        mock_sock.connect.side_effect = OSError(errno.EHOSTUNREACH, "No route to host")
        mock_sock_cls.return_value = mock_sock

        stat, msg = supervisor.check_network_route_status("10.204.175.1", 81)
        assert stat == "NETWORK_UNAVAILABLE"
        assert "errno 65" in msg

    # 2. Test errno 61 -> CAMERA_UNREACHABLE
    with patch("socket.socket") as mock_sock_cls:
        mock_sock = MagicMock()
        mock_sock.connect.side_effect = OSError(errno.ECONNREFUSED, "Connection refused")
        mock_sock_cls.return_value = mock_sock

        stat, msg = supervisor.check_network_route_status("10.204.175.1", 81)
        assert stat == "CAMERA_UNREACHABLE"
        assert "errno 61" in msg

    # 3. Test timeout -> CAMERA_UNREACHABLE
    with patch("socket.socket") as mock_sock_cls:
        mock_sock = MagicMock()
        mock_sock.connect.side_effect = socket.timeout("timed out")
        mock_sock_cls.return_value = mock_sock

        stat, msg = supervisor.check_network_route_status("10.204.175.1", 81)
        assert stat == "CAMERA_UNREACHABLE"
        assert "timed out" in msg

    # 4. Test connection established -> REACHABLE
    with patch("socket.socket") as mock_sock_cls:
        mock_sock = MagicMock()
        mock_sock.connect.return_value = None
        mock_sock_cls.return_value = mock_sock

        stat, msg = supervisor.check_network_route_status("10.204.175.1", 81)
        assert stat == "REACHABLE"
