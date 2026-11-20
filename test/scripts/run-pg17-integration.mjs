#!/usr/bin/env node
// ==============================================================================
// PresenceTrack AI — PostgreSQL 17 Ephemeral Integration Test Runner
// Path: test/scripts/run-pg17-integration.mjs
//
// Description:
//   Orchestrates isolated integration testing of migration 0002 against an
//   ephemeral, dedicated PostgreSQL 17 cluster.
//
// Safety Guarantees:
//   - Disposability: Initializes a temporary cluster in /tmp bound strictly
//     to 127.0.0.1 loopback and private Unix domain sockets.
//   - Zero Remote Impact: Never touches Supabase, live environments, or host clusters.
//   - Multi-Layered Identity: Enforces 6 identity checks (version 17, port, DB,
//     canonical data_directory, system_identifier, cryptographic marker) before
//     every administrative or test operation.
//   - Safe Identifier Handling: Database identifiers validated via strict regex.
//   - Process-Group Safety: Spawns PostgreSQL in a dedicated process group
//     (detached: true) and independently verifies termination via kernel probe
//     and /bin/ps inspection before directory deletion.
//   - Fail-Closed: Preserves cluster directory untouched if process termination
//     cannot be positively established.
// ==============================================================================

import fs from 'fs';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import child_process from 'child_process';
import postgres from 'postgres';

// --- Controlled Custom Error Types ---
class ControlledRollbackTestError extends Error {
  constructor() {
    super('CONTROLLED_TEST_ROLLBACK_EXCEPTION');
    this.name = 'ControlledRollbackTestError';
  }
}

class SecurityIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecurityIdentityError';
  }
}

// --- Configuration Constants ---
const PG_INITDB_BIN = '/opt/homebrew/opt/postgresql@17/bin/initdb';
const PG_POSTGRES_BIN = '/opt/homebrew/opt/postgresql@17/bin/postgres';

const MIGRATION_0000_PATH = path.resolve('drizzle/migrations/0000_presencetrack_schema.sql');
const MIGRATION_0001_PATH = path.resolve('drizzle/migrations/0001_attendance_backend_expansion.sql');
const MIGRATION_0002_PATH = path.resolve('drizzle/migrations/0002_auth_security_hardening.sql');

const FIXTURE_00_BOOTSTRAP = path.resolve('test/fixtures/00_cluster_bootstrap.sql');
const FIXTURE_01_COMPAT = path.resolve('test/fixtures/01_supabase_compat.sql');
const FIXTURE_02_PREREQ_BASE = path.resolve('test/fixtures/02_prereq_minimal_base.sql');

// ==============================================================================
// 1. Ephemeral Cluster Process & Lifecycle Manager
// ==============================================================================
export class EphemeralClusterManager {
  #clusterDir = '';
  #dataDir = '';
  #socketDir = '';
  #logFile = '';
  #logFd = null;
  #markerToken = '';
  #bootstrapSystemId = '';
  #allocatedPort = 0;
  #pgProcess = null;
  #pgid = null;
  #processLifecycle = 'NOT_SPAWNED'; // NOT_SPAWNED | RUNNING | EXITED
  #pgExited = false;
  #pgExitCode = null;
  #cleanupState = 'IDLE'; // IDLE | CLEANING | CLEANED | PRESERVED_ACTIVE

  get port() { return this.#allocatedPort; }
  get socketDir() { return this.#socketDir; }
  get dataDir() { return this.#dataDir; }
  get clusterDir() { return this.#clusterDir; }
  get markerToken() { return this.#markerToken; }
  get bootstrapSystemIdentifier() { return this.#bootstrapSystemId; }
  get cleanupState() { return this.#cleanupState; }
  get processLifecycle() { return this.#processLifecycle; }
  get pgid() { return this.#pgid; }
  get pgExited() { return this.#pgExited; }

  // Allocates an ephemeral loopback candidate port with bounded retry
  async #allocateCandidatePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          srv.close(() => reject(new Error('Failed to resolve ephemeral candidate port')));
          return;
        }
        const port = addr.port;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  // Prepares file system roots and initializes PostgreSQL 17 cluster
  async start() {
    if (!fs.existsSync(PG_INITDB_BIN) || !fs.existsSync(PG_POSTGRES_BIN)) {
      throw new Error(`PostgreSQL 17 binaries not found. Ensure package is installed: ${PG_INITDB_BIN}`);
    }

    const uniqueId = `${process.pid}_${crypto.randomBytes(8).toString('hex')}`;
    this.#clusterDir = path.resolve(`/tmp/pt_ephemeral_pg17_${uniqueId}`);
    this.#dataDir = path.join(this.#clusterDir, 'data');
    this.#socketDir = path.join(this.#clusterDir, 'socket');
    this.#logFile = path.join(this.#clusterDir, 'server.log');
    this.#markerToken = crypto.randomBytes(32).toString('hex'); // 256-bit cryptographic marker

    fs.mkdirSync(this.#clusterDir, { mode: 0o700, recursive: true });
    fs.mkdirSync(this.#socketDir, { mode: 0o700, recursive: true });
    this.#logFd = fs.openSync(this.#logFile, 'w');

    // Execute initdb synchronously
    child_process.execFileSync(PG_INITDB_BIN, [
      '--no-locale',
      '--encoding=UTF8',
      '-D', this.#dataDir
    ], { stdio: 'ignore' });

    // Bounded startup retry loop (max 5 attempts for port allocation race mitigation)
    const MAX_RETRIES = 5;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      this.#allocatedPort = await this.#allocateCandidatePort();

      // Configure postgresql.conf for isolated loopback and socket operations
      const confLines = [
        `listen_addresses = '127.0.0.1'`,
        `port = ${this.#allocatedPort}`,
        `unix_socket_directories = '${this.#socketDir}'`,
        `pt_test.cluster_marker = '${this.#markerToken}'`,
        `max_connections = 20`,
        `shared_buffers = 32MB`,
        `fsync = on`,
        `synchronous_commit = on`
      ];
      fs.writeFileSync(path.join(this.#dataDir, 'postgresql.conf'), confLines.join('\n') + '\n');

      // Spawn postmaster in a dedicated process group (detached: true calls setsid() on macOS)
      this.#processLifecycle = 'RUNNING';
      this.#pgExited = false;
      this.#pgExitCode = null;
      this.#pgProcess = child_process.spawn(PG_POSTGRES_BIN, [
        '-D', this.#dataDir
      ], {
        detached: true,
        stdio: ['ignore', this.#logFd, this.#logFd]
      });
      this.#pgid = this.#pgProcess.pid;

      this.#pgProcess.on('exit', (code) => {
        this.#processLifecycle = 'EXITED';
        this.#pgExited = true;
        this.#pgExitCode = code;
      });

      this.#pgProcess.on('error', (err) => {
        console.error('PostgreSQL spawn error:', err);
      });

      // Poll connection readiness
      const ready = await this.#pollConnectionReady(5000);
      if (ready) {
        // Capture bootstrap cluster system identifier using administrative superuser connection
        await this.#captureBootstrapSystemIdentifier();
        return;
      }

      // If startup failed or port occupied, stop attempted child and retry with new port
      await this.#stopChildProcess(true);
      if (attempt === MAX_RETRIES) {
        throw new Error(`Failed to bind and initialize ephemeral cluster after ${MAX_RETRIES} attempts.`);
      }
    }
  }

  // Polls PostgreSQL readiness over Unix domain socket
  async #pollConnectionReady(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.#pgExited) return false;
      try {
        const testClient = postgres({
          host: this.#socketDir,
          port: this.#allocatedPort,
          database: 'postgres',
          max: 1,
          connect_timeout: 1,
          idle_timeout: 1
        });
        const [{ ok }] = await testClient`SELECT 1 AS ok;`;
        await testClient.end({ timeout: 1 });
        if (ok === 1) return true;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return false;
  }

  // Obtains system_identifier from pg_control_system() during bootstrap
  async #captureBootstrapSystemIdentifier() {
    const admin = postgres({
      host: this.#socketDir,
      port: this.#allocatedPort,
      database: 'postgres',
      max: 1
    });
    try {
      const rows = await admin`
        SELECT
          (current_setting('server_version_num')::int / 10000) AS major_ver,
          current_setting('port')::int AS active_port,
          current_setting('data_directory') AS active_dir,
          system_identifier::text AS sys_id,
          current_setting('pt_test.cluster_marker', true) AS marker
        FROM pg_control_system();
      `;
      const r = rows[0];
      if (r.major_ver !== 17) {
        throw new SecurityIdentityError(`Expected PostgreSQL 17, found version ${r.major_ver}`);
      }
      if (r.active_port !== this.#allocatedPort) {
        throw new SecurityIdentityError(`Port mismatch: ${r.active_port} vs ${this.#allocatedPort}`);
      }
      const canonicalActual = fs.realpathSync(r.active_dir);
      const canonicalExpected = fs.realpathSync(this.#dataDir);
      if (canonicalActual !== canonicalExpected) {
        throw new SecurityIdentityError(`Directory mismatch: ${canonicalActual} vs ${canonicalExpected}`);
      }
      this.#bootstrapSystemId = r.sys_id;
    } finally {
      await admin.end({ timeout: 1 });
    }
  }

  // Stops postmaster child process gracefully
  async #stopChildProcess(isRetry = false, { sigintTimeoutMs = 5000, sigquitTimeoutMs = 3000 } = {}) {
    if (this.#processLifecycle === 'NOT_SPAWNED') return;
    if (!this.#pgProcess || this.#pgExited) return;

    // Fast Shutdown: SIGINT causes postmaster to signal backends with SIGTERM and wait for exit
    try {
      this.#pgProcess.kill('SIGINT');
    } catch (_) {}

    // Wait for postmaster exit event
    const start = Date.now();
    while (Date.now() - start < sigintTimeoutMs) {
      if (this.#pgExited) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!this.#pgExited) {
      if (Number.isInteger(this.#pgid) && this.#pgid > 0) {
        try {
          // Escalate to process group SIGQUIT if postmaster hangs
          process.kill(-this.#pgid, 'SIGQUIT');
        } catch (_) {}
      }
      const escStart = Date.now();
      while (Date.now() - escStart < sigquitTimeoutMs) {
        if (this.#pgExited) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  // Parses /bin/ps -A -o pid=,pgid=,command= line-by-line preserving full command arguments
  #parsePsOutput(rawStdout) {
    const lines = rawStdout.split('\n');
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) {
        throw new Error(`CRITICAL: Malformed /bin/ps output row encountered: "${trimmed}"`);
      }
      rows.push({
        pid: parseInt(match[1], 10),
        pgid: parseInt(match[2], 10),
        command: match[3]
      });
    }
    return rows;
  }

  // Independently verifies that all processes in PGID and cluster path are terminated on macOS
  async #verifyProcessGroupTerminated() {
    if (this.#processLifecycle === 'NOT_SPAWNED') {
      // 1. Verify #pgProcess === null && #pgid === null
      if (this.#pgProcess !== null || this.#pgid !== null) {
        return false;
      }

      // 2. Verify data/ was never created
      if (this.#dataDir && fs.existsSync(this.#dataDir)) {
        return false;
      }

      // 3. Verify no process in /bin/ps references the temporary cluster directory
      try {
        const psStdout = child_process.execFileSync('/bin/ps', [
          '-A', '-o', 'pid=,pgid=,command='
        ], { encoding: 'utf8', timeout: 5000 });

        const rows = this.#parsePsOutput(psStdout);
        if (this.#clusterDir) {
          const canonicalCluster = fs.existsSync(this.#clusterDir)
            ? fs.realpathSync(this.#clusterDir)
            : this.#clusterDir;
          const matchingDir = rows.filter((r) =>
            r.command.includes(this.#clusterDir) || r.command.includes(canonicalCluster)
          );
          if (matchingDir.length > 0) return false;
        }

        return true;
      } catch (_) {
        return false; // Malformed output, command failure, or timeout fails closed
      }
    }

    // Lifecycle is RUNNING or EXITED
    // Enforce Number.isInteger(this.#pgid) && this.#pgid > 0 before calling process.kill(-this.#pgid, 0)
    if (!Number.isInteger(this.#pgid) || this.#pgid <= 0) {
      return false;
    }

    // Check 1: Negative-PGID signal-0 probe
    try {
      process.kill(-this.#pgid, 0);
      // If no error thrown, processes still exist in group
      return false;
    } catch (err) {
      if (err.code !== 'ESRCH') {
        // EPERM or other error indicates processes exist but cannot be signaled
        return false;
      }
    }

    // Check 2: Process table inspection via /bin/ps
    try {
      const psStdout = child_process.execFileSync('/bin/ps', [
        '-A', '-o', 'pid=,pgid=,command='
      ], { encoding: 'utf8', timeout: 5000 });

      const rows = this.#parsePsOutput(psStdout);
      const matchingPgid = rows.filter((r) => r.pgid === this.#pgid);
      if (matchingPgid.length > 0) return false;

      // Safely resolve the data directory
      const dataDir = fs.existsSync(this.#dataDir) ? fs.realpathSync(this.#dataDir) : this.#dataDir;
      if (dataDir) {
        const matchingDir = rows.filter((r) => r.command.includes(dataDir));
        if (matchingDir.length > 0) return false;
      }

      if (this.#clusterDir) {
        const canonicalCluster = fs.existsSync(this.#clusterDir)
          ? fs.realpathSync(this.#clusterDir)
          : this.#clusterDir;
        const matchingCluster = rows.filter((r) =>
          r.command.includes(this.#clusterDir) || r.command.includes(canonicalCluster)
        );
        if (matchingCluster.length > 0) return false;
      }

      return true;
    } catch (_) {
      return false; // Malformed output, command failure, or timeout fails closed
    }
  }

  // Fail-closed cluster teardown and directory cleanup
  async stopAndCleanup() {
    if (this.#cleanupState !== 'IDLE') return;
    this.#cleanupState = 'CLEANING';

    try {
      if (!this.#clusterDir) {
        this.#cleanupState = 'CLEANED';
        return;
      }

      await this.#stopChildProcess();

      // Independent Process-Group Verification
      const isDead = await this.#verifyProcessGroupTerminated();
      const canClean = (this.#processLifecycle === 'NOT_SPAWNED' && isDead) ||
                       (this.#processLifecycle === 'EXITED' && this.#pgExited && isDead);

      if (!canClean) {
        this.#cleanupState = 'PRESERVED_ACTIVE';
        console.error('\n[CRITICAL SAFETY HALT] Ephemeral PostgreSQL cluster process group could not be verified stopped.');
        console.error(`Cluster directory preserved untouched at: ${this.#clusterDir}`);
        console.error('Safe Manual Inspection Procedure for Operator:');
        console.error(`1. Check running processes: /bin/ps -A -o pid=,pgid=,command= | grep "${this.#clusterDir}"`);
        console.error(`2. Inspect startup/shutdown server logs: cat "${this.#logFile}"`);
        console.error(`3. Once all processes are confirmed stopped by the operator: rm -rf "${this.#clusterDir}"\n`);
        return;
      }

      // Close log descriptor prior to directory removal
      if (this.#logFd !== null) {
        try { fs.closeSync(this.#logFd); } catch (_) {}
        this.#logFd = null;
      }

      // Re-validate directory path, ownership, and non-symlink status
      if (!/^\/tmp\/pt_ephemeral_pg17_\d+_[a-f0-9]{16}$/.test(this.#clusterDir)) return;
      const stat = fs.lstatSync(this.#clusterDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) return;

      fs.rmSync(this.#clusterDir, { recursive: true, force: true });
      this.#cleanupState = 'CLEANED';
    } catch (e) {
      this.#cleanupState = 'PRESERVED_ACTIVE';
      console.error('[CLEANUP FAILURE] Exception during cleanup. Directory preserved at:', this.#clusterDir, e);
    }
  }

  // Test construction helper for focused unit testing of cleanup states
  static _createForTesting(config = {}) {
    const instance = new EphemeralClusterManager();
    if (config.clusterDir !== undefined) instance.#clusterDir = config.clusterDir;
    if (config.dataDir !== undefined) instance.#dataDir = config.dataDir;
    if (config.socketDir !== undefined) instance.#socketDir = config.socketDir;
    if (config.logFile !== undefined) instance.#logFile = config.logFile;
    if (config.logFd !== undefined) instance.#logFd = config.logFd;
    if (config.markerToken !== undefined) instance.#markerToken = config.markerToken;
    if (config.bootstrapSystemId !== undefined) instance.#bootstrapSystemId = config.bootstrapSystemId;
    if (config.allocatedPort !== undefined) instance.#allocatedPort = config.allocatedPort;
    if (config.pgProcess !== undefined) instance.#pgProcess = config.pgProcess;
    if (config.pgid !== undefined) instance.#pgid = config.pgid;
    if (config.processLifecycle !== undefined) instance.#processLifecycle = config.processLifecycle;
    if (config.pgExited !== undefined) instance.#pgExited = config.pgExited;
    if (config.pgExitCode !== undefined) instance.#pgExitCode = config.pgExitCode;
    return instance;
  }
}

// ==============================================================================
// 2. Guarded Cluster Session Abstraction
// ==============================================================================
export class GuardedClusterSession {
  #cluster = null;

  constructor(clusterManager) {
    this.#cluster = clusterManager;
  }

  // Validates database identifiers via strict whitelist regex
  #assertValidIdentifier(name) {
    if (!/^[a-z][a-z0-9_]{2,62}$/.test(name)) {
      throw new SecurityIdentityError(`Security Halt: Invalid database identifier "${name}"`);
    }
    return name;
  }

  // Private factory creating connections strictly to ephemeral socket & port
  #createClient(database) {
    return postgres({
      host: this.#cluster.socketDir,
      port: this.#cluster.port,
      database,
      max: 1,
      connect_timeout: 5,
      idle_timeout: 5
    });
  }

  // Mandatory 6-layer identity verification executed on checkout
  async #assertClusterIdentity(sql, expectedDatabase) {
    const rows = await sql`
      SELECT
        (current_setting('server_version_num')::int / 10000) AS major_ver,
        current_setting('port')::int AS active_port,
        current_database() AS active_db,
        current_setting('data_directory') AS active_dir,
        system_identifier::text AS sys_id,
        current_setting('pt_test.cluster_marker', true) AS marker
      FROM pg_control_system();
    `;
    const r = rows[0];
    if (r.major_ver !== 17) {
      throw new SecurityIdentityError(`Identity Failure: Connected to PostgreSQL ${r.major_ver}, expected 17`);
    }
    if (r.active_port !== this.#cluster.port) {
      throw new SecurityIdentityError(`Identity Failure: Connected to port ${r.active_port}, expected ${this.#cluster.port}`);
    }
    if (r.active_db !== expectedDatabase) {
      throw new SecurityIdentityError(`Identity Failure: Connected to database ${r.active_db}, expected ${expectedDatabase}`);
    }
    const canonicalActual = fs.realpathSync(r.active_dir);
    const canonicalExpected = fs.realpathSync(this.#cluster.dataDir);
    if (canonicalActual !== canonicalExpected) {
      throw new SecurityIdentityError(`Identity Failure: Data directory mismatch`);
    }
    if (r.sys_id !== this.#cluster.bootstrapSystemIdentifier) {
      throw new SecurityIdentityError(`Identity Failure: Cluster system identifier mismatch`);
    }
    const expectedBuf = Buffer.from(this.#cluster.markerToken, 'utf8');
    const actualBuf = Buffer.from(r.marker || '', 'utf8');
    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      throw new SecurityIdentityError(`Identity Failure: Cryptographic cluster marker verification failed`);
    }
  }

  // The sole entry point for database operations: enforces identity check before callback
  async withClient(database, callback) {
    const validDb = this.#assertValidIdentifier(database);
    const sql = this.#createClient(validDb);
    try {
      await this.#assertClusterIdentity(sql, validDb);
      return await callback(sql);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  // Creates a fresh scenario database with safe quoting
  async createDatabase(dbName) {
    const validDb = this.#assertValidIdentifier(dbName);
    await this.withClient('postgres', async (adminSql) => {
      await adminSql.unsafe(`CREATE DATABASE "${validDb}";`);
    });
  }

  // Drops a scenario database with force
  async dropDatabase(dbName) {
    const validDb = this.#assertValidIdentifier(dbName);
    await this.withClient('postgres', async (adminSql) => {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS "${validDb}" WITH (FORCE);`);
    });
  }
}

// ==============================================================================
// 3. Complete Catalog & Data Capture Helpers
// ==============================================================================

// Captures full 24-attribute catalog snapshot for the 4 replaced functions
async function captureFunctionsSnapshot(sql) {
  const rows = await sql`
    SELECT
      n.nspname AS schema_name,
      p.proname AS function_name,
      p.pronargs AS argument_count,
      p.proargtypes::oid[]::text AS argument_type_oids,
      p.prorettype::oid AS return_type_oid,
      p.prorettype::regtype::text AS return_type_name,
      coalesce(p.proargnames::text, 'NONE') AS argument_names,
      coalesce(p.proargmodes::text, 'NONE') AS argument_modes,
      p.provariadic::oid AS variadic_type_oid,
      p.prokind::text AS function_kind,
      p.proretset AS returns_set,
      p.procost AS execution_cost,
      p.prorows AS result_rows,
      p.prosupport::oid AS support_function_oid,
      l.lanname AS language_name,
      pg_get_userbyid(p.proowner) AS owner_name,
      coalesce(p.proacl::text, 'DEFAULT') AS acl_entries,
      p.prosecdef AS is_security_definer,
      p.provolatile::text AS volatility_mode,
      p.proisstrict AS is_strict,
      p.proleakproof AS is_leakproof,
      p.proparallel::text AS parallel_mode,
      coalesce(array_to_string(p.proconfig, ';'), 'NONE') AS configuration_settings,
      pg_get_functiondef(p.oid) AS decompiled_definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public'
      AND (
        (p.proname = 'has_role' AND p.pronargs = 2 AND p.proargtypes[0] = 'uuid'::regtype AND p.proargtypes[1] = 'public.app_role'::regtype) OR
        (p.proname = 'has_any_role' AND p.pronargs = 2 AND p.proargtypes[0] = 'uuid'::regtype AND p.proargtypes[1] = 'public.app_role[]'::regtype) OR
        (p.proname = 'protect_last_super_admin' AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype) OR
        (p.proname = 'handle_verified_auth_user' AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype)
      )
    ORDER BY p.proname ASC;
  `;
  return rows;
}

// Captures full 24-attribute catalog snapshot for the 2 affected baseline triggers
async function captureTriggersSnapshot(sql) {
  const rows = await sql`
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      t.tgname AS trigger_name,
      t.oid AS trigger_oid,
      pn.nspname AS function_schema,
      p.proname AS function_name,
      t.tgfoid AS function_oid,
      t.tgtype AS event_type_bitmask,
      (t.tgtype & 1)::boolean AS is_row_level,
      (t.tgtype & 2)::boolean AS is_before,
      (t.tgtype & 4)::boolean AS is_insert,
      (t.tgtype & 8)::boolean AS is_delete,
      (t.tgtype & 16)::boolean AS is_update,
      (t.tgtype & 32)::boolean AS is_truncate,
      t.tgconstraint <> 0 AS is_constraint_trigger,
      t.tgconstraint AS constraint_oid,
      t.tgdeferrable AS is_deferrable,
      t.tginitdeferred AS is_initially_deferred,
      t.tgisinternal AS is_internal,
      t.tgnargs AS argument_count,
      encode(t.tgargs, 'hex') AS raw_arguments_hex,
      t.tgenabled::text AS enabled_state,
      coalesce(pg_get_expr(t.tgqual, t.tgrelid), 'NONE') AS when_clause,
      pg_get_triggerdef(t.oid, true) AS decompiled_definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE (n.nspname = 'auth' AND c.relname = 'users' AND t.tgname = 'on_auth_user_verified')
       OR (n.nspname = 'public' AND c.relname = 'user_roles' AND t.tgname = 'user_roles_protect_last_admin')
    ORDER BY n.nspname, c.relname, t.tgname;
  `;
  return rows;
}

// Captures relation ACL and owner for public.user_roles
async function captureUserRolesAcl(sql) {
  const [row] = await sql`
    SELECT
      pg_get_userbyid(c.relowner) AS relation_owner,
      c.relrowsecurity AS is_rls_enabled,
      c.relforcerowsecurity AS is_force_rls_enabled,
      coalesce(c.relacl::text, 'DEFAULT_OWNER_ONLY') AS relation_acl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'user_roles';
  `;
  return row;
}

// Captures column nullability for public.admin_audit_logs.actor_id
async function captureAuditActorIdNullability(sql) {
  const [row] = await sql`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_audit_logs' AND column_name = 'actor_id';
  `;
  return row?.is_nullable;
}

// Captures deterministic row-set snapshot and JSON hash for public.enterprise_users
async function captureEnterpriseUsersData(sql) {
  const [row] = await sql`
    SELECT
      count(*) AS total_row_count,
      coalesce(
        encode(
          sha256(
            convert_to(
              string_agg(
                to_jsonb(t.*)::text,
                E'\n'
                ORDER BY t.id::text COLLATE "C"
              ),
              'UTF8'
            )
          ),
          'hex'
        ),
        'EMPTY_TABLE'
      ) AS row_set_hash,
      coalesce(
        jsonb_agg(to_jsonb(t.*) ORDER BY t.id::text COLLATE "C"),
        '[]'::jsonb
      ) AS canonical_rows_snapshot
    FROM public.enterprise_users t;
  `;
  return row;
}

// ==============================================================================
// 4. Test Scenarios Execution Engine
// ==============================================================================

// Scenario 1: Atomic Rollback and Baseline Catalog/Data Preservation
async function runScenario1Rollback(session) {
  console.log('\n--- Scenario 1: Atomic Rollback & Baseline Restoration ---');
  const dbName = 'pt_scenario_rollback';
  await session.createDatabase(dbName);

  try {
    await session.withClient(dbName, async (sql) => {
      // 1. Apply baseline fixtures
      await sql.file(FIXTURE_01_COMPAT);
      await sql.file(MIGRATION_0000_PATH);
      await sql.file(MIGRATION_0001_PATH);

      // 2. Capture baseline snapshots with cardinality assertions
      const baselineFunctions = await captureFunctionsSnapshot(sql);
      if (baselineFunctions.length !== 4) {
        throw new Error(`Cardinality Error: Expected 4 baseline functions, found ${baselineFunctions.length}`);
      }

      const baselineTriggers = await captureTriggersSnapshot(sql);
      if (baselineTriggers.length !== 2) {
        throw new Error(`Cardinality Error: Expected 2 baseline triggers, found ${baselineTriggers.length}`);
      }

      const baselineUserRolesAcl = await captureUserRolesAcl(sql);
      const baselineAuditActorIdNullable = await captureAuditActorIdNullability(sql);
      if (baselineAuditActorIdNullable !== 'NO') {
        throw new Error(`Baseline Error: admin_audit_logs.actor_id must be NOT NULL prior to migration`);
      }

      const baselineData = await captureEnterpriseUsersData(sql);

      // 3. Begin explicit transaction, execute migration 0002, and deliberately abort
      let migrationExecutedFully = false;
      try {
        await sql.begin(async (tx) => {
          await tx.file(MIGRATION_0002_PATH);
          migrationExecutedFully = true;
          throw new ControlledRollbackTestError();
        });
      } catch (err) {
        if (!(err instanceof ControlledRollbackTestError)) {
          throw new Error(`Migration Failed Unexpectedly during rollback test: ${err.message}`);
        }
      }

      if (!migrationExecutedFully) {
        throw new Error('Test Failure: Migration 0002 did not complete execution prior to abort');
      }

      // 4. Verify post-rollback catalog equality for 4 replaced functions
      const postFunctions = await captureFunctionsSnapshot(sql);
      if (postFunctions.length !== 4) {
        throw new Error(`Rollback Defect: Post-rollback functions count is ${postFunctions.length}, expected 4`);
      }
      for (let i = 0; i < 4; i++) {
        const b = baselineFunctions[i];
        const p = postFunctions[i];
        for (const key of Object.keys(b)) {
          if (b[key] !== p[key]) {
            throw new Error(`Rollback Defect: Function ${b.function_name} attribute mismatch for "${key}": "${b[key]}" vs "${p[key]}"`);
          }
        }
      }

      // 5. Verify post-rollback catalog equality for 2 affected baseline triggers
      const postTriggers = await captureTriggersSnapshot(sql);
      if (postTriggers.length !== 2) {
        throw new Error(`Rollback Defect: Post-rollback triggers count is ${postTriggers.length}, expected 2`);
      }
      for (let i = 0; i < 2; i++) {
        const b = baselineTriggers[i];
        const p = postTriggers[i];
        for (const key of Object.keys(b)) {
          if (b[key] !== p[key]) {
            throw new Error(`Rollback Defect: Trigger ${b.trigger_name} attribute mismatch for "${key}": "${b[key]}" vs "${p[key]}"`);
          }
        }
      }

      // 6. Anti-vacuous absence assertions for 5 new triggers created by 0002
      const [newTrgCount] = await sql`
        SELECT count(*) AS cnt
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE (n.nspname = 'public' AND c.relname = 'user_roles' AND t.tgname = 'user_roles_protect_admin_stmt')
           OR (n.nspname = 'public' AND c.relname = 'enterprise_users' AND t.tgname = 'enterprise_users_protect_admin_stmt')
           OR (n.nspname = 'public' AND c.relname = 'enterprise_users' AND t.tgname = 'enterprise_users_protect_last_admin')
           OR (n.nspname = 'auth' AND c.relname = 'users' AND t.tgname = 'on_auth_user_created_confirmed')
           OR (n.nspname = 'auth' AND c.relname = 'users' AND t.tgname = 'on_auth_user_email_confirmed');
      `;
      if (parseInt(newTrgCount.cnt, 10) !== 0) {
        throw new Error(`Rollback Defect: Found ${newTrgCount.cnt} 0002-created triggers still present post-rollback`);
      }

      // 7. Anti-vacuous absence assertions for 3 new functions created by 0002
      const [newFuncCount] = await sql`
        SELECT count(*) AS cnt
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND (
            (p.proname = 'acquire_global_super_admin_lock_stmt' AND p.pronargs = 0) OR
            (p.proname = 'protect_last_super_admin_profile' AND p.pronargs = 0) OR
            (p.proname = 'assign_user_role_atomic' AND p.pronargs = 3)
          );
      `;
      if (parseInt(newFuncCount.cnt, 10) !== 0) {
        throw new Error(`Rollback Defect: Found ${newFuncCount.cnt} 0002-created functions still present post-rollback`);
      }

      // 8. Absence assertions for new type, columns, and index
      const [typeExists] = await sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typname = 'invitation_status'
        ) AS ex;
      `;
      if (typeExists.ex) throw new Error('Rollback Defect: Type public.invitation_status exists post-rollback');

      const [colsExist] = await sql`
        SELECT count(*) AS cnt FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'enterprise_users'
          AND column_name IN ('invitation_status', 'invitation_dispatched_at');
      `;
      if (parseInt(colsExist.cnt, 10) !== 0) throw new Error('Rollback Defect: 0002 columns exist on enterprise_users');

      const [idxExists] = await sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'enterprise_users' AND indexname = 'enterprise_users_lower_email_idx'
        ) AS ex;
      `;
      if (idxExists.ex) throw new Error('Rollback Defect: enterprise_users_lower_email_idx exists post-rollback');

      // 9. Restoration assertions for user_roles relation properties and column nullability
      const postUserRolesAcl = await captureUserRolesAcl(sql);
      if (postUserRolesAcl.relation_owner !== baselineUserRolesAcl.relation_owner) {
        throw new Error(`Rollback Defect: user_roles relation_owner mismatch: "${postUserRolesAcl.relation_owner}" vs baseline "${baselineUserRolesAcl.relation_owner}"`);
      }
      if (postUserRolesAcl.is_rls_enabled !== baselineUserRolesAcl.is_rls_enabled) {
        throw new Error(`Rollback Defect: user_roles is_rls_enabled mismatch: ${postUserRolesAcl.is_rls_enabled} vs baseline ${baselineUserRolesAcl.is_rls_enabled}`);
      }
      if (postUserRolesAcl.is_force_rls_enabled !== baselineUserRolesAcl.is_force_rls_enabled) {
        throw new Error(`Rollback Defect: user_roles is_force_rls_enabled mismatch: ${postUserRolesAcl.is_force_rls_enabled} vs baseline ${baselineUserRolesAcl.is_force_rls_enabled}`);
      }
      if (postUserRolesAcl.relation_acl !== baselineUserRolesAcl.relation_acl) {
        throw new Error(`Rollback Defect: user_roles relation_acl mismatch: "${postUserRolesAcl.relation_acl}" vs baseline "${baselineUserRolesAcl.relation_acl}"`);
      }

      const postAuditActorIdNullable = await captureAuditActorIdNullability(sql);
      if (postAuditActorIdNullable !== 'NO') {
        throw new Error('Rollback Defect: admin_audit_logs.actor_id nullability did not revert to NO');
      }

      // 10. Data restoration assertion for public.enterprise_users
      const postData = await captureEnterpriseUsersData(sql);
      if (postData.total_row_count !== baselineData.total_row_count) {
        throw new Error(`Data Rollback Defect: Row count mismatch: ${postData.total_row_count} vs ${baselineData.total_row_count}`);
      }
      if (postData.row_set_hash !== baselineData.row_set_hash) {
        throw new Error(`Data Rollback Defect: Row set hash mismatch: ${postData.row_set_hash} vs ${baselineData.row_set_hash}`);
      }
      if (JSON.stringify(postData.canonical_rows_snapshot) !== JSON.stringify(baselineData.canonical_rows_snapshot)) {
        throw new Error('Data Rollback Defect: Canonical JSON rows snapshot mismatch');
      }

      console.log('✔ Scenario 1 Passed: 100% catalog and row-set baseline restoration proven.');
    });
  } finally {
    await session.dropDatabase(dbName);
  }
}

// Scenario 2: Forward Migration & Security Invariants Verification
async function runScenario2Forward(session) {
  console.log('\n--- Scenario 2: Forward Migration & Security Invariants ---');
  const dbName = 'pt_scenario_forward';
  await session.createDatabase(dbName);

  try {
    await session.withClient(dbName, async (sql) => {
      await sql.file(FIXTURE_01_COMPAT);
      await sql.file(MIGRATION_0000_PATH);
      await sql.file(MIGRATION_0001_PATH);
      await sql.file(MIGRATION_0002_PATH);

      // Verify Single Super Admin Initial Invariant
      const [superAdminUser] = await sql`
        INSERT INTO auth.users (id, email, email_confirmed_at)
        VALUES (gen_random_uuid(), 'superadmin@example.com', now())
        RETURNING id;
      `;

      // Seed linked enterprise user
      await sql`
        INSERT INTO public.enterprise_users (auth_user_id, email, name, badge_id, is_active, invitation_status)
        VALUES (${superAdminUser.id}, 'superadmin@example.com', 'Super Admin', 'PT-001', true, 'LINKED'::public.invitation_status);
      `;

      // Assign initial super_admin via direct controlled seed
      await sql`
        INSERT INTO public.user_roles (user_id, role)
        VALUES (${superAdminUser.id}, 'super_admin'::public.app_role);
      `;

      // Test Invariant 1: Prevent assigning second super_admin via assign_user_role_atomic
      const [secondUser] = await sql`
        INSERT INTO auth.users (id, email, email_confirmed_at)
        VALUES (gen_random_uuid(), 'second@example.com', now())
        RETURNING id;
      `;
      await sql`
        INSERT INTO public.enterprise_users (auth_user_id, email, name, badge_id, is_active, invitation_status)
        VALUES (${secondUser.id}, 'second@example.com', 'Second User', 'PT-002', true, 'LINKED'::public.invitation_status);
      `;

      let caughtSecondAdmin = false;
      try {
        await sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE authenticated;`;
          await tx`SELECT set_config('request.jwt.claim.sub', ${superAdminUser.id}::text, true);`;
          await tx`SELECT set_config('request.jwt.claim.role', 'authenticated', true);`;
          await tx`
            SELECT public.assign_user_role_atomic(
              ${secondUser.id}::uuid,
              'super_admin'::public.app_role,
              NULL
            );
          `;
        });
      } catch (err) {
        if (err.code === '28000' && err.message.includes('Super Admin role cannot be granted via standard role assignment')) {
          caughtSecondAdmin = true;
        } else {
          throw new Error(`Unexpected error during second super_admin assignment test: [${err.code}] ${err.message}`);
        }
      }
      if (!caughtSecondAdmin) {
        throw new Error('Security Invariant Failure: Second super_admin assignment did not raise SQLSTATE 28000');
      }

      // Test Invariant 2: Cannot demote the last remaining active Super Admin
      let caughtLastAdminDemote = false;
      try {
        await sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE authenticated;`;
          await tx`SELECT set_config('request.jwt.claim.sub', ${superAdminUser.id}::text, true);`;
          await tx`SELECT set_config('request.jwt.claim.role', 'authenticated', true);`;
          await tx`
            SELECT public.assign_user_role_atomic(
              ${superAdminUser.id}::uuid,
              'security'::public.app_role,
              NULL
            );
          `;
        });
      } catch (err) {
        if (err.code === '23514' && err.message.includes('Cannot demote the last remaining active Super Admin')) {
          caughtLastAdminDemote = true;
        } else {
          throw new Error(`Unexpected error during last super_admin demotion test: [${err.code}] ${err.message}`);
        }
      }
      if (!caughtLastAdminDemote) {
        throw new Error('Security Invariant Failure: Demoting last super_admin did not raise SQLSTATE 23514');
      }

      // Test Invariant 3: Cannot deactivate the last remaining active Super Admin profile
      const [adminCountBeforeDeact] = await sql`
        SELECT count(*) AS cnt
        FROM public.user_roles ur
        JOIN public.enterprise_users eu ON eu.auth_user_id = ur.user_id
        WHERE ur.role = 'super_admin'::public.app_role
          AND eu.is_active = true
          AND eu.invitation_status = 'LINKED'::public.invitation_status;
      `;
      if (parseInt(adminCountBeforeDeact.cnt, 10) !== 1) {
        throw new Error(`Scenario 2 Setup Defect: Expected exactly 1 active linked super_admin profile, found ${adminCountBeforeDeact.cnt}`);
      }

      let caughtLastAdminDeactivate = false;
      try {
        await sql`
          UPDATE public.enterprise_users
          SET is_active = false
          WHERE auth_user_id = ${superAdminUser.id};
        `;
      } catch (err) {
        if (err.code === '23514' && err.message.includes('Cannot deactivate, alter, or delete the last remaining active Super Admin profile')) {
          caughtLastAdminDeactivate = true;
        }
      }
      if (!caughtLastAdminDeactivate) {
        throw new Error('Security Invariant Failure: Deactivating last super_admin profile did not raise SQLSTATE 23514');
      }

      // Test Invariant 4: Non-admin caller is rejected by assign_user_role_atomic in a transaction
      let caughtNonAdminAuth = false;
      try {
        await sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE authenticated;`;
          await tx`SELECT set_config('request.jwt.claim.sub', ${secondUser.id}::text, true);`;
          await tx`SELECT set_config('request.jwt.claim.role', 'authenticated', true);`;
          await tx`
            SELECT public.assign_user_role_atomic(
              ${secondUser.id}::uuid,
              'employee'::public.app_role,
              ${secondUser.id}::uuid
            );
          `;
        });
      } catch (err) {
        if (err.code === '42501' && err.message.includes('Access Denied: Super Admin role required to mutate user roles')) {
          caughtNonAdminAuth = true;
        } else {
          throw new Error(`Unexpected error during non-admin authorization test: [${err.code}] ${err.message}`);
        }
      }
      if (!caughtNonAdminAuth) {
        throw new Error('Security Invariant Failure: Non-admin role mutation did not raise SQLSTATE 42501');
      }

      console.log('✔ Scenario 2 Passed: Single Super Admin, Profile Deactivation, and Non-Admin Auth invariants enforced.');
    });
  } finally {
    await session.dropDatabase(dbName);
  }
}

// Scenario 3: Isolated Prerequisite Failure Scenarios Matrix
async function runScenario3Prerequisites(session) {
  console.log('\n--- Scenario 3: Isolated Prerequisite Failure Scenarios ---');

  // Prereq Case A: app_role Extra Label -> SQLSTATE 42804
  {
    const dbName = 'pt_prereq_extra_role';
    await session.createDatabase(dbName);
    try {
      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_01_COMPAT);
        await sql.file(MIGRATION_0000_PATH);
        await sql.file(MIGRATION_0001_PATH);

        // Mutate: add 5th label
        await sql`ALTER TYPE public.app_role ADD VALUE 'auditor';`;

        let caught = false;
        try {
          await sql.file(MIGRATION_0002_PATH);
        } catch (err) {
          if (err.code === '42804') caught = true;
        }
        if (!caught) throw new Error('Prereq A Failed: Extra app_role label did not raise 42804');
        console.log('✔ Prereq A Passed: Raised SQLSTATE 42804 on extra app_role label.');
      });
    } finally {
      await session.dropDatabase(dbName);
    }
  }

  // Prereq Case B: invitation_status Incomplete -> SQLSTATE 42804
  {
    const dbName = 'pt_prereq_inc_inv';
    await session.createDatabase(dbName);
    try {
      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_01_COMPAT);
        await sql.file(MIGRATION_0000_PATH);
        await sql.file(MIGRATION_0001_PATH);

        // Pre-create enum with missing labels
        await sql`CREATE TYPE public.invitation_status AS ENUM ('STAGED', 'LINKED');`;

        let caught = false;
        try {
          await sql.file(MIGRATION_0002_PATH);
        } catch (err) {
          if (err.code === '42804') caught = true;
        }
        if (!caught) throw new Error('Prereq B Failed: Incomplete invitation_status did not raise 42804');
        console.log('✔ Prereq B Passed: Raised SQLSTATE 42804 on incomplete invitation_status.');
      });
    } finally {
      await session.dropDatabase(dbName);
    }
  }

  // Prereq Case C: Non-Unique auth_user_id -> SQLSTATE 42P16
  {
    const dbName = 'pt_prereq_non_unique';
    await session.createDatabase(dbName);
    try {
      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_01_COMPAT);
        await sql.file(MIGRATION_0000_PATH);
        await sql.file(MIGRATION_0001_PATH);

        // Drop unique constraint cleanly without CASCADE
        await sql`ALTER TABLE public.enterprise_users DROP CONSTRAINT enterprise_users_auth_user_id_key;`;

        let caught = false;
        try {
          await sql.file(MIGRATION_0002_PATH);
        } catch (err) {
          if (err.code === '42P16') caught = true;
        }
        if (!caught) throw new Error('Prereq C Failed: Non-unique auth_user_id did not raise 42P16');
        console.log('✔ Prereq C Passed: Raised SQLSTATE 42P16 on non-unique auth_user_id.');
      });
    } finally {
      await session.dropDatabase(dbName);
    }
  }

  // Prereq Case D: Incompatible has_role Signature -> SQLSTATE 42883
  {
    const dbName = 'pt_prereq_has_role_sig';
    await session.createDatabase(dbName);
    try {
      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_02_PREREQ_BASE);

        // Define has_role with text parameter instead of uuid
        await sql`
          CREATE FUNCTION public.has_role(_user_id text, _role public.app_role)
          RETURNS boolean LANGUAGE sql AS $$ SELECT true; $$;
        `;

        let caught = false;
        try {
          await sql.file(MIGRATION_0002_PATH);
        } catch (err) {
          if (err.code === '42883') caught = true;
        }
        if (!caught) throw new Error('Prereq D Failed: Incompatible has_role signature did not raise 42883');
        console.log('✔ Prereq D Passed: Raised SQLSTATE 42883 on incompatible has_role signature.');
      });
    } finally {
      await session.dropDatabase(dbName);
    }
  }

  // Prereq Case E: Missing auth.uid() -> SQLSTATE 42883
  {
    const dbName = 'pt_prereq_missing_auth_uid';
    await session.createDatabase(dbName);
    try {
      await session.withClient(dbName, async (sql) => {
        await sql.file(FIXTURE_02_PREREQ_BASE);

        // Define valid has_role and has_any_role, omit auth.uid()
        await sql`
          CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
          RETURNS boolean LANGUAGE sql AS $$ SELECT true; $$;
        `;
        await sql`
          CREATE FUNCTION public.has_any_role(_user_id uuid, _roles public.app_role[])
          RETURNS boolean LANGUAGE sql AS $$ SELECT true; $$;
        `;

        let caught = false;
        try {
          await sql.file(MIGRATION_0002_PATH);
        } catch (err) {
          if (err.code === '42883') caught = true;
        }
        if (!caught) throw new Error('Prereq E Failed: Missing auth.uid() did not raise 42883');
        console.log('✔ Prereq E Passed: Raised SQLSTATE 42883 on missing auth.uid().');
      });
    } finally {
      await session.dropDatabase(dbName);
    }
  }
}

// ==============================================================================
// 5. Main Execution Entrypoint
// ==============================================================================
async function main() {
  console.log('==============================================================================');
  console.log(' PresenceTrack AI — Ephemeral PostgreSQL 17 Integration Test Suite');
  console.log('==============================================================================');

  const cluster = new EphemeralClusterManager();
  let session = null;

  // Global interruption and termination hooks
  const exitHandler = async (sig) => {
    console.log(`\nCaught ${sig}. Executing fail-closed cluster cleanup...`);
    await cluster.stopAndCleanup();
    process.exit(1);
  };
  process.on('SIGINT', () => exitHandler('SIGINT'));
  process.on('SIGTERM', () => exitHandler('SIGTERM'));

  try {
    console.log('1. Starting ephemeral PostgreSQL 17 cluster in dedicated process group...');
    await cluster.start();
    console.log(`   ✔ Cluster started on port ${cluster.port}`);
    console.log(`   ✔ System Identifier: ${cluster.bootstrapSystemIdentifier}`);

    session = new GuardedClusterSession(cluster);

    console.log('\n2. Executing cluster bootstrap fixture...');
    await session.withClient('postgres', async (adminSql) => {
      await adminSql.file(FIXTURE_00_BOOTSTRAP);
    });
    console.log('   ✔ Cluster-wide roles (anon, authenticated, service_role) provisioned.');

    // Execute test suites
    await runScenario1Rollback(session);
    await runScenario2Forward(session);
    await runScenario3Prerequisites(session);

    console.log('\n==============================================================================');
    console.log(' ALL INTEGRATION TESTS PASSED SUCCESSFULLY');
    console.log('==============================================================================');
  } catch (err) {
    console.error('\n[FATAL TEST RUNNER ERROR]:', err);
    process.exitCode = 1;
  } finally {
    console.log('\nExecuting fail-closed cluster teardown and process-group verification...');
    await cluster.stopAndCleanup();
    console.log('Teardown complete.');
  }
}

// ==============================================================================
// 7. Focused Cleanup Lifecycle Unit Tests (--test-cleanup)
// ==============================================================================
export async function runCleanupUnitTests() {
  console.log('==============================================================================');
  console.log(' RUNNING FOCUSED CLEANUP UNIT TESTS (--test-cleanup)');
  console.log('==============================================================================\n');

  let passed = 0;
  let failed = 0;

  // Case 1: initdb failure before spawn (NOT_SPAWNED) cleans up safely without calling process.kill()
  try {
    console.log('Case 1: initdb failure before spawn (NOT_SPAWNED)...');
    const uniqueToken = crypto.randomBytes(8).toString('hex');
    const testDir = path.resolve(`/tmp/pt_ephemeral_pg17_${process.pid}_${uniqueToken}`);
    const socketDir = path.join(testDir, 'socket');
    const logFile = path.join(testDir, 'server.log');
    const dataDir = path.join(testDir, 'data'); // Intentionally not created

    fs.mkdirSync(testDir, { mode: 0o700, recursive: true });
    fs.mkdirSync(socketDir, { mode: 0o700, recursive: true });
    const logFd = fs.openSync(logFile, 'w');

    let killCallCount = 0;
    const origKill = process.kill;
    process.kill = function (...args) {
      killCallCount++;
      return origKill.apply(this, args);
    };

    try {
      const manager = EphemeralClusterManager._createForTesting({
        clusterDir: testDir,
        dataDir: dataDir,
        socketDir: socketDir,
        logFile: logFile,
        logFd: logFd,
        processLifecycle: 'NOT_SPAWNED',
        pgProcess: null,
        pgid: null,
        pgExited: false
      });

      await manager.stopAndCleanup();

      if (killCallCount !== 0) {
        throw new Error(`Expected process.kill to NEVER be called, but was called ${killCallCount} times`);
      }
      if (manager.cleanupState !== 'CLEANED') {
        throw new Error(`Expected cleanupState to be CLEANED, got ${manager.cleanupState}`);
      }
      if (fs.existsSync(testDir)) {
        throw new Error(`Expected directory ${testDir} to be deleted`);
      }
      console.log('  ✔ Case 1 passed: NOT_SPAWNED cleaned up safely without calling process.kill().\n');
      passed++;
    } finally {
      process.kill = origKill;
      if (fs.existsSync(testDir)) {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
  } catch (err) {
    console.error('  ✖ Case 1 failed:', err);
    failed++;
  }

  // Case 2: PostgreSQL spawn followed by normal exit cleans up safely
  try {
    console.log('Case 2: PostgreSQL spawn followed by normal exit...');
    const uniqueToken = crypto.randomBytes(8).toString('hex');
    const testDir = path.resolve(`/tmp/pt_ephemeral_pg17_${process.pid}_${uniqueToken}`);
    const socketDir = path.join(testDir, 'socket');
    const logFile = path.join(testDir, 'server.log');
    const dataDir = path.join(testDir, 'data');

    fs.mkdirSync(testDir, { mode: 0o700, recursive: true });
    fs.mkdirSync(dataDir, { mode: 0o700, recursive: true });
    fs.mkdirSync(socketDir, { mode: 0o700, recursive: true });
    const logFd = fs.openSync(logFile, 'w');

    // Spawn a short-lived process that exits immediately to obtain a real exited process and PID
    const child = child_process.spawn(process.execPath, ['-e', 'process.exit(0)'], {
      detached: true,
      stdio: 'ignore'
    });
    await new Promise((r) => child.on('exit', r));

    try {
      const manager = EphemeralClusterManager._createForTesting({
        clusterDir: testDir,
        dataDir: dataDir,
        socketDir: socketDir,
        logFile: logFile,
        logFd: logFd,
        processLifecycle: 'EXITED',
        pgProcess: child,
        pgid: child.pid,
        pgExited: true,
        pgExitCode: 0
      });

      await manager.stopAndCleanup();

      if (manager.cleanupState !== 'CLEANED') {
        throw new Error(`Expected cleanupState to be CLEANED, got ${manager.cleanupState}`);
      }
      if (fs.existsSync(testDir)) {
        throw new Error(`Expected directory ${testDir} to be deleted`);
      }
      console.log('  ✔ Case 2 passed: Spawned and exited process cleaned up safely.\n');
      passed++;
    } finally {
      if (fs.existsSync(testDir)) {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
  } catch (err) {
    console.error('  ✖ Case 2 failed:', err);
    failed++;
  }

  // Case 3: PostgreSQL process that cannot be confirmed stopped preserves directory (PRESERVED_ACTIVE)
  try {
    console.log('Case 3: Process that cannot be confirmed stopped...');
    const uniqueToken = crypto.randomBytes(8).toString('hex');
    const testDir = path.resolve(`/tmp/pt_ephemeral_pg17_${process.pid}_${uniqueToken}`);
    const socketDir = path.join(testDir, 'socket');
    const logFile = path.join(testDir, 'server.log');
    const dataDir = path.join(testDir, 'data');

    fs.mkdirSync(testDir, { mode: 0o700, recursive: true });
    fs.mkdirSync(dataDir, { mode: 0o700, recursive: true });
    fs.mkdirSync(socketDir, { mode: 0o700, recursive: true });
    const logFd = fs.openSync(logFile, 'w');

    // Spawn a detached process that stays alive
    const liveChild = child_process.spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
      detached: true,
      stdio: 'ignore'
    });

    try {
      const manager = EphemeralClusterManager._createForTesting({
        clusterDir: testDir,
        dataDir: dataDir,
        socketDir: socketDir,
        logFile: logFile,
        logFd: logFd,
        processLifecycle: 'EXITED',
        pgProcess: liveChild,
        pgid: liveChild.pid,
        pgExited: true, // Marked exited, but process group still alive (signal 0 probe succeeds)
        pgExitCode: 0
      });

      // Suppress console.error during expected safety halt message
      const origErr = console.error;
      console.error = () => {};
      try {
        await manager.stopAndCleanup();
      } finally {
        console.error = origErr;
      }

      if (manager.cleanupState !== 'PRESERVED_ACTIVE') {
        throw new Error(`Expected cleanupState to be PRESERVED_ACTIVE, got ${manager.cleanupState}`);
      }
      if (!fs.existsSync(testDir)) {
        throw new Error(`Expected directory ${testDir} to be PRESERVED`);
      }
      console.log('  ✔ Case 3 passed: Unconfirmed stopped process preserves directory (PRESERVED_ACTIVE).\n');
      passed++;
    } finally {
      // Terminate the live child process and clean up test directory
      try { process.kill(-liveChild.pid, 'SIGKILL'); } catch (_) {}
      try { liveChild.kill('SIGKILL'); } catch (_) {}
      try { fs.closeSync(logFd); } catch (_) {}
      if (fs.existsSync(testDir)) {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
  } catch (err) {
    console.error('  ✖ Case 3 failed:', err);
    failed++;
  }

  // Case 4: Invalid or missing PGID (null, 0, or -1) fails closed and preserves the directory
  try {
    console.log('Case 4: Invalid or missing PGID (null, 0, -1)...');
    const invalidPgids = [null, 0, -1];
    for (const invalidPgid of invalidPgids) {
      const uniqueToken = crypto.randomBytes(8).toString('hex');
      const testDir = path.resolve(`/tmp/pt_ephemeral_pg17_${process.pid}_${uniqueToken}`);
      const socketDir = path.join(testDir, 'socket');
      const logFile = path.join(testDir, 'server.log');
      const dataDir = path.join(testDir, 'data');

      fs.mkdirSync(testDir, { mode: 0o700, recursive: true });
      fs.mkdirSync(dataDir, { mode: 0o700, recursive: true });
      fs.mkdirSync(socketDir, { mode: 0o700, recursive: true });
      const logFd = fs.openSync(logFile, 'w');

      try {
        const manager = EphemeralClusterManager._createForTesting({
          clusterDir: testDir,
          dataDir: dataDir,
          socketDir: socketDir,
          logFile: logFile,
          logFd: logFd,
          processLifecycle: 'EXITED',
          pgProcess: {},
          pgid: invalidPgid,
          pgExited: true,
          pgExitCode: 0
        });

        const origErr = console.error;
        console.error = () => {};
        try {
          await manager.stopAndCleanup();
        } finally {
          console.error = origErr;
        }

        if (manager.cleanupState !== 'PRESERVED_ACTIVE') {
          throw new Error(`For PGID ${invalidPgid}, expected cleanupState PRESERVED_ACTIVE, got ${manager.cleanupState}`);
        }
        if (!fs.existsSync(testDir)) {
          throw new Error(`For PGID ${invalidPgid}, expected directory ${testDir} to be preserved`);
        }
      } finally {
        try { fs.closeSync(logFd); } catch (_) {}
        if (fs.existsSync(testDir)) {
          try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
        }
      }
    }
    console.log('  ✔ Case 4 passed: Invalid PGIDs (null, 0, -1) fail closed and preserve directory.\n');
    passed++;
  } catch (err) {
    console.error('  ✖ Case 4 failed:', err);
    failed++;
  }

  console.log('==============================================================================');
  console.log(` CLEANUP UNIT TESTS RESULT: ${passed}/4 PASSED, ${failed} FAILED`);
  console.log('==============================================================================');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

// Execute main or test-cleanup if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--test-cleanup')) {
    runCleanupUnitTests().catch((err) => {
      console.error('Unhandled fatal error in runCleanupUnitTests:', err);
      process.exit(1);
    });
  } else {
    main().catch((err) => {
      console.error('Unhandled fatal error in main:', err);
      process.exit(1);
    });
  }
}
