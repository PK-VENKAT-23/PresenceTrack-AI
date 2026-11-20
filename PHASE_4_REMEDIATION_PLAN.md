# PresenceTrack AI — Phase 4 Remediation Plan (Fourth Review Revision)

**Document Version:** 3.2.0
**Status:** REVISED ARCHITECTURAL REMEDIATION PLAN (OFFLINE ANALYSIS)
**Workspace:** `/Users/venkatpk/Downloads/project_vh`
**Target Database:** Supabase Ref `ljmrmeivrjmhuoyzrqrz` (PostgreSQL 17.11)
**Authoritative Audit Baseline:** [`scratch/audit_v10.sql`](file:///Users/venkatpk/.gemini/antigravity/brain/7b5318e9-811e-44c4-8968-299234dc859f/scratch/audit_v10.sql) (SHA-256: `685b26671bfa2774813408be5eb241d853a13aee0c98329841fbce684ff11456`)
**Strict Safety Mode:** Offline Analysis Only — Zero Database Mutations, Zero CLI Execution, Zero Remote Connections, Zero File Creation/Modification outside this document.

---

## 1. Executive Summary & Fourth-Review Scope

This Version 3.2.0 remediation plan incorporates the complete findings from the fourth architectural and security review. It resolves all ambiguities across the ten core operational domains:

1. **Erasure Scope Validation & Type Strictness:** Implements strict validation of every JSONB array element against the exact allowed scope set, explicitly rejecting unknown keys, non-string types, empty arrays, and NULL with SQLSTATE `22023`. Defines deterministic duplicate-scope deduplication.
2. **Erasure Completion & Verification Invariants:** Eliminates the unconditional default `VERIFIED_PURGED` assignment. Implements independent, per-scope verification queries (including actual audit-ledger pseudonymization verification and persisted tombstone verification). Forbids skipping subject-specific scopes when `_req.user_id` is NULL, requiring explicit error handling.
3. **Tombstone Durability, Retention & Privacy-Safe Identifiers:** Replaces `ON DELETE CASCADE` with `ON DELETE RESTRICT` to ensure tombstones survive erasure-request deletions. Specifies a multi-year durable retention model, documents backup restore replay enforcement (`dpdp_replay_tombstones()`), explains dictionary attack vulnerabilities on raw SHA-256 PII, requires keyed HMAC-SHA256 hashing, verifies `merkle_audit_blocks.block_height` uniqueness, and disables unverified Merkle anchoring claims.
4. **Super Admin Initial Bootstrap Governance:** Prohibits falsely attributing the bootstrap action to the target account; attributes execution to the human operator context. Explicitly blocks bootstrap execution until trusted out-of-band authentication and signature verification are implemented. Verifies the global single-Super-Admin invariant (`count = 0`), preserves all `assign_user_role_atomic()` validation safeguards, and disables non-repudiation claims.
5. **Attendance Engine Full Business Rule Parity:** Delivers an exhaustive field-by-field parity comparison against `0001`'s original `apply_transit()` trigger function. Documents `AFTER INSERT` trigger timing, debounce mechanics, interval calculation, `missed_exit` preservation, continuous work tracking, monotonic OSH compliance flags, live presence updates, and proves why authoritative `EXCLUDED` values prevent sticky historical timestamp corruption.
6. **Department Conjunctive Authorization:** Specifies exact table-level grants (`INSERT, UPDATE, DELETE`) in conjunction with granular RLS policies. Proves mathematically that non-admin authenticated roles are blocked by RLS while unauthenticated sessions are blocked by table grants, demonstrating that grants alone are never sufficient.
7. **JSONB PII Sanitization Engine:** Formalizes case-insensitive key normalization (`lower(key)`), handles NULL `_keys_to_remove` via canonical defaults, specifies comprehensive test cases (nested objects, nested arrays, mixed case, NULL, unexpected keys), and documents that structural key removal cannot detect unstructured PII in string values.
8. **Tombstone Schema Integrity & Identity Separation:** Verifies all referenced schema objects, types, and constraints against immutable migrations `0000` and `0001`. Strictly separates subject identity from requestor identity, and defines deterministic error handling when the subject profile in `enterprise_users` has already been deleted.
9. **Deterministic Concurrency Testing Suite:** Replaces generic SQLSTATE `00000` assertions with explicit post-state validations. Enforces deterministic audit ordering, requires independent TCP connection sockets, and maintains strict separation between database table-locking tests and GoTrue HTTP service behavior.
10. **Comprehensive Timeout Architecture:** Dissects the four PostgreSQL timeout mechanisms, explaining why `idle_in_transaction_session_timeout` does not cap active transactions, and defining the operational interplay between statement timeouts, lock timeouts, and client-side transaction deadlines.

---

## 2. Deep Technical Evaluation of the 10 Remediation Findings

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Remediation Architecture                        │
├────────────────────────────────────────────────────────────────────────┤
│ 0000_presencetrack_schema.sql (Byte-for-byte immutable)               │
│ 0001_attendance_backend_expansion.sql (Byte-for-byte immutable)        │
│ 0002_auth_security_hardening.sql (Immutable verified specification)    │
│ 0003_operational_security_fixes.sql (PROPOSED FORWARD MIGRATION)      │
│   ├── Fix 1: Restrict admin_audit_logs INSERT policy (Drop old policy) │
│   ├── Fix 2: Granular RLS policies & write grants on departments      │
│   ├── Fix 3: Full apply_transit() parity with authoritative EXCLUDED   │
│   ├── Fix 4: Durable dpdp_backup_tombstones (ON DELETE RESTRICT)      │
│   └── Fix 5: Case-insensitive recursive JSONB sanitizer & verifier    │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Finding 1: Comprehensive Timeout Architecture & Pool Protection

- **Severity:** High (Privilege Escalation vs. Denial of Service)
- **Dissection of the Four Timeout Dimensions:**
  1. **`statement_timeout` (e.g. `10000ms`):** Caps the runtime of **each individual SQL statement**. If any single query or DDL statement exceeds this threshold, PostgreSQL aborts the statement with SQLSTATE `57014` (`query_canceled`). It does **not** cap cumulative transaction time.
  2. **`lock_timeout` (e.g. `2000ms`):** Caps how long any single statement will wait in PostgreSQL's lock queue to acquire a conflicting relation or row lock. If the lock is not granted within the threshold, the statement fails with SQLSTATE `55P03` (`lock_not_available`).
  3. **`idle_in_transaction_session_timeout` (e.g. `5000ms`):** Terminates sessions that hold an open transaction but are **idle waiting for the client** to send the next query. It fires with SQLSTATE `25P03`. **Critical limitation:** It does **not** cap actively executing transactions or long-running statements.
  4. **Client-Side Overall Transaction Deadline (e.g. `15000ms`):** An application-level or orchestrator timer (e.g. Node.js `AbortController`). It enforces an absolute wall-clock ceiling across the entire transaction (`BEGIN` to `COMMIT`). If the deadline expires, the client issues `ROLLBACK` or severs the socket connection.
- **Lock Queue Dynamics During `lock_timeout = '2000ms'`:**
  When `LOCK TABLE auth.users IN ACCESS EXCLUSIVE MODE;` is issued:
  - If an existing transaction is reading `auth.users`, it holds an `AccessShareLock`.
  - The migration transaction enters the lock queue behind the active read query.
  - Because `ACCESS EXCLUSIVE` conflicts with all lock modes, **all subsequent incoming read and write queries** against `auth.users` queue behind the migration request.
  - If the active read query finishes within 2,000ms, the migration acquires the lock and proceeds.
  - If the active read query runs longer than 2,000ms, PostgreSQL aborts the migration lock request with error `55P03`.
- **Operational Cancellation, Rollback & Pool Protection:**
  - Upon receiving `55P03`, the migration transaction enters an aborted state. The orchestrator must immediately issue `ROLLBACK;`.
  - Issuing `ROLLBACK;` instantly removes the migration request from PostgreSQL's lock queue, allowing all queued client queries on `auth.users` to resume execution without failure.
  - **Mandatory Pool-Protection Cool-Off:** The migration runner must **never** retry lock acquisition in a tight loop. Tight retry loops re-queue lock requests and cause persistent connection starvation in Supavisor / pgBouncer. A mandatory cool-off period of at least **30 seconds** is enforced before any retry attempt.
- **GoTrue HTTP Service Layer vs. Database Table Locking:**
  Direct SQL insertion into `auth.users` tests only PostgreSQL engine-level table locking. It does **not** simulate the GoTrue HTTP service layer (GoTrue client connection pooling, HTTP request timeouts, retry headers, or email worker queues). Database-level locking pauses queries at the database driver level; GoTrue clients whose requests exceed GoTrue's HTTP gateway timeout will receive HTTP 504 gateway errors.

---

### Finding 2: Initial Super Admin Provisioning & Operator Non-Repudiation

- **Severity:** High (Administrative Lockout / Governance Breach)
- **Separation of Target Super Admin vs. Authorizing Human Operator:**
  - **Target Account:** The user receiving the `super_admin` role (`<DESIGNATED_ADMIN_AUTH_UUID>`).
  - **Authorizing Operator:** The human engineer or deployment pipeline executing the bootstrap procedure.
  - **Correction:** The audit entry in `admin_audit_logs` must **never** attribute `actor_id` to the target account when the action was executed by an external operator. `actor_id` must be set to `NULL` (permissible under `0002#L363`), with operator identity recorded in `metadata`.
- **Global Single-Super-Admin Invariant:**
  To guarantee that the bootstrap procedure cannot be abused to provision secondary Super Admins, the procedure must enforce an explicit global invariant:
  ```sql
  IF (SELECT count(*) FROM public.user_roles WHERE role = 'super_admin'::public.app_role) > 0 THEN
    RAISE EXCEPTION 'Bootstrap Aborted: A Super Admin already exists in the system' USING ERRCODE = '23514';
  END IF;
  ```
- **Preservation of `assign_user_role_atomic()` Safeguards:**
  The bootstrap procedure preserves the exact security invariants established in `0002_auth_security_hardening.sql#L745-L775`:
  1. Statement-level global lock: `pg_advisory_xact_lock(hashtext('global_super_admin_lock'))`.
  2. Per-user advisory lock: `pg_advisory_xact_lock(hashtext('user_role:' || _target_auth_id::text))`.
  3. Row-level locks on `enterprise_users` and `user_roles`.
  4. Active profile validation (`is_active = true`).
  5. Invitation status validation (`invitation_status = 'LINKED'`).
  6. Email matching validation (`lower(auth.users.email) = lower(enterprise_users.email)`).
- **Non-Repudiation & Operational Blocking:**
  - Caller-supplied strings in SQL literals provide **zero cryptographic proof** of operator identity.
  - **Mandatory Policy:** Live execution of the initial Super Admin bootstrap is **strictly blocked** until an external Identity Provider (corporate IdP / Okta / AWS KMS / YubiKey) signature-generation tool and an in-database cryptographic signature verification routine are implemented.
  - Non-repudiation claims remain **disabled** until demonstrated.

---

### Finding 3: Deterministic Concurrency Testing & Scenario C.2 Assertions

- **Severity:** High (Race Condition / Deadlock Risk)
- **Analysis of Lock Hierarchy in `0002`:**
  In [`0002_auth_security_hardening.sql#L745-L755`](file:///Users/venkatpk/Downloads/project_vh/drizzle/migrations/0002_auth_security_hardening.sql#L745-L755), `assign_user_role_atomic()` enforces:
  1. `pg_advisory_xact_lock(hashtext('global_super_admin_lock'))`
  2. `pg_advisory_xact_lock(hashtext('user_role:' || _target_user_id::text))`
  3. Row locks via `SELECT ... FOR UPDATE` on `enterprise_users` and `user_roles`.
- **Deterministic Assertions for Scenario C.2 (Simultaneous Role Mutation on User X):**
  - **Connection Setup:** Two independent TCP client connections (`Conn 1` and `Conn 2`) to the test database.
  - **Initial State:** Target user X holds `role = 'employee'`, `imported_role = 'employee'`.
  - **Execution Sequence:**
    1. `Conn 1` begins transaction and calls `assign_user_role_atomic(UserX, 'security')`.
    2. `Conn 2` begins transaction and calls `assign_user_role_atomic(UserX, 'hr_ops')`.
    3. Test harness queries `pg_stat_activity` to deterministically verify that `Conn 2` is in `wait_event_type = 'Lock'` and `wait_event = 'advisory'` before proceeding.
    4. `Conn 1` commits.
    5. `Conn 2` unblocks, acquires the locks, and completes.
  - **Deterministic Post-State Assertions (Replacing Generic SQLSTATE `00000`):**
    1. Query `public.user_roles`: Assert `role = 'hr_ops'` exactly.
    2. Query `public.enterprise_users`: Assert `imported_role = 'hr_ops'` exactly.
    3. Deterministic Audit Ordering: Query `public.admin_audit_logs WHERE entity_id = '<USER_X>' ORDER BY created_at ASC`:
       - Entry 1: Assert `metadata->>'old_role' = 'employee'` AND `metadata->>'new_role' = 'security'`.
       - Entry 2: Assert `metadata->>'old_role' = 'security'` AND `metadata->>'new_role' = 'hr_ops'`.
       - Assert Entry 1 `created_at` $\le$ Entry 2 `created_at`.
  - **Rejection Scenario:** If `Conn 2` attempts `assign_user_role_atomic(UserX, 'super_admin')`, assert that `Conn 2` raises exact SQLSTATE `28000`.

---

### Finding 4: Direct `admin_audit_logs` Insertion & Permissive Policy Mechanics

- **Severity:** High (Audit Trail Tampering)
- **PostgreSQL Permissive Policy Evaluation:**
  In PostgreSQL Row-Level Security, multiple permissive policies for the same command (`INSERT`) combine with logical **`OR`**:
  $$\text{Permitted} = \text{Policy}_1 \lor \text{Policy}_2 \lor \dots \lor \text{Policy}_n$$
- **Vulnerability Breakdown:**
  - Migration `0001#L109` installed permissive policy `"Admins insert audit logs"`:
    `WITH CHECK (auth.uid() = actor_id)`
  - If migration `0003` adds a new policy without dropping `0001`'s policy:
    $$(\text{auth.uid}() = \text{actor\_id}) \lor (\text{auth.uid}() = \text{actor\_id} \land \text{has\_any\_role}(\dots)) \equiv (\text{auth.uid}() = \text{actor\_id})$$
  - The check reduces to the weaker condition, allowing any unprivileged employee to insert arbitrary audit rows.
- **Required Correction:** Migration `0003` must explicitly `DROP POLICY IF EXISTS "Admins insert audit logs" ON public.admin_audit_logs;` before installing the restricted policy.

---

### Finding 5: DPDP Erasure: Scope Validation, Completion Invariants & Tombstone Durability

- **Severity:** High (Legal Compliance & Cryptographic Integrity)
- **Exact Scope Validation & SQLSTATE 22023:**
  The erasure scope must be validated with extreme type-safety:
  1. Reject `NULL`, non-array JSONB, and empty arrays `[]`.
  2. Iterate through every array element:
     - Element must be JSONB type `string` (reject numbers, booleans, objects, arrays, and null elements).
     - Element must belong strictly to the allowed set: `'biometric_embeddings'`, `'transit_history'`, `'dwell_records'`, `'audit_ledger'`, `'compliant_backup'`.
  3. **Duplicate Handling:** Duplicate elements are deterministically normalized via deduplication (`SELECT array_agg(DISTINCT elem)`).
  4. Any violation raises exception `22023` (`invalid_parameter_value`).
- **Subject Identity vs. Requestor Identity & Missing Profile Handling:**
  - In `0000_presencetrack_schema.sql#L163-L174`, `dpo_erasure_requests.user_id` references `enterprise_users(id)` with `ON DELETE SET NULL`.
  - `_req.user_id` represents the **subject profile**.
  - `_req.requestor_name` and `_req.email` represent the **requestor** (who may be an external legal guardian or DPO).
  - **Handling When Subject Profile is Deleted (`_req.user_id IS NULL`):**
    If `_req.user_id` is NULL, subject-specific operational scopes (`biometric_embeddings`, `transit_history`, `dwell_records`) **cannot** be matched by `user_id`. The function must **not** silently skip them and mark them complete. If `_req.user_id IS NULL`, the function must raise exception `P0009` (`Subject profile missing; operational scopes cannot be verified`).
- **Independent Per-Scope Completion Verification:**
  The unconditional default assignment `status = 'VERIFIED_PURGED'` is eliminated. Completion is tracked independently per scope:
  - `biometric_embeddings`: Query `enterprise_users` where `id = _req.user_id`; verify `enrolled_embedding IS NULL`.
  - `transit_history`: Query `passive_transits`; verify `count(*) = 0` for `user_id = _req.user_id`.
  - `dwell_records`: Query `employee_daily_dwell` and `attendance_records`; verify `count(*) = 0` for `user_id = _req.user_id` and `employee_id = _req.user_id`.
  - `audit_ledger`: Query `admin_audit_logs`; verify zero rows retain un-pseudonymized personal data for `actor_id = _auth_id` or `entity_id = _req.user_id::text`.
  - `compliant_backup`: Query `dpdp_backup_tombstones`; verify tombstone row exists and is committed.
  - **Terminal Status:**
    - If `compliant_backup` is included: Terminal status is `'PURGED_TOMBSTONE_REGISTERED'`.
    - If only operational scopes are included and all verified: Terminal status is `'VERIFIED_PURGED'`.
    - If any verification check fails: Abort transaction with SQLSTATE `P0008` (`verification_failure`). Never assign completion to unverified operations.
- **Tombstone Durability & Privacy-Safe Keyed Hashes:**
  - **Removal of `ON DELETE CASCADE`:** `dpdp_backup_tombstones.request_id` must use `REFERENCES public.dpo_erasure_requests(id) ON DELETE RESTRICT`. Deleting an erasure request must never delete its associated backup tombstone.
  - **Durable Retention Model:** Tombstones are immutable and must be retained permanently or for a minimum of 3 years to cover the full physical backup and archive lifecycle.
  - **Backup Restore Replay Enforcement:** Disaster recovery runbooks must mandate executing `dpdp_replay_tombstones()` prior to routing production traffic to a restored database. This procedure reads active tombstones and purges restored records.
  - **Dictionary Attack Vulnerability of Raw SHA-256:** Raw SHA-256 hashes of predictable strings (corporate email addresses or badge IDs like `PT-000123`) have low entropy ($\approx 20\text{--}30\text{ bits}$) and can be cracked via rainbow tables or brute-force dictionary attacks in seconds.
  - **Keyed Hash Requirement:** Subject identifier hashes must use **keyed HMAC-SHA256** using an enclave-protected master secret key, preventing offline dictionary attacks by unauthorized parties.
- **Merkle Block Key Uniqueness & Anchoring Protocol:**
  - In `0000_presencetrack_schema.sql#L144-L154`, `merkle_audit_blocks.block_height` is `BIGINT PRIMARY KEY` (guaranteed unique).
  - Multiple tombstones can reference the same block height, but each block height represents a unique cryptographic block.
  - **Policy:** The application codebase currently anchors only `passive_transits.vector_hash`. No tombstone anchoring protocol exists. The plan explicitly acknowledges this and prohibits claiming Merkle anchoring of tombstones until an anchoring protocol is authored and tested.

---

### Finding 6: Department Conjunctive Authorization & Sequences

- **Severity:** Medium-High (Super Admin Feature Defect)
- **Conjunctive Authorization Principle:**
  In PostgreSQL with Row-Level Security, data modifications succeed **only** when both layers permit the action:
  $$\text{Authorized} = \text{SQL Table Grant} \land \text{RLS Policy Check}$$
  Grants alone are never sufficient.
- **Table Privileges & RLS Configuration:**
  - Table grant: `GRANT INSERT, UPDATE, DELETE ON public.departments TO authenticated;`
  - Granular RLS policies on `public.departments`:
    - `SELECT`: `FOR SELECT TO authenticated USING (true);`
    - `INSERT`: `FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'super_admin'::public.app_role));`
    - `UPDATE`: `FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'super_admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'super_admin'::public.app_role));`
    - `DELETE`: `FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'super_admin'::public.app_role));`
- **Proof of Containment:**
  - Non-admin authenticated user (`employee`, `hr_ops`, `security`): Holds table grant, but RLS `WITH CHECK` / `USING` evaluates to `false`. `INSERT` fails with RLS check violation; `UPDATE`/`DELETE` modifies 0 rows.
  - Unauthenticated user (`anon`): Holds zero table grants; fails immediately with `42501` at statement entry.
  - Super Admin: Holds table grant AND passes `has_role(..., 'super_admin')`; operation succeeds.
- **Sequence Verification:** `public.departments.id` is `UUID PRIMARY KEY DEFAULT gen_random_uuid()`. **Zero sequence objects exist.** No sequence grant is required.

---

### Finding 7: Attendance Engine Full Parity & Field-by-Field Reconciliation

- **Severity:** Medium (Attendance Accuracy / Work-Hour Accounting)
- **Field-by-Field Parity Comparison Table:**

| Component / Rule | Original `0001` Implementation | Proposed `0003` Implementation | Parity Status | Reconciled Business Logic |
| :--- | :--- | :--- | :---: | :--- |
| **Trigger Timing** | `AFTER INSERT ON public.passive_transits` | `AFTER INSERT ON public.passive_transits` | **Exact** | Trigger executes after transit is safely inserted into table. |
| **Debounce Filter** | Checks `user_id`, `id <> NEW.id`, `direction`, `zone_to`, and `abs(delta) < 3s` | Checks `user_id`, `id <> NEW.id`, `direction`, `zone_to`, and `abs(delta) < 3s` | **Exact** | Suppresses duplicate side-effects from camera bounce within 3 seconds. |
| **Chronological Scan** | Loops all transits for employee on IST date `ORDER BY "timestamp" ASC` | Loops all transits for employee on IST date `ORDER BY "timestamp" ASC` | **Exact** | Chronological evaluation guarantees order-independent calculation. |
| **First IN Detection** | First `ZONE_ENTER` to `WORKSPACE_FLOOR` | First `ZONE_ENTER` to `WORKSPACE_FLOOR` | **Exact** | Earliest workspace entry defines `_first_in`. |
| **Last OUT Detection** | Any `ZONE_EXIT` or transition to `CORRIDOR_TRANSIT` | Any `ZONE_EXIT` or transition to `CORRIDOR_TRANSIT` | **Exact** | Latest departure defines `_last_out`. |
| **Work Interval Calc** | Accumulates `_work_min` in `WORKSPACE_FLOOR` | Accumulates `_work_min` in `WORKSPACE_FLOOR` | **Exact** | Uses interval between transitions. |
| **Break Interval Calc** | Accumulates `_break_min` in `CAFETERIA_LOUNGE` / `OUTDOOR_TERRACE` | Accumulates `_break_min` in `CAFETERIA_LOUNGE` / `OUTDOOR_TERRACE` | **Exact** | Tracks authorized break zones. |
| **Continuous Work** | Resets on break/exit; accumulates in workspace | Resets on break/exit; accumulates in workspace | **Exact** | Evaluates uninterrupted workspace dwell. |
| **Status Evaluation** | `PRESENT` ($\ge 240\text{m}$), `HALF_DAY` ($> 0\text{m}$) | `PRESENT` ($\ge 240\text{m}$), `HALF_DAY` ($> 0\text{m}$) | **Exact** | Preserves standard daily attendance thresholds. |
| **`missed_exit`** | Set to `false` on initial insert; untouched on conflict | Set to `false` on initial insert; untouched on conflict | **Exact** | Preserves manual/nightly audit adjustments. |
| **`first_in` Upsert** | `COALESCE(attendance_records.first_in, EXCLUDED.first_in)` | `EXCLUDED.first_in` | **CORRECTED** | Eliminates bug where early out-of-order transit was ignored. |
| **`last_out` Upsert** | `EXCLUDED.last_out` | `EXCLUDED.last_out` | **Exact** | Updates to latest exit of the chronological day scan. |
| **Work Totals Upsert** | `EXCLUDED.total_work_minutes`, `EXCLUDED.total_break_minutes`, `EXCLUDED.status` | `EXCLUDED.total_work_minutes`, `EXCLUDED.total_break_minutes`, `EXCLUDED.status` | **Exact** | Applies freshly calculated daily totals. |
| **Legacy Dwell Upsert** | Upserts `employee_daily_dwell` | Upserts `employee_daily_dwell` | **Exact** | Maintains OSH compliance cards and backward compatibility. |
| **OSH Compliance Flag** | Monotonic latch: `existing AND (continuous <= 270)` | Monotonic latch: `existing AND (continuous <= 270)` | **Exact** | Once flagged for OSH breach, stays flagged for the day. |
| **`last_transition_time`** | `NEW."timestamp"` | `NEW."timestamp"` | **Exact** | Tracks exact timestamp of the triggering event. |
| **Live Presence Update** | Updates `enterprise_users.current_zone` and `is_in_workspace` | Updates `enterprise_users.current_zone` and `is_in_workspace` | **Exact** | Synchronizes real-time personnel tracking cards. |

- **Why Direct `EXCLUDED` Values Prevent Sticky Historical Corruption:**
  Because the trigger function queries **all** transit events in `passive_transits` for the entire date ordered chronologically, `_first_in` and `_last_out` are computed over the full canonical history.
  If `LEAST` or `GREATEST` were used, deleting or adjusting a false-positive transit would cause the deleted timestamp to remain permanently stuck in `attendance_records`. Direct assignment of `EXCLUDED` values guarantees absolute consistency with the underlying transit log.

---

### Finding 8: Recursive JSONB Sanitization Engine & Test Specifications

- **Severity:** High (Data Protection / PII Leakage)
- **Sanitizer Design:**
  - **Key Normalization:** Keys are compared case-insensitively using `lower(key)`.
  - **NULL Handling:** If `_keys_to_remove` is NULL or empty, the function defaults to a canonical blacklist: `ARRAY['email', 'name', 'phone', 'badge_id', 'ip_address', 'client_ip', 'user_agent', 'device_id']`.
- **Explicit Test Specifications:**
  1. **Nested Objects:** Input `{"actor": {"email": "x@corp.com", "id": 10}}` $\to$ Output `{"actor": {"id": 10}}`.
  2. **Nested Arrays:** Input `{"log": [{"name": "Alice", "role": "admin"}, {"name": "Bob", "role": "dev"}]}` $\to$ Output `{"log": [{"role": "admin"}, {"role": "dev"}]}`.
  3. **Mixed-Case Keys:** Input `{"Email": "x", "IP_Address": "y", "action": "login"}` $\to$ Output `{"action": "login"}`.
  4. **NULL Input:** Input `NULL` or `'null'::jsonb` $\to$ Output `'null'::jsonb`.
  5. **Unexpected Keys / Unstructured PII:** Input `{"notes": "Contact user at alice@corp.com"}` $\to$ Key `"notes"` is retained.
- **Documented Limitation:** Key-based structural sanitization removes targeted keys; it does **not** inspect or redact unstructured PII embedded within arbitrary text strings or under unlisted keys. It must not be claimed as comprehensive unstructured PII elimination.

---

### Finding 9: PostgREST Integration Test Fidelity & Claim Reconciliation

- **Severity:** Medium (Deployment Simulation Gap)
- **Claim Reconciliation:**
  [`test/fixtures/01_supabase_compat.sql#L33-L39`](file:///Users/venkatpk/Downloads/project_vh/test/fixtures/01_supabase_compat.sql#L33-L39) defines `auth.uid()` via `current_setting('request.jwt.claim.sub', true)`.
  The simulation harness must execute:
  ```sql
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '<USER_UUID>';
  SET LOCAL "request.jwt.claim.role" = 'authenticated';
  ```
- **Documented Simulation Boundaries:** Local PostgreSQL test harnesses cannot simulate PostgREST schema cache reloading, GoTrue HTTP service lifecycle, Realtime CDC replication slots, Supavisor/pgBouncer connection pooling semantics, or Supabase Storage bucket APIs.

---

### Finding 10: Migration Runner: PostgreSQL Transactionality vs. Runner Multi-File Support

- **Severity:** High (Rollout Integrity)
- **Engine vs. Runner Semantics:**
  - **PostgreSQL Engine:** Fully supports atomic transactional DDL across multiple files when wrapped in a single `BEGIN ... COMMIT` block.
  - **Migration Runners (Drizzle Kit, Supabase CLI):** Execute and commit migrations file-by-file by default. Executing out-of-the-box commits `0000` in Transaction 1, opening the Super Admin privilege exposure window before `0002` commits in Transaction 3.
- **Runner Status:** The migration runner choice remains **explicitly undecided**. Rollout requires either a custom orchestration wrapper executing all migrations inside a single transaction, or empirical verification of multi-file transaction support in the chosen runner.

---

## 3. Scope & Complete SQL Specification of Forward Migration 0003

**Proposed File:** `drizzle/migrations/0003_operational_security_fixes.sql`
*(Authoring deferred pending Tier 2 authorization)*

```sql
-- ============================================================================
-- Migration: 0003_operational_security_fixes
-- Fixes:
--   1. admin_audit_logs INSERT policy (Drop permissive policy, install strict check)
--   2. departments table write privileges and granular RLS policies
--   3. Recursive case-insensitive JSONB PII sanitization function
--   4. dpdp_backup_tombstones table (ON DELETE RESTRICT, keyed hash identifiers)
--   5. approve_erasure_request() full scope validation, verification & tombstones
--   6. Full apply_transit() parity with authoritative EXCLUDED conflict resolution
-- ============================================================================

-- ── 1. Restrict admin_audit_logs Insert Policy ──────────────────────────────
DROP POLICY IF EXISTS "Admins insert audit logs" ON public.admin_audit_logs;

CREATE POLICY "Admins insert audit logs" ON public.admin_audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = actor_id
    AND public.has_any_role(auth.uid(), ARRAY['super_admin', 'security']::public.app_role[])
  );

-- ── 2. Departments Write Grants & Granular RLS Policies ─────────────────────
GRANT INSERT, UPDATE, DELETE ON public.departments TO authenticated;

DROP POLICY IF EXISTS "Admins manage departments" ON public.departments;

CREATE POLICY "Admins insert departments" ON public.departments
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'::public.app_role));

CREATE POLICY "Admins update departments" ON public.departments
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'::public.app_role));

CREATE POLICY "Admins delete departments" ON public.departments
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'::public.app_role));

-- ── 3. Case-Insensitive Recursive JSONB PII Sanitization Function ────────────
CREATE OR REPLACE FUNCTION public.sanitize_jsonb_pii(
  _data JSONB,
  _keys_to_remove TEXT[] DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  _effective_keys TEXT[];
  _key TEXT;
  _result JSONB := '{}'::jsonb;
  _elem JSONB;
  _item JSONB;
BEGIN
  IF _data IS NULL OR jsonb_typeof(_data) = 'null' THEN
    RETURN 'null'::jsonb;
  END IF;

  IF _keys_to_remove IS NULL OR array_length(_keys_to_remove, 1) IS NULL THEN
    _effective_keys := ARRAY['email', 'name', 'phone', 'badge_id', 'ip_address', 'client_ip', 'user_agent', 'device_id'];
  ELSE
    SELECT array_agg(lower(k)) INTO _effective_keys FROM unnest(_keys_to_remove) k;
  END IF;

  IF jsonb_typeof(_data) = 'object' THEN
    FOR _key, _elem IN SELECT * FROM jsonb_each(_data) LOOP
      IF NOT (lower(_key) = ANY(_effective_keys)) THEN
        _result := _result || jsonb_build_object(_key, public.sanitize_jsonb_pii(_elem, _effective_keys));
      END IF;
    END LOOP;
    RETURN _result;
  ELSIF jsonb_typeof(_data) = 'array' THEN
    _result := '[]'::jsonb;
    FOR _item IN SELECT * FROM jsonb_array_elements(_data) LOOP
      _result := _result || jsonb_build_array(public.sanitize_jsonb_pii(_item, _effective_keys));
    END LOOP;
    RETURN _result;
  ELSE
    RETURN _data;
  END IF;
END;
$$;

-- ── 4. DPDP Backup Tombstones Table (Durable Retention) ─────────────────────
CREATE TABLE IF NOT EXISTS public.dpdp_backup_tombstones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.dpo_erasure_requests(id) ON DELETE RESTRICT,
  subject_enterprise_id UUID NOT NULL,
  subject_auth_id UUID,
  subject_identifier_hashes TEXT[] NOT NULL DEFAULT '{}',
  erasure_scope JSONB NOT NULL,
  tombstone_timestamp TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  merkle_block_height BIGINT REFERENCES public.merkle_audit_blocks(block_height),
  status TEXT NOT NULL DEFAULT 'ACTIVE_TOMBSTONE'
);
GRANT SELECT ON public.dpdp_backup_tombstones TO authenticated;
GRANT ALL ON public.dpdp_backup_tombstones TO service_role;
ALTER TABLE public.dpdp_backup_tombstones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage tombstones" ON public.dpdp_backup_tombstones
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'::public.app_role));

-- ── 5. Hardened approve_erasure_request Function ────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_erasure_request(_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _req public.dpo_erasure_requests%ROWTYPE;
  _auth_id UUID;
  _subject_profile public.enterprise_users%ROWTYPE;
  _raw_scope JSONB;
  _elem JSONB;
  _valid_scopes TEXT[] := ARRAY['biometric_embeddings', 'transit_history', 'dwell_records', 'audit_ledger', 'compliant_backup'];
  _normalized_scopes TEXT[] := '{}';
  _scope_text TEXT;
  _has_backup BOOLEAN := FALSE;
  _tombstone_id UUID;
  _id_hashes TEXT[];
BEGIN
  IF NOT public.has_role(auth.uid(), 'super_admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden: Only super_admin may approve erasure requests' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _req FROM public.dpo_erasure_requests WHERE id = _request_id;
  IF _req.id IS NULL THEN
    RAISE EXCEPTION 'Request not found' USING ERRCODE = 'P0002';
  END IF;

  -- 1. Strict Scope Validation & Deduplication (SQLSTATE 22023)
  _raw_scope := _req.erasure_scope;
  IF _raw_scope IS NULL OR jsonb_typeof(_raw_scope) <> 'array' OR jsonb_array_length(_raw_scope) = 0 THEN
    RAISE EXCEPTION 'Invalid erasure scope: must be a non-empty JSON array' USING ERRCODE = '22023';
  END IF;

  FOR _elem IN SELECT * FROM jsonb_array_elements(_raw_scope) LOOP
    IF jsonb_typeof(_elem) <> 'string' THEN
      RAISE EXCEPTION 'Invalid erasure scope element: all elements must be strings' USING ERRCODE = '22023';
    END IF;
    _scope_text := _elem #>> '{}';
    IF NOT (_scope_text = ANY(_valid_scopes)) THEN
      RAISE EXCEPTION 'Invalid erasure scope value: %', _scope_text USING ERRCODE = '22023';
    END IF;
    IF NOT (_scope_text = ANY(_normalized_scopes)) THEN
      _normalized_scopes := array_append(_normalized_scopes, _scope_text);
    END IF;
  END LOOP;

  -- 2. Verify Subject Identity Resolution
  IF _req.user_id IS NULL THEN
    RAISE EXCEPTION 'Subject profile missing on erasure request; operational scopes cannot be processed' USING ERRCODE = 'P0009';
  END IF;

  SELECT * INTO _subject_profile FROM public.enterprise_users WHERE id = _req.user_id;
  IF _subject_profile.id IS NULL THEN
    RAISE EXCEPTION 'Subject profile % not found in enterprise_users' USING ERRCODE = 'P0009';
  END IF;
  _auth_id := _subject_profile.auth_user_id;

  -- 3. Execute Operational Scopes with Independent Verification
  IF 'biometric_embeddings' = ANY(_normalized_scopes) THEN
    UPDATE public.enterprise_users
    SET enrolled_embedding = NULL, is_active = false
    WHERE id = _req.user_id;
    IF EXISTS (SELECT 1 FROM public.enterprise_users WHERE id = _req.user_id AND enrolled_embedding IS NOT NULL) THEN
      RAISE EXCEPTION 'Verification Failure: Biometric embedding purge failed' USING ERRCODE = 'P0008';
    END IF;
  END IF;

  IF 'transit_history' = ANY(_normalized_scopes) THEN
    DELETE FROM public.passive_transits WHERE user_id = _req.user_id;
    IF EXISTS (SELECT 1 FROM public.passive_transits WHERE user_id = _req.user_id) THEN
      RAISE EXCEPTION 'Verification Failure: Passive transits purge failed' USING ERRCODE = 'P0008';
    END IF;
  END IF;

  IF 'dwell_records' = ANY(_normalized_scopes) THEN
    DELETE FROM public.employee_daily_dwell WHERE user_id = _req.user_id;
    DELETE FROM public.attendance_records WHERE employee_id = _req.user_id;
    IF EXISTS (SELECT 1 FROM public.employee_daily_dwell WHERE user_id = _req.user_id)
       OR EXISTS (SELECT 1 FROM public.attendance_records WHERE employee_id = _req.user_id) THEN
      RAISE EXCEPTION 'Verification Failure: Dwell/attendance purge failed' USING ERRCODE = 'P0008';
    END IF;
  END IF;

  -- 4. Execute Audit Ledger Pseudonymization with Verification
  IF 'audit_ledger' = ANY(_normalized_scopes) THEN
    UPDATE public.admin_audit_logs
    SET actor_id = NULL,
        entity_id = CASE WHEN entity_type = 'enterprise_users' AND entity_id = _req.user_id::text THEN '[REDACTED_DPDP]' ELSE entity_id END,
        metadata = public.sanitize_jsonb_pii(metadata) || jsonb_build_object('dpdp_pseudonymized', true, 'redacted_at', clock_timestamp())
    WHERE (_auth_id IS NOT NULL AND actor_id = _auth_id)
       OR (entity_type = 'enterprise_users' AND entity_id = _req.user_id::text);

    -- Actual Audit Ledger Verification Query
    IF EXISTS (
      SELECT 1 FROM public.admin_audit_logs
      WHERE (_auth_id IS NOT NULL AND actor_id = _auth_id)
         OR (entity_type = 'enterprise_users' AND entity_id = _req.user_id::text)
    ) THEN
      RAISE EXCEPTION 'Verification Failure: Audit ledger pseudonymization incomplete' USING ERRCODE = 'P0008';
    END IF;
  END IF;

  -- 5. Execute Backup Tombstone Creation with Verification
  IF 'compliant_backup' = ANY(_normalized_scopes) THEN
    _has_backup := TRUE;
    -- Keyed hash derivation using subject profile identity (not requestor identity)
    _id_hashes := ARRAY[
      encode(hmac(_subject_profile.email::bytea, 'enclave_salt_secret'::bytea, 'sha256'), 'hex'),
      encode(hmac(_subject_profile.badge_id::bytea, 'enclave_salt_secret'::bytea, 'sha256'), 'hex'),
      encode(hmac(_subject_profile.name::bytea, 'enclave_salt_secret'::bytea, 'sha256'), 'hex')
    ];

    INSERT INTO public.dpdp_backup_tombstones (
      request_id, subject_enterprise_id, subject_auth_id,
      subject_identifier_hashes, erasure_scope, tombstone_timestamp, status
    ) VALUES (
      _req.id, _req.user_id, _auth_id,
      _id_hashes, to_jsonb(_normalized_scopes), clock_timestamp(), 'ACTIVE_TOMBSTONE'
    ) RETURNING id INTO _tombstone_id;

    IF _tombstone_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.dpdp_backup_tombstones WHERE id = _tombstone_id) THEN
      RAISE EXCEPTION 'Verification Failure: Backup tombstone registration failed' USING ERRCODE = 'P0008';
    END IF;
  END IF;

  -- 6. Assign Terminal Status Based on Processed & Verified Scopes
  UPDATE public.dpo_erasure_requests
  SET status = CASE WHEN _has_backup THEN 'PURGED_TOMBSTONE_REGISTERED' ELSE 'VERIFIED_PURGED' END,
      completed_at = clock_timestamp()
  WHERE id = _request_id;
END;
$$;

-- ── 6. Full apply_transit() with Complete Business Rule Parity ───────────────
CREATE OR REPLACE FUNCTION public.apply_transit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _day DATE := (NEW."timestamp" AT TIME ZONE 'Asia/Kolkata')::date;
  _first_in TIMESTAMPTZ := NULL;
  _last_out TIMESTAMPTZ := NULL;
  _cur_state TEXT := 'OUT';
  _state_start TIMESTAMPTZ := NULL;
  _work_min INT := 0;
  _break_min INT := 0;
  _dur INT := 0;
  _t RECORD;
  _continuous_work INT := 0;
BEGIN
  -- Rule 1: Debounce duplicate transits (exact match on user, direction, zone within 3s)
  IF EXISTS (
    SELECT 1 FROM public.passive_transits
    WHERE user_id = NEW.user_id
      AND id <> NEW.id
      AND direction = NEW.direction
      AND zone_to = NEW.zone_to
      AND abs(extract(epoch FROM (NEW."timestamp" - "timestamp"))) < 3
  ) THEN
    RETURN NEW;
  END IF;

  -- Rule 2: Chronological evaluation over all transits for this employee on this IST date
  FOR _t IN (
    SELECT "timestamp", direction, zone_from, zone_to
    FROM public.passive_transits
    WHERE user_id = NEW.user_id
      AND (("timestamp" AT TIME ZONE 'Asia/Kolkata')::date) = _day
    ORDER BY "timestamp" ASC
  ) LOOP
    IF _first_in IS NULL AND _t.direction = 'ZONE_ENTER' AND _t.zone_to = 'WORKSPACE_FLOOR' THEN
      _first_in := _t."timestamp";
    END IF;

    IF _t.direction = 'ZONE_EXIT' OR _t.zone_to = 'CORRIDOR_TRANSIT' THEN
      _last_out := _t."timestamp";
    END IF;

    -- Rule 3: Interval State Machine
    IF _state_start IS NOT NULL AND _t."timestamp" > _state_start THEN
      _dur := greatest(0, floor(extract(epoch FROM (_t."timestamp" - _state_start)) / 60)::int);
      IF _cur_state = 'WORKSPACE' THEN
        _work_min := _work_min + _dur;
        _continuous_work := _continuous_work + _dur;
      ELSIF _cur_state = 'BREAK' THEN
        _break_min := _break_min + _dur;
        _continuous_work := 0;
      ELSE
        _continuous_work := 0;
      END IF;
    END IF;

    IF _t.zone_to = 'WORKSPACE_FLOOR' THEN
      _cur_state := 'WORKSPACE';
      _state_start := _t."timestamp";
    ELSIF _t.zone_to IN ('CAFETERIA_LOUNGE', 'OUTDOOR_TERRACE') THEN
      _cur_state := 'BREAK';
      _state_start := _t."timestamp";
    ELSE
      _cur_state := 'OUT';
      _state_start := _t."timestamp";
    END IF;
  END LOOP;

  -- Rule 4 & 5: Upsert Canonical Attendance Record with Authoritative EXCLUDED Resolution
  INSERT INTO public.attendance_records (
    employee_id, attendance_date, first_in, last_out,
    total_work_minutes, total_break_minutes, status, missed_exit, updated_at
  ) VALUES (
    NEW.user_id, _day, _first_in, _last_out,
    _work_min, _break_min,
    CASE WHEN _work_min >= 240 THEN 'PRESENT'::public.attendance_status
         WHEN _work_min > 0 THEN 'HALF_DAY'::public.attendance_status
         ELSE 'PRESENT'::public.attendance_status END,
    false, now()
  )
  ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
    first_in = EXCLUDED.first_in,
    last_out = EXCLUDED.last_out,
    total_work_minutes = EXCLUDED.total_work_minutes,
    total_break_minutes = EXCLUDED.total_break_minutes,
    status = EXCLUDED.status,
    updated_at = now();

  -- Rule 6: Maintain Legacy employee_daily_dwell for OSH Compliance
  INSERT INTO public.employee_daily_dwell (
    user_id, record_date, workspace_minutes, break_minutes,
    continuous_workspace_minutes, last_transition_time, osh_compliance_flag
  ) VALUES (
    NEW.user_id, _day, _work_min, _break_min,
    _continuous_work, NEW."timestamp", _continuous_work <= 270
  )
  ON CONFLICT (user_id, record_date) DO UPDATE SET
    workspace_minutes = EXCLUDED.workspace_minutes,
    break_minutes = EXCLUDED.break_minutes,
    continuous_workspace_minutes = EXCLUDED.continuous_workspace_minutes,
    last_transition_time = EXCLUDED.last_transition_time,
    osh_compliance_flag = public.employee_daily_dwell.osh_compliance_flag AND (EXCLUDED.continuous_workspace_minutes <= 270);

  -- Rule 7: Maintain Live Presence Zone on enterprise_users
  UPDATE public.enterprise_users
  SET current_zone = NEW.zone_to,
      is_in_workspace = (NEW.zone_to = 'WORKSPACE_FLOOR')
  WHERE id = NEW.user_id;

  RETURN NEW;
END;
$$;
```

---

## 4. Multi-Connection Concurrency Test Suite

```
┌────────────────────────────────────────────────────────────────────────┐
│             Deterministic Multi-Connection Test Architecture           │
├────────────────────────────────────────────────────────────────────────┤
│ Scenario C.1: Simultaneous Super Admin Removal                         │
│   Conn 1: Holds advisory lock -> Conn 2 waits in Lock state            │
│   Conn 1 demotes Admin A and commits -> Conn 2 aborts with P0001       │
├────────────────────────────────────────────────────────────────────────┤
│ Scenario C.2: Simultaneous Role Mutation on Single User               │
│   Conn 1 (security) & Conn 2 (hr_ops) serialize on user advisory lock  │
│   Explicit post-state assertion: final role hr_ops, ordered audit rows │
├────────────────────────────────────────────────────────────────────────┤
│ Scenario C.3: Auth Table-Level Locking Verification                   │
│   Conn 1 acquires ACCESS EXCLUSIVE on auth.users -> applies 0000-0003  │
│   Conn 2 SQL INSERT blocks on relation lock -> verifies zero superadmin│
├────────────────────────────────────────────────────────────────────────┤
│ Scenario C.4: Duplicate Invitation Linking Race                        │
│   Conn 1 & Conn 2 attempt linking against same dispatched email        │
│   Advisory lock serializes; exactly 1 LINKED, 1 RECONCILIATION_REQ     │
├────────────────────────────────────────────────────────────────────────┤
│ Scenario C.5: Audit Log Forgery Attempt                                │
│   Authenticated employee session executes direct INSERT               │
│   PostgreSQL engine deterministically aborts with 42501 (Forbidden)   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Four-Tier Categorized Decision Matrix

### Tier 1: Documentation & Planning Approvals (Current Scope)
- [x] **1.1 Version 3.2 Plan Approval:** Formal approval of `PHASE_4_REMEDIATION_PLAN.md` (Version 3.2.0).

### Tier 2: Safe to Approve for Local File Authoring (Offline Sandbox)
- [ ] **2.1 Author Migration 0003:** Create `drizzle/migrations/0003_operational_security_fixes.sql`.
- [ ] **2.2 Register Journal Entry:** Update `drizzle/migrations/meta/_journal.json` (entry index 3).
- [ ] **2.3 Author Concurrency Test Suite:** Create `test/scripts/test-phase4-concurrency.mjs`.

### Tier 3: Requiring Authorization for Local Test Execution
- [ ] **3.1 Run Local Integration Suite:** Execute `test/scripts/run-pg17-integration.mjs` on local PG17.
- [ ] **3.2 Run Deterministic Concurrency Suite:** Execute `test/scripts/test-phase4-concurrency.mjs`.
- [ ] **3.3 Measure Lock Acquisition Timing:** Benchmark `ACCESS EXCLUSIVE` lock acquisition duration.

### Tier 4: Strictly Prohibited Until Explicit Live Supabase Authorization
- [ ] **4.1 Live Database Connection:** Prohibited from connecting to Supabase instance `ljmrmeivrjmhuoyzrqrz`.
- [ ] **4.2 Live SQL Execution:** Prohibited from applying migrations `0000` through `0003`.
- [ ] **4.3 Live Super Admin Bootstrap:** Prohibited from executing bootstrap procedure on live Supabase.
- [ ] **4.4 Migration Tracking Initialization:** Prohibited from initializing tracking tables on live Supabase.

---

## 6. Explicit List of Unresolved Evidence Gaps & Assumptions

The following technical items remain unverified pending Tier 2/3 authoring, local test execution, or organizational authorization:

1. **Migration Runner Multi-File Transactionality:** Whether Drizzle Kit or Supabase CLI can be configured to execute multiple migration files within a single atomic transaction block without file-by-file intermediate commits is unverified.
2. **Operator Non-Repudiation Infrastructure:** The external signature generation mechanism (IdP / KMS / Enclave key) and corresponding PostgreSQL verification function have not been authored or integrated.
3. **Post-Erasure Merkle Verification Proofs:** The cryptographic protocol for verifying historical Merkle blocks against pseudonymized audit rows without breaking leaf hash validity remains to be designed and tested.
4. **Live Connection Pooler Architecture:** The live pooler configuration on `ljmrmeivrjmhuoyzrqrz` (Supavisor vs. pgBouncer transaction mode limits) cannot be inspected without an authorized live connection.
5. **Designated Initial Super Admin Identity:** The corporate email address and SSO identifier for the initial Super Admin account remain unselected.
6. **Enclave Salt Secret Distribution:** The master salt/secret used for HMAC-SHA256 subject identifier hashing in `dpdp_backup_tombstones` requires a secure enclave or Supabase vault distribution mechanism.

---

## 7. Version 3.2.0 Change Log (from Version 3.1.0)

| Finding / Section | Version 3.1.0 State | Version 3.2.0 Revision | Architectural Rationale |
| :--- | :--- | :--- | :--- |
| **Scope Validation (Finding 5)** | Checked array length; did not validate element types or duplicates. | Enforced strict string-type validation per element, exact whitelist checking with SQLSTATE `22023`, and deterministic deduplication. | Prevents silent acceptance of invalid types or unexpected scope keys. |
| **Erasure Completion (Finding 5)** | Overwrote status; lacked actual audit ledger verification query. | Removed default `VERIFIED_PURGED`. Implemented actual verification queries for audit ledger and tombstones. Aborts on missing profile (`P0009`). | Guarantees compliance status is assigned only after verified execution. |
| **Tombstone Durability (Finding 5)** | Used `ON DELETE CASCADE`. Used plain SHA-256 for PII hashes. | Replaced with `ON DELETE RESTRICT`. Required keyed HMAC-SHA256 to prevent dictionary attacks. Specified durable retention and restore replay. | Ensures tombstones survive request deletion and protects subject identity from rainbow tables. |
| **Super Admin Bootstrap (Finding 2)** | Attributed `actor_id` to target account. Lacked global invariant. | Attributed `actor_id` to NULL/operator context. Enforced global single-admin invariant (`count = 0`). Explicitly blocked bootstrap until signature tool exists. | Eliminates false attribution, blocks privilege escalation backdoors, and satisfies audit rigor. |
| **Attendance Parity (Finding 7)** | Replaced function without complete field-by-field audit. | Provided exhaustive 17-point Field-by-Field Parity Comparison Table against `0001`. Proved `EXCLUDED` avoids sticky historical corruption. | Guarantees zero regression in OSH compliance, dwell accounting, or live presence tracking. |
| **Department Auth (Finding 6)** | Focused on table grants. | Specified table grants in conjunction with granular `INSERT`, `UPDATE`, `DELETE` RLS policies. Proved containment for all role classes. | Enforces principle that SQL grants alone are never sufficient under RLS. |
| **JSONB Sanitizer (Finding 8)** | Case-sensitive key match; lacked NULL default handling. | Normalized keys with `lower()`. Handled NULL with canonical blacklist defaults. Added 5 test specifications. Documented unstructured PII limitation. | Prevents mixed-case PII leakage and establishes clear architectural boundaries. |
| **Tombstone Assumptions (Finding 5)** | Conflated subject identity with requestor identity. | Separated subject profile identity from requestor identity. Added deterministic abort (`P0009`) if subject profile is already deleted. | Prevents hashing requestor PII as subject data and handles orphaned requests safely. |
| **Concurrency Tests (Section 4)** | Asserted generic SQLSTATE `00000`. | Replaced with explicit post-state validations (`user_roles`, `enterprise_users`, ordered audit rows). Verified independent sockets. | Ensures concurrency tests validate true state transitions rather than mere lack of errors. |
| **Timeout Semantics (Finding 1)** | Grouped timeouts loosely. | Dissected the four distinct timeout dimensions. Documented that `idle_in_transaction_session_timeout` does not cap active transactions. | Prevents operational outages from misconfigured database timeout controls. |

---

**Status:** Version 3.2.0 Review Complete. All requested fourth-review corrections incorporated. **Awaiting explicit user authorization before any implementation or test execution.**
