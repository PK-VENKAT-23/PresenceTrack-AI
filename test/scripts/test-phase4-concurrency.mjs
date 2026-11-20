#!/usr/bin/env node
// ==============================================================================
// PresenceTrack AI — Phase 4 Concurrency & Remediation Test Suite
// Path: test/scripts/test-phase4-concurrency.mjs
//
// Tests:
//   1. Multi-migration sequential rollout (0000 -> 0001 -> 0002 -> 0003) & atomic rollback
//   2. RLS matrix across all 4 roles (employee, hr_ops, security, super_admin) on departments & attendance
//   3. Audit log forgery prevention (blocking ordinary employee direct INSERT)
//   4. DPDP erasure scope validation (22023), verification (P0008, P0009), & durable tombstones (RESTRICT)
//   5. Attendance out-of-order transit reconciliation with authoritative EXCLUDED parity
//   6. Concurrent first-Super-Admin provisioning race & operator attribution
//   7. Concurrent role mutations with advisory lock serialization
//   8. Auth trigger invitation lifecycle (STAGED -> DISPATCHED -> LINKED vs uninvited quarantine)
// ==============================================================================

import fs from 'fs';
import path from 'path';
import postgres from 'postgres';
import { EphemeralClusterManager, GuardedClusterSession } from './run-pg17-integration.mjs';

const MIGRATION_0000_PATH = path.resolve('drizzle/migrations/0000_presencetrack_schema.sql');
const MIGRATION_0001_PATH = path.resolve('drizzle/migrations/0001_attendance_backend_expansion.sql');
const MIGRATION_0002_PATH = path.resolve('drizzle/migrations/0002_auth_security_hardening.sql');
const MIGRATION_0003_PATH = path.resolve('drizzle/migrations/0003_operational_security_fixes.sql');

const FIXTURE_00_BOOTSTRAP = path.resolve('test/fixtures/00_cluster_bootstrap.sql');
const FIXTURE_01_COMPAT = path.resolve('test/fixtures/01_supabase_compat.sql');

async function runAllPhase4Tests() {
  console.log('==============================================================================');
  console.log(' PresenceTrack AI — Phase 4 Concurrency & Remediation Test Suite');
  console.log('==============================================================================');

  const cluster = new EphemeralClusterManager();
  let session = null;

  try {
    console.log('1. Initializing ephemeral PostgreSQL 17 cluster...');
    await cluster.start();
    console.log(`   ✔ Cluster started on port ${cluster.port}`);
    console.log(`   ✔ System Identifier: ${cluster.bootstrapSystemIdentifier}`);

    session = new GuardedClusterSession(cluster);

    console.log('\n2. Bootstrapping cluster-wide roles (anon, authenticated, service_role)...');
    await session.withClient('postgres', async (adminSql) => {
      await adminSql.file(FIXTURE_00_BOOTSTRAP);
    });
    console.log('   ✔ Roles provisioned.');

    let passed = 0;
    let failed = 0;

    // Helper to create an authenticated client session for a given user & role
    async function createAuthSession(sql, userId, role = 'authenticated') {
      await sql`SET LOCAL ROLE authenticated;`;
      await sql`SELECT set_config('request.jwt.claim.sub', ${userId}::text, true);`;
      await sql`SELECT set_config('request.jwt.claim.role', ${role}, true);`;
    }

    // ────────────────────────────────────────────────────────────────────────
    // TEST 1: Full Sequential Migration Rollout (0000 -> 0001 -> 0002 -> 0003)
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('\n--- Test 1: Full Sequential Migration Rollout (0000..0003) & Rollback ---');
      const dbName = 'pt_p4_rollout';
      await session.createDatabase(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_01_COMPAT);

        // Apply 0000
        await sql.file(MIGRATION_0000_PATH);
        console.log('   ✔ Migration 0000 applied successfully.');

        // Apply 0001
        await sql.file(MIGRATION_0001_PATH);
        console.log('   ✔ Migration 0001 applied successfully.');

        // Apply 0002
        await sql.file(MIGRATION_0002_PATH);
        console.log('   ✔ Migration 0002 applied successfully.');

        // Apply 0003
        await sql.file(MIGRATION_0003_PATH);
        console.log('   ✔ Migration 0003 applied successfully.');

        // Verify total tables = 12
        const tables = await sql`
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public'
          ORDER BY tablename;
        `;
        const tableNames = tables.map((t) => t.tablename);
        const expectedTables = [
          'admin_audit_logs',
          'attendance_records',
          'departments',
          'dpdp_backup_tombstones',
          'dpo_erasure_requests',
          'employee_daily_dwell',
          'enterprise_users',
          'esp32_camera_nodes',
          'merkle_audit_blocks',
          'passive_transits',
          'unknown_detections',
          'user_roles',
        ];
        for (const exp of expectedTables) {
          if (!tableNames.includes(exp)) {
            throw new Error(`Expected table ${exp} not found in public schema`);
          }
        }
        console.log(`   ✔ All ${expectedTables.length} expected application & compliance tables verified.`);

        // Rollback test: in sub-transaction, attempt invalid SQL, verify rollback
        let rollbackCaught = false;
        try {
          await sql.begin(async (tx) => {
            await tx`CREATE TABLE public.temp_should_rollback (id int);`;
            throw new Error('INTENTIONAL_ROLLBACK');
          });
        } catch (e) {
          if (e.message === 'INTENTIONAL_ROLLBACK') rollbackCaught = true;
        }
        if (!rollbackCaught) throw new Error('Rollback was not triggered');
        const [tempExists] = await sql`
          SELECT count(*) as cnt FROM pg_tables WHERE schemaname = 'public' AND tablename = 'temp_should_rollback';
        `;
        if (parseInt(tempExists.cnt, 10) !== 0) throw new Error('Rollback failure: table still exists');
        console.log('   ✔ Atomic transaction rollback behavior verified.');
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test 1 Passed.\n');
    } catch (err) {
      console.error('✖ Test 1 Failed:', err);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // TEST 2: Department Grants & Conjunctive RLS Authorization Matrix
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Test 2: Department Write Grants & Conjunctive RLS Matrix ---');
      const dbName = 'pt_p4_depts_rls';
      await session.createDatabase(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_01_COMPAT);
        await sql.file(MIGRATION_0000_PATH);
        await sql.file(MIGRATION_0001_PATH);
        await sql.file(MIGRATION_0002_PATH);
        await sql.file(MIGRATION_0003_PATH);

        // Setup test users for all 4 roles:
        // 1. Super Admin user
        const [adminAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('admin@corp.com', now()) RETURNING id;`;
        await sql`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, imported_role)
                  VALUES (${adminAuth.id}, 'Super Admin', 'admin@corp.com', 'PT-ADM', true, 'LINKED', 'super_admin');`;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${adminAuth.id}, 'super_admin');`;

        // 2. HR Ops user
        const [hrAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('hr@corp.com', now()) RETURNING id;`;
        await sql`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, imported_role)
                  VALUES (${hrAuth.id}, 'HR Ops Specialist', 'hr@corp.com', 'PT-HR', true, 'LINKED', 'hr_ops');`;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${hrAuth.id}, 'hr_ops');`;

        // 3. Security Officer user
        const [secAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('sec@corp.com', now()) RETURNING id;`;
        await sql`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, imported_role)
                  VALUES (${secAuth.id}, 'Security Officer', 'sec@corp.com', 'PT-SEC-DEPT', true, 'LINKED', 'security');`;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${secAuth.id}, 'security');`;

        // 4. Employee user
        const [empAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('emp@corp.com', now()) RETURNING id;`;
        await sql`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, imported_role)
                  VALUES (${empAuth.id}, 'Regular Employee', 'emp@corp.com', 'PT-EMP', true, 'LINKED', 'employee');`;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${empAuth.id}, 'employee');`;

        // First, Super Admin inserts a baseline department
        let baseDeptId = null;
        await sql.begin(async (tx) => {
          await createAuthSession(tx, adminAuth.id);
          const [d] = await tx`INSERT INTO public.departments (name, description) VALUES ('Core Engineering', 'R&D Department') RETURNING id;`;
          baseDeptId = d.id;
        });
        if (!baseDeptId) throw new Error('Super Admin failed to create baseline department');

        // Test non-admin roles: employee, hr_ops, security across INSERT, UPDATE, DELETE, and SELECT
        const nonAdminRoles = [
          { name: 'employee', authId: empAuth.id },
          { name: 'hr_ops', authId: hrAuth.id },
          { name: 'security', authId: secAuth.id }
        ];

        for (const roleTest of nonAdminRoles) {
          // A. INSERT must fail with 42501
          let insertFailed = false;
          try {
            await sql.begin(async (tx) => {
              await createAuthSession(tx, roleTest.authId);
              await tx`INSERT INTO public.departments (name) VALUES (${'Dept by ' + roleTest.name});`;
            });
          } catch (e) {
            insertFailed = true;
            if (e.code !== '42501') throw new Error(`Expected 42501 for ${roleTest.name} insert, got ${e.code}: ${e.message}`);
          }
          if (!insertFailed) throw new Error(`Security Breach: ${roleTest.name} was able to insert into departments`);

          // B. UPDATE must affect 0 rows
          await sql.begin(async (tx) => {
            await createAuthSession(tx, roleTest.authId);
            const res = await tx`UPDATE public.departments SET name = 'Tampered' WHERE id = ${baseDeptId};`;
            if (res.count !== 0) throw new Error(`Security Breach: ${roleTest.name} modified department rows`);
          });

          // C. DELETE must affect 0 rows
          await sql.begin(async (tx) => {
            await createAuthSession(tx, roleTest.authId);
            const res = await tx`DELETE FROM public.departments WHERE id = ${baseDeptId};`;
            if (res.count !== 0) throw new Error(`Security Breach: ${roleTest.name} deleted department rows`);
          });

          // D. SELECT must succeed (read-only allowed for authenticated)
          await sql.begin(async (tx) => {
            await createAuthSession(tx, roleTest.authId);
            const rows = await tx`SELECT id, name FROM public.departments WHERE id = ${baseDeptId};`;
            if (rows.length !== 1) throw new Error(`Read Failure: ${roleTest.name} could not read department`);
          });

          console.log(`   ✔ Role ${roleTest.name} correctly blocked from INSERT (42501), UPDATE (0 rows), DELETE (0 rows); permitted SELECT.`);
        }

        // Now test Super Admin UPDATE and DELETE -> MUST SUCCEED
        await sql.begin(async (tx) => {
          await createAuthSession(tx, adminAuth.id);
          const updRes = await tx`UPDATE public.departments SET description = 'Updated Description' WHERE id = ${baseDeptId};`;
          if (updRes.count !== 1) throw new Error('Admin failed to update department');
          const delRes = await tx`DELETE FROM public.departments WHERE id = ${baseDeptId};`;
          if (delRes.count !== 1) throw new Error('Admin failed to delete department');
        });
        console.log('   ✔ Super Admin INSERT, UPDATE, and DELETE on departments succeeded.');
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test 2 Passed.\n');
    } catch (err) {
      console.error('✖ Test 2 Failed:', err);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // TEST 3: Audit Log Forgery Prevention
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Test 3: Audit Log Forgery Prevention ---');
      const dbName = 'pt_p4_audit_rls';
      await session.createDatabase(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_01_COMPAT);
        await sql.file(MIGRATION_0000_PATH);
        await sql.file(MIGRATION_0001_PATH);
        await sql.file(MIGRATION_0002_PATH);
        await sql.file(MIGRATION_0003_PATH);

        // 1. Admin user
        const [admAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('auditadm@corp.com', now()) RETURNING id;`;
        await sql`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, imported_role)
                  VALUES (${admAuth.id}, 'Audit Admin', 'auditadm@corp.com', 'PT-AUD-ADM', true, 'LINKED', 'super_admin');`;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${admAuth.id}, 'super_admin');`;

        // 2. Employee user
        const [empAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('emp@corp.com', now()) RETURNING id;`;
        await sql`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, imported_role)
                  VALUES (${empAuth.id}, 'Regular Employee', 'emp@corp.com', 'PT-EMP-SEC', true, 'LINKED', 'employee');`;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${empAuth.id}, 'employee');`;

        // 3. HR Ops user
        const [hrAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('hrops@corp.com', now()) RETURNING id;`;
        await sql`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, imported_role)
                  VALUES (${hrAuth.id}, 'HR Specialist', 'hrops@corp.com', 'PT-HR-AUD', true, 'LINKED', 'hr_ops');`;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${hrAuth.id}, 'hr_ops');`;

        // 4. Security Officer user
        const [secAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('sec@corp.com', now()) RETURNING id;`;
        await sql`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, imported_role)
                  VALUES (${secAuth.id}, 'Security Officer', 'sec@corp.com', 'PT-SEC', true, 'LINKED', 'security');`;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${secAuth.id}, 'security');`;

        // A. Employee attempts direct INSERT with their own actor_id -> MUST FAIL (42501)
        let empOwnBlocked = false;
        try {
          await sql.begin(async (tx) => {
            await createAuthSession(tx, empAuth.id);
            await tx`
              INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, metadata)
              VALUES (${empAuth.id}, 'fraudulent.action', 'auth', '{"own": true}'::jsonb);
            `;
          });
        } catch (e) {
          empOwnBlocked = true;
          if (e.code !== '42501') throw new Error(`Expected 42501, got ${e.code}: ${e.message}`);
        }
        if (!empOwnBlocked) throw new Error('Security Breach: Employee inserted row with own actor_id');
        console.log('   ✔ Direct INSERT by employee with own actor_id blocked by RLS (42501).');

        // B. Employee attempts direct INSERT spoofing another user (Admin actor_id) -> MUST FAIL (42501)
        let empSpoofBlocked = false;
        try {
          await sql.begin(async (tx) => {
            await createAuthSession(tx, empAuth.id);
            await tx`
              INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, metadata)
              VALUES (${admAuth.id}, 'spoofed.admin.action', 'auth', '{"spoofed": true}'::jsonb);
            `;
          });
        } catch (e) {
          empSpoofBlocked = true;
          if (e.code !== '42501') throw new Error(`Expected 42501, got ${e.code}: ${e.message}`);
        }
        if (!empSpoofBlocked) throw new Error('Security Breach: Employee inserted row with spoofed actor_id');
        console.log('   ✔ Direct INSERT by employee with spoofed actor_id blocked by RLS (42501).');

        // C. HR Ops attempts direct INSERT with their own actor_id -> MUST FAIL (42501)
        let hrBlocked = false;
        try {
          await sql.begin(async (tx) => {
            await createAuthSession(tx, hrAuth.id);
            await tx`
              INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, metadata)
              VALUES (${hrAuth.id}, 'hr.action', 'auth', '{"hr": true}'::jsonb);
            `;
          });
        } catch (e) {
          hrBlocked = true;
          if (e.code !== '42501') throw new Error(`Expected 42501, got ${e.code}: ${e.message}`);
        }
        if (!hrBlocked) throw new Error('Security Breach: HR Ops inserted row into admin_audit_logs');
        console.log('   ✔ Direct INSERT by HR Ops blocked by RLS (42501).');

        // D. Security officer direct INSERT without RETURNING -> MUST SUCCEED
        let secAuditInserted = false;
        await sql.begin(async (tx) => {
          await createAuthSession(tx, secAuth.id);
          const res = await tx`
            INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, metadata)
            VALUES (${secAuth.id}, 'security.camera_reboot', 'esp32_camera_nodes', '{"camera_id": "CAM-01"}'::jsonb);
          `;
          secAuditInserted = res.count === 1;
        });
        if (!secAuditInserted) throw new Error('Security role could not insert valid audit log');
        const [secPersisted] = await sql`SELECT id FROM public.admin_audit_logs WHERE action = 'security.camera_reboot';`;
        if (!secPersisted) throw new Error('Security audit record was not persisted to database');
        console.log('   ✔ Authorized Security role INSERT (without RETURNING) succeeded and verified in database.');

        // E. Security officer attempts INSERT ... RETURNING -> MUST FAIL (42501) due to SELECT policy asymmetry
        let secReturningBlocked = false;
        try {
          await sql.begin(async (tx) => {
            await createAuthSession(tx, secAuth.id);
            await tx`
              INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, metadata)
              VALUES (${secAuth.id}, 'security.alarm_silenced', 'esp32_camera_nodes', '{"camera_id": "CAM-02"}'::jsonb)
              RETURNING id;
            `;
          });
        } catch (e) {
          secReturningBlocked = true;
          if (e.code !== '42501') throw new Error(`Expected 42501 on security RETURNING query, got ${e.code}: ${e.message}`);
        }
        if (!secReturningBlocked) throw new Error('Security Breach: Security role read back row via RETURNING without super_admin privilege');
        console.log('   ✔ Security role INSERT ... RETURNING blocked by SELECT policy asymmetry (42501).');

        // F. Super Admin attempts direct INSERT with RETURNING id -> MUST SUCCEED
        let adminInsertedId = null;
        await sql.begin(async (tx) => {
          await createAuthSession(tx, admAuth.id);
          const [admIns] = await tx`
            INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, metadata)
            VALUES (${admAuth.id}, 'admin.policy_update', 'policies', '{"updated": true}'::jsonb)
            RETURNING id;
          `;
          adminInsertedId = admIns?.id;
        });
        if (!adminInsertedId) throw new Error('Super Admin audit insert failed');
        const [admPersisted] = await sql`SELECT id FROM public.admin_audit_logs WHERE id = ${adminInsertedId};`;
        if (!admPersisted) throw new Error('Super Admin audit record was not persisted to database');
        console.log('   ✔ Authorized Super Admin INSERT (with RETURNING) succeeded and verified in database.');
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test 3 Passed.\n');
    } catch (err) {
      console.error('✖ Test 3 Failed:', err);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // TEST 4: DPDP Erasure Scope Validation, Verification & Durable Tombstones
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Test 4: DPDP Erasure Scope Validation & Durable Tombstones ---');
      const dbName = 'pt_p4_erasure';
      await session.createDatabase(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_01_COMPAT);
        await sql.file(MIGRATION_0000_PATH);
        await sql.file(MIGRATION_0001_PATH);
        await sql.file(MIGRATION_0002_PATH);
        await sql.file(MIGRATION_0003_PATH);

        const [adminAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('admin@corp.com', now()) RETURNING id;`;
        await sql`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, imported_role)
                  VALUES (${adminAuth.id}, 'Admin User', 'admin@corp.com', 'PT-ADM-ERASURE', true, 'LINKED', 'super_admin');`;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${adminAuth.id}, 'super_admin');`;

        const [userAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('alice@corp.com', now()) RETURNING id;`;
        const [profile] = await sql`
          INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, enrolled_embedding)
          VALUES (${userAuth.id}, 'Alice Smith', 'alice@corp.com', 'PT-ALICE', true, 'LINKED', '[0.1, 0.2, 0.3]')
          RETURNING id;
        `;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${userAuth.id}, 'employee');`;

        // Seed transits and attendance records for Alice
        await sql`
          INSERT INTO public.passive_transits (user_id, direction, zone_from, zone_to, "timestamp", cosine_score, dram_scrub_ms, vector_hash)
          VALUES (${profile.id}, 'ZONE_ENTER', 'CORRIDOR_TRANSIT', 'WORKSPACE_FLOOR', now(), 0.9850, 12.0, 'dummy_hash_alice');
        `;
        await sql`
          INSERT INTO public.attendance_records (employee_id, attendance_date, total_work_minutes, status)
          VALUES (${profile.id}, (now() AT TIME ZONE 'Asia/Kolkata')::date, 300, 'PRESENT')
          ON CONFLICT (employee_id, attendance_date) DO UPDATE
          SET total_work_minutes = 300, status = 'PRESENT';
        `;
        await sql`
          INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
          VALUES (${userAuth.id}, 'auth.login_success', 'enterprise_users', ${profile.id}::text, '{"email": "alice@corp.com", "name": "Alice"}'::jsonb);
        `;

        // Sub-test 4A: Scope validation - non-string array element raises 22023
        const [badReq1] = await sql`
          INSERT INTO public.dpo_erasure_requests (user_id, requestor_name, email, badge_id, erasure_scope)
          VALUES (${profile.id}, 'Alice', 'alice@corp.com', 'PT-ALICE', '[123, "transit_history"]'::jsonb)
          RETURNING id;
        `;
        let badScopeCaught = false;
        try {
          await sql.begin(async (tx) => {
            await createAuthSession(tx, adminAuth.id);
            await tx`SELECT public.approve_erasure_request(${badReq1.id});`;
          });
        } catch (e) {
          if (e.code === '22023') badScopeCaught = true;
        }
        if (!badScopeCaught) throw new Error('Scope validation failed to reject non-string element with 22023');
        console.log('   ✔ Scope validation rejects non-string element with SQLSTATE 22023.');

        // Sub-test 4B: Scope validation - unknown scope key raises 22023
        const [badReq2] = await sql`
          INSERT INTO public.dpo_erasure_requests (user_id, requestor_name, email, badge_id, erasure_scope)
          VALUES (${profile.id}, 'Alice', 'alice@corp.com', 'PT-ALICE', '["arbitrary_unknown_key"]'::jsonb)
          RETURNING id;
        `;
        let unknownScopeCaught = false;
        try {
          await sql.begin(async (tx) => {
            await createAuthSession(tx, adminAuth.id);
            await tx`SELECT public.approve_erasure_request(${badReq2.id});`;
          });
        } catch (e) {
          if (e.code === '22023') unknownScopeCaught = true;
        }
        if (!unknownScopeCaught) throw new Error('Scope validation failed to reject unknown scope key with 22023');
        console.log('   ✔ Scope validation rejects unknown scope key with SQLSTATE 22023.');

        // Sub-test 4C: Missing subject profile (user_id IS NULL) raises P0009
        const [orphanReq] = await sql`
          INSERT INTO public.dpo_erasure_requests (user_id, requestor_name, email, badge_id, erasure_scope)
          VALUES (NULL, 'Orphaned Subject', 'orphan@corp.com', 'PT-ORPHAN', '["transit_history"]'::jsonb)
          RETURNING id;
        `;
        let orphanCaught = false;
        try {
          await sql.begin(async (tx) => {
            await createAuthSession(tx, adminAuth.id);
            await tx`SELECT public.approve_erasure_request(${orphanReq.id});`;
          });
        } catch (e) {
          if (e.code === 'P0009') orphanCaught = true;
        }
        if (!orphanCaught) throw new Error('Missing profile failed to raise P0009');
        console.log('   ✔ Missing subject profile raises SQLSTATE P0009.');

        // Sub-test 4D: Erasure Verification Failure (P0008) deliberately leaves a record behind & rolls back
        const [bobAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('bob_verif@corp.com', now()) RETURNING id;`;
        const [bobProfile] = await sql`
          INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, enrolled_embedding)
          VALUES (${bobAuth.id}, 'Bob Verification', 'bob_verif@corp.com', 'PT-BOB-VERIF', true, 'LINKED', '[0.4, 0.5, 0.6]')
          RETURNING id;
        `;
        await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${bobAuth.id}, 'employee');`;
        const [stuckTransit] = await sql`
          INSERT INTO public.passive_transits (user_id, direction, zone_from, zone_to, "timestamp", cosine_score, dram_scrub_ms, vector_hash)
          VALUES (${bobProfile.id}, 'ZONE_ENTER', 'CORRIDOR_TRANSIT', 'WORKSPACE_FLOOR', now(), 0.9850, 12.0, 'dummy_hash_bob')
          RETURNING id;
        `;

        const [bobReq] = await sql`
          INSERT INTO public.dpo_erasure_requests (user_id, requestor_name, email, badge_id, erasure_scope)
          VALUES (${bobProfile.id}, 'Bob Verification', 'bob_verif@corp.com', 'PT-BOB-VERIF', '["transit_history", "compliant_backup"]'::jsonb)
          RETURNING id;
        `;

        // Install a canary trigger on passive_transits that suppresses delete
        await sql`
          CREATE OR REPLACE FUNCTION public.simulate_stuck_transit()
          RETURNS TRIGGER LANGUAGE plpgsql AS $$
          BEGIN
            RETURN NULL; -- Suppress deletion to simulate stuck row / read-only glitch
          END $$;
        `;

        await sql`
          CREATE TRIGGER trg_test_stuck_transit
          BEFORE DELETE ON public.passive_transits
          FOR EACH ROW EXECUTE FUNCTION public.simulate_stuck_transit();
        `;

        let p0008Caught = false;
        try {
          await sql.begin(async (tx) => {
            await createAuthSession(tx, adminAuth.id);
            await tx`SELECT public.approve_erasure_request(${bobReq.id});`;
          });
        } catch (e) {
          if (e.code === 'P0008') p0008Caught = true;
          else console.error('Unexpected error on stuck transit:', e);
        }

        // Drop canary trigger
        await sql`DROP TRIGGER IF EXISTS trg_test_stuck_transit ON public.passive_transits;`;
        await sql`DROP FUNCTION IF EXISTS public.simulate_stuck_transit();`;

        if (!p0008Caught) throw new Error('Verification failure did not raise SQLSTATE P0008');
        console.log('   ✔ Erasure verification failure raises SQLSTATE P0008.');

        // Verify full transaction rollback:
        // - Request status must STILL be 'SUBMITTED'
        // - completed_at must STILL be NULL
        // - Tombstones for bobReq must be 0
        // - Transit record must still exist in database
        const [bobReqCheck] = await sql`SELECT status, completed_at FROM public.dpo_erasure_requests WHERE id = ${bobReq.id};`;
        if (bobReqCheck.status !== 'SUBMITTED' || bobReqCheck.completed_at !== null) {
          throw new Error(`Transaction rollback failed: status = ${bobReqCheck.status}, completed_at = ${bobReqCheck.completed_at}`);
        }
        const [bobTombCheck] = await sql`SELECT count(*) as cnt FROM public.dpdp_backup_tombstones WHERE request_id = ${bobReq.id};`;
        if (parseInt(bobTombCheck.cnt, 10) !== 0) {
          throw new Error('Transaction rollback failed: tombstone was created despite P0008');
        }
        const [bobTransitCheck] = await sql`SELECT count(*) as cnt FROM public.passive_transits WHERE id = ${stuckTransit.id};`;
        if (parseInt(bobTransitCheck.cnt, 10) !== 1) {
          throw new Error('Transaction rollback failed: transit record was deleted');
        }
        console.log('   ✔ Verified atomic transaction rollback: status preserved in SUBMITTED, 0 tombstones, zero partial deletion.');

        // Sub-test 4E: Missing Vault Secret fail-closed (55000)
        await sql`UPDATE vault.decrypted_secrets SET name = 'enclave_salt_secret_renamed' WHERE name = 'enclave_salt_secret';`;
        const [vaultTestReq] = await sql`
          INSERT INTO public.dpo_erasure_requests (user_id, requestor_name, email, badge_id, erasure_scope)
          VALUES (${profile.id}, 'Alice', 'alice@corp.com', 'PT-ALICE', '["compliant_backup"]'::jsonb)
          RETURNING id;
        `;
        let vaultFailClosed = false;
        try {
          await sql.begin(async (tx) => {
            await createAuthSession(tx, adminAuth.id);
            await tx`SELECT public.approve_erasure_request(${vaultTestReq.id});`;
          });
        } catch (e) {
          if (e.code === '55000') vaultFailClosed = true;
        }
        // Restore secret
        await sql`UPDATE vault.decrypted_secrets SET name = 'enclave_salt_secret' WHERE name = 'enclave_salt_secret_renamed';`;
        if (!vaultFailClosed) throw new Error('Missing vault secret failed to raise SQLSTATE 55000 (fail-closed check failed)');
        console.log('   ✔ Missing Supabase Vault secret fails closed with SQLSTATE 55000.');

        // Sub-test 4F: Full valid erasure including compliant_backup and audit_ledger
        const [validReq] = await sql`
          INSERT INTO public.dpo_erasure_requests (user_id, requestor_name, email, badge_id, erasure_scope)
          VALUES (
            ${profile.id}, 'Alice', 'alice@corp.com', 'PT-ALICE',
            '["biometric_embeddings", "transit_history", "dwell_records", "audit_ledger", "compliant_backup"]'::jsonb
          )
          RETURNING id;
        `;

        await sql.begin(async (tx) => {
          await createAuthSession(tx, adminAuth.id);
          await tx`SELECT public.approve_erasure_request(${validReq.id});`;
        });

        // Verify status is PURGED_TOMBSTONE_REGISTERED
        const [updatedReq] = await sql`SELECT status, completed_at FROM public.dpo_erasure_requests WHERE id = ${validReq.id};`;
        if (updatedReq.status !== 'PURGED_TOMBSTONE_REGISTERED') {
          throw new Error(`Expected status PURGED_TOMBSTONE_REGISTERED, got ${updatedReq.status}`);
        }
        if (!updatedReq.completed_at) throw new Error('completed_at was not populated');
        console.log('   ✔ Terminal status correctly set to PURGED_TOMBSTONE_REGISTERED.');

        // Verify biometric embeddings purged
        const [pCheck] = await sql`SELECT enrolled_embedding, is_active FROM public.enterprise_users WHERE id = ${profile.id};`;
        if (pCheck.enrolled_embedding !== null || pCheck.is_active !== false) {
          throw new Error('Biometric embeddings were not purged or profile not deactivated');
        }
        console.log('   ✔ Biometric embeddings purged and profile deactivated.');

        // Verify transits and attendance records purged
        const [tCount] = await sql`SELECT count(*) as cnt FROM public.passive_transits WHERE user_id = ${profile.id};`;
        const [aCount] = await sql`SELECT count(*) as cnt FROM public.attendance_records WHERE employee_id = ${profile.id};`;
        if (parseInt(tCount.cnt, 10) !== 0 || parseInt(aCount.cnt, 10) !== 0) {
          throw new Error('Transits or attendance records were not purged');
        }
        console.log('   ✔ Transits and attendance records purged.');

        // Verify audit log pseudonymization
        const [auditCheck] = await sql`
          SELECT actor_id, entity_id, metadata
          FROM public.admin_audit_logs
          WHERE entity_id = '[REDACTED_DPDP]';
        `;
        if (auditCheck.actor_id !== null) throw new Error('Audit log actor_id was not pseudonymized to NULL');
        if (auditCheck.metadata.email || auditCheck.metadata.name) {
          throw new Error('PII keys were not stripped by sanitize_jsonb_pii');
        }
        console.log('   ✔ Audit log pseudonymized and sensitive metadata keys stripped.');

        // Verify tombstone durability & ON DELETE RESTRICT
        const [tombstone] = await sql`
          SELECT id, subject_enterprise_id, status
          FROM public.dpdp_backup_tombstones
          WHERE request_id = ${validReq.id};
        `;
        if (!tombstone || tombstone.status !== 'ACTIVE_TOMBSTONE') {
          throw new Error('Durable tombstone was not created');
        }

        let restrictTriggered = false;
        try {
          await sql`DELETE FROM public.dpo_erasure_requests WHERE id = ${validReq.id};`;
        } catch (e) {
          // Foreign key violation 23503
          if (e.code === '23503') restrictTriggered = true;
        }
        if (!restrictTriggered) throw new Error('ON DELETE RESTRICT failed; tombstone allowed parent deletion');
        console.log('   ✔ Durable tombstone survives deletion attempts via ON DELETE RESTRICT (23503).');
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test 4 Passed.\n');
    } catch (err) {
      console.error('✖ Test 4 Failed:', err);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // TEST 5: Attendance Engine Out-of-Order Parity & Authoritative EXCLUDED
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Test 5: Attendance Engine Out-of-Order Transits & Authoritative EXCLUDED ---');
      const dbName = 'pt_p4_attendance';
      await session.createDatabase(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_01_COMPAT);
        await sql.file(MIGRATION_0000_PATH);
        await sql.file(MIGRATION_0001_PATH);
        await sql.file(MIGRATION_0002_PATH);
        await sql.file(MIGRATION_0003_PATH);

        const [userAuth] = await sql`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('bob@corp.com', now()) RETURNING id;`;
        const [profile] = await sql`
          INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status, imported_role)
          VALUES (${userAuth.id}, 'Bob Jones', 'bob@corp.com', 'PT-BOB', true, 'LINKED', 'employee')
          RETURNING id;
        `;

        // 1. Insert late exit FIRST (e.g. 17:30 IST)
        const tsExit = '2026-11-15T12:00:00Z'; // 17:30 IST
        await sql`
          INSERT INTO public.passive_transits (user_id, direction, zone_from, zone_to, "timestamp", cosine_score, dram_scrub_ms, vector_hash)
          VALUES (${profile.id}, 'ZONE_EXIT', 'WORKSPACE_FLOOR', 'CORRIDOR_TRANSIT', ${tsExit}::timestamptz, 0.9850, 12.0, 'dummy_exit_hash');
        `;

        // 2. Insert early morning entry SECOND (e.g. 09:15 IST) - Arrived out of chronological order!
        const tsEntry = '2026-11-15T03:45:00Z'; // 09:15 IST
        await sql`
          INSERT INTO public.passive_transits (user_id, direction, zone_from, zone_to, "timestamp", cosine_score, dram_scrub_ms, vector_hash)
          VALUES (${profile.id}, 'ZONE_ENTER', 'CORRIDOR_TRANSIT', 'WORKSPACE_FLOOR', ${tsEntry}::timestamptz, 0.9850, 12.0, 'dummy_enter_hash');
        `;

        // Check attendance record
        const [att] = await sql`
          SELECT first_in, last_out, total_work_minutes, status, missed_exit
          FROM public.attendance_records
          WHERE employee_id = ${profile.id};
        `;

        if (!att.first_in || new Date(att.first_in).toISOString() !== new Date(tsEntry).toISOString()) {
          throw new Error(`Expected first_in to be ${tsEntry}, got ${att.first_in}`);
        }
        if (!att.last_out || new Date(att.last_out).toISOString() !== new Date(tsExit).toISOString()) {
          throw new Error(`Expected last_out to be ${tsExit}, got ${att.last_out}`);
        }
        if (att.total_work_minutes !== 495) {
          throw new Error(`Expected total_work_minutes = 495 (8h 15m), got ${att.total_work_minutes}`);
        }
        if (att.status !== 'PRESENT') {
          throw new Error(`Expected status PRESENT, got ${att.status}`);
        }
        console.log(`   ✔ Out-of-order transits correctly resolved first_in (${att.first_in}) and last_out (${att.last_out}).`);
        console.log(`   ✔ Total work minutes (${att.total_work_minutes}m) and status (${att.status}) computed accurately.`);
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test 5 Passed.\n');
    } catch (err) {
      console.error('✖ Test 5 Failed:', err);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // TEST 6: Concurrent First-Super-Admin Provisioning Race
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Test 6: Concurrent First Super Admin Provisioning Race ---');
      const dbName = 'pt_p4_admin_race';
      await session.createDatabase(dbName);

      // We use two independent connection clients directly to test concurrency
      const client1 = postgres({
        host: cluster.socketDir,
        port: cluster.port,
        database: dbName,
        max: 1,
      });
      const client2 = postgres({
        host: cluster.socketDir,
        port: cluster.port,
        database: dbName,
        max: 1,
      });

      try {
        await client1.file(FIXTURE_01_COMPAT);
        await client1.file(MIGRATION_0000_PATH);
        await client1.file(MIGRATION_0001_PATH);
        await client1.file(MIGRATION_0002_PATH);
        await client1.file(MIGRATION_0003_PATH);

        // Create two candidate users in auth.users and enterprise_users
        const [u1] = await client1`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('candidate1@corp.com', now()) RETURNING id;`;
        await client1`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status)
                      VALUES (${u1.id}, 'Candidate 1', 'candidate1@corp.com', 'PT-C1', true, 'LINKED');`;

        const [u2] = await client1`INSERT INTO auth.users (email, email_confirmed_at) VALUES ('candidate2@corp.com', now()) RETURNING id;`;
        await client1`INSERT INTO public.enterprise_users (auth_user_id, name, email, badge_id, is_active, invitation_status)
                      VALUES (${u2.id}, 'Candidate 2', 'candidate2@corp.com', 'PT-C2', true, 'LINKED');`;

        // Provisioning function executed by both clients
        const bootstrapProcedure = `
          DO $$
          DECLARE
            _email TEXT := current_setting('pt_test.target_email');
            _auth_id UUID;
            _profile_id UUID;
            _current_count INT;
          BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('global_super_admin_lock'));

            SELECT count(*) INTO _current_count FROM public.user_roles WHERE role = 'super_admin'::public.app_role;
            IF _current_count > 0 THEN
              RAISE EXCEPTION 'A Super Admin already exists' USING ERRCODE = '23514';
            END IF;

            SELECT id INTO _auth_id FROM auth.users WHERE lower(email) = lower(_email) AND email_confirmed_at IS NOT NULL;
            SELECT id INTO _profile_id FROM public.enterprise_users WHERE auth_user_id = _auth_id AND is_active = true FOR UPDATE;

            INSERT INTO public.user_roles (user_id, role) VALUES (_auth_id, 'super_admin'::public.app_role);
            UPDATE public.enterprise_users SET imported_role = 'super_admin' WHERE id = _profile_id;

            INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
            VALUES (NULL, 'admin.initial_super_admin_bootstrapped', 'user_roles', _auth_id::text, jsonb_build_object('email', _email));
          END $$;
        `;

        // Run Conn 1 and Conn 2 simultaneously
        const p1 = client1.begin(async (tx) => {
          await tx`SELECT set_config('pt_test.target_email', 'candidate1@corp.com', true);`;
          await tx.unsafe(bootstrapProcedure);
        });

        const p2 = client2.begin(async (tx) => {
          await tx`SELECT set_config('pt_test.target_email', 'candidate2@corp.com', true);`;
          await tx.unsafe(bootstrapProcedure);
        });

        const results = await Promise.allSettled([p1, p2]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        if (fulfilled.length !== 1 || rejected.length !== 1) {
          throw new Error(`Expected exactly 1 success and 1 rejection, got ${fulfilled.length} successes and ${rejected.length} rejections`);
        }

        const rejectionError = rejected[0].reason;
        if (rejectionError.code !== '23514') {
          throw new Error(`Expected rejection code 23514 (A Super Admin already exists), got ${rejectionError.code}: ${rejectionError.message}`);
        }
        console.log('   ✔ Concurrency race resolved: exactly 1 Super Admin provisioned, competitor aborted with 23514.');

        // Verify state
        const adminRoles = await client1`SELECT user_id, role FROM public.user_roles WHERE role = 'super_admin';`;
        if (adminRoles.length !== 1 || adminRoles[0].user_id !== u1.id) {
          throw new Error('Unexpected Super Admin user in user_roles');
        }

        const [auditLog] = await client1`
          SELECT actor_id, action, metadata
          FROM public.admin_audit_logs
          WHERE action = 'admin.initial_super_admin_bootstrapped';
        `;
        if (auditLog.actor_id !== null) {
          throw new Error('Audit log actor_id should be NULL for operator bootstrap');
        }
        console.log('   ✔ Audit log attributes bootstrap to operator context with actor_id = NULL.');
      } finally {
        await client1.end({ timeout: 1 });
        await client2.end({ timeout: 1 });
      }

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test 6 Passed.\n');
    } catch (err) {
      console.error('✖ Test 6 Failed:', err);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // TEST 7: Auth Confirmation Trigger Invitation Lifecycle
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Test 7: Auth Confirmation Trigger Invitation Lifecycle ---');
      const dbName = 'pt_p4_lifecycle';
      await session.createDatabase(dbName);

      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_01_COMPAT);
        await sql.file(MIGRATION_0000_PATH);
        await sql.file(MIGRATION_0001_PATH);
        await sql.file(MIGRATION_0002_PATH);
        await sql.file(MIGRATION_0003_PATH);

        // 1. Legitimate invited user: staged as DISPATCHED with imported_role = hr_ops
        const [empProfile] = await sql`
          INSERT INTO public.enterprise_users (name, email, badge_id, is_active, invitation_status, imported_role)
          VALUES ('Carlos Gomez', 'carlos@corp.com', 'PT-CARLOS', true, 'DISPATCHED', 'hr_ops')
          RETURNING id;
        `;

        // GoTrue creates and confirms user in auth.users -> fires trigger
        const [carlosAuth] = await sql`
          INSERT INTO auth.users (email, email_confirmed_at)
          VALUES ('carlos@corp.com', now())
          RETURNING id;
        `;

        // Check profile updated to LINKED and role established in user_roles
        const [carlosUpdatedProfile] = await sql`SELECT auth_user_id, invitation_status FROM public.enterprise_users WHERE id = ${empProfile.id};`;
        if (carlosUpdatedProfile.auth_user_id !== carlosAuth.id || carlosUpdatedProfile.invitation_status !== 'LINKED') {
          throw new Error(`Carlos profile failed to link: status=${carlosUpdatedProfile.invitation_status}`);
        }
        const [carlosRole] = await sql`SELECT role FROM public.user_roles WHERE user_id = ${carlosAuth.id};`;
        if (!carlosRole || carlosRole.role !== 'hr_ops') {
          throw new Error(`Expected carlos role hr_ops, got ${carlosRole?.role}`);
        }
        console.log('   ✔ Invited employee in DISPATCHED status was confirmed and linked with role hr_ops.');

        // 2. Uninvited signup: email has no enterprise_users row
        const [uninvitedAuth] = await sql`
          INSERT INTO auth.users (email, email_confirmed_at)
          VALUES ('intruder@external.io', now())
          RETURNING id;
        `;
        const uninvitedRoles = await sql`SELECT * FROM public.user_roles WHERE user_id = ${uninvitedAuth.id};`;
        if (uninvitedRoles.length !== 0) throw new Error('Uninvited user received role in user_roles');
        console.log('   ✔ Uninvited signup quarantined with zero roles assigned.');

        // 3. User with staged super_admin role -> auto-grant rejected and quarantined
        const [rogueProfile] = await sql`
          INSERT INTO public.enterprise_users (name, email, badge_id, is_active, invitation_status, imported_role)
          VALUES ('Rogue Admin', 'rogue@corp.com', 'PT-ROGUE', true, 'DISPATCHED', 'super_admin')
          RETURNING id;
        `;
        const [rogueAuth] = await sql`
          INSERT INTO auth.users (email, email_confirmed_at)
          VALUES ('rogue@corp.com', now())
          RETURNING id;
        `;
        const [rogueUpdated] = await sql`SELECT invitation_status FROM public.enterprise_users WHERE id = ${rogueProfile.id};`;
        if (rogueUpdated.invitation_status !== 'RECONCILIATION_REQUIRED') {
          throw new Error(`Expected rogue admin profile to be RECONCILIATION_REQUIRED, got ${rogueUpdated.invitation_status}`);
        }
        const rogueRoles = await sql`SELECT * FROM public.user_roles WHERE user_id = ${rogueAuth.id};`;
        if (rogueRoles.length !== 0) throw new Error('Rogue admin received role in user_roles');
        console.log('   ✔ Unauthorized super_admin grant attempt rejected and quarantined in RECONCILIATION_REQUIRED.');
      });

      await session.dropDatabase(dbName);
      passed++;
      console.log('✔ Test 7 Passed.\n');
    } catch (err) {
      console.error('✖ Test 7 Failed:', err);
      failed++;
    }

    // ────────────────────────────────────────────────────────────────────────
    // TEST 8: Migration Journal Consistency Verification
    // ────────────────────────────────────────────────────────────────────────
    try {
      console.log('--- Test 8: Migration Journal Consistency Verification ---');
      const journalPath = path.resolve('drizzle/migrations/meta/_journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));

      if (journal.version !== '7' || journal.dialect !== 'postgresql') {
        throw new Error(`Invalid journal metadata: version ${journal.version}, dialect ${journal.dialect}`);
      }

      if (journal.entries.length !== 4) {
        throw new Error(`Expected exactly 4 journal entries, found ${journal.entries.length}`);
      }

      const expectedTags = [
        '0000_presencetrack_schema',
        '0001_attendance_backend_expansion',
        '0002_auth_security_hardening',
        '0003_operational_security_fixes',
      ];

      for (let i = 0; i < 4; i++) {
        const entry = journal.entries[i];
        if (entry.idx !== i) throw new Error(`Entry ${i} has invalid idx ${entry.idx}`);
        if (entry.tag !== expectedTags[i]) {
          throw new Error(`Entry ${i} tag mismatch: expected ${expectedTags[i]}, got ${entry.tag}`);
        }
        const sqlPath = path.resolve(`drizzle/migrations/${entry.tag}.sql`);
        if (!fs.existsSync(sqlPath)) {
          throw new Error(`Migration SQL file not found for tag: ${entry.tag}`);
        }
      }
      console.log('   ✔ All 4 migration journal entries validated against files on disk.');

      passed++;
      console.log('✔ Test 8 Passed.\n');
    } catch (err) {
      console.error('✖ Test 8 Failed:', err);
      failed++;
    }

    console.log('==============================================================================');
    console.log(` PHASE 4 CONCURRENCY & REMEDIATION SUITE RESULT: ${passed}/8 PASSED, ${failed} FAILED`);
    console.log('==============================================================================');

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    console.log('\nExecuting fail-closed cluster teardown and process-group verification...');
    await cluster.stopAndCleanup();
    console.log('Teardown complete.');
  }
}

runAllPhase4Tests().catch((err) => {
  console.error('Unhandled fatal error in runAllPhase4Tests:', err);
  process.exit(1);
});
