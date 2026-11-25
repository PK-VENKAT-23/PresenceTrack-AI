# PresenceTrack AI — Physical Camera & Platform Demonstration Runbook

**Document Version:** 1.0.0 (Pre-Flight Freeze)
**Scheduled Execution:** Tomorrow
**Project Workspace:** `/Users/venkatpk/Downloads/project_vh`
**Target Hardware:** AI-Thinker ESP32-CAM (GC2145 / OV2640) + HW-381 Micro-USB Daughterboard
**Target Network:** Android Mobile Hotspot (SSID: `hari`)

---

## 1. System Parameters & Configuration Baseline

| Component | Target Address / Endpoint | Protocol / Role | Credentials / Keys |
| :--- | :--- | :--- | :--- |
| **Android Hotspot** | SSID: `hari` (2.4 GHz) | Wi-Fi Access Point | Hotspot password configured in `config.h` |
| **ESP32-CAM Node** | `http://10.204.175.1:81` | MJPEG Stream (`/stream`), Status (`/status`) | `x-device-key` header |
| **Vision Gateway** | `http://localhost:8001` | FastAPI / OpenCV SFace pipeline | Internal token / CORS localhost |
| **Website Backend** | `http://localhost:8080` | TanStack Start / Vinxi / Vite | Supabase Project `ljmrmeivrjmhuoyzrqrz` |
| **Supervisor** | LaunchAgent `com.presencetrack.supervisor` | Daemon / Port 8080 & 8001 monitor | Auto-healing on sleep/wake |

### Mandatory Safety Gates:
- `AUTO_BIOMETRIC_ATTENDANCE_ENABLED=false` (Strictly enforced: biometric transits recorded as security boundary events, not auto-clock-ins).
- Verification Cosine Similarity: $\ge 0.70$ (Canonical database transit threshold).
- Preliminary Tracking Threshold: $0.45$ with $\ge 2$ consecutive frames (Visual bounding box association only).
- Database Migrations 0004 & 0005: Authored locally, **not applied remotely**.

---

## 2. Step-by-Step Startup Sequence

### Step 1: Initialize Network
1. On your Android smartphone, enable the Portable Hotspot with SSID **`hari`**.
2. On your Mac, join the **`hari`** Wi-Fi network.
3. Confirm Mac IP assignment:
   ```bash
   ipconfig getifaddr en0
   ```
   *Expected output: An IP address within the `10.204.175.x` subnet.*

### Step 2: Power Up ESP32-CAM
1. Connect the ESP32-CAM + HW-381 assembly to a powered USB port or 5V 2A power brick using a quality Micro-USB cable.
2. Wait 5–8 seconds for the ESP32-CAM to complete boot and associate with the `hari` hotspot.
3. Verify hardware reachability from your Mac terminal:
   ```bash
   ping -c 2 10.204.175.1
   curl -s http://10.204.175.1:81/status
   ```
   *Expected output: Valid JSON reporting sensor details (GC2145/OV2640) and stream status.*

### Step 3: Verify and Start Local Services
1. Inspect the service supervisor status:
   ```bash
   cd /Users/venkatpk/Downloads/project_vh
   ./scripts/status.sh
   ```
2. If backend or gateway are not yet running, execute the clean start command:
   ```bash
   ./scripts/start.sh
   ```
3. Re-run `./scripts/status.sh` to confirm:
   - Backend on Port 8080: `HEALTHY` (PID displayed)
   - Vision Gateway on Port 8001: `HEALTHY` (PID displayed)
   - Physical Camera: `REACHABLE` / `STREAM_LIVE`

---

## 3. Demonstration Walkthrough by Role

Open Google Chrome and navigate to: **`http://localhost:8080`**

### A. Security Operations Enclave (`/enclave/security`)
1. **Live Camera Feed & HUD:**
   - Observe the live video feed from `ESP32-CAM-01-NORTH`.
   - The status badge will show **`LIVE`** (Green) with real-time FPS counter (~10–15 FPS).
2. **Fresh-Frame Verification Test:**
   - Click the **"Refresh Camera"** button on the Camera Control Card.
   - Confirm that the system performs a genuine 5-second verification window and reports `Reconnection verified with fresh frames`.
3. **Facial Tracking & Boundary Crossing:**
   - Stand or walk across the optical threshold in front of the ESP32-CAM.
   - Observe the dynamic canvas bounding box:
     - Multi-frame tracker associates identity across $\ge 2$ consecutive frames at $0.45$.
     - Identity confirmation and boundary transit event fire only when cosine similarity reaches $\ge 0.70$.
     - Unrecognized or low-confidence faces ($< 0.70$) are classified as `UNKNOWN` and logged to `unknown_detections`.

### B. Employee Portal Enclave (`/enclave/employee`)
1. **Personal Dwell & Attendance:**
   - View computed check-in times and zone transitions computed by database triggers.
2. **DPDP Act 2023 Privacy Controls:**
   - View active consent notice and data processing purpose specifications.
   - Demonstrate the **"Revoke Consent"** or **"Request Data Erasure"** workflow.
   - Note: Once consent is revoked, the Vision Gateway instantly ignores subsequent optical detections (HTTP 403).

### C. HR Operations Enclave (`/enclave/hr`)
1. **Roster & Presence Reconciliation:**
   - View the active workforce roster, on-site personnel count, and zone occupancy.
2. **Grievance Triage:**
   - Review employee submissions regarding attendance corrections or privacy concerns.

### D. Super Admin / DPO Enclave (`/enclave/admin`)
1. **Hardware Topology:**
   - View the centralized node registry (`ESP32-CAM-01-NORTH`).
2. **Immutable Audit Logs:**
   - Review the security audit log showing boundary events, system logins, and supervisor interventions.
   - Confirm zero plain-text passwords or biometric vectors appear in log entries.

---

## 4. Emergency Troubleshooting & Recovery Commands

| Symptom | Cause | Solution Command |
| :--- | :--- | :--- |
| **"CAMERA OFFLINE" / Error 65** | Hotspot disconnected or ESP32 lost Wi-Fi | 1. Ensure hotspot `hari` is active.<br>2. Power-cycle ESP32-CAM.<br>3. Run `ping -c 2 10.204.175.1`.<br>4. Click "Refresh Camera" in dashboard. |
| **Port 8080 or 8001 busy** | Stale processes after sleep | Run `./scripts/restart.sh` (Safely stops and restarts only PresenceTrack processes). |
| **ESP32 single-client lock** | Old socket connection hanging | Query status endpoint: `curl -s http://10.204.175.1:81/status`. Power-cycle ESP32 if socket is wedged. |
| **Check logs in real-time** | Diagnose gateway or backend issues | Backend: `tail -f logs/backend.log`<br>Gateway: `tail -f logs/gateway.log`<br>Supervisor: `tail -f logs/supervisor.log` |

---

## 5. Post-Demonstration Clean Shutdown

When the demonstration concludes:
```bash
cd /Users/venkatpk/Downloads/project_vh
./scripts/stop.sh
```
*Stops website backend and vision gateway cleanly while leaving the supervisor daemon available.*
