# PresenceTrack AI — Phase 4: Controlled Migration-Readiness & Execution Plan

**Document Version:** 1.0.0
**Generated Date:** 2026-11-14
**Project Workspace:** `/Users/venkatpk/Downloads/project_vh`
**Target Supabase Project:** Ref `ljmrmeivrjmhuoyzrqrz` (`https://ljmrmeivrjmhuoyzrqrz.supabase.co`)
**Strict Prohibition:** Never connect to or reference legacy project `tfirnoogvpychhfeglnc`.
**Execution Status:** **PLANNING AND DOCUMENTATION ONLY — NO DATABASE CONNECTIONS OR MUTATIONS PERFORMED.**

---

## 1. Executive Summary & Audit Baseline

Phase 3 concluded with the execution of the authoritative read-only audit specification [`scratch/audit_v10.sql`](file:///Users/venkatpk/.gemini/antigravity/brain/7b5318e9-811e-44c4-8968-299234dc859f/scratch/audit_v10.sql) against the target Supabase instance `ljmrmeivrjmhuoyzrqrz`. The findings provide an unambiguous baseline of the live system:

1. **Engine & Runtime:** PostgreSQL **17.11** running on 64-bit architecture in primary (non-replica) mode (`is_read_replica = false`).
2. **Application Tables:** All **11 expected application tables are completely ABSENT** from the `public` schema (`enterprise_users`, `user_roles`, `esp32_camera_nodes`, `passive_transits`, `employee_daily_dwell`, `merkle_audit_blocks`, `dpo_erasure_requests`, `departments`, `attendance_records`, `admin_audit_logs`, `unknown_detections`).
3. **Application Types, Routines, and Triggers:** All PresenceTrack custom enums (`app_role`, `zone_type`, `transit_direction`, `attendance_status`, `invitation_status`), security helper routines (`has_role`, `has_any_role`, `protect_last_super_admin`, `current_enterprise_user_id`), and event triggers are completely absent.
4. **Supabase Core Auth Infrastructure:** `auth.users` exists; `auth.uid()` exists; the visible user count in `auth.users` is **0** (clean auth state).
5. **Realtime Infrastructure:** `supabase_realtime` publication exists but contains **zero published tables**.
6. **Migration Tracking Relations:** Both tracking tables (`supabase_migrations.schema_migrations` and `drizzle.__drizzle_migrations`) are **ABSENT**.
7. **Prerequisite Matrix (Statement 12):** Evaluated all 28 structural checks across the three migration tiers:
   - **SATISFIED:** **10** (all 5 checks for `0000`, 2 checks for `0001`, 3 checks for `0002`).
   - **ABSENT:** **17** (3 checks for `0001` and 14 checks for `0002`, each expecting objects defined by earlier migrations).
   - **NOT_APPLICABLE:** **1** (`0002-1.A.3`: `invitation_status` is not pre-existing, which is a clean valid state).
   - **INCOMPATIBLE:** **0** (Zero structural or naming collisions exist).

**Conclusion:** The live database is in a clean, compatible slate ready for sequential forward migration.

---

## 2. Migration Files Integrity & Inventory

All migration files are located under [`drizzle/migrations/`](file:///Users/venkatpk/Downloads/project_vh/drizzle/migrations). Their contents and cryptographic checksums are immutable:

| Migration File | SHA-256 Checksum | Line Count | Status |
| :--- | :--- | :---: | :---: |
| [`drizzle/migrations/0000_presencetrack_schema.sql`](file:///Users/venkatpk/Downloads/project_vh/drizzle/migrations/0000_presencetrack_schema.sql) | `259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b` | 345 | **IMMUTABLE BASELINE** |
| [`drizzle/migrations/0001_attendance_backend_expansion.sql`](file:///Users/venkatpk/Downloads/project_vh/drizzle/migrations/0001_attendance_backend_expansion.sql) | `cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee` | 296 | **IMMUTABLE BASELINE** |
| [`drizzle/migrations/0002_auth_security_hardening.sql`](file:///Users/venkatpk/Downloads/project_vh/drizzle/migrations/0002_auth_security_hardening.sql) | `01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271` | 1,214 | **VERIFIED SPECIFICATION** |
| [`drizzle/migrations/meta/_journal.json`](file:///Users/venkatpk/Downloads/project_vh/drizzle/migrations/meta/_journal.json) | Tracks entries 0, 1, and 2 under version 7 dialect `postgresql` | 23 | **ALIGNED** |

---

## 3. Migration Dependency, Conflict & Security Analysis

```
┌────────────────────────────────────────────────────────────────────────┐
│               0000_presencetrack_schema.sql                            │
│  Prerequisites: auth.users, auth.uid(), gen_random_uuid(), realtime    │
│  Creates: app_role, zone_type, transit_direction                       │
│           user_roles, enterprise_users, esp32_camera_nodes,            │
│           passive_transits, employee_daily_dwell, merkle_audit_blocks, │
│           dpo_erasure_requests                                         │
│           has_role, has_any_role, protect_last_super_admin             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Satisfies 0001-P1, P2, P3
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               0001_attendance_backend_expansion.sql                   │
│  Prerequisites: 0000 baseline tables & enums                           │
│  Creates: departments, attendance_status, attendance_records,          │
│           admin_audit_logs, unknown_detections                         │
│  Alters: enterprise_users, esp32_camera_nodes                          │
│  Adds to publication: attendance_records, unknown_detections, logs     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Satisfies 0002-1.B.x, 1.C.x, etc.
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               0002_auth_security_hardening.sql                         │
│  Prerequisites: Verified defensively by internal 18-check DO block     │
│  Alters: admin_audit_logs.actor_id DROP NOT NULL                       │
│  Creates: invitation_status, lower(email) unique expression index      │
│  Replaces: statement-level & row-level super admin protection          │
│  Installs: assign_user_role_atomic, hardened has_role/has_any_role,    │
│            handle_verified_auth_user & dedicated auth.users triggers   │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Tier 1: Migration 0000 (`0000_presencetrack_schema.sql`)
- **Dependencies:** Requires Supabase `auth.users` relation, `auth.uid()` function, `pg_catalog.gen_random_uuid()`, and `supabase_realtime` publication.
- **Audit Status:** All 5 prerequisites are **SATISFIED** on `ljmrmeivrjmhuoyzrqrz`.
- **Created Artifacts:**
  - Enums: `public.app_role` (`employee`, `hr_ops`, `security`, `super_admin`), `public.zone_type`, `public.transit_direction`.
  - Tables (7): `user_roles`, `enterprise_users`, `esp32_camera_nodes`, `passive_transits`, `employee_daily_dwell`, `merkle_audit_blocks`, `dpo_erasure_requests`.
  - Routines: `has_role`, `has_any_role`, `protect_last_super_admin`, `current_enterprise_user_id`, `handle_verified_auth_user`, `apply_transit`, `exercise_erasure`, `restore_consent`, `approve_erasure_request`.
  - Triggers: `user_roles_protect_last_admin`, `on_auth_user_verified` on `auth.users`, `passive_transits_apply`.
  - RLS: Enables RLS on all 7 tables with 12 access policies.

### 3.2 Tier 2: Migration 0001 (`0001_attendance_backend_expansion.sql`)
- **Dependencies:** Directly references and extends tables, types, and functions created in `0000`.
- **Audit Status:** Currently reports 3 ABSENT checks (`0001-P1`, `0001-P2`, `0001-P3`), which will be **100% SATISFIED** immediately upon execution of `0000`.
- **Created Artifacts:**
  - Enums: `public.attendance_status`.
  - Tables (4): `public.departments`, `public.attendance_records`, `public.admin_audit_logs`, `public.unknown_detections`.
  - Table Alterations: Adds department foreign keys and employment metadata to `enterprise_users`; adds streaming configuration columns to `esp32_camera_nodes`.
  - Realtime Publication: Publishes `attendance_records`, `unknown_detections`, and `admin_audit_logs`.
  - RLS: Enables RLS across all 4 new tables with 7 access policies.

### 3.3 Tier 3: Migration 0002 (`0002_auth_security_hardening.sql`)
- **Dependencies & Pre-Conditions:**
  - Contains an embedded, self-auditing defensive PL/pgSQL block (Lines 4–361) verifying all 18 prerequisite invariants before making any DDL mutations.
  - Requires `admin_audit_logs` from `0001` and `enterprise_users`/`user_roles` from `0000`.
- **Created & Hardened Artifacts:**
  - Relaxes `admin_audit_logs.actor_id` nullability (`DROP NOT NULL`) to accommodate system actions and `ON DELETE SET NULL`.
  - Validates absence of duplicate normalized emails in `enterprise_users`.
  - Creates `public.invitation_status` enum (`STAGED`, `DISPATCH_PENDING`, `DISPATCHED`, `LINKED`, `RECONCILIATION_REQUIRED`) and backfills existing profiles.
  - Creates case-insensitive unique index `enterprise_users_lower_email_idx` on `lower(email)`.
  - Installs statement-level lock trigger `acquire_global_super_admin_lock_stmt()` to serialize concurrent role modifications.
  - Replaces `protect_last_super_admin()` with a concurrency-safe implementation and adds `protect_last_super_admin_profile()` to forbid deactivating the sole active Super Admin.
  - Installs atomic role mutation RPC `assign_user_role_atomic()`.
  - Hardens `has_role` and `has_any_role` to query `public.user_roles` directly.
  - Replaces the legacy `on_auth_user_verified` trigger on `auth.users` with two dedicated, decoupled triggers (`on_auth_user_created_confirmed` and `on_auth_user_email_confirmed`), ensuring idempotent linking without circular trigger execution.

---

## 4. Uncertainty Flags: Missing Migration Tracking Tables

> [!WARNING]
> **CRITICAL OPERATOR NOTICE ON MIGRATION HISTORY UNCERTAINTY**
> The live audit confirmed that neither `supabase_migrations.schema_migrations` nor `drizzle.__drizzle_migrations` exists in the database.
>
> 1. **Absence Does Not Mean Clean History:** The absence of tracking tables proves only that those specific relations were not found. It does not prove that unmanaged SQL was never executed.
> 2. **Catalog Invariant Verification Replaces History Assumptions:** Because tracking history is absent, we do NOT assume the database was never touched. Instead, we rely strictly on the **direct catalog inspection** (Sections 2–10) and the **Prerequisite Matrix** (Section 12), which proved that all 11 application tables and custom types are truly absent from schema `public`.
> 3. **Risk of Future Tool Drift:** If migrations are applied manually via the Supabase Dashboard SQL Editor without recording entries into a tracking table, future invocations of `drizzle-kit migrate` or `supabase db push` will attempt to re-apply `0000`, resulting in immediate failure (`relation "user_roles" already exists`).
> 4. **Mitigation:** The execution plan includes explicit steps to record migration completion in both tracking formats (`drizzle.__drizzle_migrations` and `supabase_migrations.schema_migrations`), ensuring future CLI and tooling interoperability.

---

## 5. Controlled Execution Plan

The execution plan is split into five distinct, strictly sequential phases. **Each phase has explicit preconditions and stop conditions.**

### Phase A: Local Isolated PostgreSQL 17 Validation (Zero Remote Impact)

*Goal:* Validate the entire three-migration sequential rollout, rollback scenarios, and first Super Admin provisioning in a fresh, isolated local PostgreSQL 17 disposable cluster before touching Supabase.

1. **Preconditions:**
   - Ephemeral port allocated; isolated data directory in `/tmp`.
   - Migration files verified against checksums:
     - `0000`: `259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b`
     - `0001`: `cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee`
     - `0002`: `01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271`
2. **Execution Steps:**
   - Initialize disposable PG17 cluster (`initdb -E UTF8 --no-locale`).
   - Mock Supabase base environment (`auth.users`, `auth.uid()`, `supabase_realtime` publication, standard roles `anon`, `authenticated`, `service_role`).
   - Apply `0000_presencetrack_schema.sql` inside a transaction block (`BEGIN; ... COMMIT;`).
   - Run Section 12 checks for 0001 $\to$ Confirm all 5 checks transition to `SATISFIED`.
   - Apply `0001_attendance_backend_expansion.sql` inside a transaction block.
   - Run Section 12 checks for 0002 $\to$ Confirm all 18 checks transition to `SATISFIED`.
   - Apply `0002_auth_security_hardening.sql` inside a transaction block.
   - Execute the complete 22-statement audit from `audit_v10.sql` $\to$ Confirm 100% of prerequisites are `SATISFIED`.
   - Test Super Admin bootstrap sequence and last-admin protection triggers.
3. **Validation Checkpoint:** Process exits with code `0`, and zero errors occur.
4. **Stop Condition:** Any syntax error, transaction abort, or unfulfilled prerequisite immediately aborts testing. Cluster is destroyed.

---

### Phase B: Live Supabase Migration Preparation (Read-Only)

*Goal:* Final live preflight confirmation immediately prior to authorized migration execution.

1. **Preconditions:**
   - Operator logged into Supabase Dashboard at:
     ```text
     https://supabase.com/dashboard/project/ljmrmeivrjmhuoyzrqrz
     ```
   - Target project confirmed: `ljmrmeivrjmhuoyzrqrz`.
   - Legacy project `tfirnoogvpychhfeglnc` confirmed NOT active.
2. **Execution Steps:**
   - Run Statement 1.1 (Lines 29–34) $\to$ Confirm `server_version_num` is $\ge 170000$.
   - Run Statement 1.2 (Lines 37–43) $\to$ Confirm `current_user` is `postgres` and `is_read_replica` is `false`.
   - Run Statement 12 (Lines 442–1073) $\to$ Re-verify that all 5 checks for `0000` (`0000-P1` through `0000-P5`) are `SATISFIED`.
   - Prepare clean migration query tabs in the SQL Editor.
3. **Validation Checkpoint:** Preflight outputs match Phase 3 audit baseline exactly.
4. **Stop Condition:** If any unexpected table exists or if `is_read_replica = true`, STOP IMMEDIATELY.

---

### Phase C: Live Migration Execution (REQUIRES SEPARATE OPERATOR AUTHORIZATION)

*Goal:* Execute migrations 0000, 0001, and 0002 sequentially with intermediate transactional verification.

> [!IMPORTANT]
> Every migration step must be wrapped in `BEGIN ... COMMIT;` to guarantee full atomicity. If any error occurs, PostgreSQL automatically rolls back the entire transaction block.

#### Step C.1: Apply Migration 0000
1. In SQL Editor Tab 1, execute:
   ```sql
   BEGIN;
   -- Paste exact contents of drizzle/migrations/0000_presencetrack_schema.sql
   COMMIT;
   ```
2. **Intermediate Validation Checkpoint C.1:**
   - Run Statement 4.1 $\to$ Confirm 7 tables exist (`enterprise_users`, `user_roles`, `esp32_camera_nodes`, `passive_transits`, `employee_daily_dwell`, `merkle_audit_blocks`, `dpo_erasure_requests`).
   - Run Statement 12 for `0001` $\to$ Confirm checks `0001-P1`, `0001-P2`, and `0001-P3` are now `SATISFIED`.
3. **Stop Condition:** If any statement in 0000 fails, transaction aborts. Do not proceed to 0001.

#### Step C.2: Apply Migration 0001
1. In SQL Editor Tab 2, execute:
   ```sql
   BEGIN;
   -- Paste exact contents of drizzle/migrations/0001_attendance_backend_expansion.sql
   COMMIT;
   ```
2. **Intermediate Validation Checkpoint C.2:**
   - Run Statement 4.1 $\to$ Confirm 11 tables now exist (now includes `departments`, `attendance_records`, `admin_audit_logs`, `unknown_detections`).
   - Run Statement 10.3 $\to$ Confirm `attendance_records`, `unknown_detections`, `admin_audit_logs` are members of `supabase_realtime`.
   - Run Statement 12 for `0002` $\to$ Confirm all 18 checks for 0002 are now `SATISFIED`.
3. **Stop Condition:** If any statement in 0001 fails, transaction aborts. Do not proceed to 0002.

#### Step C.3: Apply Migration 0002
1. In SQL Editor Tab 3, execute:
   ```sql
   BEGIN;
   -- Paste exact contents of drizzle/migrations/0002_auth_security_hardening.sql
   COMMIT;
   ```
2. **Intermediate Validation Checkpoint C.3:**
   - Run Statement 3.1 $\to$ Confirm `invitation_status` enum exists with 5 labels.
   - Run Statement 5.2 $\to$ Confirm `enterprise_users_lower_email_idx` is present, valid, and unique.
   - Run Statement 7.1 $\to$ Confirm triggers `on_auth_user_created_confirmed` and `on_auth_user_email_confirmed` are active on `auth.users`, and `user_roles_protect_admin_stmt` is active on `user_roles`.
3. **Stop Condition:** If any check in the defensive DO block or any statement fails, transaction aborts.

#### Step C.4: Record Migration History
To prevent future tool drift with Drizzle Kit and Supabase CLI:
```sql
BEGIN;
-- Initialize Drizzle tracking table and record migrations
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES
  ('259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b', 1794057325415),
  ('cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee', 1794057325416),
  ('01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271', 1794057325417);

-- Initialize Supabase CLI tracking table and record migrations
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  name text,
  applied_at timestamptz DEFAULT now()
);
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('20261114000000', '0000_presencetrack_schema'),
  ('20261114000001', '0001_attendance_backend_expansion'),
  ('20261114000002', '0002_auth_security_hardening');
COMMIT;
```

---

### Phase D: First Super Admin Provisioning (REQUIRES SEPARATE AUTHORIZATION)

*Goal:* Provision the initial Super Admin account without violating `protect_last_super_admin()`, email verification invariants, or RBAC segregation rules.

> [!CAUTION]
> **GOVERNANCE RULE (AGENTS.md):**
> - Roles live ONLY in `public.user_roles` (one row per user) and are checked with `has_role`/`has_any_role`. NEVER store roles in auth metadata or profile columns.
> - `enterprise_users.id` is the person ID; `auth_user_id` links a sign-in ONLY after email verification via `on_auth_user_verified` / `on_auth_user_email_confirmed`.

1. **Step D.1: Create & Verify Auth User:**
   - In Supabase Dashboard $\to$ **Authentication** $\to$ **Users** $\to$ **Invite / Add user**.
   - Enter administrative email (e.g., `admin@presencetrack.local` or designated organization admin).
   - Check **"Auto-confirm user"** so that `email_confirmed_at` is populated immediately upon creation.
   - Note the generated `id` (UUID) from the Auth Users table.
2. **Step D.2: Automatic Profile Creation Verification:**
   - The trigger `on_auth_user_created_confirmed` executes immediately upon insert.
   - Verify that a linked row exists in `public.enterprise_users`:
     ```sql
     SELECT id, auth_user_id, email, is_active, invitation_status
     FROM public.enterprise_users
     WHERE auth_user_id = '<ADMIN_AUTH_UUID>';
     ```
   - Expected: `invitation_status = 'LINKED'`, `is_active = true`.
3. **Step D.3: Assign Initial Super Admin Role:**
   - Assign the role in `public.user_roles` via SQL Editor:
     ```sql
     INSERT INTO public.user_roles (user_id, role)
     VALUES ('<ADMIN_AUTH_UUID>', 'super_admin');
     ```
4. **Step D.4: Clearance Verification:**
   - Test the database authorization function:
     ```sql
     SELECT public.has_role('<ADMIN_AUTH_UUID>', 'super_admin') AS is_super_admin;
     ```
   - Must return `true`.
5. **Step D.5: Super Admin Invariant Verification:**
   - Attempt to remove the sole Super Admin in a test rollback block:
     ```sql
     BEGIN;
     DELETE FROM public.user_roles WHERE user_id = '<ADMIN_AUTH_UUID>';
     -- Expected: Fails with exception 'Cannot remove the last super_admin'
     ROLLBACK;
     ```
   - Confirm exception code `P0001` is raised and delete is blocked.

---

### Phase E: Post-Migration Security & Application Validation Tests

*Goal:* Verify full operational readiness, API access paths, and hardware endpoints.

1. **Test E.1: Complete Re-Audit with audit_v10.sql**
   - Execute Statements 1.1 through 13.2 in sequence.
   - **Statement 12 Checkpoint:** All 28 checks must report `SATISFIED`. Zero `ABSENT` or `INCOMPATIBLE` rows.
   - **Statement 11.1 Checkpoint:** Tracking tables report `table_exists = true` and `has_select_privilege = true`.
   - **Optional Queries B & C:** Execute and confirm migration history records match.
   - **Optional Query A:** Confirm `visible_auth_users_count` is $\ge 1$ and `confirmed_users_count` is $\ge 1$.
2. **Test E.2: RLS Isolation & Role Boundary Tests**
   - Execute client query as role `anon`:
     - `SELECT * FROM public.enterprise_users` $\to$ Returns 0 rows (permission denied / RLS empty).
     - `SELECT * FROM public.user_roles` $\to$ Returns 0 rows.
     - `SELECT * FROM public.admin_audit_logs` $\to$ Returns 0 rows.
   - Execute client query as authenticated Super Admin:
     - Can query own profile and all audit logs.
3. **Test E.3: Hardware ESP32 Public Ingestion Path**
   - Confirm route `/api/public/esp32/*` correctly validates `x-device-key` header against `ESP32_DEVICE_KEY`.
   - Verify that inserts into `public.passive_transits` trigger `apply_transit` to update dwell minutes and zone states.

---

## 6. Rollback Considerations & Emergency Recovery

Because each migration step is wrapped in `BEGIN ... COMMIT;`, any runtime failure during execution automatically rolls back to the previous stable checkpoint. However, if a migration succeeds and an operational fault is identified post-commit:

1. **Rollback Strategy for 0002:**
   - Execute a reverse DDL transaction:
     - Drop dedicated triggers on `auth.users` (`on_auth_user_created_confirmed`, `on_auth_user_email_confirmed`).
     - Drop statement-level lock triggers on `user_roles` and `enterprise_users`.
     - Revert `has_role`, `has_any_role`, and `protect_last_super_admin` to their 0000 definitions.
     - Drop `assign_user_role_atomic()` RPC.
     - Drop `enterprise_users_lower_email_idx` index.
     - Drop `invitation_status` column and enum type.
     - Re-add `NOT NULL` constraint to `admin_audit_logs.actor_id`.
2. **Rollback Strategy for 0001:**
   - Remove tables from `supabase_realtime` publication (`attendance_records`, `unknown_detections`, `admin_audit_logs`).
   - Drop tables in reverse dependency order: `unknown_detections`, `admin_audit_logs`, `attendance_records`, `departments`.
   - Drop enum `public.attendance_status`.
   - Drop added columns from `enterprise_users` and `esp32_camera_nodes`.
3. **Rollback Strategy for 0000:**
   - Drop public tables in reverse foreign key order: `dpo_erasure_requests`, `merkle_audit_blocks`, `employee_daily_dwell`, `passive_transits`, `esp32_camera_nodes`, `enterprise_users`, `user_roles`.
   - Drop enums: `transit_direction`, `zone_type`, `app_role`.
   - Drop functions in `public`.

---

## 7. Open Questions & Governance Decisions

Prior to requesting final authorization for Phase C (Live Execution), the operator must resolve the following organizational items:

1. **Initial Super Admin Identity:** Confirm the exact corporate email address that will receive the first Super Admin invite in Step D.1.
2. **Migration History Tracking Standard:** Confirm whether to maintain tracking records in `drizzle.__drizzle_migrations`, `supabase_migrations.schema_migrations`, or both (recommended: both for universal tool compatibility).
3. **Firmware Key Coordination:** Confirm that `ESP32_DEVICE_KEY` has been provisioned in Supabase Secrets for edge device authentication before live attendance recording begins.

---

**Plan Status:** **PREPARED AND VERIFIED — AWAITING SEPARATE USER AUTHORIZATION PRIOR TO ANY LIVE DATABASE OPERATIONS.**
