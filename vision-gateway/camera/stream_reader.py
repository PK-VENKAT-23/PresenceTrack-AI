"""
Video Stream Reader and Camera Ingestion.

Supports MJPEG streams from ESP32-CAM nodes, local video files,
and synthetic test generators.
"""

import logging
import socket
import threading
import time
from typing import Any, Optional, Tuple

import cv2
import numpy as np
import requests

from config import config

logger = logging.getLogger("uvicorn.error")


def _safe_log(msg: str, level: str = "info"):
    """Thread-safe logging that never raises if stdout/terminal is disconnected."""
    try:
        if level == "error":
            logger.error(msg)
        elif level == "warning":
            logger.warning(msg)
        else:
            logger.info(msg)
    except Exception:
        pass


def _extract_raw_socket(response) -> Optional[Any]:
    """Robustly extract underlying socket from requests/urllib3 response across versions."""
    if response is None or not hasattr(response, "raw") or not response.raw:
        return None
    raw = response.raw
    sock = getattr(raw, "_sock", None)
    if sock is not None:
        return sock
    conn = getattr(raw, "_connection", None)
    if conn and hasattr(conn, "sock") and conn.sock is not None:
        return conn.sock
    try:
        fp = getattr(raw, "_fp", None)
        if fp and hasattr(fp, "fp") and fp.fp:
            inner_fp = fp.fp
            if hasattr(inner_fp, "raw") and hasattr(inner_fp.raw, "_sock"):
                return inner_fp.raw._sock
    except Exception:
        pass
    return None


def _force_close_response(response):
    """Force close response and shutdown underlying socket to immediately unblock reading threads."""
    if response is None:
        return
    try:
        sock = _extract_raw_socket(response)
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass
    except Exception:
        pass
    try:
        if hasattr(response, "raw") and response.raw:
            response.raw.close()
    except Exception:
        pass
    try:
        response.close()
    except Exception:
        pass


class CameraStreamReader:
    def __init__(
        self,
        source: str = config.camera_source,
        target_fps: int = config.target_fps,
        reconnect_interval_sec: float = config.reconnect_interval_sec,
        max_reconnect_attempts: int = config.max_reconnect_attempts,
        fallback_reconnect_interval_sec: float = 12.0,
        stale_timeout_sec: float = 3.0,
    ):
        self.source = source
        self.target_fps = target_fps
        self.reconnect_interval_sec = reconnect_interval_sec
        self.max_reconnect_attempts = max_reconnect_attempts
        self.fallback_reconnect_interval_sec = fallback_reconnect_interval_sec
        self.stale_timeout_sec = stale_timeout_sec

        self.cap: Optional[cv2.VideoCapture] = None
        self._mjpeg_response = None
        self._mjpeg_iterator = None
        self._mjpeg_buffer = bytearray()

        self._is_transport_open = False
        self._forced_is_camera_connected: Optional[bool] = None
        self._forced_is_camera_live: Optional[bool] = None
        self.is_running = False
        self.frame_count = 0
        self.real_frame_count = 0
        self.reconnect_count = 0
        self.last_frame_time = 0.0
        self.last_real_frame_timestamp = 0.0
        self.last_frame_timestamp = 0.0
        self._actual_fps = 0.0
        self._connection_established_time = 0.0
        self.avg_frame_interval_ms = 66.6
        self.dropped_frames = 0
        self.frame_queue_depth = 0

        self._latest_frame: Optional[np.ndarray] = None
        self._latest_jpeg_bytes: Optional[bytes] = None
        self._latest_jpeg_chunk: Optional[bytes] = None
        self._frame_lock = threading.Lock()
        self._lock = self._frame_lock  # Backwards compatibility alias
        self._frame_condition = threading.Condition(self._frame_lock)
        self._stream_lock = threading.Lock()
        self._reconnect_lock = threading.Lock()
        self._thread_lifecycle_lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._watchdog_thread: Optional[threading.Thread] = None
        self._reconnect_thread: Optional[threading.Thread] = None
        self._is_reconnecting = False
        self._last_reconnect_attempt_time = 0.0

        self.use_synthetic = False
        self._synthetic_step = 0

    @property
    def is_stale(self) -> bool:
        """True if real camera has produced frames in the past but none within stale_timeout_sec, or if transport is open but 0 frames arrive within stale_timeout_sec."""
        if self.use_synthetic or self._is_configured_synthetic():
            return False
        now = time.time()
        if self.last_real_frame_timestamp > 0.0:
            return (now - self.last_real_frame_timestamp) > self.stale_timeout_sec
        if self._is_transport_open and self._connection_established_time > 0.0:
            return (now - self._connection_established_time) > self.stale_timeout_sec
        return False

    @property
    def is_camera_connected(self) -> bool:
        """True strictly while fresh real camera frames are actively arriving within stale_timeout_sec."""
        if self._forced_is_camera_connected is not None:
            if not self._forced_is_camera_connected:
                return False
            if self.is_stale:
                return False
            return True

        if self.use_synthetic or self._is_configured_synthetic():
            return False
        if not self._is_transport_open:
            return False
        if self.is_stale:
            return False
        if self.last_real_frame_timestamp <= 0.0:
            return False
        return (time.time() - self.last_real_frame_timestamp) <= self.stale_timeout_sec

    @is_camera_connected.setter
    def is_camera_connected(self, value: Optional[bool]):
        self._forced_is_camera_connected = value
        if value:
            self._is_transport_open = True
        else:
            self._is_transport_open = False

    @property
    def is_camera_live(self) -> bool:
        """True strictly when real camera is connected and receiving fresh frames within stale_timeout_sec."""
        if self._forced_is_camera_live is not None:
            return self._forced_is_camera_live
        return self.is_camera_connected

    @is_camera_live.setter
    def is_camera_live(self, value: Optional[bool]):
        self._forced_is_camera_live = value

    @property
    def is_connected(self) -> bool:
        """True if stream transport is active and fresh (or configured synthetic is running)."""
        if self.use_synthetic:
            return self._is_transport_open and self._is_configured_synthetic()
        return self.is_camera_connected

    @is_connected.setter
    def is_connected(self, value: bool):
        self._is_transport_open = bool(value)

    @property
    def actual_fps(self) -> float:
        """Real-time FPS calculation; returns 0.0 if stream is stale, disconnected, or no frames in 2.0s."""
        if self.is_stale or not self.is_camera_connected:
            return 0.0
        if self.last_frame_timestamp <= 0.0:
            return 0.0
        if (time.time() - self.last_frame_timestamp) > 2.0:
            return 0.0
        return self._actual_fps

    @actual_fps.setter
    def actual_fps(self, value: float):
        self._actual_fps = max(0.0, float(value))

    def _get_reconnect_backoff_delay(self) -> float:
        """Calculate exponential backoff delay capped at approximately 15 seconds."""
        base = max(1.0, self.reconnect_interval_sec)
        exponent = min(self.reconnect_count, 4)
        return min(15.0, base * (1.8 ** exponent))

    def _is_configured_synthetic(self) -> bool:
        """Check if source is explicitly configured as synthetic or mock."""
        return isinstance(self.source, str) and self.source.lower() in (
            "synthetic",
            "test",
            "mock",
            "none",
        )

    def connect(self) -> bool:
        """Initialize connection to the configured video source."""
        if self._is_configured_synthetic():
            self.use_synthetic = True
            self._is_transport_open = True
            return True

        try:
            if isinstance(self.source, str) and self.source.lower().startswith(
                ("http://", "https://")
            ):
                response = requests.get(
                    self.source,
                    stream=True,
                    timeout=(2.5, 2.5),
                    headers={"Accept": "multipart/x-mixed-replace"},
                )
                response.raise_for_status()

                try:
                    sock = _extract_raw_socket(response)
                    if sock is not None:
                        sock.settimeout(2.5)
                except Exception:
                    pass

                with self._stream_lock:
                    if self._mjpeg_response is not None:
                        _force_close_response(self._mjpeg_response)
                    self._mjpeg_response = response
                    self._mjpeg_iterator = response.iter_content(chunk_size=4096)
                    self._mjpeg_buffer.clear()

                self.use_synthetic = False
                self._is_transport_open = True
                self._forced_is_camera_connected = None
                self.reconnect_count = 0
                self._connection_established_time = time.time()
                self.last_real_frame_timestamp = time.time()
                return True

            src = int(self.source) if str(self.source).isdigit() else self.source
            new_cap = cv2.VideoCapture(src)

            if new_cap.isOpened():
                with self._stream_lock:
                    if self.cap is not None:
                        try:
                            self.cap.release()
                        except Exception:
                            pass
                    self.cap = new_cap

                self.use_synthetic = False
                self._is_transport_open = True
                self._forced_is_camera_connected = None
                self.reconnect_count = 0
                self._connection_established_time = time.time()
                self.last_real_frame_timestamp = time.time()
                return True

            new_cap.release()
            self.disconnect(reset_forced=False)
            return False

        except Exception as exc:
            err_msg = f"{type(exc).__name__}: {exc}"
            _safe_log(f"Camera connection failed: {err_msg}", "warning")
            if "81" in str(self.source) and any(w in err_msg.lower() for w in ("timed out", "refused", "reset", "closed", "connection")):
                _safe_log(
                    f"[CameraStreamReader] HINT: ESP32-CAM supports only 1 active client stream. "
                    f"If a browser tab is directly viewing {self.source}, please close it "
                    f"so the gateway can connect and relay the live feed to the dashboard.",
                    "warning",
                )
            self.disconnect(reset_forced=False)
            return False

    def disconnect(self, reset_forced: bool = True):
        """Release video capture and HTTP stream resources and clear cached frames."""
        self._is_transport_open = False
        self._actual_fps = 0.0
        if reset_forced:
            self._forced_is_camera_connected = None
            self._forced_is_camera_live = None

        with self._frame_lock:
            self._latest_frame = None
            self._latest_jpeg_bytes = None
            self._latest_jpeg_chunk = None
            self.frame_queue_depth = 0
            self._frame_condition.notify_all()

        with self._stream_lock:
            if self.cap is not None:
                try:
                    self.cap.release()
                except Exception:
                    pass
                self.cap = None

            if self._mjpeg_response is not None:
                _force_close_response(self._mjpeg_response)
                self._mjpeg_response = None

            self._mjpeg_iterator = None
            self._mjpeg_buffer.clear()

    def _abort_dead_stream(self):
        """Force close hung socket and state from watchdog thread without deadlock."""
        self._is_transport_open = False
        self._forced_is_camera_connected = None
        self._forced_is_camera_live = None
        self._actual_fps = 0.0

        with self._frame_lock:
            self._latest_frame = None
            self._latest_jpeg_bytes = None
            self._latest_jpeg_chunk = None
            self.frame_queue_depth = 0
            self._frame_condition.notify_all()

        with self._stream_lock:
            if self._mjpeg_response is not None:
                _force_close_response(self._mjpeg_response)
                self._mjpeg_response = None
            self._mjpeg_iterator = None
            self._mjpeg_buffer.clear()

            if self.cap is not None:
                try:
                    self.cap.release()
                except Exception:
                    pass
                self.cap = None

    def probe_camera_status(self, timeout: float = 1.5) -> Tuple[bool, str]:
        """Check whether camera hardware status endpoint responds without consuming stream."""
        if not isinstance(self.source, str) or not self.source.lower().startswith(("http://", "https://")):
            return True, "non-http source"
        status_url = self.source.replace("/stream", "/status")
        try:
            resp = requests.get(status_url, timeout=timeout)
            if resp.status_code == 200:
                return True, "OK"
            return False, f"HTTP {resp.status_code}"
        except Exception as exc:
            return False, f"{type(exc).__name__}: {exc}"

    def reconnect(self, force: bool = False, drain_delay: Optional[float] = None) -> bool:
        """
        Trigger reconnection to the camera source.
        Does not disrupt a healthy, actively streaming connection unless force=True or stream is stale.
        Thread-safe against concurrent manual or background reconnect calls.
        Ensures capture loop and watchdog threads are revived if terminated.
        Waits drain_delay seconds after disconnect to allow single-client ESP32 socket to drain cleanly.
        """
        if self.is_camera_live and not force:
            _safe_log(f"[CameraStreamReader] Active stream healthy ({self.real_frame_count} real frames received); skipping redundant reconnect")
            return True

        self.ensure_threads_running()

        acquired = self._reconnect_lock.acquire(timeout=5.0)
        if not acquired:
            return self.is_camera_live

        try:
            self._is_reconnecting = True
            self.disconnect()
            # Allow ESP32 FreeRTOS stream handler time to release socket if streaming over HTTP
            if drain_delay is None:
                drain_delay = 0.4 if (isinstance(self.source, str) and ":81" in self.source and not self.use_synthetic) else 0.0
            if drain_delay > 0:
                time.sleep(drain_delay)

            self.reconnect_count = 0
            success = self.connect()
            return success
        finally:
            self._is_reconnecting = False
            self._reconnect_lock.release()

    def _start_background_reconnect(self):
        """Spawn background reconnection probe thread if not already running."""
        if self.is_camera_connected and not self.is_stale:
            return

        with self._reconnect_lock:
            if self.is_camera_connected and not self.is_stale:
                return
            if self._is_reconnecting:
                return
            if self._reconnect_thread and self._reconnect_thread.is_alive():
                return
            self._is_reconnecting = True
            self._reconnect_thread = threading.Thread(
                target=self._background_reconnect_worker,
                daemon=True,
                name="CameraReconnectWorker",
            )
            self._reconnect_thread.start()

    def _background_reconnect_worker(self):
        """
        Background probe and reconnection worker.
        Runs asynchronously without blocking the frame capture loop.
        """
        if self.is_camera_connected and not self.is_stale:
            return

        response = None
        new_cap = None
        try:
            if self._is_configured_synthetic():
                return

            if isinstance(self.source, str) and self.source.lower().startswith(
                ("http://", "https://")
            ):
                response = requests.get(
                    self.source,
                    stream=True,
                    timeout=(2.5, 2.5),
                    headers={"Accept": "multipart/x-mixed-replace"},
                )
                response.raise_for_status()

                try:
                    sock = _extract_raw_socket(response)
                    if sock is not None:
                        sock.settimeout(2.5)
                except Exception:
                    pass

                iterator = response.iter_content(chunk_size=4096)

                with self._stream_lock:
                    if self._mjpeg_response is not None:
                        _force_close_response(self._mjpeg_response)
                    self._mjpeg_response = response
                    self._mjpeg_iterator = iterator
                    self._mjpeg_buffer.clear()
                    response = None  # Transferred ownership

                    self._is_transport_open = True
                    self._forced_is_camera_connected = None
                    self.use_synthetic = False
                    self.reconnect_count = 0
                    self._connection_established_time = time.time()
                    self.last_real_frame_timestamp = time.time()
                _safe_log(f"[CameraStreamReader] Successfully reconnected to live camera stream: {self.source}")
                return

            src = int(self.source) if str(self.source).isdigit() else self.source
            new_cap = cv2.VideoCapture(src)
            if new_cap.isOpened():
                with self._stream_lock:
                    if self.cap is not None:
                        try:
                            self.cap.release()
                        except Exception:
                            pass
                    self.cap = new_cap
                    new_cap = None  # Transferred ownership

                    self._is_transport_open = True
                    self._forced_is_camera_connected = None
                    self.use_synthetic = False
                    self.reconnect_count = 0
                    self._connection_established_time = time.time()
                    self.last_real_frame_timestamp = time.time()
                _safe_log(f"[CameraStreamReader] Successfully reconnected to camera capture: {self.source}")
                return
            else:
                self.reconnect_count += 1
        except Exception as exc:
            self.reconnect_count += 1
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
            if new_cap is not None:
                try:
                    new_cap.release()
                except Exception:
                    pass
            self._is_reconnecting = False

    def _read_mjpeg_frame(self) -> Tuple[bool, Optional[np.ndarray]]:
        """Extract and decode one JPEG frame from an MJPEG HTTP stream."""

        with self._stream_lock:
            iterator = self._mjpeg_iterator
            buffer = self._mjpeg_buffer

        if iterator is None or not self._is_transport_open:
            return False, None

        consecutive_empty = 0
        try:
            while self._is_transport_open:
                # Scan for all complete JPEG frames in the buffer to jump directly to the newest
                last_start = -1
                last_end = -1
                pos = 0
                found_count = 0
                while True:
                    s = buffer.find(b"\xff\xd8", pos)
                    if s < 0:
                        break
                    e = buffer.find(b"\xff\xd9", s + 2)
                    if e < 0:
                        break
                    last_start = s
                    last_end = e + 2
                    found_count += 1
                    pos = e + 2

                if found_count > 0:
                    if found_count > 1:
                        self.dropped_frames += (found_count - 1)
                    jpeg_data = bytes(buffer[last_start:last_end])
                    del buffer[:last_end]
                    self.frame_queue_depth = len(buffer)

                    frame = cv2.imdecode(
                        np.frombuffer(jpeg_data, dtype=np.uint8),
                        cv2.IMREAD_COLOR,
                    )

                    if frame is not None:
                        with self._frame_lock:
                            self._latest_jpeg_bytes = jpeg_data
                            self._latest_jpeg_chunk = (
                                b"--frame\r\n"
                                b"Content-Type: image/jpeg\r\n"
                                b"Content-Length: "
                                + str(len(jpeg_data)).encode("ascii")
                                + b"\r\n\r\n"
                                + jpeg_data
                                + b"\r\n"
                            )
                        return True, frame

                    continue

                try:
                    chunk = next(iterator)
                except StopIteration:
                    _safe_log("[CameraStreamReader] MJPEG stream iterator finished (StopIteration)", "warning")
                    return False, None
                except Exception as stream_err:
                    _safe_log(f"[CameraStreamReader] MJPEG stream chunk read error: {type(stream_err).__name__}: {stream_err}", "warning")
                    return False, None

                if chunk:
                    consecutive_empty = 0
                    buffer.extend(chunk)
                else:
                    consecutive_empty += 1
                    if consecutive_empty >= 5:
                        _safe_log("[CameraStreamReader] Received 5 consecutive empty stream chunks; connection closed", "warning")
                        return False, None
                    time.sleep(0.02)

                # Prevent unbounded memory growth if the stream is malformed.
                if len(buffer) > 8 * 1024 * 1024:
                    start = buffer.rfind(b"\xff\xd8")
                    if start >= 0:
                        del buffer[:start]
                    else:
                        buffer.clear()

        except Exception as exc:
            _safe_log(f"[CameraStreamReader] MJPEG stream read failed: {type(exc).__name__}: {exc}", "warning")
            return False, None

        return False, None

    def read_frame(self) -> Tuple[bool, Optional[np.ndarray]]:
        """Read one frame from the configured source."""

        if self.use_synthetic:
            return True, self._generate_synthetic_frame()

        if not self._is_transport_open and not self._forced_is_camera_connected:
            return False, None

        if isinstance(self.source, str) and self.source.lower().startswith(
            ("http://", "https://")
        ):
            return self._read_mjpeg_frame()

        if self.cap is None or not self.cap.isOpened():
            return False, None

        ret, frame = self.cap.read()

        if not ret or frame is None:
            if isinstance(self.source, str) and not self.source.startswith("http"):
                self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ret, frame = self.cap.read()

                if ret and frame is not None:
                    return True, frame

            return False, None

        return True, frame

    def _generate_synthetic_frame(self) -> np.ndarray:
        """Generate a synthetic frame for testing."""

        h, w = config.frame_height, config.frame_width
        frame = np.full((h, w, 3), 22, dtype=np.uint8)

        by = int(h * config.boundary_y_ratio)
        cv2.line(frame, (20, by), (w - 20, by), (16, 185, 129), 2)

        self._synthetic_step = (self._synthetic_step + 2) % (h - 60)
        cy = 30 + self._synthetic_step
        cx = w // 2

        cv2.circle(frame, (cx, cy), 18, (186, 200, 224), -1)
        cv2.rectangle(
            frame,
            (cx - 24, cy + 18),
            (cx + 24, cy + 70),
            (100, 115, 130),
            -1,
        )

        return frame

    def ensure_threads_running(self):
        """Ensure capture loop and watchdog threads are alive and running."""
        with self._thread_lifecycle_lock:
            if not self.is_running:
                return

            if self._thread is None or not self._thread.is_alive():
                _safe_log("[CameraStreamReader] Reviving dead capture loop thread", "warning")
                self._thread = threading.Thread(
                    target=self._capture_loop,
                    daemon=True,
                    name="CameraCaptureLoop",
                )
                self._thread.start()

            if self._watchdog_thread is None or not self._watchdog_thread.is_alive():
                _safe_log("[CameraStreamReader] Reviving dead watchdog thread", "warning")
                self._watchdog_thread = threading.Thread(
                    target=self._watchdog_loop,
                    daemon=True,
                    name="CameraStreamWatchdog",
                )
                self._watchdog_thread.start()

    def start(self):
        """Start background frame capture and independent watchdog."""
        if self.is_running:
            self.ensure_threads_running()
            return

        self.is_running = True
        self._thread = threading.Thread(
            target=self._capture_loop,
            daemon=True,
            name="CameraCaptureLoop",
        )
        self._thread.start()

        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop,
            daemon=True,
            name="CameraStreamWatchdog",
        )
        self._watchdog_thread.start()

    def stop(self):
        """Stop background capture and release resources."""

        self.is_running = False

        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)

        if self._watchdog_thread and self._watchdog_thread.is_alive():
            self._watchdog_thread.join(timeout=2.0)

        if self._reconnect_thread and self._reconnect_thread.is_alive():
            self._reconnect_thread.join(timeout=2.0)

        self.disconnect()

    def _watchdog_loop(self):
        """
        Independent watchdog thread running at 2 Hz.
        Actively detects when real camera frame ingestion stalls (> stale_timeout_sec),
        clears frames and closes sockets so blocked capture threads abort and reconnect.
        """
        while self.is_running:
            try:
                time.sleep(0.5)
                now = time.time()
                if (
                    self._is_transport_open
                    and not self.use_synthetic
                    and not self._is_configured_synthetic()
                ):
                    has_stalled = False
                    if self.last_real_frame_timestamp > 0.0:
                        if (now - self.last_real_frame_timestamp) > self.stale_timeout_sec:
                            has_stalled = True
                    elif self._connection_established_time > 0.0:
                        if (now - self._connection_established_time) > self.stale_timeout_sec:
                            has_stalled = True

                    if has_stalled:
                        stall_duration = (
                            (now - self.last_real_frame_timestamp)
                            if self.last_real_frame_timestamp > 0.0
                            else (now - self._connection_established_time)
                        )
                        _safe_log(
                            f"[CameraWatchdog] Real camera stream stalled for {stall_duration:.2f}s "
                            f"(> {self.stale_timeout_sec}s threshold). Forcibly aborting dead socket.",
                            "warning",
                        )
                        self._abort_dead_stream()
            except Exception as w_err:
                _safe_log(f"[CameraWatchdog] Error in watchdog loop: {w_err}", "error")

    def _capture_loop(self):
        """Continuously capture frames, detect disconnects, and auto-reconnect with exponential backoff."""

        delay = 1.0 / max(1, self.target_fps)

        while self.is_running:
            t0 = time.time()
            now = time.time()
            try:
                # 1. Connection & Auto-reconnection logic with exponential backoff
                if not self._is_transport_open:
                    if self._is_configured_synthetic():
                        self.use_synthetic = True
                        self._is_transport_open = True
                    elif self.reconnect_count >= self.max_reconnect_attempts and self.max_reconnect_attempts < 999:
                        # Max reconnect attempts exhausted; fall back to synthetic frames while probing in background
                        self.use_synthetic = True
                        self._is_transport_open = False
                        now_check = time.time()
                        if (
                            not self._is_reconnecting
                            and (now_check - self._last_reconnect_attempt_time >= self.fallback_reconnect_interval_sec)
                        ):
                            self._last_reconnect_attempt_time = now_check
                            self._start_background_reconnect()
                    else:
                        self.use_synthetic = False
                        backoff = self._get_reconnect_backoff_delay()
                        if (now - self._last_reconnect_attempt_time) >= backoff:
                            self._last_reconnect_attempt_time = now
                            if self._reconnect_lock.acquire(blocking=False):
                                try:
                                    self._is_reconnecting = True
                                    _safe_log(
                                        f"[CameraStreamReader] Attempting camera reconnection "
                                        f"(attempt #{self.reconnect_count + 1}, backoff={backoff:.1f}s)..."
                                    )
                                    connected = self.connect()
                                    if connected:
                                        _safe_log(f"[CameraStreamReader] Camera reconnection SUCCEEDED: {self.source}")
                                        self.reconnect_count = 0
                                    else:
                                        self.reconnect_count += 1
                                        _safe_log(
                                            f"[CameraStreamReader] Camera reconnection failed; "
                                            f"next retry in {self._get_reconnect_backoff_delay():.1f}s",
                                            "warning",
                                        )
                                finally:
                                    self._is_reconnecting = False
                                    self._reconnect_lock.release()

                # 2. Frame acquisition
                if self._is_transport_open or self.use_synthetic or self._forced_is_camera_connected:
                    success, frame = self.read_frame()

                    if success and frame is not None:
                        frame_now = time.time()
                        with self._frame_condition:
                            self._latest_frame = frame
                            self.frame_count += 1
                            if not self.use_synthetic and not self._is_configured_synthetic():
                                self.real_frame_count += 1
                                self.last_real_frame_timestamp = frame_now
                            self.last_frame_timestamp = frame_now

                            if self.last_frame_time > 0:
                                dt = frame_now - self.last_frame_time
                                if dt > 0:
                                    self._actual_fps = (
                                        0.9 * self._actual_fps + 0.1 * (1.0 / dt)
                                    )
                                    self.avg_frame_interval_ms = (
                                        0.9 * self.avg_frame_interval_ms + 0.1 * (dt * 1000.0)
                                    )
                            self.last_frame_time = frame_now
                            self._frame_condition.notify_all()
                    else:
                        if not self.use_synthetic:
                            _safe_log("[CameraStreamReader] Frame read returned failure; disconnecting", "warning")
                            self.disconnect(reset_forced=False)
                            self._last_reconnect_attempt_time = time.time()

            except Exception as loop_err:
                _safe_log(f"[CameraStreamReader] Error in capture loop: {type(loop_err).__name__}: {loop_err}", "error")
                if not self.use_synthetic:
                    try:
                        self.disconnect(reset_forced=False)
                    except Exception:
                        pass
                    self._last_reconnect_attempt_time = time.time()

            elapsed = time.time() - t0
            is_http = (
                isinstance(self.source, str)
                and self.source.lower().startswith(("http://", "https://"))
            )
            if is_http and self._is_transport_open:
                if elapsed < 0.002:
                    time.sleep(0.002)
            else:
                time.sleep(max(0.001, delay - elapsed))

    def get_latest_frame(self) -> Optional[np.ndarray]:
        """Return a thread-safe copy of the latest frame. Returns None if stale or disconnected."""
        if self.is_stale or not self.is_connected:
            return None

        with self._frame_lock:
            return (
                self._latest_frame.copy()
                if self._latest_frame is not None
                else None
            )

    def get_latest_jpeg_chunk(self) -> Optional[bytes]:
        """Return pre-formatted MJPEG chunk of latest frame directly without re-encoding."""
        if self.is_stale or not self.is_connected:
            return None

        with self._frame_lock:
            return self._latest_jpeg_chunk

    def get_frame_package(self) -> dict:
        """Return atomic snapshot of frame and telemetry counters."""

        with self._frame_lock:
            frame_copy = (
                self._latest_frame.copy()
                if self._latest_frame is not None
                else None
            )
            return {
                "frame": frame_copy,
                "frame_count": self.frame_count,
                "real_frame_count": self.real_frame_count,
                "last_real_frame_timestamp": self.last_real_frame_timestamp,
                "is_camera_connected": self.is_camera_connected,
                "is_stale": self.is_stale,
                "actual_fps": self.actual_fps,
                "avg_frame_interval_ms": round(self.avg_frame_interval_ms, 2),
                "dropped_frames": self.dropped_frames,
                "frame_queue_depth": self.frame_queue_depth,
            }

    def wait_for_frame(self, timeout: float = 1.0) -> Optional[np.ndarray]:
        """Wait for the next fresh frame using condition notification."""

        with self._frame_condition:
            if self._latest_frame is not None:
                return self._latest_frame.copy()

            self._frame_condition.wait(timeout=timeout)

            return (
                self._latest_frame.copy()
                if self._latest_frame is not None
                else None
            )

    def get_status(self) -> dict:
        """Return camera health and freshness information."""

        return {
            "source": self.source,
            "is_connected": self.is_connected,
            "is_camera_connected": self.is_camera_connected,
            "is_camera_live": self.is_camera_live,
            "is_synthetic": self.use_synthetic,
            "is_stale": self.is_stale,
            "target_fps": self.target_fps,
            "actual_fps": round(self.actual_fps, 1),
            "frame_count": self.frame_count,
            "real_frame_count": self.real_frame_count,
            "last_real_frame_timestamp": self.last_real_frame_timestamp,
            "last_frame_timestamp": self.last_frame_timestamp,
            "reconnect_count": self.reconnect_count,
            "reconnect_backoff_sec": round(self._get_reconnect_backoff_delay(), 1),
        }
