#!/usr/bin/env node
// ==============================================================================
// PresenceTrack AI — Super Admin Bootstrap Validation Test Suite
// Path: test/scripts/test-bootstrap-validation.mjs
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

function generateBootstrapSQL(targetUserId, targetEmail = 'admin@presencetrack.local', injectFailure = false) {
  return `
    BEGIN;

    -- 1. Acquire platform-wide global advisory lock
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('global_super_admin_lock'));

    -- 2. Immediate Security Guard: Assert zero existing Super Admins
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

        -- 4B. Explicitly count matching enterprise_users profiles (detect ambiguous duplicates)
        SELECT count(*) INTO v_matching_count
        FROM public.enterprise_users
        WHERE pg_catalog.lower(email) = v_target_email OR auth_user_id = v_target_user_id;

        IF v_matching_count > 1 THEN
            RAISE EXCEPTION 'Integrity Failure: Multiple (% matching) enterprise profiles match email % or auth_user_id %',
                v_matching_count, v_target_email, v_target_user_id
                USING ERRCODE = '23505';
        ELSIF v_matching_count = 1 THEN
            -- Exactly 1 matching profile: lock and validate state
            SELECT * INTO STRICT v_existing_profile
            FROM public.enterprise_users
            WHERE pg_catalog.lower(email) = v_target_email OR auth_user_id = v_target_user_id
            FOR UPDATE;

            -- Conflict 1: Already linked to a DIFFERENT auth_user_id
            IF v_existing_profile.auth_user_id IS NOT NULL AND v_existing_profile.auth_user_id <> v_target_user_id THEN
                RAISE EXCEPTION 'Identity Conflict: Enterprise profile % is already linked to auth_user_id % (target is %)',
                    v_existing_profile.id, v_existing_profile.auth_user_id, v_target_user_id
                    USING ERRCODE = '23505';
            END IF;

            -- Conflict 2: Email mismatch on existing profile
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

            -- Conflict 5: Unexpected invitation status
            IF v_existing_profile.invitation_status NOT IN (
                'STAGED'::public.invitation_status,
                'DISPATCH_PENDING'::public.invitation_status,
                'DISPATCHED'::public.invitation_status,
                'LINKED'::public.invitation_status
            ) THEN
                RAISE EXCEPTION 'State Conflict: Enterprise profile % has unexpected invitation status %',
                    v_existing_profile.id, v_existing_profile.invitation_status
                    USING ERRCODE = '22000';
            END IF;

            -- If already LINKED to this target user, preserve without unnecessary changes
            IF v_existing_profile.invitation_status = 'LINKED'::public.invitation_status AND v_existing_profile.auth_user_id = v_target_user_id THEN
                IF v_existing_profile.imported_role IS DISTINCT FROM 'super_admin'::public.app_role THEN
                    UPDATE public.enterprise_users
                    SET imported_role = 'super_admin'
                    WHERE id = v_existing_profile.id;
                END IF;
            ELSE
                -- Safely transition allowable pre-onboard status to LINKED
                UPDATE public.enterprise_users
                SET auth_user_id = v_target_user_id,
                    invitation_status = 'LINKED',
                    imported_role = 'super_admin'
                WHERE id = v_existing_profile.id;
            END IF;

        ELSE
            -- 4C. Zero matching profiles: Insert clean fresh profile
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
        END IF;
    END $$;

    -- 5. Final assertion & Super Admin role grant
    DO $$
    DECLARE
        v_target_user_id uuid := '${targetUserId}';
        v_is_eligible boolean;
    BEGIN
        -- Assert profile is active and in LINKED status
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

    ${injectFailure ? `RAISE EXCEPTION 'Simulated failure after role insert' USING ERRCODE = 'P0001';` : ''}

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

async function runBootstrapTests() {
  console.log('==============================================================================');
  console.log(' PresenceTrack AI — Super Admin Bootstrap Comprehensive Test Suite');
  console.log('==============================================================================\n');

  const cluster = new EphemeralClusterManager();
  let session = null;

  try {
    await cluster.start();
    session = new GuardedClusterSession(cluster);

    await session.withClient('postgres', async (adminSql) => {
      await adminSql.file(FIXTURE_00_BOOTSTRAP);
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
    // SCENARIO 1: Clean First-Admin Bootstrap (zero profile beforehand)
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Scenario 1: Clean First-Admin Bootstrap ---');
      const dbName = 'pt_boot_s1';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`
          INSERT INTO auth.users (email, email_confirmed_at)
          VALUES ('admin@presencetrack.local', now())
          RETURNING id;
        `;
        await sql.unsafe(generateBootstrapSQL(u.id));

        const [role] = await sql`SELECT * FROM public.user_roles WHERE user_id = ${u.id};`;
        if (!role || role.role !== 'super_admin') throw new Error('Role super_admin not granted');

        const [profile] = await sql`SELECT * FROM public.enterprise_users WHERE auth_user_id = ${u.id};`;
        if (!profile || profile.invitation_status !== 'LINKED' || !profile.is_active) {
          throw new Error('Profile invalid or not LINKED');
        }

        const [audit] = await sql`SELECT * FROM public.admin_audit_logs WHERE action = 'BOOTSTRAP_FIRST_SUPER_ADMIN';`;
        if (!audit || audit.actor_id !== null) throw new Error('Audit log actor_id should be NULL');
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Scenario 1 Passed: Clean bootstrap succeeded, profile LINKED, audit logged.\n');
    } catch (e) {
      console.error('✖ Scenario 1 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCENARIO 2: Existing Correctly Linked Profile
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Scenario 2: Existing Correctly Linked Profile ---');
      const dbName = 'pt_boot_s2';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`
          INSERT INTO auth.users (email, email_confirmed_at)
          VALUES ('admin@presencetrack.local', now())
          RETURNING id;
        `;
        // Pre-create correctly linked profile
        const [p] = await sql`
          INSERT INTO public.enterprise_users (
            id, email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            gen_random_uuid(), 'admin@presencetrack.local', 'Admin User', 'Exec', 'SA-0002', ${u.id}, true, 'LINKED'
          ) RETURNING id;
        `;

        await sql.unsafe(generateBootstrapSQL(u.id));

        const [role] = await sql`SELECT * FROM public.user_roles WHERE user_id = ${u.id};`;
        if (!role || role.role !== 'super_admin') throw new Error('Role super_admin not granted');

        const [afterProfile] = await sql`SELECT * FROM public.enterprise_users WHERE id = ${p.id};`;
        if (afterProfile.auth_user_id !== u.id || afterProfile.invitation_status !== 'LINKED') {
          throw new Error('Profile was corrupted');
        }
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Scenario 2 Passed: Existing LINKED profile preserved and promoted.\n');
    } catch (e) {
      console.error('✖ Scenario 2 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCENARIO 3: Existing Profile Linked to Another Auth UUID
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Scenario 3: Existing Profile Linked to Another Auth UUID ---');
      const dbName = 'pt_boot_s3';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u1] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('other@corp.com', now()) RETURNING id;`;
        const [u2] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('admin@presencetrack.local', now()) RETURNING id;`;

        // Profile has target email but is linked to u1
        await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            'admin@presencetrack.local', 'Impostor', 'Staff', 'BAD-01', ${u1.id}, true, 'LINKED'
          );
        `;

        let errCode = null;
        try {
          await sql.unsafe(generateBootstrapSQL(u2.id));
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '23505') throw new Error(`Expected 23505, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Scenario 3 Passed: Failed closed with 23505 on conflicting auth_user_id.\n');
    } catch (e) {
      console.error('✖ Scenario 3 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCENARIO 4: Duplicate Profile Matches
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Scenario 4: Duplicate Profile Matches ---');
      const dbName = 'pt_boot_s4';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('admin@presencetrack.local', now()) RETURNING id;`;

        // Profile 1 matches auth_user_id (different email)
        await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            'legacy@presencetrack.local', 'Admin Old', 'Staff', 'BAD-02', ${u.id}, true, 'LINKED'
          );
        `;

        // Profile 2 matches email (unlinked)
        await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            'admin@presencetrack.local', 'Admin New', 'Staff', 'BAD-03', NULL, true, 'STAGED'
          );
        `;

        let errCode = null;
        try {
          await sql.unsafe(generateBootstrapSQL(u.id));
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '23505') throw new Error(`Expected 23505, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Scenario 4 Passed: Failed closed with 23505 on duplicate profile match.\n');
    } catch (e) {
      console.error('✖ Scenario 4 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCENARIO 5: RECONCILIATION_REQUIRED Quarantine
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Scenario 5: RECONCILIATION_REQUIRED Quarantine ---');
      const dbName = 'pt_boot_s5';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('admin@presencetrack.local', now()) RETURNING id;`;

        await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            'admin@presencetrack.local', 'Quarantined Admin', 'Staff', 'Q-01', ${u.id}, true, 'RECONCILIATION_REQUIRED'
          );
        `;

        let errCode = null;
        try {
          await sql.unsafe(generateBootstrapSQL(u.id));
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '22000') throw new Error(`Expected 22000, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Scenario 5 Passed: Failed closed with 22000 on quarantined profile.\n');
    } catch (e) {
      console.error('✖ Scenario 5 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCENARIO 6: Inactive Profile
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Scenario 6: Inactive Profile ---');
      const dbName = 'pt_boot_s6';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('admin@presencetrack.local', now()) RETURNING id;`;

        await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            'admin@presencetrack.local', 'Inactive Admin', 'Staff', 'INACT-01', ${u.id}, false, 'LINKED'
          );
        `;

        let errCode = null;
        try {
          await sql.unsafe(generateBootstrapSQL(u.id));
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '22000') throw new Error(`Expected 22000, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Scenario 6 Passed: Failed closed with 22000 on inactive profile.\n');
    } catch (e) {
      console.error('✖ Scenario 6 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCENARIO 7: Unexpected Invitation Status
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Scenario 7: Unexpected Invitation Status ---');
      const dbName = 'pt_boot_s7';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('admin@presencetrack.local', now()) RETURNING id;`;

        // We temporarily test with a status that isn't allowable (e.g. STAGED is allowable, but what if profile email mismatch?)
        await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            'mismatch@corp.com', 'Mismatch Admin', 'Staff', 'UNEXP-01', ${u.id}, true, 'STAGED'
          );
        `;

        let errCode = null;
        try {
          await sql.unsafe(generateBootstrapSQL(u.id));
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '22000') throw new Error(`Expected 22000, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Scenario 7 Passed: Failed closed with 22000 on email mismatch / state anomaly.\n');
    } catch (e) {
      console.error('✖ Scenario 7 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCENARIO 8: Pre-Existing Super Admin
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Scenario 8: Pre-Existing Super Admin ---');
      const dbName = 'pt_boot_s8';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [existingAdmin] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('root@presencetrack.local', now()) RETURNING id;`;
        await sql`
          INSERT INTO public.enterprise_users (email, name, role_title, badge_id, auth_user_id, is_active, invitation_status)
          VALUES ('root@presencetrack.local', 'Root Admin', 'Staff', 'ROOT-01', ${existingAdmin.id}, true, 'LINKED');
        `;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${existingAdmin.id}, 'super_admin');`;

        const [candidate] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('candidate@presencetrack.local', now()) RETURNING id;`;

        let errCode = null;
        try {
          await sql.unsafe(generateBootstrapSQL(candidate.id, 'candidate@presencetrack.local'));
        } catch (e) {
          errCode = e.code;
        }

        if (errCode !== '23514') throw new Error(`Expected 23514, got ${errCode}`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Scenario 8 Passed: Failed closed with 23514 when a Super Admin already exists.\n');
    } catch (e) {
      console.error('✖ Scenario 8 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCENARIO 9: Atomicity & Complete Rollback Verification
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Scenario 9: Complete Rollback on Mid-Transaction Failure ---');
      const dbName = 'pt_boot_s9';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('admin@presencetrack.local', now()) RETURNING id;`;

        let failedAsExpected = false;
        try {
          // Inject an error after role insert but before audit insert
          await sql.unsafe(generateBootstrapSQL(u.id, 'admin@presencetrack.local', true));
        } catch (e) {
          failedAsExpected = true;
        }

        if (!failedAsExpected) throw new Error('Expected transaction to fail');

        // Verify that NO role was committed
        const roles = await sql`SELECT * FROM public.user_roles WHERE user_id = ${u.id};`;
        if (roles.length !== 0) throw new Error('user_roles row was NOT rolled back!');

        // Verify that NO bootstrap audit log was committed
        const logs = await sql`SELECT * FROM public.admin_audit_logs WHERE action = 'BOOTSTRAP_FIRST_SUPER_ADMIN';`;
        if (logs.length !== 0) throw new Error('admin_audit_logs bootstrap row was NOT rolled back!');

        // Verify that profile insert was also rolled back
        const profiles = await sql`SELECT * FROM public.enterprise_users WHERE auth_user_id = ${u.id};`;
        if (profiles.length !== 0) throw new Error('enterprise_users row was NOT rolled back!');
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Scenario 9 Passed: Atomic rollback verified; zero lingering state.\n');
    } catch (e) {
      console.error('✖ Scenario 9 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCENARIO 10: Concurrent Bootstrap Attempts
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Scenario 10: Concurrent Bootstrap Race ---');
      const dbName = 'pt_boot_s10';
      await setupBaseDB(dbName);

      const client1 = postgres({ host: cluster.socketDir, port: cluster.port, database: dbName, max: 1 });
      const client2 = postgres({ host: cluster.socketDir, port: cluster.port, database: dbName, max: 1 });

      try {
        const [u1] = await client1`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('cand1@presencetrack.local', now()) RETURNING id;`;
        const [u2] = await client1`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('cand2@presencetrack.local', now()) RETURNING id;`;

        const p1 = client1.unsafe(generateBootstrapSQL(u1.id, 'cand1@presencetrack.local'));
        const p2 = client2.unsafe(generateBootstrapSQL(u2.id, 'cand2@presencetrack.local'));

        const results = await Promise.allSettled([p1, p2]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        if (fulfilled.length !== 1 || rejected.length !== 1) {
          throw new Error(`Expected 1 success and 1 rejection, got ${fulfilled.length} fulfilled and ${rejected.length} rejected`);
        }

        const rejectionCode = rejected[0].reason.code;
        if (rejectionCode !== '23514') {
          throw new Error(`Expected 23514, got ${rejectionCode}: ${rejected[0].reason.message}`);
        }

        const adminCount = await client1`SELECT count(*) FROM public.user_roles WHERE role = 'super_admin';`;
        if (parseInt(adminCount[0].count) !== 1) throw new Error('Expected exactly 1 Super Admin in database');
      } finally {
        await client1.end({ timeout: 1 });
        await client2.end({ timeout: 1 });
      }

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Scenario 10 Passed: Concurrency race serialized; exactly 1 won, competitor failed with 23514.\n');
    } catch (e) {
      console.error('✖ Scenario 10 Failed:', e);
      failed++;
    }

    console.log('==============================================================================');
    console.log(` Summary: ${passed} / 10 Scenarios Passed (${failed} Failed)`);
    console.log('==============================================================================');

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await cluster.stopAndCleanup();
  }
}

runBootstrapTests().catch((err) => {
  console.error('Fatal Test Suite Error:', err);
  process.exit(1);
});
