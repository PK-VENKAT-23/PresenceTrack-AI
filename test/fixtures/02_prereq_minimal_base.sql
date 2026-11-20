-- ==============================================================================
-- PresenceTrack AI — Minimal Isolated Prerequisite Baseline Fixture
-- Path: test/fixtures/02_prereq_minimal_base.sql
--
-- Scope:
--   Executed in DEDICATED scenario databases for testing isolated prerequisite
--   validation failures (specifically 'missing auth.uid()' and 'incompatible has_role()').
--
-- Responsibilities:
--   1. Defines base tables, enums, and columns required by 0002's initial checks.
--   2. Intentionally omits ALL Row Level Security (RLS) policies and dependent views.
--
-- Architectural Purpose:
--   In PostgreSQL, dropping or modifying functions referenced by RLS policies fails
--   with '2BP01: cannot drop function because other objects depend on it'.
--   This minimal fixture allows testing prerequisite failures in total isolation
--   without requiring CASCADE or corrupting authentic migration baselines.
-- ==============================================================================

-- 1. Base Application Role Enum with exact 4 required labels
CREATE TYPE public.app_role AS ENUM (
  'employee',
  'hr_ops',
  'security',
  'super_admin'
);

-- 2. Base enterprise_users Table
CREATE TABLE public.enterprise_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID UNIQUE,
  imported_role public.app_role,
  email TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true
);

-- 3. Base user_roles Table with primary key constraint on id alone matching 0000_presencetrack_schema.sql
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Base admin_audit_logs Table with all required columns
CREATE TABLE public.admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 5. Minimal auth schema and users table
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  email_confirmed_at TIMESTAMPTZ
);
