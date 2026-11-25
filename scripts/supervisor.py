#!/usr/bin/env python3
"""
PresenceTrack AI — Local Process Supervisor & Automatic Recovery Engine
=======================================================================
Manages the two core project services:
  1. Website Backend (TanStack Start / Vite on port 8080)
  2. Vision Gateway (FastAPI / Uvicorn on port 8001)

Features:
  - Precise process detection by port, PID file, and verified command line
  - Safe, selective termination of stale project processes (SIGTERM -> bounded wait -> SIGKILL)
  - Strict protection of unrelated processes (Antigravity, user sessions, editors)
  - Enforces startup sequence: Website backend first, then Vision Gateway
  - Automatic recovery upon process failure or Mac wake from sleep
  - Exponential backoff with bounded retries to prevent runaway respawns
  - Single supervisor instance enforcement via file locking
  - Structured logging to logs/supervisor.log, logs/backend.log, logs/gateway.log
"""

import argparse
import errno
import fcntl
import json
import logging
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Base paths
PROJECT_ROOT = Path(__file__).resolve().parent.parent
GATEWAY_DIR = PROJECT_ROOT / "vision-gateway"
LOGS_DIR = PROJECT_ROOT / "logs"

# Ensure logs directory exists
LOGS_DIR.mkdir(parents=True, exist_ok=True)

SUPERVISOR_LOG_FILE = LOGS_DIR / "supervisor.log"
BACKEND_LOG_FILE = LOGS_DIR / "backend.log"
GATEWAY_LOG_FILE = LOGS_DIR / "gateway.log"

SUPERVISOR_LOCK_FILE = LOGS_DIR / "supervisor.lock"
SUPERVISOR_PID_FILE = LOGS_DIR / "supervisor.pid"
BACKEND_PID_FILE = LOGS_DIR / "backend.pid"
GATEWAY_PID_FILE = LOGS_DIR / "gateway.pid"

# Service configurations
BACKEND_PORT = 8080
GATEWAY_PORT = 8001
CAMERA_HOST = "10.204.175.1"
CAMERA_PORT = 81

BACKEND_HEALTH_URL = f"http://localhost:{BACKEND_PORT}/"
GATEWAY_HEALTH_URL = f"http://localhost:{GATEWAY_PORT}/health"
GATEWAY_STATUS_URL = f"http://localhost:{GATEWAY_PORT}/camera/status"
CAMERA_STATUS_URL = f"http://{CAMERA_HOST}:{CAMERA_PORT}/status"

# Python interpreter in vision-gateway venv
GATEWAY_VENV_PYTHON = GATEWAY_DIR / ".venv" / "bin" / "python"
if not GATEWAY_VENV_PYTHON.exists():
    GATEWAY_VENV_PYTHON = Path(sys.executable)

# Load environment variables from .env files
def _load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip("'\"")
            if k not in os.environ:
                os.environ[k] = v
    except Exception:
        pass

_load_env_file(PROJECT_ROOT / ".env")
_load_env_file(GATEWAY_DIR / ".env")

# Setup logging
logger = logging.getLogger("PresenceTrackSupervisor")
logger.setLevel(logging.INFO)
formatter = logging.Formatter(
    "[%(asctime)s] [%(levelname)s] [Supervisor] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

file_handler = logging.FileHandler(SUPERVISOR_LOG_FILE, mode="a", encoding="utf-8")
file_handler.setFormatter(formatter)
logger.addHandler(file_handler)

stream_handler = logging.StreamHandler(sys.stdout)
stream_handler.setFormatter(formatter)
logger.addHandler(stream_handler)


# ==============================================================================
# Process Inspection & Safety Safeguards
# ==============================================================================

def get_process_cmd(pid: int) -> str:
    """Retrieve the command line of a given PID on macOS."""
    try:
        res = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=2.0,
        )
        return res.stdout.strip()
    except Exception:
        return ""


def get_pids_on_port(port: int) -> List[int]:
    """Retrieve list of PIDs currently listening on a local TCP port."""
    try:
        res = subprocess.run(
            ["lsof", f"-i:{port}", "-sTCP:LISTEN", "-t"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=2.0,
        )
        if res.returncode == 0 and res.stdout.strip():
            pids = []
            for line in res.stdout.strip().splitlines():
                line = line.strip()
                if line.isdigit():
                    pids.append(int(line))
            return pids
    except Exception:
        pass
    return []


def get_process_cwd(pid: int) -> str:
    """Retrieve the working directory of a process via lsof on macOS."""
    try:
        res = subprocess.run(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=2.0,
        )
        for line in res.stdout.splitlines():
            if line.startswith("n"):
                return line[1:].strip()
    except Exception:
        pass
    return ""


def is_project_path(path: str) -> bool:
    """Verify strictly if a path belongs to this project workspace."""
    if not path:
        return False
    try:
        resolved = Path(path).resolve()
        proj_resolved = PROJECT_ROOT.resolve()
        return resolved == proj_resolved or proj_resolved in resolved.parents
    except Exception:
        return str(PROJECT_ROOT) in path


def is_project_backend_process(pid: int, cmd: str, check_port: bool = True) -> bool:
    """
    Verify strictly whether a process belongs to the PresenceTrack website backend.
    Enforces all of:
      1. Valid process identity (pid > 1, not current supervisor).
      2. Strict negative filters (never Antigravity, user shell, editors, or unrelated apps).
      3. Working directory or explicit command path verified inside PROJECT_ROOT.
      4. Expected service command (vite / tanstack / npm run dev).
      5. Expected port ownership (listening on port 8080 or recorded in backend.pid).
    """
    if pid <= 1 or pid == os.getpid():
        return False

    cmd_lower = cmd.lower()
    # Explicit negative safeguards
    forbidden_tokens = ["antigravity", "gemini", "code_helper", "cursor", "/bin/zsh", "/bin/bash", "/bin/sh"]
    if any(tok in cmd_lower for tok in forbidden_tokens):
        return False

    # Working directory verification
    cwd = get_process_cwd(pid)
    has_project_cwd = is_project_path(cwd)
    has_project_cmd = ("project_vh" in cmd_lower) or (str(PROJECT_ROOT).lower() in cmd_lower)

    if not (has_project_cwd or has_project_cmd):
        return False

    # Expected command validation
    expected_tokens = ["vite", "tanstack", "npm run dev"]
    if not any(tok in cmd_lower for tok in expected_tokens):
        return False

    # Expected port ownership check
    if check_port:
        pids_on_port = get_pids_on_port(BACKEND_PORT)
        pid_file_match = False
        if BACKEND_PID_FILE.exists():
            try:
                pid_file_match = (int(BACKEND_PID_FILE.read_text().strip()) == pid)
            except Exception:
                pass
        if (pid not in pids_on_port) and not pid_file_match:
            return False

    return True


def is_project_gateway_process(pid: int, cmd: str, check_port: bool = True) -> bool:
    """
    Verify strictly whether a process belongs to the PresenceTrack Vision Gateway.
    Enforces all of:
      1. Valid process identity (pid > 1, not current supervisor).
      2. Strict negative filters (never Antigravity, user shell, editors, or unrelated apps).
      3. Working directory or explicit command path verified inside GATEWAY_DIR / PROJECT_ROOT.
      4. Expected service command (uvicorn main:app or vision-gateway python).
      5. Expected port ownership (listening on port 8001 or recorded in gateway.pid).
    """
    if pid <= 1 or pid == os.getpid():
        return False

    cmd_lower = cmd.lower()
    # Explicit negative safeguards
    forbidden_tokens = ["antigravity", "gemini", "code_helper", "cursor", "/bin/zsh", "/bin/bash", "/bin/sh"]
    if any(tok in cmd_lower for tok in forbidden_tokens):
        return False

    # Working directory verification
    cwd = get_process_cwd(pid)
    has_project_cwd = is_project_path(cwd)
    has_project_cmd = ("vision-gateway" in cmd_lower) or ("project_vh" in cmd_lower) or (str(GATEWAY_DIR).lower() in cmd_lower)

    if not (has_project_cwd or has_project_cmd):
        return False

    # Expected command validation
    is_uvicorn_main = ("uvicorn" in cmd_lower and "main:app" in cmd_lower)
    is_gateway_py = ("vision-gateway" in cmd_lower and "python" in cmd_lower)
    if not (is_uvicorn_main or is_gateway_py):
        return False

    # Expected port ownership check
    if check_port:
        pids_on_port = get_pids_on_port(GATEWAY_PORT)
        pid_file_match = False
        if GATEWAY_PID_FILE.exists():
            try:
                pid_file_match = (int(GATEWAY_PID_FILE.read_text().strip()) == pid)
            except Exception:
                pass
        if (pid not in pids_on_port) and not pid_file_match:
            return False

    return True


def is_pid_alive(pid: int) -> bool:
    """Check if process PID is alive."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def safe_terminate_process(pid: int, service_name: str, timeout_sec: float = 5.0) -> bool:
    """
    Safely and gracefully terminate a verified project process.
    1. Sends SIGTERM.
    2. Waits up to timeout_sec for graceful exit.
    3. If still alive and confirmed project-owned, issues SIGKILL as final resort.
    """
    if not is_pid_alive(pid):
        return True

    cmd = get_process_cmd(pid)
    logger.info("Gracefully stopping stale %s (PID %d: %s)...", service_name, pid, cmd[:60])

    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except PermissionError:
        logger.error("Permission denied to terminate PID %d", pid)
        return False

    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if not is_pid_alive(pid):
            logger.info("Process %d exited cleanly.", pid)
            return True
        time.sleep(0.2)

    # Process refused to terminate gracefully
    logger.warning("Process %d did not exit after %.1fs. Sending SIGKILL...", pid, timeout_sec)
    try:
        os.kill(pid, signal.SIGKILL)
        time.sleep(0.3)
    except (ProcessLookupError, PermissionError):
        pass

    return not is_pid_alive(pid)


def is_port_bound(port: int) -> bool:
    """Check if a local port is bound."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_for_port_available(port: int, timeout_sec: float = 5.0) -> bool:
    """Wait until port is completely released."""
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if not is_port_bound(port):
            return True
        time.sleep(0.2)
    return not is_port_bound(port)


# ==============================================================================
# Health Probing
# ==============================================================================

def probe_http(url: str, timeout_sec: float = 2.0, allowed_codes: Tuple[int, ...] = (200,)) -> Tuple[bool, int, str]:
    """Perform HTTP probe and return (is_ok, status_code, message)."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "PresenceTrackSupervisor/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            code = resp.getcode()
            return (code in allowed_codes, code, f"HTTP {code}")
    except urllib.error.HTTPError as e:
        return (e.code in allowed_codes, e.code, f"HTTP {e.code}")
    except urllib.error.URLError as e:
        return (False, 0, str(e.reason))
    except Exception as e:
        return (False, 0, str(e))


def check_backend_healthy() -> bool:
    """Check if Website Backend is responding on port 8080."""
    ok, _, _ = probe_http(BACKEND_HEALTH_URL, timeout_sec=2.0, allowed_codes=(200, 301, 302, 307, 308))
    return ok


def check_gateway_healthy() -> bool:
    """Check if Vision Gateway is responding on port 8001."""
    ok, _, _ = probe_http(GATEWAY_HEALTH_URL, timeout_sec=2.0, allowed_codes=(200,))
    return ok


def check_camera_reachable() -> Tuple[bool, str]:
    """Check if physical ESP32-CAM is reachable on 10.204.175.1:81/status."""
    ok, code, msg = probe_http(CAMERA_STATUS_URL, timeout_sec=1.5, allowed_codes=(200,))
    return ok, msg


def check_network_route_status(host: str = CAMERA_HOST, port: int = CAMERA_PORT) -> Tuple[str, str]:
    """
    Check low-level TCP/IP route to the camera.
    Distinguishes:
      - "NETWORK_UNAVAILABLE": Darwin errno 65 (EHOSTUNREACH), errno 51 (ENETUNREACH), errno 50 (ENETDOWN), errno 64 (EHOSTDOWN).
      - "CAMERA_UNREACHABLE": Connection refused (errno 61) or socket timeout.
      - "REACHABLE": Successfully connected to TCP socket.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.5)
    try:
        s.connect((host, port))
        return "REACHABLE", f"TCP connection established to {host}:{port}"
    except socket.timeout:
        return "CAMERA_UNREACHABLE", f"TCP connection timed out to {host}:{port}"
    except OSError as e:
        if e.errno in (errno.EHOSTUNREACH, errno.ENETUNREACH, errno.ENETDOWN, 64):
            return "NETWORK_UNAVAILABLE", f"Network route unavailable (errno {e.errno}: {os.strerror(e.errno)}) - verify Mac Wi-Fi / hotspot"
        if e.errno == errno.ECONNREFUSED:
            return "CAMERA_UNREACHABLE", f"Port {port} refused connection (errno 61)"
        return "CAMERA_UNREACHABLE", f"Connection error (errno {e.errno}: {os.strerror(e.errno)})"
    finally:
        try:
            s.close()
        except Exception:
            pass


def check_camera_status_category(gateway_status: Optional[Dict[str, any]] = None) -> Tuple[str, str]:
    """
    Check camera status categorized strictly as:
      - "NETWORK_UNAVAILABLE": Wi-Fi route not available to camera subnet.
      - "CAMERA_UNREACHABLE": Route exists, but camera IP is unreachable/unresponsive.
      - "STREAM_STALE": Hardware reachable, but stream has stalled.
      - "LIVE": Verified live stream with advancing real frames.
      - Gateway state (e.g. "RECOVERY_FAILED", "OFFLINE", "POWER_CYCLE_REQUIRED").
    Returns (category, detail_message).
    """
    route_status, route_msg = check_network_route_status()
    if route_status == "NETWORK_UNAVAILABLE":
        return "NETWORK_UNAVAILABLE", route_msg
    if route_status != "REACHABLE":
        return "CAMERA_UNREACHABLE", route_msg

    # Check camera HTTP /status
    cam_ok, cam_msg = check_camera_reachable()
    if not cam_ok:
        return "CAMERA_UNREACHABLE", f"Hardware unreachable on HTTP: {cam_msg}"

    # Query Vision Gateway's view if not provided
    if gateway_status is None and check_gateway_healthy():
        try:
            req = urllib.request.Request(GATEWAY_STATUS_URL)
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                gateway_status = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            return "GATEWAY_UNAVAILABLE", f"Failed to query gateway: {e}"

    if gateway_status:
        is_live = bool(
            gateway_status.get("is_camera_live")
            and gateway_status.get("real_frame_count", 0) > 0
            and not gateway_status.get("is_stale")
        )
        if is_live:
            return "LIVE", "Camera is streaming live real frames"
        if gateway_status.get("is_stale"):
            return "STREAM_STALE", "Stream socket open but no fresh frames arriving"
        rec_stat = gateway_status.get("recovery_status", "OFFLINE")
        return rec_stat, gateway_status.get("current_failure_reason") or "Camera stream is not live"

    return "STREAM_OFFLINE", "Gateway has not established stream"


# ==============================================================================
# Service Lifecycle Control
# ==============================================================================

def clean_stale_backend_processes() -> None:
    """Detect and safely terminate confirmed stale PresenceTrack backend processes on port 8080."""
    pids = get_pids_on_port(BACKEND_PORT)
    for pid in pids:
        cmd = get_process_cmd(pid)
        if is_project_backend_process(pid, cmd):
            safe_terminate_process(pid, "Website Backend")
        else:
            logger.warning("Unrelated process holding port %d (PID %d: %s); skipping termination", BACKEND_PORT, pid, cmd[:60])

    if BACKEND_PID_FILE.exists():
        try:
            stored_pid = int(BACKEND_PID_FILE.read_text().strip())
            if stored_pid not in pids and is_pid_alive(stored_pid):
                cmd = get_process_cmd(stored_pid)
                if is_project_backend_process(stored_pid, cmd):
                    safe_terminate_process(stored_pid, "Website Backend (from PID file)")
        except Exception:
            pass
        BACKEND_PID_FILE.unlink(missing_ok=True)


def clean_stale_gateway_processes() -> None:
    """Detect and safely terminate confirmed stale Vision Gateway processes on port 8001."""
    pids = get_pids_on_port(GATEWAY_PORT)
    for pid in pids:
        cmd = get_process_cmd(pid)
        if is_project_gateway_process(pid, cmd):
            safe_terminate_process(pid, "Vision Gateway")
        else:
            logger.warning("Unrelated process holding port %d (PID %d: %s); skipping termination", GATEWAY_PORT, pid, cmd[:60])

    if GATEWAY_PID_FILE.exists():
        try:
            stored_pid = int(GATEWAY_PID_FILE.read_text().strip())
            if stored_pid not in pids and is_pid_alive(stored_pid):
                cmd = get_process_cmd(stored_pid)
                if is_project_gateway_process(stored_pid, cmd):
                    safe_terminate_process(stored_pid, "Vision Gateway (from PID file)")
        except Exception:
            pass
        GATEWAY_PID_FILE.unlink(missing_ok=True)


def start_backend(timeout_sec: float = 15.0) -> bool:
    """
    Start the Website Backend (TanStack Start / Vite) using existing project configuration.
    Waits for HTTP readiness check before returning.
    """
    if check_backend_healthy():
        logger.info("Website Backend is already healthy on http://localhost:%d", BACKEND_PORT)
        return True

    logger.info("Initiating Website Backend startup...")
    clean_stale_backend_processes()
    if not wait_for_port_available(BACKEND_PORT, timeout_sec=5.0):
        logger.error("Port %d is still occupied; cannot start Website Backend", BACKEND_PORT)
        return False

    with open(BACKEND_LOG_FILE, "a", encoding="utf-8") as out:
        out.write(f"\n--- [Supervisor] Starting Backend at {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
        out.flush()
        proc = subprocess.Popen(
            ["npm", "run", "dev"],
            cwd=str(PROJECT_ROOT),
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            env=os.environ.copy(),
            start_new_session=True,
        )

    BACKEND_PID_FILE.write_text(str(proc.pid))
    logger.info("Website Backend spawned (PID %d). Awaiting readiness...", proc.pid)

    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if check_backend_healthy():
            logger.info("Website Backend verified READY on http://localhost:%d (PID %d)", BACKEND_PORT, proc.pid)
            return True
        if proc.poll() is not None:
            logger.error("Website Backend exited prematurely with code %d. See logs at %s", proc.returncode, BACKEND_LOG_FILE)
            BACKEND_PID_FILE.unlink(missing_ok=True)
            return False
        time.sleep(0.5)

    logger.error("Website Backend failed to respond within %.1fs timeout", timeout_sec)
    return False


def start_gateway(timeout_sec: float = 15.0) -> bool:
    """
    Start the Vision Gateway (FastAPI / Uvicorn).
    Enforces that Website Backend must be up and ready first.
    Waits for HTTP readiness check before returning.
    """
    if not check_backend_healthy():
        logger.info("Backend is not ready; starting Website Backend before Vision Gateway...")
        if not start_backend():
            logger.error("Cannot start Vision Gateway because Website Backend failed to become ready")
            return False

    if check_gateway_healthy():
        logger.info("Vision Gateway is already healthy on http://localhost:%d/health", GATEWAY_PORT)
        return True

    logger.info("Initiating Vision Gateway startup...")
    clean_stale_gateway_processes()
    if not wait_for_port_available(GATEWAY_PORT, timeout_sec=5.0):
        logger.error("Port %d is still occupied; cannot start Vision Gateway", GATEWAY_PORT)
        return False

    with open(GATEWAY_LOG_FILE, "a", encoding="utf-8") as out:
        out.write(f"\n--- [Supervisor] Starting Vision Gateway at {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
        out.flush()
        proc = subprocess.Popen(
            [str(GATEWAY_VENV_PYTHON), "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", str(GATEWAY_PORT)],
            cwd=str(GATEWAY_DIR),
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            env=os.environ.copy(),
            start_new_session=True,
        )

    GATEWAY_PID_FILE.write_text(str(proc.pid))
    logger.info("Vision Gateway spawned (PID %d). Awaiting readiness...", proc.pid)

    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if check_gateway_healthy():
            logger.info("Vision Gateway verified READY on http://localhost:%d/health (PID %d)", GATEWAY_PORT, proc.pid)
            return True
        if proc.poll() is not None:
            logger.error("Vision Gateway exited prematurely with code %d. See logs at %s", proc.returncode, GATEWAY_LOG_FILE)
            GATEWAY_PID_FILE.unlink(missing_ok=True)
            return False
        time.sleep(0.5)

    logger.error("Vision Gateway failed to respond within %.1fs timeout", timeout_sec)
    return False


def stop_backend() -> None:
    """Gracefully stop the Website Backend."""
    logger.info("Stopping Website Backend...")
    clean_stale_backend_processes()
    wait_for_port_available(BACKEND_PORT, timeout_sec=3.0)


def stop_gateway() -> None:
    """Gracefully stop the Vision Gateway."""
    logger.info("Stopping Vision Gateway...")
    clean_stale_gateway_processes()
    wait_for_port_available(GATEWAY_PORT, timeout_sec=3.0)


def stop_all() -> None:
    """Stop both Vision Gateway and Website Backend cleanly."""
    stop_gateway()
    stop_backend()
    logger.info("All PresenceTrack services stopped.")


def start_all() -> bool:
    """Sequence startup: Website Backend first, then Vision Gateway."""
    logger.info("Starting PresenceTrack services in strict sequence...")
    if not start_backend():
        return False
    if not start_gateway():
        return False
    logger.info("PresenceTrack stack successfully started and verified healthy.")
    return True


def restart_all() -> bool:
    """Restart both services cleanly."""
    logger.info("Restarting PresenceTrack services...")
    stop_all()
    time.sleep(1.0)
    return start_all()


# ==============================================================================
# Camera Stream Recovery Trigger
# ==============================================================================

def trigger_camera_reconnect(force: bool = True) -> Dict[str, any]:
    """Trigger gateway camera stream recovery endpoint with device key."""
    if not check_gateway_healthy():
        return {"success": False, "message": "Vision Gateway is offline"}

    device_key = os.getenv("ESP32_DEVICE_KEY", "")
    url = f"http://localhost:{GATEWAY_PORT}/camera/reconnect?force={'true' if force else 'false'}"
    headers = {"Content-Type": "application/json"}
    if device_key:
        headers["x-device-key"] = device_key

    req = urllib.request.Request(url, method="POST", headers=headers, data=b"{}")
    try:
        with urllib.request.urlopen(req, timeout=8.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data
    except Exception as e:
        return {"success": False, "message": f"Reconnect request failed: {e}"}


# ==============================================================================
# Status Reporting
# ==============================================================================

def get_status_report() -> Dict[str, any]:
    """Aggregate detailed status of all components."""
    backend_ok = check_backend_healthy()
    gateway_ok = check_gateway_healthy()
    camera_ok, camera_msg = check_camera_reachable()
    gateway_camera_status = None
    if gateway_ok:
        try:
            req = urllib.request.Request(GATEWAY_STATUS_URL)
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                gateway_camera_status = json.loads(resp.read().decode("utf-8"))
        except Exception:
            pass

    category, cat_msg = check_camera_status_category(gateway_status=gateway_camera_status)

    backend_pids = get_pids_on_port(BACKEND_PORT)
    gateway_pids = get_pids_on_port(GATEWAY_PORT)

    return {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "services": {
            "backend": {
                "port": BACKEND_PORT,
                "healthy": backend_ok,
                "listening_pids": backend_pids,
                "url": BACKEND_HEALTH_URL,
            },
            "gateway": {
                "port": GATEWAY_PORT,
                "healthy": gateway_ok,
                "listening_pids": gateway_pids,
                "url": GATEWAY_HEALTH_URL,
            },
        },
        "camera": {
            "host": CAMERA_HOST,
            "port": CAMERA_PORT,
            "category": category,
            "category_message": cat_msg,
            "physically_reachable": camera_ok,
            "ping_message": camera_msg,
            "gateway_status": gateway_camera_status,
        },
    }


def print_status_table() -> None:
    """Print human-readable status table to stdout."""
    rep = get_status_report()
    b = rep["services"]["backend"]
    g = rep["services"]["gateway"]
    c = rep["camera"]

    print("\n" + "=" * 65)
    print(" PresenceTrack AI — Supervisor System Status")
    print("=" * 65)
    print(f"Timestamp: {rep['timestamp']}\n")

    print(f"1. Website Backend (Port {b['port']}):")
    print(f"   Status:   {'ONLINE [READY]' if b['healthy'] else 'OFFLINE / UNHEALTHY'}")
    print(f"   PIDs:     {b['listening_pids'] or 'None'}")
    print(f"   Endpoint: {b['url']}")

    print(f"\n2. Vision Gateway (Port {g['port']}):")
    print(f"   Status:   {'ONLINE [READY]' if g['healthy'] else 'OFFLINE / UNHEALTHY'}")
    print(f"   PIDs:     {g['listening_pids'] or 'None'}")
    print(f"   Endpoint: {g['url']}")

    print(f"\n3. Physical Camera ({c['host']}:{c['port']}):")
    print(f"   Category: {c['category']}")
    print(f"   Detail:   {c['category_message']}")
    print(f"   Hardware: {'REACHABLE' if c['physically_reachable'] else 'UNREACHABLE (' + c['ping_message'] + ')'}")

    if c["gateway_status"]:
        gs = c["gateway_status"]
        is_live = bool(gs.get("is_camera_live") and gs.get("real_frame_count", 0) > 0 and not gs.get("is_stale"))
        stream_str = "LIVE" if is_live else ("STREAM STALE" if gs.get("is_stale") else "OFFLINE")
        print(f"   Stream:   {stream_str}")
        print(f"   FPS:      {gs.get('actual_fps', 0):.1f} (Real frames: {gs.get('real_frame_count', 0)})")
        print(f"   State:    {gs.get('recovery_status', 'UNKNOWN')}")
        if gs.get("current_failure_reason"):
            print(f"   Reason:   {gs.get('current_failure_reason')}")
    else:
        print("   Stream:   UNKNOWN (Gateway offline)")

    print("=" * 65 + "\n")


# ==============================================================================
# Persistent Supervisor Daemon Loop
# ==============================================================================

class SupervisorDaemon:
    """
    Continuous background supervisor watchdog loop.
    Enforces service health, detects Mac wake, handles auto-recovery.
    """

    def __init__(self, check_interval_sec: float = 10.0):
        self.check_interval_sec = check_interval_sec
        self.running = False
        self.backend_fail_count = 0
        self.gateway_fail_count = 0
        self.camera_fail_count = 0
        self.next_camera_recovery_time = 0.0
        self.last_healthy_reset = time.time()
        self.last_loop_time = time.time()
        self.lock_fd: Optional[int] = None

    def acquire_single_instance_lock(self) -> bool:
        """Prevent multiple supervisor instances using non-blocking flock."""
        try:
            self.lock_fd = os.open(str(SUPERVISOR_LOCK_FILE), os.O_CREAT | os.O_RDWR, 0o644)
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            SUPERVISOR_PID_FILE.write_text(str(os.getpid()))
            return True
        except (IOError, OSError):
            return False

    def release_lock(self) -> None:
        """Release single-instance lock upon shutdown."""
        if self.lock_fd is not None:
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
                os.close(self.lock_fd)
            except Exception:
                pass
        SUPERVISOR_PID_FILE.unlink(missing_ok=True)

    def handle_signal(self, signum, frame):
        """Handle termination signals gracefully."""
        logger.info("Termination signal (%d) received. Shutting down supervisor daemon...", signum)
        self.running = False

    def run(self) -> None:
        """Main monitoring loop."""
        if not self.acquire_single_instance_lock():
            logger.error("Another supervisor daemon instance is already active. Exiting.")
            sys.exit(1)

        signal.signal(signal.SIGINT, self.handle_signal)
        signal.signal(signal.SIGTERM, self.handle_signal)

        logger.info("Supervisor Daemon started (PID %d, interval %.1fs).", os.getpid(), self.check_interval_sec)
        self.running = True

        # Initial startup pass
        start_all()

        while self.running:
            try:
                now = time.time()
                time_delta = now - self.last_loop_time
                self.last_loop_time = now

                # Detect Mac wake: if loop took significantly longer than expected interval,
                # system was likely suspended/asleep.
                if time_delta > (self.check_interval_sec * 2.5):
                    logger.info("Mac sleep/wake detected (time delta: %.1fs). Awaiting network route before camera recovery...", time_delta)
                    self.backend_fail_count = 0
                    self.gateway_fail_count = 0
                    self.camera_fail_count = 0
                    self.next_camera_recovery_time = 0.0

                    # Wait up to 10 seconds for network route to become available post-wake
                    route_ready = False
                    for _ in range(10):
                        route_stat, _ = check_network_route_status()
                        if route_stat != "NETWORK_UNAVAILABLE":
                            route_ready = True
                            break
                        time.sleep(1.0)

                    if not check_backend_healthy():
                        logger.info("Post-wake: starting Website Backend...")
                        start_backend()
                    if not check_gateway_healthy():
                        logger.info("Post-wake: starting Vision Gateway...")
                        start_gateway()

                    if route_ready and check_gateway_healthy():
                        logger.info("Network route restored post-wake. Triggering stream reconnect...")
                        trigger_camera_reconnect(force=True)
                    else:
                        logger.info("Post-wake: route not yet ready or gateway offline; daemon loop will handle when route returns.")

                # 1. Check Backend
                if not check_backend_healthy():
                    self.backend_fail_count += 1
                    backoff = min(30.0, 2.0 ** min(self.backend_fail_count, 5))
                    logger.warning(
                        "Website Backend is offline (failure #%d). Initiating recovery with %.1fs backoff...",
                        self.backend_fail_count,
                        backoff,
                    )
                    time.sleep(backoff)
                    start_backend()
                else:
                    if self.backend_fail_count > 0:
                        logger.info("Website Backend has recovered and is healthy.")
                        self.backend_fail_count = 0

                # 2. Check Vision Gateway
                if not check_gateway_healthy():
                    self.gateway_fail_count += 1
                    backoff = min(30.0, 2.0 ** min(self.gateway_fail_count, 5))
                    logger.warning(
                        "Vision Gateway is offline (failure #%d). Initiating recovery with %.1fs backoff...",
                        self.gateway_fail_count,
                        backoff,
                    )
                    time.sleep(backoff)
                    start_gateway()
                else:
                    if self.gateway_fail_count > 0:
                        logger.info("Vision Gateway has recovered and is healthy.")
                        self.gateway_fail_count = 0

                # 3. Check Camera Link (if gateway is up)
                if check_gateway_healthy():
                    cat, cat_msg = check_camera_status_category()
                    if cat == "LIVE":
                        if self.camera_fail_count > 0:
                            logger.info("Camera stream is healthy and LIVE. Resetting failure counter.")
                        self.camera_fail_count = 0
                        self.next_camera_recovery_time = 0.0
                    elif cat == "NETWORK_UNAVAILABLE":
                        # Network route unavailable - wait for Wi-Fi / hotspot to reconnect without hammering
                        logger.debug("Network route unavailable to %s:%d (%s) - waiting for route...", CAMERA_HOST, CAMERA_PORT, cat_msg)
                    else:
                        # STREAM_STALE, CAMERA_UNREACHABLE, RECOVERY_FAILED, OFFLINE, etc.
                        if now >= self.next_camera_recovery_time:
                            self.camera_fail_count += 1
                            backoff = min(60.0, 5.0 * (2.0 ** min(self.camera_fail_count - 1, 4)))
                            self.next_camera_recovery_time = now + backoff
                            logger.warning(
                                "Camera stream is not live (category: %s, failure #%d: %s). Attempting stream reconnect (next backoff: %.1fs)...",
                                cat,
                                self.camera_fail_count,
                                cat_msg,
                                backoff,
                            )
                            trigger_camera_reconnect(force=True)

                # Reset failure counts after 5 minutes of continuous stability
                if now - self.last_healthy_reset > 300.0:
                    if check_backend_healthy() and check_gateway_healthy():
                        self.backend_fail_count = 0
                        self.gateway_fail_count = 0
                        self.camera_fail_count = 0
                    self.last_healthy_reset = now

            except Exception as e:
                logger.error("Unexpected error in supervisor loop: %s", e, exc_info=True)

            # Sleep in small slices to respond promptly to termination signals
            sleep_slices = int(self.check_interval_sec * 5)
            for _ in range(sleep_slices):
                if not self.running:
                    break
                time.sleep(0.2)

        self.release_lock()
        logger.info("Supervisor Daemon shut down cleanly.")


# ==============================================================================
# CLI Entry Point
# ==============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="PresenceTrack AI — Local Process Supervisor & Automatic Recovery Engine",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "action",
        choices=["start", "stop", "restart", "status", "daemon", "recover-camera"],
        help="Supervisor action to perform",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output status as structured JSON",
    )

    args = parser.parse_args()

    if args.action == "start":
        success = start_all()
        sys.exit(0 if success else 1)
    elif args.action == "stop":
        stop_all()
        sys.exit(0)
    elif args.action == "restart":
        success = restart_all()
        sys.exit(0 if success else 1)
    elif args.action == "status":
        if args.json:
            print(json.dumps(get_status_report(), indent=2))
        else:
            print_status_table()
        sys.exit(0)
    elif args.action == "daemon":
        daemon = SupervisorDaemon(check_interval_sec=8.0)
        daemon.run()
    elif args.action == "recover-camera":
        res = trigger_camera_reconnect(force=True)
        print(json.dumps(res, indent=2))
        sys.exit(0 if res.get("success") else 1)


if __name__ == "__main__":
    main()
