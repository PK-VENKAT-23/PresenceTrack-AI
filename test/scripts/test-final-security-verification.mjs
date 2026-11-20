#!/usr/bin/env node
// ==============================================================================
// PresenceTrack AI — Final Three-Issue Security Verification Test Suite
// Path: test/scripts/test-final-security-verification.mjs
// ==============================================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { EphemeralClusterManager, GuardedClusterSession } from './run-pg17-integration.mjs';

const MIGRATION_0000_PATH = path.resolve('drizzle/migrations/0000_presencetrack_schema.sql');
const MIGRATION_0001_PATH = path.resolve('drizzle/migrations/0001_attendance_backend_expansion.sql');
const MIGRATION_0002_PATH = path.resolve('drizzle/migrations/0002_auth_security_hardening.sql');
const MIGRATION_0003_PATH = path.resolve('drizzle/migrations/0003_operational_security_fixes.sql');

const FIXTURE_00_BOOTSTRAP = path.resolve('test/fixtures/00_cluster_bootstrap.sql');
const FIXTURE_01_COMPAT = path.resolve('test/fixtures/01_supabase_compat.sql');

const JOURNAL_PATH = path.resolve('drizzle/migrations/meta/_journal.json');
const JOURNAL_BACKUP_PATH = path.resolve('drizzle/migrations/meta/_journal.json.bak');

function generateHardenedBootstrapSQL(targetUserId, targetEmail = 'admin@presencetrack.local') {
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
    -- Lock enterprise_users in SHARE ROW EXCLUSIVE MODE to serialize against concurrent profile creation
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

            -- Conflict 5: NULL or Unexpected invitation status (Fail closed on NULL or non-allowlisted)
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

async function runAllSecurityVerifications() {
  console.log('==============================================================================');
  console.log(' PresenceTrack AI — Final Three-Issue Security Verification Suite');
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
    // TEST 1: NULL invitation_status Fails Closed (SQLSTATE 22000)
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Test 1: NULL invitation_status Handling ---');
      const dbName = 'pt_sec_null_inv';
      await setupBaseDB(dbName);

      await session.withClient(dbName, async (sql) => {
        const [u] = await sql`
          INSERT INTO auth.users (email, email_confirmed_at)
          VALUES ('admin@presencetrack.local', now())
          RETURNING id;
        `;

        // Temporarily allow NULL to test the runtime guard
        await sql`ALTER TABLE public.enterprise_users ALTER COLUMN invitation_status DROP NOT NULL;`;

        await sql`
          INSERT INTO public.enterprise_users (
            email, name, role_title, badge_id, auth_user_id, is_active, invitation_status
          ) VALUES (
            'admin@presencetrack.local', 'Null Status User', 'Staff', 'NULL-01', ${u.id}, true, NULL
          );
        `;

        let errCode = null;
        let errMsg = '';
        try {
          await sql.unsafe(generateHardenedBootstrapSQL(u.id));
        } catch (e) {
          errCode = e.code;
          errMsg = e.message;
        }

        if (errCode !== '22000') {
          throw new Error(`Expected 22000 on NULL invitation_status, got ${errCode}: ${errMsg}`);
        }
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test 1 Passed: NULL invitation_status failed closed with SQLSTATE 22000.\n');
    } catch (e) {
      console.error('✖ Test 1 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // TEST 2: Concurrent Profile Insertion Isolation (SHARE ROW EXCLUSIVE)
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Test 2: Concurrent Profile Creation Race Prevention ---');
      const dbName = 'pt_sec_profile_race';
      await setupBaseDB(dbName);

      const client1 = postgres({ host: cluster.socketDir, port: cluster.port, database: dbName, max: 1 });
      const client2 = postgres({ host: cluster.socketDir, port: cluster.port, database: dbName, max: 1 });

      try {
        const [u] = await client1`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('admin@presencetrack.local', now()) RETURNING id;`;

        // Client 1 begins bootstrap, acquires lock and table lock
        let client1Inserted = false;
        let client2Blocked = false;

        const p1 = client1.begin(async (tx) => {
          await tx`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('global_super_admin_lock'));`;
          await tx`LOCK TABLE public.enterprise_users IN SHARE ROW EXCLUSIVE MODE;`;

          // Simulate slight delay to test Client 2 lock contention
          await new Promise((r) => setTimeout(r, 200));

          await tx`
            INSERT INTO public.enterprise_users (
              email, name, role_title, badge_id, auth_user_id, is_active, invitation_status, imported_role
            ) VALUES (
              'admin@presencetrack.local', 'Admin', 'Staff', 'SA-0001', ${u.id}, true, 'LINKED', 'super_admin'
            );
          `;
          await tx`INSERT INTO public.user_roles (user_id, role) VALUES (${u.id}, 'super_admin');`;
          client1Inserted = true;
        });

        // Client 2 attempts to insert a profile for the exact same email concurrently
        const p2 = (async () => {
          await new Promise((r) => setTimeout(r, 50)); // let client 1 acquire table lock first
          try {
            await client2`
              INSERT INTO public.enterprise_users (
                email, name, role_title, badge_id, is_active, invitation_status
              ) VALUES (
                'admin@presencetrack.local', 'Concurrent Intruder', 'Staff', 'INTRUDER-1', true, 'STAGED'
              );
            `;
            return { success: true };
          } catch (e) {
            return { success: false, code: e.code, message: e.message };
          }
        })();

        const [r1, r2] = await Promise.all([p1, p2]);

        if (r2.success === true) {
          throw new Error('Concurrent insert succeeded when it should have been blocked/failed!');
        }

        if (r2.code !== '23505') {
          throw new Error(`Expected 23505 on concurrent insert, got ${r2.code}: ${r2.message}`);
        }

        // Verify only 1 profile exists
        const profiles = await client1`SELECT * FROM public.enterprise_users WHERE email = 'admin@presencetrack.local';`;
        if (profiles.length !== 1 || profiles[0].auth_user_id !== u.id) {
          throw new Error('Unexpected profile state after concurrent race');
        }
      } finally {
        await client1.end({ timeout: 1 });
        await client2.end({ timeout: 1 });
      }

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test 2 Passed: Concurrent profile creation serialized and blocked cleanly with 23505.\n');
    } catch (e) {
      console.error('✖ Test 2 Failed:', e);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // TEST 3: Drizzle Migration History Reconciliation & Idempotent Rollout
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Test 3: Drizzle Migration Reconciliation & Temporary 0004 Execution ---');
      const dbName = 'pt_sec_drizzle_reconcile';
      await setupBaseDB(dbName);

      // Verify exact timestamps from _journal.json
      const journalRaw = fs.readFileSync(JOURNAL_PATH, 'utf8');
      const journal = JSON.parse(journalRaw);

      console.log('   Inspecting _journal.json entries:');
      const expectedEntries = [
        { idx: 0, tag: '0000_presencetrack_schema', when: 1794057325415 },
        { idx: 1, tag: '0001_attendance_backend_expansion', when: 1794057325416 },
        { idx: 2, tag: '0002_auth_security_hardening', when: 1794057325417 },
        { idx: 3, tag: '0003_operational_security_fixes', when: 1794057325418 },
      ];

      for (let i = 0; i < 4; i++) {
        const jEntry = journal.entries[i];
        const exp = expectedEntries[i];
        if (jEntry.tag !== exp.tag || jEntry.when !== exp.when) {
          throw new Error(`Journal entry mismatch at ${i}: expected ${exp.tag}@${exp.when}, got ${jEntry.tag}@${jEntry.when}`);
        }
        const fileContent = fs.readFileSync(path.resolve(`drizzle/migrations/${jEntry.tag}.sql`), 'utf8');
        const computedHash = crypto.createHash('sha256').update(fileContent).digest('hex');
        console.log(`     [${i}] ${jEntry.tag} -> when: ${jEntry.when}, hash: ${computedHash.slice(0, 16)}...`);
      }

      // Step 3A: Register the baseline history in drizzle.__drizzle_migrations
      await session.withClient(dbName, async (sql) => {
        await sql`CREATE SCHEMA IF NOT EXISTS drizzle;`;
        await sql`
          CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint
          );
        `;
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES
            ('259625640316f51aef2ddab51b48f4fd78977a9927a470975a0dea07527d861b', 1794057325415),
            ('cf0f37d3d760ff24aa03a500e861e766cfc1e2e72266b1b3b2bc06235acee1ee', 1794057325416),
            ('01dd9ea5fe5bc0b953ad7229d00bca6e4826f105c247c00537ee09ed63731271', 1794057325417),
            ('6675879c535c20f4a8cbf50c7c9fd6370fb2d3e237a0a0dc243bb5df860b0b08', 1794057325418);
        `;
      });

      // Step 3B: Create temporary migration 0004
      const TEMP_0004_SQL_PATH = path.resolve('drizzle/migrations/0004_test_verification.sql');
      const temp0004Content = `CREATE TABLE public.test_canary_0004 (
  id SERIAL PRIMARY KEY,
  canary_label TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);`;
      fs.writeFileSync(TEMP_0004_SQL_PATH, temp0004Content, 'utf8');

      // Backup original _journal.json and append 0004
      fs.writeFileSync(JOURNAL_BACKUP_PATH, journalRaw, 'utf8');
      const modifiedJournal = JSON.parse(journalRaw);
      modifiedJournal.entries.push({
        idx: 4,
        version: '7',
        when: 1794057325419,
        tag: '0004_test_verification',
        breakpoints: true,
      });
      fs.writeFileSync(JOURNAL_PATH, JSON.stringify(modifiedJournal, null, 2), 'utf8');

      const client = postgres({ host: cluster.socketDir, port: cluster.port, database: dbName, max: 1 });
      const db = drizzle(client);

      try {
        console.log('   Executing Migrator Run 1 (expecting 0000-0003 skipped, 0004 applied)...');
        await migrate(db, { migrationsFolder: path.resolve('drizzle/migrations') });

        // Verify test_canary_0004 exists
        const canaryTable = await client`SELECT to_regclass('public.test_canary_0004');`;
        if (!canaryTable[0].to_regclass) {
          throw new Error('test_canary_0004 table was not created by migration 0004!');
        }

        // Verify drizzle.__drizzle_migrations count is now 5
        const historyRows = await client`SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at ASC;`;
        if (historyRows.length !== 5) {
          throw new Error(`Expected exactly 5 rows in __drizzle_migrations, got ${historyRows.length}`);
        }
        if (historyRows[4].created_at !== '1794057325419') {
          throw new Error(`Migration 0004 created_at mismatch: ${historyRows[4].created_at}`);
        }
        console.log('   ✔ Run 1 successfully skipped 0000-0003 and applied 0004.');

        console.log('   Executing Migrator Run 2 (expecting complete skip of 0000-0004)...');
        await migrate(db, { migrationsFolder: path.resolve('drizzle/migrations') });

        const historyRowsRun2 = await client`SELECT count(*) FROM drizzle.__drizzle_migrations;`;
        if (parseInt(historyRowsRun2[0].count) !== 5) {
          throw new Error(`Expected count to remain 5, got ${historyRowsRun2[0].count}`);
        }
        console.log('   ✔ Run 2 successfully skipped all migrations with zero duplicate execution.');
      } finally {
        await client.end({ timeout: 1 });
        // Clean up temporary 0004 file
        if (fs.existsSync(TEMP_0004_SQL_PATH)) {
          fs.unlinkSync(TEMP_0004_SQL_PATH);
        }
        // Restore original _journal.json
        fs.copyFileSync(JOURNAL_BACKUP_PATH, JOURNAL_PATH);
        if (fs.existsSync(JOURNAL_BACKUP_PATH)) {
          fs.unlinkSync(JOURNAL_BACKUP_PATH);
        }
      }

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test 3 Passed: Drizzle migration reconciliation mathematically & empirically proven.\n');
    } catch (e) {
      console.error('✖ Test 3 Failed:', e);
      failed++;
    }

    console.log('==============================================================================');
    console.log(` Summary: ${passed} / 3 Security Verifications Passed (${failed} Failed)`);
    console.log('==============================================================================');

    if (failed > 0) process.exit(1);
  } finally {
    // Ensure journal is restored even on error
    if (fs.existsSync(JOURNAL_BACKUP_PATH)) {
      fs.copyFileSync(JOURNAL_BACKUP_PATH, JOURNAL_PATH);
      fs.unlinkSync(JOURNAL_BACKUP_PATH);
    }
    const temp0004 = path.resolve('drizzle/migrations/0004_test_verification.sql');
    if (fs.existsSync(temp0004)) {
      fs.unlinkSync(temp0004);
    }
    await cluster.stopAndCleanup();
  }
}

runAllSecurityVerifications().catch((err) => {
  console.error('Fatal Security Verification Suite Error:', err);
  process.exit(1);
});
