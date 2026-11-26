"""
Camera Health Monitor, Diagnostics, and Automatic Recovery Engine for Edge Vision Gateway.

Continuously monitors:
1. ESP32 network reachability
2. Camera stream connection
3. MJPEG frame decoding
4. Real frame count advancement
5. Frame freshness
6. Camera reader health
7. Gateway pipeline health
8. Node registration / heartbeat
9. Video relay health

Provides:
- Bounded exponential backoff automatic recovery
- Bounded diagnostic history (in-memory ring buffer)
- Safe concurrency protection
- Verification of actual real frame advancement before declaring recovery success
- Safe manual refresh with immediate verification
"""

from collections import deque
from datetime import datetime, timezone
import errno
import logging
import os
import socket
import threading
import time
from typing import Any, Deque, Dict, List, Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger("uvicorn.error")


class DiagnosticEntry:
    def __init__(
        self,
        failure_category: str,
        error_details: str,
        recovery_action: str,
        attempt_number: int,
        recovery_result: str,
        time_taken_sec: float,
        timestamp: Optional[str] = None,
    ):
        self.timestamp = timestamp or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        self.failure_category = failure_category
        self.error_details = error_details
        self.recovery_action = recovery_action
        self.attempt_number = attempt_number
        self.recovery_result = recovery_result
        self.time_taken_sec = round(time_taken_sec, 3)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "failure_category": self.failure_category,
            "error_details": self.error_details,
            "recovery_action": self.recovery_action,
            "attempt_number": self.attempt_number,
            "recovery_result": self.recovery_result,
            "time_taken_sec": self.time_taken_sec,
        }


class CameraHealthMonitor:
    def __init__(
        self,
        camera_reader: Any,
        event_dispatcher: Any,
        check_interval_sec: float = 15.0,
        max_history_entries: int = 50,
        max_recovery_failures: int = 5,
    ):
        self.camera = camera_reader
        self.dispatcher = event_dispatcher
        self.check_interval_sec = check_interval_sec
        self.max_recovery_failures = max_recovery_failures

        self._history: Deque[DiagnosticEntry] = deque(maxlen=max_history_entries)
        self._lock = threading.Lock()
        self._recovery_lock = threading.Lock()

        # Operational state
        self.is_running = False
        self._monitor_thread: Optional[threading.Thread] = None

        self.last_diagnostic_timestamp: Optional[str] = None
        self.last_diagnostic_time_sec: float = 0.0
        self.last_successful_frame_timestamp: Optional[str] = None
        self.recovery_attempt_count: int = 0
        self.consecutive_failures: int = 0
        self.current_failure_reason: Optional[str] = None
        self.recovery_status: str = "IDLE"  # IDLE, MONITORING, CHECKING, RECONNECTING, LIVE, STREAM_STALE, CAMERA_OFFLINE, RECOVERY_FAILED

        self._last_observed_real_frame_count: int = 0
        self._consecutive_failed_checks: int = 0
        self._next_allowed_recovery_time: float = 0.0

    @property
    def recovery_backoff_delay(self) -> float:
        """Calculate bounded exponential backoff delay."""
        if self.consecutive_failures <= 0:
            return 0.0
        if self.consecutive_failures == 1:
            return 5.0
        if self.consecutive_failures == 2:
            return 15.0
        # Subsequent attempts capped at 60s
        exponent = min(self.consecutive_failures - 2, 4)
        return min(60.0, 15.0 * (1.8 ** exponent))

    def start(self):
        """Start the background health monitor thread."""
        if self.is_running:
            return
        self.is_running = True
        self.recovery_status = "MONITORING"
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop,
            daemon=True,
            name="CameraHealthMonitorThread",
        )
        self._monitor_thread.start()
        logger.info("[CameraHealthMonitor] Background camera health monitor started (interval: %.1fs)", self.check_interval_sec)

    def stop(self):
        """Stop the background monitor thread."""
        self.is_running = False
        if self._monitor_thread and self._monitor_thread.is_alive():
            self._monitor_thread.join(timeout=2.0)
        self.recovery_status = "IDLE"

    def check_network_reachability(self) -> Tuple[bool, str]:
        """
        Check if the configured camera IP and port are reachable on the local network.
        Does NOT open a new HTTP connection if camera is actively streaming to avoid contention.
        """
        source = str(getattr(self.camera, "source", ""))
        if not source.startswith(("http://", "https://")):
            return True, "Local or non-HTTP camera source configured"

        # If already streaming and live, network is definitely reachable
        if getattr(self.camera, "is_camera_live", False) and not getattr(self.camera, "is_stale", True):
            return True, f"Network verified active; live MJPEG stream receiving frames from {source}"

        try:
            parsed = urlparse(source)
            host = parsed.hostname or "127.0.0.1"
            port = parsed.port or (80 if parsed.scheme == "http" else 443)

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1.5)
            try:
                sock.connect((host, port))
                return True, f"ESP32-CAM endpoint reachable on {host}:{port}"
            except (socket.timeout, TimeoutError):
                return False, f"Connection to {host}:{port} timed out after 1.5s"
            except OSError as exc:
                res = getattr(exc, "errno", 0)
                err_desc = ""
                try:
                    err_desc = os.strerror(res)
                except Exception:
                    err_desc = errno.errorcode.get(res, f"errno {res}")
                if res in (65, 64, 50, 51):
                    return False, f"Network route unreachable to {host}:{port} ({err_desc}, errno {res}) - verify Mac Wi-Fi / hotspot"
                return False, f"Connection to {host}:{port} failed ({err_desc}, errno {res})"
            finally:
                sock.close()
        except Exception as exc:
            return False, f"Network probe error for {source}: {type(exc).__name__}: {exc}"

    def run_diagnostics(self) -> Dict[str, Any]:
        """
        Execute full structured diagnostic evaluation across all 9 dimensions.
        Thread-safe and callable on-demand or periodically.
        """
        now_sec = time.time()
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        checks: Dict[str, Dict[str, Any]] = {}
        failure_reasons: List[str] = []

        # 1. ESP32 Network Reachability
        net_ok, net_msg = self.check_network_reachability()
        checks["network_reachability"] = {
            "status": "PASS" if net_ok else "FAIL",
            "detail": net_msg,
        }
        if not net_ok:
            failure_reasons.append(f"Network unreachable: {net_msg}")

        # 2. Camera Stream Connection
        is_transport_open = bool(getattr(self.camera, "_is_transport_open", False))
        is_connected = bool(getattr(self.camera, "is_connected", False))
        is_synthetic = bool(getattr(self.camera, "use_synthetic", False))
        checks["stream_connection"] = {
            "status": "PASS" if (is_transport_open and is_connected) else "FAIL",
            "detail": (
                "Transport open and socket connected"
                if (is_transport_open and is_connected)
                else ("Synthetic fallback active" if is_synthetic else "Camera transport disconnected")
            ),
            "is_synthetic": is_synthetic,
        }
        if not (is_transport_open and is_connected) and not is_synthetic:
            failure_reasons.append("Camera transport disconnected")

        # 3. MJPEG Frame Decoding
        last_frame_ts = getattr(self.camera, "last_frame_timestamp", 0.0)
        has_decoded = last_frame_ts > 0.0
        checks["mjpeg_decoding"] = {
            "status": "PASS" if has_decoded else ("WARN" if is_synthetic else "FAIL"),
            "detail": f"Last decoded frame timestamp: {last_frame_ts:.1f}" if has_decoded else "No MJPEG frames decoded yet",
        }
        if not has_decoded and not is_synthetic:
            failure_reasons.append("No valid MJPEG frames decoded by reader")

        # 4. Real Frame Count Advancement
        current_real_count = getattr(self.camera, "real_frame_count", 0)
        delta_real = current_real_count - self._last_observed_real_frame_count
        # Frame count advancement check is only evaluated if camera was expected to be active
        if is_connected and not is_synthetic:
            if delta_real > 0:
                frame_adv_status = "PASS"
                frame_adv_msg = f"Real frames advancing ({delta_real} frames since last check, total: {current_real_count})"
            else:
                frame_adv_status = "FAIL"
                frame_adv_msg = f"Real frame count frozen at {current_real_count} (0 new frames in check window)"
                failure_reasons.append(frame_adv_msg)
        else:
            frame_adv_status = "WARN" if is_synthetic else "FAIL"
            frame_adv_msg = f"Camera not connected; real frame count is {current_real_count}"

        checks["frame_advancement"] = {
            "status": frame_adv_status,
            "detail": frame_adv_msg,
            "real_frame_count": current_real_count,
            "delta_frames": delta_real,
        }
        self._last_observed_real_frame_count = current_real_count

        # 5. Frame Freshness
        last_real_ts = getattr(self.camera, "last_real_frame_timestamp", 0.0)
        stale_timeout = getattr(self.camera, "stale_timeout_sec", 3.0)
        is_stale = getattr(self.camera, "is_stale", False)
        age_sec = (now_sec - last_real_ts) if last_real_ts > 0.0 else None

        if last_real_ts > 0.0:
            self.last_successful_frame_timestamp = datetime.fromtimestamp(last_real_ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")

        if is_stale:
            freshness_status = "FAIL"
            freshness_msg = f"Stream STALE: no new real frames for {age_sec:.1f}s (threshold {stale_timeout:.1f}s)"
            failure_reasons.append(freshness_msg)
        elif last_real_ts > 0.0:
            freshness_status = "PASS"
            freshness_msg = f"Fresh real frames arriving (last frame received {age_sec:.2f}s ago)"
        else:
            freshness_status = "FAIL"
            freshness_msg = "No real frames have been received from hardware camera"
            if not is_synthetic:
                failure_reasons.append(freshness_msg)

        checks["frame_freshness"] = {
            "status": freshness_status,
            "detail": freshness_msg,
            "age_seconds": round(age_sec, 2) if age_sec is not None else None,
            "is_stale": is_stale,
        }

        # 6. Camera Reader Health
        reader_running = bool(getattr(self.camera, "is_running", False))
        thread_alive = bool(self.camera._thread and self.camera._thread.is_alive()) if hasattr(self.camera, "_thread") else False
        watchdog_alive = bool(self.camera._watchdog_thread and self.camera._watchdog_thread.is_alive()) if hasattr(self.camera, "_watchdog_thread") else False
        reader_ok = reader_running and thread_alive and watchdog_alive
        checks["camera_reader"] = {
            "status": "PASS" if reader_ok else "FAIL",
            "detail": (
                "Capture loop and watchdog threads active"
                if reader_ok
                else f"Thread status: capture={thread_alive}, watchdog={watchdog_alive}, running={reader_running}"
            ),
        }
        if not reader_ok:
            failure_reasons.append("Camera reader thread or watchdog inactive")

        # 7. Gateway Health
        actual_fps = getattr(self.camera, "actual_fps", 0.0)
        checks["gateway_health"] = {
            "status": "PASS",
            "detail": f"Gateway service online; rendering at {actual_fps:.1f} FPS",
            "actual_fps": round(actual_fps, 1),
        }

        # 8. Node Registration / Heartbeat
        heartbeat_err = getattr(self.dispatcher, "last_heartbeat_error", None)
        checks["node_heartbeat"] = {
            "status": "PASS" if not heartbeat_err else "WARN",
            "detail": "Heartbeat active" if not heartbeat_err else f"Heartbeat warning: {heartbeat_err}",
        }

        # 9. Video Relay Health
        latest_frame = self.camera.get_latest_frame()
        relay_ok = latest_frame is not None
        checks["video_relay"] = {
            "status": "PASS" if relay_ok else ("WARN" if is_stale else "FAIL"),
            "detail": "Latest frame buffer non-empty and accessible" if relay_ok else "Latest frame buffer empty / stale",
        }

        # Overall Status Determination
        is_camera_live = getattr(self.camera, "is_camera_live", False)
        has_real_frames = (current_real_count > 0) or is_synthetic or bool(getattr(self.camera, "_forced_is_camera_connected", False))
        if is_camera_live and not is_stale and has_real_frames and delta_real >= 0:
            overall_status = "LIVE"
            failure_reason = None
            self.consecutive_failures = 0
        elif not net_ok:
            overall_status = "RECOVERY_FAILED" if self.consecutive_failures >= self.max_recovery_failures else "CAMERA_OFFLINE"
            net_reasons = [r for r in failure_reasons if "Network unreachable" in r]
            failure_reason = net_reasons[0] if net_reasons else (failure_reasons[0] if failure_reasons else "ESP32 network connection failed")
        elif is_stale:
            overall_status = "STREAM_STALE"
            stale_reasons = [r for r in failure_reasons if "STALE" in r or "stale" in r]
            failure_reason = stale_reasons[0] if stale_reasons else (failure_reasons[0] if failure_reasons else "Camera stream is stale")
        elif self.consecutive_failures >= self.max_recovery_failures:
            overall_status = "RECOVERY_FAILED"
            failure_reason = (
                f"Automatic recovery halted after {self.consecutive_failures} attempts: "
                f"{failure_reasons[0] if failure_reasons else 'Camera unreachable'}"
            )
        else:
            overall_status = "CAMERA_OFFLINE"
            failure_reason = failure_reasons[0] if failure_reasons else "Camera offline"

        with self._lock:
            self.last_diagnostic_timestamp = now_iso
            self.last_diagnostic_time_sec = now_sec
            self.current_failure_reason = failure_reason
            if self.recovery_status != "RECONNECTING":
                self.recovery_status = overall_status

        return {
            "timestamp": now_iso,
            "overall_status": overall_status,
            "is_camera_live": is_camera_live,
            "is_stale": is_stale,
            "is_synthetic": is_synthetic,
            "real_frame_count": current_real_count,
            "last_successful_frame_timestamp": self.last_successful_frame_timestamp,
            "recovery_attempt_count": self.recovery_attempt_count,
            "consecutive_failures": self.consecutive_failures,
            "recovery_status": self.recovery_status,
            "current_failure_reason": self.current_failure_reason,
            "recovery_backoff_sec": round(self.recovery_backoff_delay, 1),
            "checks": checks,
        }

    def _attempt_automatic_recovery(self, reason: str):
        """
        Execute safe, idempotent automatic stream recovery with exponential backoff.
        Verifies actual real frame count advancement before declaring success.
        """
        now = time.time()
        if now < self._next_allowed_recovery_time:
            logger.info(
                "[CameraHealthMonitor] Backoff active; next recovery allowed in %.1fs",
                self._next_allowed_recovery_time - now,
            )
            return

        acquired = self._recovery_lock.acquire(blocking=False)
        if not acquired:
            logger.info("[CameraHealthMonitor] Recovery already in progress; skipping duplicate attempt")
            return

        t_start = time.time()
        attempt_num = self.recovery_attempt_count + 1
        self.recovery_status = "RECONNECTING"
        logger.info(
            "[CameraHealthMonitor] Starting automatic recovery attempt #%d (Reason: %s)...",
            attempt_num,
            reason,
        )

        try:
            initial_real_frames = getattr(self.camera, "real_frame_count", 0)
            is_synthetic = getattr(self.camera, "use_synthetic", False) or (
                hasattr(self.camera, "_is_configured_synthetic") and self.camera._is_configured_synthetic()
            )

            # 1. Reconnect camera transport
            success = self.camera.reconnect(force=True)

            # 2. Verification window: poll for real frame advancement (up to 5.0 seconds)
            self.recovery_status = "VERIFYING_FRESH_FRAMES"
            verified = False
            if success:
                if is_synthetic:
                    verified = True
                else:
                    poll_deadline = time.time() + 5.0
                    while time.time() < poll_deadline:
                        time.sleep(0.1)
                        cur_real = getattr(self.camera, "real_frame_count", 0)
                        if (cur_real > initial_real_frames) and not getattr(self.camera, "is_stale", False):
                            verified = True
                            break

            t_elapsed = time.time() - t_start

            if verified:
                logger.info(
                    "[CameraHealthMonitor] Automatic recovery attempt #%d SUCCEEDED in %.2fs (real_frames: %d -> %d)",
                    attempt_num,
                    t_elapsed,
                    initial_real_frames,
                    getattr(self.camera, "real_frame_count", 0),
                )
                self.recovery_attempt_count += 1
                self.consecutive_failures = 0
                self._consecutive_failed_checks = 0
                self.recovery_status = "LIVE"
                self.current_failure_reason = None
                self._next_allowed_recovery_time = 0.0

                entry = DiagnosticEntry(
                    failure_category="AUTOMATIC_RECOVERY",
                    error_details=reason,
                    recovery_action="RECONNECT_STREAM",
                    attempt_number=attempt_num,
                    recovery_result="SUCCESS",
                    time_taken_sec=t_elapsed,
                )
                self._history.append(entry)
            else:
                self.recovery_attempt_count += 1
                self.consecutive_failures += 1
                backoff = self.recovery_backoff_delay
                self._next_allowed_recovery_time = time.time() + backoff

                net_ok, net_msg = self.check_network_reachability()
                is_net_route_error = (not net_ok) and any(
                    w in net_msg for w in ("errno 65", "errno 50", "errno 51", "errno 64", "No route to host", "Network route unreachable")
                )

                if self.consecutive_failures >= 7 and not is_net_route_error:
                    self.recovery_status = "PHYSICAL_POWER_CYCLE_REQUIRED"
                    err_msg = (
                        "Camera stream failed to restore real frames after multiple recovery attempts. "
                        "Please physically power cycle (unplug and replug USB) the ESP32-CAM."
                    )
                elif self.consecutive_failures >= self.max_recovery_failures:
                    self.recovery_status = "RECOVERY_FAILED"
                    err_msg = (
                        f"Automatic recovery halted after {self.consecutive_failures} failed attempts: "
                        f"{'Camera subnet/route unreachable from Mac' if is_net_route_error else 'Camera stream could not advance real frames'}. "
                        f"Ongoing background retries every {backoff:.1f}s or click Retry now."
                    )
                else:
                    self.recovery_status = "CAMERA_OFFLINE"
                    err_msg = f"Recovery attempt #{attempt_num} failed: {net_msg if not net_ok else '0 fresh real frames'}; retry in {backoff:.1f}s"

                self.current_failure_reason = err_msg
                logger.warning("[CameraHealthMonitor] %s (took %.2fs)", err_msg, t_elapsed)

                entry = DiagnosticEntry(
                    failure_category="AUTOMATIC_RECOVERY",
                    error_details=f"{reason} -> {err_msg}",
                    recovery_action="RECONNECT_STREAM",
                    attempt_number=attempt_num,
                    recovery_result="FAILED",
                    time_taken_sec=t_elapsed,
                )
                self._history.append(entry)

        except Exception as exc:
            t_elapsed = time.time() - t_start
            self.recovery_attempt_count += 1
            self.consecutive_failures += 1
            backoff = self.recovery_backoff_delay
            self._next_allowed_recovery_time = time.time() + backoff
            self.current_failure_reason = f"Exception during recovery: {type(exc).__name__}: {exc}"
            if self.consecutive_failures >= 7:
                self.recovery_status = "PHYSICAL_POWER_CYCLE_REQUIRED"
            elif self.consecutive_failures >= self.max_recovery_failures:
                self.recovery_status = "RECOVERY_FAILED"
            else:
                self.recovery_status = "CAMERA_OFFLINE"

            entry = DiagnosticEntry(
                failure_category="RECOVERY_EXCEPTION",
                error_details=str(exc),
                recovery_action="RECONNECT_STREAM",
                attempt_number=attempt_num,
                recovery_result="FAILED",
                time_taken_sec=t_elapsed,
            )
            self._history.append(entry)
        finally:
            self._recovery_lock.release()

    def manual_refresh(self, force: bool = True) -> Dict[str, Any]:
        """
        Operator-triggered manual stream refresh.
        Resets failure counters upon verified frame arrival, triggers immediate safe reconnection,
        and verifies that real frames advance before returning structured result.
        """
        # Revive capture and watchdog threads if terminated
        if hasattr(self.camera, "ensure_threads_running"):
            try:
                self.camera.ensure_threads_running()
            except Exception as e:
                logger.warning("[CameraHealthMonitor] Failed to revive reader threads: %s", e)

        # Allow operator manual refresh to bypass background backoff wait
        self._next_allowed_recovery_time = 0.0

        # Step 1: Check network reachability before attempting reconnect
        net_ok, net_msg = self.check_network_reachability()
        is_net_route_error = (not net_ok) and any(
            w in net_msg for w in ("errno 65", "errno 50", "errno 51", "errno 64", "No route to host", "Network route unreachable")
        )
        if not net_ok and is_net_route_error:
            self.recovery_status = "CAMERA_OFFLINE"
            self.current_failure_reason = f"Network unavailable: {net_msg}"
            return {
                "success": False,
                "status": "CAMERA_OFFLINE",
                "detailed_state": "NETWORK_UNAVAILABLE",
                "camera_live": False,
                "is_stale": True,
                "real_frame_count": getattr(self.camera, "real_frame_count", 0),
                "new_frames_received": 0,
                "message": f"Network unavailable: {net_msg}",
                "failure_reason": f"Network unavailable: {net_msg}",
                "time_taken_sec": 0.0,
            }

        acquired = self._recovery_lock.acquire(timeout=6.0)
        if not acquired:
            return {
                "success": False,
                "status": "BUSY",
                "message": "Another recovery or refresh operation is currently in progress",
                "camera_live": getattr(self.camera, "is_camera_live", False),
                "is_stale": getattr(self.camera, "is_stale", True),
                "real_frame_count": getattr(self.camera, "real_frame_count", 0),
                "new_frames_received": 0,
                "time_taken_sec": 0.0,
            }

        t_start = time.time()
        self.recovery_status = "RECONNECTING"
        initial_real_frames = getattr(self.camera, "real_frame_count", 0)
        is_synthetic = getattr(self.camera, "use_synthetic", False) or (
            hasattr(self.camera, "_is_configured_synthetic") and self.camera._is_configured_synthetic()
        )

        try:
            # Reconnect camera transport
            connected = self.camera.reconnect(force=force)

            # Verification loop: wait up to 5.0s for genuinely new real frames to advance
            self.recovery_status = "VERIFYING_FRESH_FRAMES"
            verified = False
            new_frames = 0
            if connected:
                if is_synthetic:
                    verified = True
                else:
                    deadline = time.time() + 5.0
                    while time.time() < deadline:
                        time.sleep(0.1)
                        cur_real = getattr(self.camera, "real_frame_count", 0)
                        if (cur_real > initial_real_frames) and not getattr(self.camera, "is_stale", False):
                            verified = True
                            new_frames = max(0, cur_real - initial_real_frames)
                            break

            t_elapsed = time.time() - t_start

            if verified:
                self.consecutive_failures = 0
                self._consecutive_failed_checks = 0
                self.recovery_status = "LIVE"
                self.current_failure_reason = None
                self._next_allowed_recovery_time = 0.0
                msg = f"Manual refresh succeeded: {new_frames} fresh frames verified in {t_elapsed:.2f}s"

                entry = DiagnosticEntry(
                    failure_category="FRESH_FRAMES_RECEIVED",
                    error_details="Operator triggered refresh with verified frame arrival",
                    recovery_action="RECONNECT_STREAM",
                    attempt_number=self.recovery_attempt_count + 1,
                    recovery_result="SUCCESS",
                    time_taken_sec=t_elapsed,
                )
                self._history.append(entry)

                return {
                    "success": True,
                    "status": "LIVE",
                    "detailed_state": "FRESH_FRAMES_RECEIVED",
                    "camera_live": True,
                    "is_stale": False,
                    "real_frame_count": getattr(self.camera, "real_frame_count", 0),
                    "new_frames_received": new_frames,
                    "message": msg,
                    "time_taken_sec": round(t_elapsed, 3),
                }
            else:
                self.consecutive_failures += 1

                # Probe hardware to distinguish reachability vs frame stall
                cam_hw_ok = False
                if hasattr(self.camera, "probe_camera_status"):
                    try:
                        probe_res = self.camera.probe_camera_status(timeout=1.5)
                        if isinstance(probe_res, tuple) and len(probe_res) >= 1:
                            cam_hw_ok = bool(probe_res[0])
                    except Exception:
                        cam_hw_ok = False

                net_ok, net_msg = self.check_network_reachability()
                is_net_route_error = (not net_ok) and any(
                    w in net_msg for w in ("errno 65", "errno 50", "errno 51", "errno 64", "No route to host", "Network route unreachable")
                )

                if self.consecutive_failures >= 7 and not is_net_route_error:
                    self.recovery_status = "PHYSICAL_POWER_CYCLE_REQUIRED"
                    detailed_state = "PHYSICAL_POWER_CYCLE_REQUIRED"
                    msg = (
                        f"Manual refresh completed but 0 fresh real frames received ({t_elapsed:.2f}s). "
                        "Repeated failures indicate hardware contention or crash; please power cycle the ESP32-CAM."
                    )
                elif cam_hw_ok:
                    self.recovery_status = "STREAM_STALE"
                    detailed_state = "CAMERA_REACHABLE"
                    msg = (
                        f"Camera hardware reachable at :81/status, but stream produced 0 fresh frames in 5.0s window ({t_elapsed:.2f}s). "
                        "Stream is stale or decoder stalled. Note: If a browser tab is viewing http://10.204.175.1:81/stream directly, please close it as ESP32-CAM supports only 1 active client stream."
                    )
                elif connected and getattr(self.camera, "is_connected", False):
                    self.recovery_status = "STREAM_STALE"
                    detailed_state = "STREAM_LIVE"
                    msg = (
                        f"TCP socket opened, but 0 fresh real frames advanced within 5.0s ({t_elapsed:.2f}s). "
                        "Camera framebuffer acquisition stalled."
                    )
                elif not net_ok:
                    self.recovery_status = "CAMERA_OFFLINE"
                    detailed_state = "CAMERA_UNREACHABLE"
                    msg = f"Manual refresh failed: Camera endpoint unreachable ({net_msg}) ({t_elapsed:.2f}s)"
                elif self.consecutive_failures >= self.max_recovery_failures:
                    self.recovery_status = "RECOVERY_FAILED"
                    detailed_state = "STALE_OR_OFFLINE"
                    msg = f"Manual refresh failed: Camera is offline ({net_msg if not net_ok else '0 fresh frames'}) ({t_elapsed:.2f}s)"
                else:
                    self.recovery_status = "CAMERA_OFFLINE"
                    detailed_state = "STALE_OR_OFFLINE"
                    msg = f"Manual refresh completed but no fresh real frames were received ({net_msg if not net_ok else '0 fresh frames'}) ({t_elapsed:.2f}s)"

                self.current_failure_reason = msg
                self._next_allowed_recovery_time = time.time() + self.recovery_backoff_delay

                entry = DiagnosticEntry(
                    failure_category=detailed_state,
                    error_details=msg,
                    recovery_action="RECONNECT_STREAM",
                    attempt_number=self.recovery_attempt_count + 1,
                    recovery_result="FAILED",
                    time_taken_sec=t_elapsed,
                )
                self._history.append(entry)

                return {
                    "success": False,
                    "status": self.recovery_status,
                    "detailed_state": detailed_state,
                    "camera_live": False,
                    "is_stale": True,
                    "real_frame_count": getattr(self.camera, "real_frame_count", 0),
                    "new_frames_received": 0,
                    "message": msg,
                    "failure_reason": msg,
                    "time_taken_sec": round(t_elapsed, 3),
                }
        except Exception as exc:
            t_elapsed = time.time() - t_start
            self.consecutive_failures += 1
            self.recovery_status = "RECOVERY_FAILED" if self.consecutive_failures >= self.max_recovery_failures else "CAMERA_OFFLINE"
            msg = f"Manual refresh error: {type(exc).__name__}: {exc}"
            self.current_failure_reason = msg
            self._next_allowed_recovery_time = time.time() + self.recovery_backoff_delay

            entry = DiagnosticEntry(
                failure_category="MANUAL_REFRESH_EXCEPTION",
                error_details=str(exc),
                recovery_action="RECONNECT_STREAM",
                attempt_number=self.recovery_attempt_count + 1,
                recovery_result="FAILED",
                time_taken_sec=t_elapsed,
            )
            self._history.append(entry)

            return {
                "success": False,
                "status": self.recovery_status,
                "camera_live": False,
                "is_stale": getattr(self.camera, "is_stale", True),
                "real_frame_count": getattr(self.camera, "real_frame_count", 0),
                "new_frames_received": 0,
                "message": msg,
                "time_taken_sec": round(t_elapsed, 3),
            }
        finally:
            self._recovery_lock.release()

    def get_diagnostic_history(self) -> List[Dict[str, Any]]:
        """Return snapshot of bounded diagnostic history entries."""
        with self._lock:
            return [entry.to_dict() for entry in self._history]

    def _monitor_loop(self):
        """
        Background loop executing periodic checks every check_interval_sec (~15s).
        Confirms failure across multiple cycles to avoid reacting to temporary network jitter.
        """
        while self.is_running:
            try:
                # If a test or manual override has set forced connection state, do not trigger background recovery
                if getattr(self.camera, "_forced_is_camera_connected", None) is not None:
                    time.sleep(0.5)
                    continue

                diag = self.run_diagnostics()

                is_live = diag["is_camera_live"]
                is_stale = diag["is_stale"]
                overall_status = diag["overall_status"]

                if is_live and not is_stale:
                    self._consecutive_failed_checks = 0
                    self.consecutive_failures = 0
                    self.current_failure_reason = None
                    if self.recovery_status != "LIVE":
                        self.recovery_status = "LIVE"
                else:
                    self._consecutive_failed_checks += 1
                    logger.warning(
                        "[CameraHealthMonitor] Camera unhealthy: status=%s, consecutive_failed_checks=%d",
                        overall_status,
                        self._consecutive_failed_checks,
                    )

                    # Multi-check failure confirmation (2 consecutive failed checks = ~30s or confirmed stale)
                    # To prevent hair-trigger reboots on brief transient network jitter
                    if self._consecutive_failed_checks >= 2 or is_stale:
                        now_check = time.time()
                        if now_check >= self._next_allowed_recovery_time:
                            self._attempt_automatic_recovery(
                                diag.get("current_failure_reason") or "Stream unhealthy after confirmation checks"
                            )
                        elif self.consecutive_failures >= self.max_recovery_failures:
                            self.recovery_status = "RECOVERY_FAILED"
                        else:
                            self.recovery_status = "CAMERA_OFFLINE"
            except Exception as loop_err:
                logger.error("[CameraHealthMonitor] Unexpected error in monitor loop: %s", loop_err)

            # Sleep in small increments for responsive shutdown
            delay = max(1.0, self.check_interval_sec)
            deadline = time.time() + delay
            while self.is_running and time.time() < deadline:
                time.sleep(0.5)
