-- ==============================================================================
-- PresenceTrack AI — Scenario Database Supabase Compatibility Fixture
-- Path: test/fixtures/01_supabase_compat.sql
--
-- Scope:
--   Executed in EACH freshly spawned scenario database prior to applying
--   authentic migrations 0000 and 0001.
--
-- Responsibilities:
--   1. Provisions local 'auth' schema and minimal 'auth.users' table.
--   2. Declares 'auth.uid()' evaluating JWT claims without fallback.
--   3. Registers the global 'supabase_realtime' publication.
--
-- Architectural Notes:
--   - Does NOT create cluster-wide roles (managed in 00_cluster_bootstrap.sql).
--   - Does NOT create application tables (managed by authentic migrations).
-- ==============================================================================

-- 1. Create Supabase Auth Schema
CREATE SCHEMA IF NOT EXISTS auth;

-- 2. Minimal auth.users structure required by 0000, 0001, and 0002
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  email_confirmed_at TIMESTAMPTZ,
  raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
);

-- 3. auth.uid() function evaluating JWT claims without fallback to arbitrary rows
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- 4. Global Supabase Realtime Publication
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- 5. Supabase Vault Schema & Compatibility View/Table
CREATE SCHEMA IF NOT EXISTS vault;

CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  secret TEXT,
  decrypted_secret TEXT NOT NULL,
  key_id UUID,
  nonce BYTEA,
  created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
);

-- Vault access controls: strictly restricted to superuser / service_role
REVOKE ALL ON SCHEMA vault FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE vault.decrypted_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON SCHEMA vault TO service_role;
GRANT ALL ON TABLE vault.decrypted_secrets TO service_role;

-- Seed default test secret for ephemeral local environments
INSERT INTO vault.decrypted_secrets (name, description, decrypted_secret)
VALUES ('enclave_salt_secret', 'Enclave salt for DPDP backup tombstone hash derivation', 'local_ephemeral_vault_salt_secret')
ON CONFLICT (name) DO UPDATE SET decrypted_secret = EXCLUDED.decrypted_secret;
