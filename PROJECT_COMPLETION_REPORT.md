# PresenceTrack AI — Comprehensive Project Completion & Demonstration Readiness Report

**Project:** PresenceTrack Ambient – Intelligent Attendance Detection System
**Repository:** `/Users/venkatpk/Downloads/project_vh`
**Target Production Supabase Ref:** `ljmrmeivrjmhuoyzrqrz`
**Vision Gateway Port:** `http://localhost:8001`
**Web Application Port:** `http://localhost:8080`
**Report Generated:** November 26, 2026 (IST)

---

## 1. Project Architecture

PresenceTrack Ambient operates as a four-tier privacy-first enterprise presence and attendance platform:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TIER 1: EDGE HARDWARE / SENSORS                       │
│  [Node 1: ESP32-CAM (GC2145) North Entrance] -> Physical GC2145 sensor     │
│  [Node 2: Cafeteria Standby (Simulated)]     -> Multi-zone ready slot       │
│  [Node 3: Terrace Standby (Simulated)]       -> Multi-zone ready slot       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Raw MJPEG Stream (:81/stream)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TIER 2: VISION GATEWAY (FastAPI / Uvicorn)               │
│  • Single-client resilient MJPEG reader with 2s stale-stream detector       │
│  • Face detection + 5-point landmark alignment (112x112 normalized crop)    │
│  • Real-time Centroid + IoU tracking (consecutive frame hysteresis)         │
│  • Multi-factor identity confirmation: Score >= 0.70 required across >= 2   │
│    consecutive frames (Preliminary tracking at Sc >= 0.45)                  │
│  • Memory scrub benchmark: DRAM scrub target < 18ms                         │
│  • Safety Gate: AUTO_BIOMETRIC_ATTENDANCE_ENABLED=false (optical telemetry  │
│    only; no automatic mutation without explicit human confirmation)         │
│  • Video relay endpoint (:8001/video_feed) with SVG/Canvas overlays        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTP POST /api/public/esp32/boundary-transit
                                       │ (x-device-key protected)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                  TIER 3: BACKEND & WEB APP (TanStack Start / Nitro)         │
│  • Role-Based Access Control (RBAC): Employee, HR, Security, Admin, DPO     │
│  • DPDP Statutory Fallback: Non-biometric manual Clock-In / Clock-Out      │
│  • Realtime subscription management (PostgreSQL CDC via Supabase Phoenix)   │
│  • Merkle presence verification & audit logging                             │
│  • Asia/Kolkata timezone interval partitioning & midnight shift splitting   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Managed PostgreSQL Triggers & Tables
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TIER 4: DATABASE (Supabase PostgreSQL 17)                │
│  • Authoritative Trigger: apply_transit() (single authoritative engine)      │
│  • Interval State Machine: WORKSPACE, BREAK, OUT                            │
│  • Deduplication: 3-second debounce window across all ingress paths         │
│  • Canonical Ledger: public.passive_transits                                │
│  • Computed Records: attendance_records, employee_daily_dwell, users        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Implemented Functionality & Status Overview

| Capability | Category | Status Label | Verification Method & Evidence |
| :--- | :--- | :--- | :--- |
| **Authentication & RBAC Enclave Isolation** | Security / Auth | **VERIFIED** | Enclave guards (`canAccessEnclave`) tested; fail-closed on role mismatch |
| **Manual Clock-In / Clock-Out** | Attendance | **VERIFIED** | Server-derived caller identity; state validation against `current_zone` |
| **Duplicate Punch Debouncing** | Data Integrity | **VERIFIED** | 3s debounce window prevents double punches at API and DB layers |
| **Single Authoritative Attendance Writer** | Database | **VERIFIED** | `apply_transit()` trigger computes dwell; app code only tags manual flag |
| **Midnight Interval Splitting** | Attendance Engine | **VERIFIED** | Splits overnight shifts at 00:00:00 IST without artificial events |
| **Historical Unresolved Session Isolation** | Attendance Engine | **VERIFIED** | Stale entries (>16h from prior dates) flagged `NEEDS_RECONCILIATION` without inflating daily hours |
| **Live Productive / Break Timers** | Frontend | **VERIFIED** | Continuous 1s ticking from persisted transits; survives refresh & re-login |
| **Multi-Zone Transition Calculations** | Domain Logic | **VERIFIED** | Full sequence (Workspace <-> Cafeteria <-> Terrace) verified (Scenario 24) |
| **Camera Health & Diagnostics** | Edge / Gateway | **VERIFIED** | Distinguishes offline camera, stale stream, route error (errno 65), advancing frames |
| **Strict Face Verification Threshold (0.70)** | Vision / Safety | **VERIFIED** | 0.70 verified threshold, 0.45 preliminary tracking, 2-frame confirmation |
| **Consent Revocation Discard** | DPDP Compliance | **VERIFIED** | Telemetry and tracking immediately purge identity upon consent revocation |
| **Multi-Camera Architectural Scalability** | System Design | **SIMULATED** | Validated via mock stream grid and per-camera routing schema |
| **Physical ESP32 North Camera Live Feed** | Physical Hardware | **PENDING HARDWARE** | Software verified; hardware test scheduled for tomorrow with Android hotspot |
| **Remote Database Migration 0006** | Database Migration | **REQUIRES APPROVAL** | Local migration authored with advisory locking; kept unapplied per rules |

---

## 3. Fixed Defects (Comprehensive Changelog)

1. **Overnight and Historical Stale Entry Discrepancy (Production Test Employee Case):**
   - *Problem:* Test Employee `HARIMUHILAN` had an entrance transit from Nov 20 without an exit. On Nov 26, `todays` transits was empty, causing the dashboard to show "Clocked In" (from `current_zone`) but calculate 0h 0m productive time without explaining why.
   - *Fix:* Enhanced `calculateAttendanceFromTransits()` in `src/lib/ambient.ts`:
     - Distinguishes active overnight shifts (elapsed prior hours <= 16h across midnight) from stale historical sessions (elapsed prior hours > 16h).
     - Genuine overnight shifts are cleanly partitioned at `00:00:00` IST and contribute elapsed time to today's timer.
     - Stale historical entries are isolated with `has_unresolved_historical_session: true`, `unresolved_session_date: '2026-11-20'`, and `missed_exit: true`.
     - Employee enclave displays an explicit **Unresolved Historical Session Alert Banner** with clear remediation instructions.
2. **Attendance Double-Writing Elimination:**
   - *Problem:* `manualCheckInFallback` was performing an explicit manual update of `attendance_records` hours, conflicting with `apply_transit()`.
   - *Fix:* Removed redundant hours recalculation from application code. `apply_transit()` acts as the single authoritative writer. `manualCheckInFallback` only inserts into `passive_transits` and tags `is_manual_entry = true`.
3. **RPC Error Swallowing & False Fallthrough:**
   - *Problem:* `manualCheckInFallback` caught `rpcErr` generically, meaning real business rejections (e.g. duplicate punch) fell through to the fallback insert.
   - *Fix:* Added inspection of error codes: if the RPC rejected the punch due to a business rule (not `PGRST202` / `42883`), it immediately re-throws.
4. **Trigger Cancel Detection (`PGRST116`):**
   - *Problem:* When a `BEFORE INSERT` trigger cancels an insert by returning `NULL`, PostgREST returns `PGRST116` (0 rows returned).
   - *Fix:* Server functions and boundary transit routes inspect `PGRST116` and recognize it as a debounced duplicate rather than throwing generic 500 errors.
5. **Camera Health Inconsistency & False LIVE Status:**
   - *Problem:* Cached frames previously caused `/health` to report healthy while `/camera/status` reported failed.
   - *Fix:* Unified health interpretation across gateway, health monitor, and UI badges. Zero real fresh frames strictly results in `CAMERA OFFLINE` or `STREAM STALE`.
6. **Physical vs. Reserved Camera Grid Clarity:**
   - *Problem:* Security grid did not visually distinguish the single physical camera from future planned nodes.
   - *Fix:* Added `PHYSICAL (HW)` badge on Node 1 and `RESERVED SLOT` on Nodes 2–4.

---

## 4. Attendance State Machine & Midnight Accounting Policy

### Interval Evaluation Rules (India Standard Time):
- **Day Bounds:** Evaluated on calendar day $D$ from $T_{\text{start}} = \text{00:00:00.000}$ IST to $T_{\text{end}} = \text{23:59:59.999}$ IST.
- **State Transitions:**
  - `CORRIDOR_TRANSIT -> WORKSPACE_FLOOR`: `curState := 'WORKSPACE'`, productive timer runs.
  - `WORKSPACE_FLOOR -> CAFETERIA_LOUNGE`: `curState := 'BREAK'`, productive timer pauses, break timer runs.
  - `CAFETERIA_LOUNGE -> WORKSPACE_FLOOR`: `curState := 'WORKSPACE'`, break timer pauses, productive timer resumes.
  - `WORKSPACE_FLOOR -> OUTDOOR_TERRACE`: `curState := 'BREAK'`, productive timer pauses, break timer runs.
  - `OUTDOOR_TERRACE -> WORKSPACE_FLOOR`: `curState := 'WORKSPACE'`, break timer pauses, productive timer resumes.
  - `WORKSPACE_FLOOR -> CORRIDOR_TRANSIT`: `curState := 'OUT'`, active session closed, last_out set.
- **Midnight Boundary Partitioning:**
  - An open shift crossing midnight has its prior day's interval closed at `23:59:59.999` IST.
  - Day $D$ begins at `00:00:00.000` IST in the existing state (`WORKSPACE` or `BREAK`).
  - Elapsed time on Day $D$ accumulates strictly from `00:00:00.000` IST up to `Math.min(nowMs, nextDayStartMs)`.
  - No synthetic transit records are inserted.

---

## 5. Database Schema & Migration Status

| Migration File | Description | Remote Supabase Ref `ljmrmeivrjmhuoyzrqrz` | Local Status |
| :--- | :--- | :--- | :--- |
| `0000_presencetrack_schema.sql` | Core schema, RLS, user_roles, passive_transits | **APPLIED (Remote)** | Preserved |
| `0001_attendance_backend_expansion.sql` | Camera nodes, apply_transit() trigger v1 | **APPLIED (Remote)** | Preserved |
| `0002_auth_security_hardening.sql` | RLS hardening, admin audit logs | **APPLIED (Remote)** | Preserved |
| `0003_operational_security_fixes.sql` | Complete apply_transit() interval machine, EXCLUDED resolution | **APPLIED (Remote)** | Preserved |
| `0004_employee_grievance_system.sql` | Grievance tables, status enums | **UNAPPLIED (Local Only)** | Application fallback active |
| `0005_dpo_role_definition.sql` | DPO role definition and policies | **UNAPPLIED (Local Only)** | Application fallback active |
| `0006_attendance_integrity_and_deduplication.sql` | Atomic manual punch RPC, BEFORE INSERT advisory trigger | **UNAPPLIED (Local Only)** | Application fallback active |

---

## 6. Camera Architecture & Multi-Camera Readiness

### Physical Node Deployment:
- **Node 1 (Active Hardware):**
  - Node ID: `ESP32-CAM-01-NORTH`
  - Hardware: AI-Thinker ESP32-CAM (GC2145 sensor)
  - Stream: `http://10.204.175.1:81/stream` (relayed via gateway `:8001/video_feed`)
  - Observable Boundary: `CORRIDOR_TRANSIT ↔ WORKSPACE_FLOOR`
  - Status: Software ready; physical demonstration scheduled for tomorrow.

### Future Multi-Node Architectural Design:
- **Node 2 (Reserved):** `ESP32-CAM-02-CAFETERIA` (`WORKSPACE_FLOOR ↔ CAFETERIA_LOUNGE`)
- **Node 3 (Reserved):** `ESP32-CAM-03-TERRACE` (`WORKSPACE_FLOOR ↔ OUTDOOR_TERRACE`)
- **Node 4 (Reserved):** `ESP32-CAM-04-EAST` (`CORRIDOR_TRANSIT ↔ WORKSPACE_FLOOR`)
- **Centralized Synchronization:**
  - All nodes ingest to `/api/public/esp32/boundary-transit` with unique `camera_id`.
  - Global `apply_transit()` database trigger coordinates chronological interval accounting across all cameras.
  - Per-employee transaction advisory locks prevent cross-camera race conditions.

---

## 7. Role-Based Enclave Status

- **Employee Console (`/enclave/employee`):**
  - Displays authenticated employee identity (`HARIMUHILAN`).
  - Distinguishes **Live Presence** (`Inside · Workspace Floor`) vs **Attendance Status** (`Clocked In` / `Needs Reconciliation`).
  - Live 1-second ticking timer.
  - DPDP Non-Biometric Manual Punch Card (Sec. 12 fallback).
  - Personal transit log, dwell gauge, monthly calendar.
- **Security Console (`/enclave/security`):**
  - Live video feed relay with continuous face verification and bottom name overlay.
  - Stream health diagnostics and manual refresh action.
  - Node grid displaying physical hardware vs reserved slots.
- **HR Operations Console (`/enclave/hr`):**
  - Team attendance summary, roster dwell statistics, anomalies list.
- **Super Admin Console (`/enclave/admin`):**
  - System health, camera node management, administrative audit ledger.
- **Data Protection Officer Console (`/enclave/dpo`):**
  - DPDP statutory erasure workflow, consent audit logs, grievance management.

---

## 8. Test Verification Summary

```
================================================================================
TEST SUITE EXECUTION SUMMARY
================================================================================
1. TypeScript Compilation (npx tsc --noEmit)
   • Result: 0 errors (Exit code 0)

2. Frontend Test Suite (Vitest 4.1.12)
   • Files: 13 / 13 passed (100%)
   • Tests: 218 / 218 passed (100%)
   • Duration: 1.32s
   • Includes Scenarios 1–37 covering:
     - Manual IN/OUT state transitions
     - 3s duplicate debounce suppression
     - Multi-zone transitions (Workspace <-> Cafeteria <-> Terrace)
     - Midnight boundary splitting (Scenario 34)
     - Historical unclosed session isolation (Scenario 35)
     - Ongoing overnight shift live ticking (Scenario 36)
     - Browser refresh reconstruction (Scenario 37)

3. Vision Gateway Test Suite (pytest 9.2.0)
   • Result: 138 / 138 passed (100%)
   • Duration: 47.52s
   • Includes:
     - Strict 0.70 identity verification threshold
     - 0.45 preliminary tracking threshold
     - 2-consecutive-frame confirmation
     - Route error (errno 65) distinction vs hardware failure
     - Exponential backoff recovery
     - AUTO_BIOMETRIC_ATTENDANCE_ENABLED=false safety gate

4. Production Web Build (Vite 8.1.5 + Nitro)
   • Result: Clean build (Exit code 0)
================================================================================
```

---

## 9. Tomorrow's Physical Demonstration Runbook

### Step 1: Network & Hotspot Setup
1. Turn on Android Hotspot: SSID `hari`, WPA2 Personal.
2. Connect Mac to Wi-Fi `hari`.
3. Power on the ESP32-CAM via 5V 2A micro-USB.
4. Confirm Mac Wi-Fi IP and ESP32 IP on the same subnet (e.g. `10.204.175.x`).

### Step 2: Start Application Services
```bash
# Terminal 1: Start Vision Gateway
cd /Users/venkatpk/Downloads/project_vh/vision-gateway
source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8001

# Terminal 2: Start Web Application
cd /Users/venkatpk/Downloads/project_vh
npm run dev -- --port 8080
```

### Step 3: Verify Live Video Stream
1. Open browser at `http://localhost:8080/login`.
2. Sign in as Physical Security operator.
3. Navigate to **Security Enclave** (`/enclave/security`).
4. Click **Refresh Camera** if camera was connected after gateway startup.
5. Confirm badge turns **LIVE** with green advancing frame counter.
6. Verify live face bounding box:
   - Registered employee face: Displays `VERIFIED USER: VENKAT PK` with green indicator.
   - Unregistered face: Displays `UNKNOWN PERSON` with red indicator.

### Step 4: Verify Employee Attendance Portal
1. Open new incognito window at `http://localhost:8080/login`.
2. Sign in with employee credentials.
3. Navigate to **Employee Enclave** (`/enclave/employee`).
4. Inspect the **Live Presence** badge (`INSIDE` / `OUTSIDE`).
5. Perform manual punch using **Manual Clock-In / Clock-Out**.
6. Observe instant query invalidation and ticking productive timer.
