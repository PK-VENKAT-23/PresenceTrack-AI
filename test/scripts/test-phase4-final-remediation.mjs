#!/usr/bin/env node
// ==============================================================================
// PresenceTrack AI — Phase 4 Final Two-Issue Remediation Test Suite
// Path: test/scripts/test-phase4-final-remediation.mjs
// ==============================================================================

import path from 'path';
import postgres from 'postgres';
import { EphemeralClusterManager, GuardedClusterSession } from './run-pg17-integration.mjs';

const MIGRATION_0000_PATH = path.resolve('drizzle/migrations/0000_presencetrack_schema.sql');
const MIGRATION_0001_PATH = path.resolve('drizzle/migrations/0001_attendance_backend_expansion.sql');
const MIGRATION_0002_PATH = path.resolve('drizzle/migrations/0002_auth_security_hardening.sql');
const MIGRATION_0003_PATH = path.resolve('drizzle/migrations/0003_operational_security_fixes.sql');

const FIXTURE_00_BOOTSTRAP = path.resolve('test/fixtures/00_cluster_bootstrap.sql');
const FIXTURE_01_COMPAT = path.resolve('test/fixtures/01_supabase_compat.sql');

export const DRIZZLE_BASELINE_REGISTRATION_SQL = `
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
        RAISE EXCEPTION 'Drizzle Migration Integrity Error: Incomplete migration history (% / 4 baseline records present). Manual operator investigation required.', v_total_count
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
`;

export function generateNormalizedBootstrapSQL(targetUserId, targetEmail = 'admin@presencetrack.local') {
  return `
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

    -- 4. Validate Auth user and safely create/link profile
    LOCK TABLE public.enterprise_users IN SHARE ROW EXCLUSIVE MODE;

    DO $$
    DECLARE
        v_target_user_id uuid := '${targetUserId}';
        v_target_email text := pg_catalog.lower(pg_catalog.btrim('${targetEmail}'));
        v_auth_email text;
        v_auth_confirmed_at timestamptz;
        v_matching_count int;
        v_existing_profile public.enterprise_users%ROWTYPE;
    BEGIN
        -- 4A. Lock and validate Auth User in auth.users
        SELECT email, email_confirmed_at
        INTO v_auth_email, v_auth_confirmed_at
        FROM auth.users
        WHERE id = v_target_user_id
        FOR UPDATE;

        IF v_auth_email IS NULL THEN
            RAISE EXCEPTION 'Target Auth User % does not exist in auth.users', v_target_user_id
                USING ERRCODE = 'P0002';
        END IF;

        IF pg_catalog.lower(pg_catalog.btrim(v_auth_email)) <> v_target_email THEN
            RAISE EXCEPTION 'Email mismatch: auth.users email (%) does not match target email (%)',
                v_auth_email, v_target_email
                USING ERRCODE = '22000';
        END IF;

        IF v_auth_confirmed_at IS NULL THEN
            RAISE EXCEPTION 'Target Auth User % email is unconfirmed (email_confirmed_at IS NULL)', v_target_user_id
                USING ERRCODE = '22000';
        END IF;

        -- 4B. Explicitly count matching enterprise_users profiles with consistent btrim normalization
        SELECT count(*) INTO v_matching_count
        FROM public.enterprise_users
        WHERE pg_catalog.lower(pg_catalog.btrim(email)) = v_target_email OR auth_user_id = v_target_user_id;

        IF v_matching_count > 1 THEN
            RAISE EXCEPTION 'Integrity Failure: Multiple (% matching) enterprise profiles match email % or auth_user_id %',
                v_matching_count, v_target_email, v_target_user_id
                USING ERRCODE = '23505';
        ELSIF v_matching_count = 1 THEN
            -- Exactly 1 matching profile: lock and validate state
            SELECT * INTO STRICT v_existing_profile
            FROM public.enterprise_users
            WHERE pg_catalog.lower(pg_catalog.btrim(email)) = v_target_email OR auth_user_id = v_target_user_id
            FOR UPDATE;

            -- Conflict 1: Already linked to a DIFFERENT auth_user_id
            IF v_existing_profile.auth_user_id IS NOT NULL AND v_existing_profile.auth_user_id <> v_target_user_id THEN
                RAISE EXCEPTION 'Identity Conflict: Enterprise profile % is already linked to auth_user_id % (target is %)',
                    v_existing_profile.id, v_existing_profile.auth_user_id, v_target_user_id
                    USING ERRCODE = '23505';
            END IF;

            -- Conflict 2: Email mismatch on existing profile (with consistent btrim)
            IF pg_catalog.lower(pg_catalog.btrim(v_existing_profile.email)) <> v_target_email THEN
                RAISE EXCEPTION 'Identity Conflict: Enterprise profile % email (%) does not match target email (%)',
                    v_existing_profile.id, v_existing_profile.email, v_target_email
                    USING ERRCODE = '22000';
            END IF;

            -- Conflict 3: Inactive profile
            IF v_existing_profile.is_active = false THEN
                RAISE EXCEPTION 'State Conflict: Enterprise profile % is inactive (is_active = false). Manual reactivation required.',
                    v_existing_profile.id
                    USING ERRCODE = '22000';
            END IF;

            -- Conflict 4: Profile is in security quarantine
            IF v_existing_profile.invitation_status = 'RECONCILIATION_REQUIRED'::public.invitation_status THEN
                RAISE EXCEPTION 'State Conflict: Enterprise profile % is in RECONCILIATION_REQUIRED quarantine. Manual reconciliation required.',
                    v_existing_profile.id
                    USING ERRCODE = '22000';
            END IF;

            -- Conflict 5: NULL or Unexpected invitation status
            IF v_existing_profile.invitation_status IS NULL
               OR v_existing_profile.invitation_status NOT IN (
                   'STAGED'::public.invitation_status,
                   'DISPATCH_PENDING'::public.invitation_status,
                   'DISPATCHED'::public.invitation_status,
                   'LINKED'::public.invitation_status
               ) THEN
                RAISE EXCEPTION 'State Conflict: Enterprise profile % has invalid or unexpected invitation status %',
                    v_existing_profile.id, coalesce(v_existing_profile.invitation_status::text, 'NULL')
                    USING ERRCODE = '22000';
            END IF;

            -- If already LINKED to this target user, preserve without unnecessary changes
            IF v_existing_profile.invitation_status = 'LINKED'::public.invitation_status AND v_existing_profile.auth_user_id = v_target_user_id THEN
                IF v_existing_profile.imported_role IS DISTINCT FROM 'super_admin'::public.app_role
                   OR v_existing_profile.email <> v_target_email THEN
                    UPDATE public.enterprise_users
                    SET email = v_target_email,
                        imported_role = 'super_admin'
                    WHERE id = v_existing_profile.id;
                END IF;
            ELSE
                -- Safely transition allowable pre-onboard status to LINKED with normalized email
                UPDATE public.enterprise_users
                SET email = v_target_email,
                    auth_user_id = v_target_user_id,
                    invitation_status = 'LINKED',
                    imported_role = 'super_admin'
                WHERE id = v_existing_profile.id;
            END IF;

        ELSE
            -- 4C. Zero matching profiles: Insert clean fresh profile
            BEGIN
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
                    'SA-' || pg_catalog.substr(v_target_user_id::text, 1, 8),
                    'Executive Leadership',
                    (SELECT id FROM public.departments WHERE name = 'Executive Leadership' LIMIT 1),
                    v_target_user_id,
                    true,
                    'LINKED',
                    'super_admin'
                );
            EXCEPTION WHEN unique_violation THEN
                RAISE EXCEPTION 'Concurrency Conflict: A profile matching email % or auth_user_id % was created concurrently',
                    v_target_email, v_target_user_id
                    USING ERRCODE = '23505';
            END;
        END IF;
    END $$;

    -- 5. Final assertion & Super Admin role grant
    DO $$
    DECLARE
        v_target_user_id uuid := '${targetUserId}';
        v_is_eligible boolean;
    BEGIN
        SELECT (is_active = true AND invitation_status = 'LINKED') INTO v_is_eligible
        FROM public.enterprise_users
        WHERE auth_user_id = v_target_user_id;

        IF NOT coalesce(v_is_eligible, false) THEN
            RAISE EXCEPTION 'Security Guard: Target user % does not possess an active, LINKED enterprise profile', v_target_user_id
                USING ERRCODE = '22000';
        END IF;
    END $$;

    -- 5B. Insert role into user_roles
    INSERT INTO public.user_roles (
        user_id,
        role
    )
    VALUES (
        '${targetUserId}',
        'super_admin'
    );

    -- 6. Insert verifiable audit log
    INSERT INTO public.admin_audit_logs (
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    )
    VALUES (
        NULL,
        'BOOTSTRAP_FIRST_SUPER_ADMIN',
        'user_roles',
        '${targetUserId}',
        pg_catalog.jsonb_build_object(
            'bootstrap_method', 'phase4_manual_dba_runbook',
            'target_auth_user_id', '${targetUserId}',
            'target_email', '${targetEmail}',
            'role', 'super_admin',
            'executing_role', current_user,
            'timestamp', clock_timestamp()
        )
    );

    COMMIT;
  `;
}

async function runAllRemediationTests() {
  console.log('==============================================================================');
  console.log(' PresenceTrack AI — Phase 4 Final Two-Issue Remediation Test Suite');
  console.log('==============================================================================\n');

  const cluster = new EphemeralClusterManager();
  let session = null;

  try {
    await cluster.start();
    session = new GuardedClusterSession(cluster);

    await session.withClient('postgres', async (s) => {
      await s.file(FIXTURE_00_BOOTSTRAP);
    });

    let passed = 0;
    let failed = 0;

    async function setupBaseDB(dbName) {
      await session.createDatabase(dbName);
      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_01_COMPAT);
        await sql.file(MIGRATION_0000_PATH);
        await sql.file(MIGRATION_0001_PATH);
        await sql.file(MIGRATION_0002_PATH);
        await sql.file(MIGRATION_0003_PATH);
      });
    }

    // ────────────────────────────────────────────────────────────────────────
    // PART A: Profile Normalization Tests (Issue 1)
    // ────────────────────────────────────────────────────────────────────────

    // Test A1: Whitespace-padded email profile matching and linking
    try {
      console.log('--- Test A1: Whitespace-Padded Email Profile Normalization ---');
      const dbName = 'pt_rem_a1';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`
          INSERT INTO auth.users (email, email_confirmed_at)
          VALUES ('admin@presencetrack.local', now())
          RETURNING id;
        `;

        // Pre-create profile with leading and trailing whitespace in email
        const [p] = await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            '   Admin@PresenceTrack.Local   ', 'Whitespace Admin', 'Staff', 'PAD-01', NULL, true, 'STAGED'
          ) RETURNING id;
        `;

        // Execute normalized bootstrap SQL
        await sql.unsafe(generateNormalizedBootstrapSQL(u.id, 'admin@presencetrack.local'));

        // Verify profile was matched, normalized, and linked to u.id
        const [linkedProfile] = await sql`SELECT * FROM public.enterprise_users WHERE id = ${p.id};`;
        if (linkedProfile.auth_user_id !== u.id) {
          throw new Error(`Profile was not linked to auth user ${u.id}`);
        }
        if (linkedProfile.invitation_status !== 'LINKED') {
          throw new Error(`Profile status is ${linkedProfile.invitation_status}, expected LINKED`);
        }
        if (linkedProfile.email !== 'admin@presencetrack.local') {
          throw new Error(`Profile email was not normalized: ${linkedProfile.email}`);
        }

        const [role] = await sql`SELECT * FROM public.user_roles WHERE user_id = ${u.id};`;
        if (!role || role.role !== 'super_admin') throw new Error('Role super_admin was not granted');
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test A1 Passed: Whitespace-padded email correctly matched, normalized, and linked.\n');
    } catch (e) {
      console.error('✖ Test A1 Failed:', e);
      failed++;
    }

    // Test A2: Normalized email matching more than one profile (fails closed with 23505)
    try {
      console.log('--- Test A2: Multiple Profiles Matching Normalized Email ---');
      const dbName = 'pt_rem_a2';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`
          INSERT INTO auth.users (email, email_confirmed_at)
          VALUES ('admin@presencetrack.local', now())
          RETURNING id;
        `;

        // Profile 1 matches auth_user_id
        await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            'other_admin@corp.com', 'Admin 1', 'Staff', 'DUP-01', ${u.id}, true, 'LINKED'
          );
        `;

        // Profile 2 matches normalized email
        await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            'admin@presencetrack.local', 'Admin 2', 'Staff', 'DUP-02', NULL, true, 'STAGED'
          );
        `;

        let errCode = null;
        try {
          await sql.unsafe(generateNormalizedBootstrapSQL(u.id, 'admin@presencetrack.local'));
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '23505') throw new Error(`Expected 23505 on duplicate match, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test A2 Passed: Multiple matching profiles aborted closed with 23505.\n');
    } catch (e) {
      console.error('✖ Test A2 Failed:', e);
      failed++;
    }

    // Test A3: Conflicting Auth linkage (fails closed with 23505)
    try {
      console.log('--- Test A3: Conflicting Auth Linkage on Target Email ---');
      const dbName = 'pt_rem_a3';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [otherUser] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('other@corp.com', now()) RETURNING id;`;
        const [adminUser] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('admin@presencetrack.local', now()) RETURNING id;`;

        // Profile matches target email but is already linked to otherUser
        await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            '  admin@presencetrack.local  ', 'Conflicting Admin', 'Staff', 'CONF-01', ${otherUser.id}, true, 'LINKED'
          );
        `;

        let errCode = null;
        try {
          await sql.unsafe(generateNormalizedBootstrapSQL(adminUser.id, 'admin@presencetrack.local'));
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '23505') throw new Error(`Expected 23505 on conflicting auth_user_id, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test A3 Passed: Conflicting Auth linkage aborted closed with 23505.\n');
    } catch (e) {
      console.error('✖ Test A3 Failed:', e);
      failed++;
    }

    // Test A4: No duplicate profile creation on repeat attempts
    try {
      console.log('--- Test A4: Zero Duplicate Profiles Created ---');
      const dbName = 'pt_rem_a4';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`
          INSERT INTO auth.users (email, email_confirmed_at)
          VALUES ('admin@presencetrack.local', now())
          RETURNING id;
        `;

        // First bootstrap execution: creates profile and role
        await sql.unsafe(generateNormalizedBootstrapSQL(u.id, 'admin@presencetrack.local'));

        // Verify exactly 1 profile exists
        const profiles1 = await sql`SELECT * FROM public.enterprise_users WHERE email = 'admin@presencetrack.local';`;
        if (profiles1.length !== 1) throw new Error(`Expected exactly 1 profile, found ${profiles1.length}`);

        // Second bootstrap execution: must abort with 23514 (Super Admin already exists) and NOT create a second profile
        let errCode = null;
        try {
          await sql.unsafe(generateNormalizedBootstrapSQL(u.id, 'admin@presencetrack.local'));
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '23514') throw new Error(`Expected 23514 on repeat bootstrap, got ${errCode}`);

        await sql.unsafe('ROLLBACK;').catch(() => {});

        const profiles2 = await sql`SELECT * FROM public.enterprise_users WHERE email = 'admin@presencetrack.local';`;
        if (profiles2.length !== 1) throw new Error(`Duplicate profile created! Count: ${profiles2.length}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test A4 Passed: Zero duplicate profiles created; repeat attempts abort cleanly.\n');
    } catch (e) {
      console.error('✖ Test A4 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // PART B: Fail-Safe Drizzle Baseline Registration Tests (Issue 2)
    // ────────────────────────────────────────────────────────────────────────

    // Test B1: Empty-table registration
    try {
      console.log('--- Test B1: Drizzle Baseline Empty-Table Registration ---');
      const dbName = 'pt_rem_b1';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        // Table does not exist initially; procedure creates it and inserts 4 records
        await sql.unsafe(DRIZZLE_BASELINE_REGISTRATION_SQL);

        const rows = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at ASC;`;
        if (rows.length !== 4) throw new Error(`Expected 4 rows, got ${rows.length}`);
        if (rows[0].created_at !== '1794057325415' || rows[3].created_at !== '1794057325418') {
          throw new Error('Timestamps mismatch in registered baseline');
        }
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test B1 Passed: Empty-table registration inserted exactly 4 verified records.\n');
    } catch (e) {
      console.error('✖ Test B1 Failed:', e);
      failed++;
    }

    // Test B2: Repeated registration (idempotent no-op)
    try {
      console.log('--- Test B2: Drizzle Baseline Repeated Registration (Idempotent No-Op) ---');
      const dbName = 'pt_rem_b2';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql.unsafe(DRIZZLE_BASELINE_REGISTRATION_SQL);
        // Execute second time: must succeed without inserting duplicate rows or raising errors
        await sql.unsafe(DRIZZLE_BASELINE_REGISTRATION_SQL);

        const rows = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at ASC;`;
        if (rows.length !== 4) throw new Error(`Expected exactly 4 rows after repeat, got ${rows.length}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test B2 Passed: Repeated registration verified as an idempotent no-op.\n');
    } catch (e) {
      console.error('✖ Test B2 Failed:', e);
      failed++;
    }

    // Test B3: Partial history (aborts with 22000)
    try {
      console.log('--- Test B3: Drizzle Baseline Partial History Detection ---');
      const dbName = 'pt_rem_b3';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql`CREATE SCHEMA IF NOT EXISTS drizzle;`;
        await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);`;
        // Insert only 2 of the 4 records
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES
            ('259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b', 1794057325415),
            ('cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee', 1794057325416);
        `;

        let errCode = null;
        try {
          await sql.unsafe(DRIZZLE_BASELINE_REGISTRATION_SQL);
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '22000') throw new Error(`Expected 22000 on partial history, got ${errCode}`);

        // Verify count remains 2 (zero partial mutation)
        const rows = await sql`SELECT count(*) FROM drizzle.__drizzle_migrations;`;
        if (parseInt(rows[0].count) !== 2) throw new Error('Table was modified unexpectedly');
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test B3 Passed: Partial history aborted closed with 22000 without mutation.\n');
    } catch (e) {
      console.error('✖ Test B3 Failed:', e);
      failed++;
    }

    // Test B4: Duplicate records (aborts with 23505)
    try {
      console.log('--- Test B4: Drizzle Baseline Duplicate Records Detection ---');
      const dbName = 'pt_rem_b4';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql`CREATE SCHEMA IF NOT EXISTS drizzle;`;
        await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);`;
        // Insert duplicate created_at / hash
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES
            ('259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b', 1794057325415),
            ('259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b', 1794057325415);
        `;

        let errCode = null;
        try {
          await sql.unsafe(DRIZZLE_BASELINE_REGISTRATION_SQL);
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '23505') throw new Error(`Expected 23505 on duplicate records, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test B4 Passed: Duplicate records detected and aborted closed with 23505.\n');
    } catch (e) {
      console.error('✖ Test B4 Failed:', e);
      failed++;
    }

    // Test B5: Incorrect hash (aborts with 22000)
    try {
      console.log('--- Test B5: Drizzle Baseline Incorrect Hash Detection ---');
      const dbName = 'pt_rem_b5';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql`CREATE SCHEMA IF NOT EXISTS drizzle;`;
        await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);`;
        // Insert 4 records, but migration 1 has a tampered hash
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES
            ('259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b', 1794057325415),
            ('TAMPERED_HASH_CORRUPT_0001000000000000000000000000000000000000000', 1794057325416),
            ('01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271', 1794057325417),
            ('6675879c535c20f4a8cbf50c7c9fd6370fb2d3e237a0a0dc243bb5df860b0b08', 1794057325418);
        `;

        let errCode = null;
        try {
          await sql.unsafe(DRIZZLE_BASELINE_REGISTRATION_SQL);
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '22000') throw new Error(`Expected 22000 on tampered hash, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test B5 Passed: Corrupt hash detected and aborted closed with 22000.\n');
    } catch (e) {
      console.error('✖ Test B5 Failed:', e);
      failed++;
    }

    // Test B6: Incorrect timestamp (aborts with 22000)
    try {
      console.log('--- Test B6: Drizzle Baseline Incorrect Timestamp Detection ---');
      const dbName = 'pt_rem_b6';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql`CREATE SCHEMA IF NOT EXISTS drizzle;`;
        await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);`;
        // Insert 4 records, but migration 2 has an incorrect timestamp
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES
            ('259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b', 1794057325415),
            ('cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee', 1794057325416),
            ('01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271', 9999999999999),
            ('6675879c535c20f4a8cbf50c7c9fd6370fb2d3e237a0a0dc243bb5df860b0b08', 1794057325418);
        `;

        let errCode = null;
        try {
          await sql.unsafe(DRIZZLE_BASELINE_REGISTRATION_SQL);
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '22000') throw new Error(`Expected 22000 on tampered timestamp, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test B6 Passed: Corrupt timestamp detected and aborted closed with 22000.\n');
    } catch (e) {
      console.error('✖ Test B6 Failed:', e);
      failed++;
    }

    // Test B7: Existing unexpected record (aborts with 22000)
    try {
      console.log('--- Test B7: Drizzle Baseline Existing Unexpected Record Detection ---');
      const dbName = 'pt_rem_b7';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql`CREATE SCHEMA IF NOT EXISTS drizzle;`;
        await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);`;
        // Insert all 4 expected records PLUS a 5th rogue record
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES
            ('259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b', 1794057325415),
            ('cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee', 1794057325416),
            ('01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271', 1794057325417),
            ('6675879c535c20f4a8cbf50c7c9fd6370fb2d3e237a0a0dc243bb5df860b0b08', 1794057325418),
            ('ROGUE_EXTRA_RECORD_HASH_00000000000000000000000000000000000000000', 1794057325499);
        `;

        let errCode = null;
        try {
          await sql.unsafe(DRIZZLE_BASELINE_REGISTRATION_SQL);
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '22000') throw new Error(`Expected 22000 on unexpected record, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test B7 Passed: Unexpected record detected and aborted closed with 22000.\n');
    } catch (e) {
      console.error('✖ Test B7 Failed:', e);
      failed++;
    }

    console.log('==============================================================================');
    console.log(` Summary: All ${passed} / 11 Remediation Tests Passed (${failed} Failed)`);
    console.log('==============================================================================');

    if (failed > 0) process.exit(1);
  } finally {
    await cluster.stopAndCleanup();
  }
}

runAllRemediationTests().catch((err) => {
  console.error('Fatal Remediation Test Error:', err);
  process.exit(1);
});
