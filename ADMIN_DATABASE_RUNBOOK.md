# PresenceTrack AI — Administrator Database & Security Hardening Runbook

This runbook provides the verified, copy-pasteable SQL scripts and operational procedures to apply database migrations, provision the first Super Admin under strict concurrency locks, and seal public registration in Supabase.

Target Project Ref: `ljmrmeivrjmhuoyzrqrz`

---

## Pre-flight Checklist

Before executing any script, confirm:
1. You have opened the **Supabase Dashboard** $\to$ **SQL Editor** with an administrative/postgres connection, or have access to `psql` configured with your administrative connection string `SUPABASE_DB_URL`.
2. All frontend and Python test suites pass locally:
   - TypeScript compilation: `npx tsc --noEmit` (0 errors)
   - Vitest test suite: `npm test` (109/109 tests passing)
   - Vision Gateway test suite: `pytest vision-gateway/tests/` (39/39 tests passing)
   - PostgreSQL 17 test suite: `node test/scripts/test-phase4-final-remediation.mjs` (11/11 tests passing)
3. No active users are undergoing email confirmation during the migration run.

---

## Stage 0: Pre-Flight Baseline Verification

Execute this query in the Supabase SQL Editor to inspect your existing schema status:

```sql
SELECT
  table_schema,
  table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'enterprise_users',
    'user_roles',
    'departments',
    'zones',
    'transit_records',
    'attendance_records',
    'admin_audit_logs'
  )
ORDER BY table_name;
```

### Evaluation Guide:
- **0 tables found:** Apply **Migration 0000**, followed by **Migration 0001**, then **Migration 0002** and **0003**.
- **`enterprise_users`, `user_roles`, `zones` found, but not `admin_audit_logs`:** Apply **Migration 0001**, then **Migration 0002** and **0003**.
- **All tables including `admin_audit_logs` found:** Proceed directly with Stage 1 single-transaction execution.

---

## Stage 1: Single-Transaction Atomic Migration Execution

> [!IMPORTANT]
> All four migrations (`0000` through `0003`) along with the strict Drizzle baseline history registration must be applied inside a **single atomic transaction** using `psql --single-transaction`. Do not execute migrations piecemeal or out of sequence. If any statement or baseline check fails, the entire transaction rolls back automatically without partial catalog corruption.

### Step 1A: Configure Vault Prerequisite
Ensure the `supabase_vault` extension is active and the DPDP erasure salt secret is populated (required by `approve_erasure_request` in Migration 0003):

```sql
CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;

-- Insert salt secret if not already set
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'enclave_salt_secret') THEN
    PERFORM vault.create_secret(
      pg_catalog.encode(pg_catalog.gen_random_bytes(32), 'hex'),
      'enclave_salt_secret',
      'PresenceTrack DPDP Audit Erasure Salt'
    );
  END IF;
END $$;
```

### Step 1B: Atomic Database Migration & Strict Drizzle Baseline Registration via `psql --single-transaction`

Execute the complete migration bundle (`0000` through `0003`) **and** the individual-pair Drizzle history validation block inside a single atomic transaction against your target Supabase connection string (`SUPABASE_DB_URL`).

> [!IMPORTANT]
> Because `drizzle.__drizzle_migrations` does not have a unique constraint on `(hash)` or `(created_at)`, we **do not use `ON CONFLICT DO NOTHING`**. Instead, the script uses exclusive table locking (`LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE`), validates existing history, halts closed on duplicate or unexpected records, and asserts:
> 1. Exactly four total rows.
> 2. Exactly one row for each expected hash.
> 3. Exactly one row for each expected created_at.
> 4. No unexpected hash or timestamp.
> 5. No NULL hash or timestamp.
> 6. Any mismatch raises an exception and rolls back the transaction.

Run this single shell command:

```bash
# Target Supabase project ref: ljmrmeivrjmhuoyzrqrz
# Ensure SUPABASE_DB_URL is set in your environment (e.g. postgresql://postgres:[YOUR-PASSWORD]@db.ljmrmeivrjmhuoyzrqrz.supabase.co:5432/postgres)
(
  cat drizzle/migrations/0000_presencetrack_schema.sql
  cat drizzle/migrations/0001_attendance_backend_expansion.sql
  cat drizzle/migrations/0002_auth_security_hardening.sql
  cat drizzle/migrations/0003_operational_security_fixes.sql
  cat <<'EOF'
DO $$
DECLARE
    v_total_count int;
    v_null_count int;
    v_duplicate_count int;
    v_unexpected_count int;
    v_cnt_hash0 int;
    v_cnt_hash1 int;
    v_cnt_hash2 int;
    v_cnt_hash3 int;
    v_cnt_time0 int;
    v_cnt_time1 int;
    v_cnt_time2 int;
    v_cnt_time3 int;
    v_cnt_pair0 int;
    v_cnt_pair1 int;
    v_cnt_pair2 int;
    v_cnt_pair3 int;
BEGIN
    -- Ensure schema and table exist
    CREATE SCHEMA IF NOT EXISTS drizzle;

    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
    );

    -- Lock table in EXCLUSIVE mode during state validation and insertion
    LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE;

    -- Query initial count
    SELECT count(*) INTO v_total_count
    FROM drizzle.__drizzle_migrations;

    -- Case 1: Empty history table -> insert exactly the 4 baseline records
    IF v_total_count = 0 THEN
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES
            ('259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b', 1794057325415),
            ('cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee', 1794057325416),
            ('01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271', 1794057325417),
            ('6675879c535c20f4a8cbf50c7c9fd6370fb2d3e237a0a0dc243bb5df860b0b08', 1794057325418);

        RAISE NOTICE 'Drizzle baseline registered: 4 verified migration records inserted.';
    END IF;

    -- Case 2 & Post-Insert Validation:
    -- Check for duplicate records on (created_at) or (hash)
    SELECT count(*) INTO v_duplicate_count
    FROM (
        SELECT created_at FROM drizzle.__drizzle_migrations GROUP BY created_at HAVING count(*) > 1
        UNION
        SELECT (SELECT created_at FROM drizzle.__drizzle_migrations m2 WHERE m2.hash = m1.hash LIMIT 1)
        FROM drizzle.__drizzle_migrations m1 GROUP BY hash HAVING count(*) > 1
    ) dups;

    IF v_duplicate_count > 0 THEN
        RAISE EXCEPTION 'Drizzle Migration Integrity Error: Duplicate migration records detected in drizzle.__drizzle_migrations'
            USING ERRCODE = '23505';
    END IF;

    -- Re-query total count
    SELECT count(*) INTO v_total_count FROM drizzle.__drizzle_migrations;

    -- Requirement: Exactly four total rows
    IF v_total_count <> 4 THEN
        RAISE EXCEPTION 'Drizzle Migration Integrity Error: Expected exactly 4 rows in drizzle.__drizzle_migrations, found %', v_total_count
            USING ERRCODE = '22000';
    END IF;

    -- Requirement: No NULL hash or timestamp
    SELECT count(*) INTO v_null_count
    FROM drizzle.__drizzle_migrations
    WHERE hash IS NULL OR created_at IS NULL;

    IF v_null_count > 0 THEN
        RAISE EXCEPTION 'Drizzle Migration Integrity Error: Found % row(s) with NULL hash or timestamp in drizzle.__drizzle_migrations', v_null_count
            USING ERRCODE = '22000';
    END IF;

    -- Requirement: Exactly one row for each expected hash
    SELECT count(*) INTO v_cnt_hash0 FROM drizzle.__drizzle_migrations WHERE hash = '259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b';
    SELECT count(*) INTO v_cnt_hash1 FROM drizzle.__drizzle_migrations WHERE hash = 'cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee';
    SELECT count(*) INTO v_cnt_hash2 FROM drizzle.__drizzle_migrations WHERE hash = '01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271';
    SELECT count(*) INTO v_cnt_hash3 FROM drizzle.__drizzle_migrations WHERE hash = '6675879c535c20f4a8cbf50c7c9fd6370fb2d3e237a0a0dc243bb5df860b0b08';

    IF v_cnt_hash0 <> 1 OR v_cnt_hash1 <> 1 OR v_cnt_hash2 <> 1 OR v_cnt_hash3 <> 1 THEN
        RAISE EXCEPTION 'Drizzle Migration Integrity Error: Expected hash counts (1,1,1,1) but found (%, %, %, %)',
            v_cnt_hash0, v_cnt_hash1, v_cnt_hash2, v_cnt_hash3
            USING ERRCODE = '22000';
    END IF;

    -- Requirement: Exactly one row for each expected created_at
    SELECT count(*) INTO v_cnt_time0 FROM drizzle.__drizzle_migrations WHERE created_at = 1794057325415;
    SELECT count(*) INTO v_cnt_time1 FROM drizzle.__drizzle_migrations WHERE created_at = 1794057325416;
    SELECT count(*) INTO v_cnt_time2 FROM drizzle.__drizzle_migrations WHERE created_at = 1794057325417;
    SELECT count(*) INTO v_cnt_time3 FROM drizzle.__drizzle_migrations WHERE created_at = 1794057325418;

    IF v_cnt_time0 <> 1 OR v_cnt_time1 <> 1 OR v_cnt_time2 <> 1 OR v_cnt_time3 <> 1 THEN
        RAISE EXCEPTION 'Drizzle Migration Integrity Error: Expected timestamp counts (1,1,1,1) but found (%, %, %, %)',
            v_cnt_time0, v_cnt_time1, v_cnt_time2, v_cnt_time3
            USING ERRCODE = '22000';
    END IF;

    -- Requirement: Validate the exact four expected (hash, created_at) pairs individually
    SELECT count(*) INTO v_cnt_pair0 FROM drizzle.__drizzle_migrations
    WHERE hash = '259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b' AND created_at = 1794057325415;

    SELECT count(*) INTO v_cnt_pair1 FROM drizzle.__drizzle_migrations
    WHERE hash = 'cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee' AND created_at = 1794057325416;

    SELECT count(*) INTO v_cnt_pair2 FROM drizzle.__drizzle_migrations
    WHERE hash = '01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271' AND created_at = 1794057325417;

    SELECT count(*) INTO v_cnt_pair3 FROM drizzle.__drizzle_migrations
    WHERE hash = '6675879c535c20f4a8cbf50c7c9fd6370fb2d3e237a0a0dc243bb5df860b0b08' AND created_at = 1794057325418;

    IF v_cnt_pair0 <> 1 OR v_cnt_pair1 <> 1 OR v_cnt_pair2 <> 1 OR v_cnt_pair3 <> 1 THEN
        RAISE EXCEPTION 'Drizzle Migration Integrity Error: Expected exact baseline pairs (1,1,1,1) but found (%, %, %, %)',
            v_cnt_pair0, v_cnt_pair1, v_cnt_pair2, v_cnt_pair3
            USING ERRCODE = '22000';
    END IF;

    -- Requirement: No unexpected hash or timestamp
    SELECT count(*) INTO v_unexpected_count
    FROM drizzle.__drizzle_migrations
    WHERE (hash, created_at) NOT IN (
        ('259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b', 1794057325415),
        ('cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee', 1794057325416),
        ('01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271', 1794057325417),
        ('6675879c535c20f4a8cbf50c7c9fd6370fb2d3e237a0a0dc243bb5df860b0b08', 1794057325418)
    );

    IF v_unexpected_count > 0 THEN
        RAISE EXCEPTION 'Drizzle Migration Integrity Error: % unexpected/corrupt migration record(s) detected in drizzle.__drizzle_migrations', v_unexpected_count
            USING ERRCODE = '22000';
    END IF;

    RAISE NOTICE 'Drizzle baseline verified: exact 4 records present and validated individually. Transaction consistent.';
END $$;
EOF
) | psql "$SUPABASE_DB_URL" --single-transaction -v ON_ERROR_STOP=1
```

---

## Stage 2: First Super Admin Provisioning (Atomic Procedure)

To guarantee that the initial platform administrator is established without race conditions and without exposing unverified self-registration, execute the following atomic procedure.

### Step 2A: Create Auth Identity in Supabase
1. In the **Supabase Dashboard**, navigate to **Authentication** $\to$ **Users**.
2. Click **Add User** $\to$ **Create User**.
3. Enter your corporate administrator email address (e.g. `admin@presencetrack.local` or company domain).
4. Enter a strong initial password (e.g. 16+ characters).
5. Ensure **"Auto Confirm User?"** is **checked** (`email_confirmed_at` set immediately).
6. Click **Create User**.
7. Copy the generated **User UID** (UUID).

---

### Step 2B: Atomic Profile Creation & Super Admin Provisioning (SQL Editor)

Execute the following script in the Supabase SQL Editor. **Edit `c_target_auth_uuid` and `c_target_email_raw` to match the exact Auth account created in Step 2A:**

```sql
BEGIN;

-- 1. Acquire platform-wide global advisory lock
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('global_super_admin_lock'));

-- 2. Immediate Security Guard: Fail fast if any Super Admin already exists
DO $$
DECLARE
    v_existing_count int;
BEGIN
    SELECT count(*) INTO v_existing_count
    FROM public.user_roles
    WHERE role = 'super_admin';

    IF v_existing_count > 0 THEN
        RAISE EXCEPTION 'Security Guard: % Super Admin(s) already exist. Unrestricted bootstrap aborted.', v_existing_count
            USING ERRCODE = '23514';
    END IF;
END $$;

-- 3. Pre-requisite: Executive Department setup
INSERT INTO public.departments (name, description)
VALUES ('Executive Leadership', 'Executive Leadership & Administration')
ON CONFLICT (name) DO NOTHING;

-- 4. Validate Auth user and safely create/link profile using actual schema
LOCK TABLE public.enterprise_users IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    -- REPLACE WITH YOUR EXACT VALUES FROM STEP 2A
    c_target_auth_uuid CONSTANT uuid := 'REPLACE_WITH_AUTH_USER_UUID'::uuid;
    c_target_email_raw CONSTANT text := 'REPLACE_WITH_REAL_ADMIN_EMAIL';

    v_target_email text;
    v_auth_email text;
    v_auth_confirmed_at timestamptz;
    v_exec_dept_id uuid;
    v_matching_count int;
    v_existing_profile public.enterprise_users%ROWTYPE;
    v_target_profile_id uuid;
BEGIN
    -- Executable placeholder guard
    IF c_target_auth_uuid = '00000000-0000-0000-0000-000000000000'::uuid
       OR c_target_email_raw = 'REPLACE_WITH_REAL_ADMIN_EMAIL' THEN
        RAISE EXCEPTION 'Execution Aborted: Set c_target_auth_uuid and c_target_email_raw to your actual administrator identity.'
            USING ERRCODE = '22023';
    END IF;

    -- Consistent normalization
    v_target_email := pg_catalog.lower(pg_catalog.btrim(c_target_email_raw));
    IF v_target_email IS NULL OR v_target_email = '' THEN
        RAISE EXCEPTION 'Target email cannot be null or empty.'
            USING ERRCODE = '22000';
    END IF;

    -- Retrieve department ID
    SELECT id INTO v_exec_dept_id
    FROM public.departments
    WHERE name = 'Executive Leadership'
    LIMIT 1;

    -- 4A. Auth Row-Locking & Email Confirmation Validation
    SELECT email, email_confirmed_at
    INTO v_auth_email, v_auth_confirmed_at
    FROM auth.users
    WHERE id = c_target_auth_uuid
    FOR UPDATE;

    IF v_auth_email IS NULL THEN
        RAISE EXCEPTION 'Target Auth User % does not exist in auth.users. Complete Step 2A first.', c_target_auth_uuid
            USING ERRCODE = 'P0002';
    END IF;

    IF pg_catalog.lower(pg_catalog.btrim(v_auth_email)) <> v_target_email THEN
        RAISE EXCEPTION 'Email mismatch: auth.users email ("%") does not match target email ("%")',
            v_auth_email, v_target_email
            USING ERRCODE = '22000';
    END IF;

    IF v_auth_confirmed_at IS NULL THEN
        RAISE EXCEPTION 'Target Auth User % email is unconfirmed (email_confirmed_at IS NULL). Auto-confirm or verify first.', c_target_auth_uuid
            USING ERRCODE = '22000';
    END IF;

    -- 4B. Explicitly count matching enterprise_users profiles with consistent btrim normalization
    SELECT count(*) INTO v_matching_count
    FROM public.enterprise_users
    WHERE pg_catalog.lower(pg_catalog.btrim(email)) = v_target_email
       OR auth_user_id = c_target_auth_uuid;

    IF v_matching_count > 1 THEN
        RAISE EXCEPTION 'Integrity Failure: Multiple (% matching) enterprise profiles match email % or auth_user_id %',
            v_matching_count, v_target_email, c_target_auth_uuid
            USING ERRCODE = '23505';
    ELSIF v_matching_count = 1 THEN
        -- Exactly 1 matching profile: lock and validate state
        SELECT * INTO STRICT v_existing_profile
        FROM public.enterprise_users
        WHERE pg_catalog.lower(pg_catalog.btrim(email)) = v_target_email
           OR auth_user_id = c_target_auth_uuid
        FOR UPDATE;

        -- Conflict checks
        IF v_existing_profile.auth_user_id IS NOT NULL AND v_existing_profile.auth_user_id <> c_target_auth_uuid THEN
            RAISE EXCEPTION 'Identity Conflict: Enterprise profile % already linked to auth_user_id %',
                v_existing_profile.id, v_existing_profile.auth_user_id
                USING ERRCODE = '23505';
        END IF;

        IF pg_catalog.lower(pg_catalog.btrim(v_existing_profile.email)) <> v_target_email THEN
            RAISE EXCEPTION 'Identity Conflict: Enterprise profile % email (%) does not match target email (%)',
                v_existing_profile.id, v_existing_profile.email, v_target_email
                USING ERRCODE = '22000';
        END IF;

        IF v_existing_profile.is_active = false THEN
            RAISE EXCEPTION 'State Conflict: Enterprise profile % is inactive. Reactivation required.',
                v_existing_profile.id
                USING ERRCODE = '22000';
        END IF;

        IF v_existing_profile.invitation_status = 'RECONCILIATION_REQUIRED'::public.invitation_status THEN
            RAISE EXCEPTION 'State Conflict: Enterprise profile % is in RECONCILIATION_REQUIRED quarantine.',
                v_existing_profile.id
                USING ERRCODE = '22000';
        END IF;

        IF v_existing_profile.invitation_status IS NULL
           OR v_existing_profile.invitation_status NOT IN (
               'STAGED'::public.invitation_status,
               'DISPATCH_PENDING'::public.invitation_status,
               'DISPATCHED'::public.invitation_status,
               'LINKED'::public.invitation_status
           ) THEN
            RAISE EXCEPTION 'State Conflict: Enterprise profile % has invalid invitation status %',
                v_existing_profile.id, coalesce(v_existing_profile.invitation_status::text, 'NULL')
                USING ERRCODE = '22000';
        END IF;

        -- Promote or link existing profile cleanly using actual columns
        UPDATE public.enterprise_users
        SET email = v_target_email,
            auth_user_id = c_target_auth_uuid,
            invitation_status = 'LINKED'::public.invitation_status,
            imported_role = 'super_admin'::public.app_role,
            department_id = COALESCE(department_id, v_exec_dept_id)
        WHERE id = v_existing_profile.id
        RETURNING id INTO v_target_profile_id;
    ELSE
        -- 4C. Zero matching profiles: Insert clean fresh profile using actual columns
        INSERT INTO public.enterprise_users (
            id,
            email,
            name,
            role_title,
            badge_id,
            department,
            department_id,
            auth_user_id,
            is_active,
            invitation_status,
            imported_role
        )
        VALUES (
            gen_random_uuid(),
            v_target_email,
            'System Administrator',
            'Principal Super Admin',
            'SA-' || pg_catalog.substr(c_target_auth_uuid::text, 1, 8),
            'Executive Leadership',
            v_exec_dept_id,
            c_target_auth_uuid,
            true,
            'LINKED'::public.invitation_status,
            'super_admin'::public.app_role
        )
        RETURNING id INTO v_target_profile_id;
    END IF;

    -- 5. Insert role into user_roles
    INSERT INTO public.user_roles (
        user_id,
        role
    )
    VALUES (
        c_target_auth_uuid,
        'super_admin'
    );

    -- 6. Record immutable audit log entry (actor_id = NULL for initial bootstrap)
    INSERT INTO public.admin_audit_logs (
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) VALUES (
        NULL,
        'BOOTSTRAP_FIRST_SUPER_ADMIN',
        'user_roles',
        c_target_auth_uuid::text,
        jsonb_build_object(
            'bootstrap_method', 'DATABASE_OUT_OF_BAND_RUNBOOK',
            'target_email', v_target_email,
            'enterprise_user_id', v_target_profile_id,
            'assigned_role', 'super_admin'
        )
    );

    RAISE NOTICE 'SUCCESS: User % (%) successfully bootstrapped as first Super Admin and linked to profile %',
        v_target_email, c_target_auth_uuid, v_target_profile_id;
END $$;

COMMIT;
```

---

## Stage 3: Supabase Dashboard Authentication Hardening

To enforce the invitation-only security model and disable open self-registration:

1. In the **Supabase Dashboard**, navigate to **Authentication** $\to$ **Providers**.
2. Click on **Email**.
3. Locate **"Enable Signups"** and toggle it **OFF**.
   > Disabling signups prevents any public visitor from invoking `supabase.auth.signUp()`. Invitations dispatched by Super Admins via `supabase.auth.admin.inviteUserByEmail()` or the PresenceTrack invitation workflow will continue to work normally.
4. Verify that **"Confirm email"** is toggled **ON**.
5. Under **Authentication** $\to$ **URL Configuration**:
   - Ensure **Site URL** is configured to your production domain (or `http://localhost:8080` for local testing).
   - Ensure **Redirect URLs** include:
     - `http://localhost:8080/**`
     - `http://localhost:8080/reset-password`
     - `https://<your-domain>/reset-password`
6. Click **Save**.

---

## Stage 4: Post-Deployment Verification Queries

Verify that the system catalog and roles are in a pristine, compliant state:

```sql
-- 1. Verify 11-point index on enterprise_users
SELECT
  c.relname AS index_name,
  am.amname AS access_method,
  i.indisunique,
  i.indisvalid,
  pg_get_expr(i.indexprs, i.indrelid) AS index_expression
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_am am ON am.oid = c.relam
WHERE c.relname = 'enterprise_users_lower_email_idx';

-- 2. Verify Super Admin assignment and linked status
SELECT
  eu.id AS profile_id,
  eu.email,
  eu.imported_role,
  eu.invitation_status,
  eu.is_active,
  ur.role AS granted_role
FROM public.enterprise_users eu
LEFT JOIN public.user_roles ur ON ur.user_id = eu.auth_user_id
WHERE ur.role = 'super_admin' OR eu.imported_role = 'super_admin';

-- 3. Verify Active Triggers on auth.users, user_roles, and enterprise_users
SELECT
  tgrelid::regclass AS table_name,
  tgname AS trigger_name,
  tgenabled AS is_enabled,
  pg_get_triggerdef(oid) AS trigger_definition
FROM pg_trigger
WHERE tgname IN (
  'on_auth_user_created_confirmed',
  'on_auth_user_email_confirmed',
  'user_roles_protect_admin_stmt',
  'user_roles_protect_last_admin',
  'enterprise_users_protect_admin_stmt',
  'enterprise_users_protect_last_admin'
)
ORDER BY table_name, trigger_name;

-- 4. Verify Admin Audit Logs recorded initial provisioning
SELECT
  id,
  created_at,
  action,
  entity_type,
  entity_id,
  metadata
FROM public.admin_audit_logs
ORDER BY created_at DESC
LIMIT 5;
```

---

## Stage 5: Application Sign-In Test

1. Navigate to `http://localhost:8080/login`.
2. Confirm the **"Sign up"** tab is absent. The corporate notice *"Personnel onboarding is strictly by corporate invitation"* is displayed.
3. Sign in with the newly provisioned Super Admin credentials.
4. Verify you are automatically redirected to `/enclave/admin` (Super Admin Enclave).
5. In the navigation bar, verify full access to employee management, live cameras, audit logs, and hardware registration.
