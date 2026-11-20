-- ==============================================================================
-- PresenceTrack AI — Ephemeral PostgreSQL 17 Cluster Bootstrap Fixture
-- Path: test/fixtures/00_cluster_bootstrap.sql
--
-- Scope:
--   Executed ONCE per ephemeral cluster lifecycle against the administrative
--   'postgres' database by the cluster bootstrap superuser.
--
-- Responsibilities:
--   1. Idempotently provisions Supabase-standard cluster-wide roles.
--   2. Establishes exact RBAC privilege flags required for integration testing.
--
-- Architectural Notes:
--   - PostgreSQL roles are cluster-wide (stored in pg_roles). They must NEVER
--     be created in per-scenario fixtures.
--   - pg_default_acl is NOT modified by migration 0002; default privileges
--     remain unchanged across cluster execution.
-- ==============================================================================

DO $$
BEGIN
  -- 1. Unauthenticated client role: strictly unprivileged, cannot log in directly
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon WITH
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      NOINHERIT;
  END IF;

  -- 2. Authenticated user role: represents standard signed-in users, bound by RLS
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated WITH
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      NOINHERIT;
  END IF;

  -- 3. Backend service role: administrative API worker, endowed with BYPASSRLS
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role WITH
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      BYPASSRLS
      NOINHERIT;
  END IF;
END $$;
