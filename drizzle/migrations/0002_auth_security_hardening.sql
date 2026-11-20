-- ── Migration 0002: PresenceTrack Auth & Provisioning Security Hardening ─────
-- Safe forward-only migration. Preserves committed migrations 0000 and 0001.

-- ── 1. Defensive Prerequisite Verification ─────────────────────────────────
DO $$
BEGIN
  -- ── A. Existing Enum Types ──────────────────────────────────────────────────
  -- 1. Verify 0000 base enum public.app_role exists and is an enum type
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'app_role' AND t.typtype = 'e'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Type public.app_role does not exist or is not an enum type. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42704';
  END IF;

  -- 2. Verify public.app_role contains exactly four required labels and no unexpected labels
  IF (
    SELECT count(*) FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'app_role'
  ) <> 4 OR (
    SELECT count(DISTINCT e.enumlabel)
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'app_role'
      AND e.enumlabel IN ('employee', 'hr_ops', 'security', 'super_admin')
  ) <> 4 THEN
    RAISE EXCEPTION 'Prerequisite Failure: Enum public.app_role must contain exactly four labels (employee, hr_ops, security, super_admin).'
      USING ERRCODE = '42804';
  END IF;

  -- 3. Verify public.invitation_status: if pre-existing, must be an enum containing exactly the 5 required labels
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'invitation_status'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = 'invitation_status' AND t.typtype = 'e'
    ) OR (
      SELECT count(*) FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = 'invitation_status'
    ) <> 5 OR (
      SELECT count(DISTINCT e.enumlabel)
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = 'invitation_status'
        AND e.enumlabel IN ('STAGED', 'DISPATCH_PENDING', 'DISPATCHED', 'LINKED', 'RECONCILIATION_REQUIRED')
    ) <> 5 THEN
      RAISE EXCEPTION 'Prerequisite Failure: Pre-existing public.invitation_status must be an enum type containing exactly the 5 required labels (STAGED, DISPATCH_PENDING, DISPATCHED, LINKED, RECONCILIATION_REQUIRED).'
        USING ERRCODE = '42804';
    END IF;
  END IF;

  -- ── B. Base Tables & Profile Columns ────────────────────────────────────────
  -- 1. Verify 0000 base tables exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'enterprise_users' AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: public.enterprise_users ordinary table does not exist. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42P01';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'user_roles' AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: public.user_roles ordinary table does not exist. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42P01';
  END IF;

  -- 2. Verify enterprise_users columns and nullability
  -- enterprise_users.id is UUID NOT NULL
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'enterprise_users'
      AND column_name = 'id' AND udt_name = 'uuid' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Column enterprise_users.id must be UUID NOT NULL. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42804';
  END IF;

  -- enterprise_users.auth_user_id is UUID nullable
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'enterprise_users'
      AND column_name = 'auth_user_id' AND udt_name = 'uuid' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Column enterprise_users.auth_user_id must be UUID nullable. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42804';
  END IF;

  -- enterprise_users.imported_role is public.app_role enum type nullable
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'enterprise_users'
      AND column_name = 'imported_role' AND udt_schema = 'public' AND udt_name = 'app_role' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Column enterprise_users.imported_role must be of enum type public.app_role. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42804';
  END IF;

  -- enterprise_users.email is text NOT NULL
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'enterprise_users'
      AND column_name = 'email' AND data_type = 'text' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Column enterprise_users.email must be text NOT NULL. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42804';
  END IF;

  -- enterprise_users.is_active is boolean NOT NULL
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'enterprise_users'
      AND column_name = 'is_active' AND data_type = 'boolean' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Column enterprise_users.is_active must be boolean NOT NULL. Apply 0001_attendance_backend_expansion.sql first.'
      USING ERRCODE = '42804';
  END IF;

  -- enterprise_users.invitation_status if already present must be public.invitation_status
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'enterprise_users' AND column_name = 'invitation_status'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'enterprise_users'
        AND column_name = 'invitation_status' AND udt_schema = 'public' AND udt_name = 'invitation_status'
    ) THEN
      RAISE EXCEPTION 'Prerequisite Failure: Existing enterprise_users.invitation_status must be public.invitation_status type.'
        USING ERRCODE = '42804';
    END IF;
  END IF;

  -- 3. Verify public.user_roles columns (user_id UUID NOT NULL, role public.app_role NOT NULL)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_roles'
      AND column_name = 'user_id' AND udt_name = 'uuid' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_roles'
      AND column_name = 'role' AND udt_schema = 'public' AND udt_name = 'app_role' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Columns on public.user_roles (user_id UUID NOT NULL, role public.app_role NOT NULL) missing or invalid. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42703';
  END IF;

  -- ── C. Audit Table Validation ───────────────────────────────────────────────
  -- Verify admin_audit_logs ordinary table exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'admin_audit_logs' AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: public.admin_audit_logs table does not exist. Apply 0001_attendance_backend_expansion.sql first.'
      USING ERRCODE = '42P01';
  END IF;

  -- Verify all admin_audit_logs columns used by audit inserts
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_audit_logs'
      AND column_name = 'id' AND udt_name = 'uuid' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_audit_logs'
      AND column_name = 'actor_id' AND udt_name = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_audit_logs'
      AND column_name = 'action' AND data_type = 'text' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_audit_logs'
      AND column_name = 'entity_type' AND data_type = 'text' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_audit_logs'
      AND column_name = 'entity_id' AND data_type = 'text' AND is_nullable = 'YES'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_audit_logs'
      AND column_name = 'metadata' AND data_type = 'jsonb' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_audit_logs'
      AND column_name = 'created_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Columns on public.admin_audit_logs (id UUID, actor_id UUID, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, metadata JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL) missing or invalid. Apply 0001_attendance_backend_expansion.sql first.'
      USING ERRCODE = '42703';
  END IF;

  -- ── D. Existing Helper Functions (Exact Signatures via Schema-Qualified Type OIDs) ──
  -- Verify function public.has_role(uuid, public.app_role) -> boolean
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'has_role'
      AND p.pronargs = 2
      AND p.prorettype = 'boolean'::regtype
      AND p.proargtypes[0] = 'uuid'::regtype
      AND p.proargtypes[1] = 'public.app_role'::regtype
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Function public.has_role(uuid, public.app_role) returning boolean does not exist. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42883';
  END IF;

  -- Verify function public.has_any_role(uuid, public.app_role[]) -> boolean
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'has_any_role'
      AND p.pronargs = 2
      AND p.prorettype = 'boolean'::regtype
      AND p.proargtypes[0] = 'uuid'::regtype
      AND p.proargtypes[1] = 'public.app_role[]'::regtype
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Function public.has_any_role(uuid, public.app_role[]) returning boolean does not exist. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42883';
  END IF;

  -- ── E. Constraints and Keys ─────────────────────────────────────────────────
  -- Verify enterprise_users has a PRIMARY KEY constraint on id alone
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'public' AND t.relname = 'enterprise_users'
      AND c.contype = 'p' AND cardinality(c.conkey) = 1 AND a.attname = 'id'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Table public.enterprise_users must have a PRIMARY KEY constraint on id alone. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42P16';
  END IF;

  -- Verify enterprise_users.auth_user_id has a genuine single-column UNIQUE constraint or index
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'public' AND t.relname = 'enterprise_users'
      AND c.contype = 'u' AND cardinality(c.conkey) = 1 AND a.attname = 'auth_user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
    WHERE n.nspname = 'public' AND t.relname = 'enterprise_users'
      AND i.indisunique = true
      AND i.indisvalid = true
      AND i.indisready = true
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 1
      AND a.attname = 'auth_user_id'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Column enterprise_users.auth_user_id must have a genuine single-column UNIQUE constraint or index. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42P16';
  END IF;

  -- Verify user_roles has a PRIMARY KEY constraint on id alone
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'public' AND t.relname = 'user_roles'
      AND c.contype = 'p' AND cardinality(c.conkey) = 1 AND a.attname = 'id'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Table public.user_roles must have a PRIMARY KEY constraint on id alone matching 0000_presencetrack_schema.sql.'
      USING ERRCODE = '42P16';
  END IF;

  -- Verify user_roles.user_id has a genuine single-column UNIQUE constraint or index
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'public' AND t.relname = 'user_roles'
      AND c.contype = 'u' AND cardinality(c.conkey) = 1 AND a.attname = 'user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
    WHERE n.nspname = 'public' AND t.relname = 'user_roles'
      AND i.indisunique = true
      AND i.indisvalid = true
      AND i.indisready = true
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 1
      AND a.attname = 'user_id'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Column user_roles.user_id must have a genuine single-column UNIQUE constraint or index. Apply 0000_presencetrack_schema.sql first.'
      USING ERRCODE = '42P16';
  END IF;

  -- ── F. Auth Schema Validation ───────────────────────────────────────────────
  -- Verify auth.users table exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth' AND c.relname = 'users' AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: auth.users table does not exist. Supabase Auth must be active.'
      USING ERRCODE = '42P01';
  END IF;

  -- Verify auth.users columns: id (UUID NOT NULL), email (TEXT/VARCHAR), email_confirmed_at (TIMESTAMPTZ)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'id'
      AND udt_name = 'uuid' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'email'
      AND data_type IN ('text', 'character varying')
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'email_confirmed_at'
      AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Required columns on auth.users (id UUID NOT NULL, email TEXT, email_confirmed_at TIMESTAMPTZ) missing or invalid.'
      USING ERRCODE = '42703';
  END IF;

  -- Verify function auth.uid() returning UUID exists with 0 arguments
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth'
      AND p.proname = 'uid'
      AND p.pronargs = 0
      AND p.prorettype = 'uuid'::regtype
  ) THEN
    RAISE EXCEPTION 'Prerequisite Failure: Function auth.uid() returning UUID with 0 arguments does not exist. Supabase Auth must be active.'
      USING ERRCODE = '42883';
  END IF;
END $$;

-- Ensure admin_audit_logs.actor_id allows NULL for system/unlinked actions and ON DELETE SET NULL
ALTER TABLE public.admin_audit_logs ALTER COLUMN actor_id DROP NOT NULL;

-- ── 2. Pre-Migration Duplicate-Email Check on enterprise_users ───────────────
DO $$
DECLARE
  _dup_count INT;
  _dup_samples TEXT;
BEGIN
  SELECT count(*), string_agg(lower_email || ' (' || cnt || 'x)', ', ')
  INTO _dup_count, _dup_samples
  FROM (
    SELECT lower(email) AS lower_email, count(*) AS cnt
    FROM public.enterprise_users
    GROUP BY lower(email)
    HAVING count(*) > 1
    LIMIT 5
  ) dups;

  IF _dup_count > 0 THEN
    RAISE EXCEPTION 'Integrity Failure: Cannot proceed with migration 0002. Duplicate normalized emails exist in public.enterprise_users: %', _dup_samples
      USING ERRCODE = '23505';
  END IF;
END $$;

-- ── 3. Invitation Status Enum & Lifecycle Backfill ──────────────────────────
DO $$ BEGIN
  CREATE TYPE public.invitation_status AS ENUM (
    'STAGED',
    'DISPATCH_PENDING',
    'DISPATCHED',
    'LINKED',
    'RECONCILIATION_REQUIRED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE public.enterprise_users
  ADD COLUMN IF NOT EXISTS invitation_status public.invitation_status NOT NULL DEFAULT 'STAGED',
  ADD COLUMN IF NOT EXISTS invitation_dispatched_at TIMESTAMPTZ;

-- Backfill classification for existing enterprise_users
-- 1. Unlinked profiles -> STAGED
UPDATE public.enterprise_users
SET invitation_status = 'STAGED'
WHERE auth_user_id IS NULL;

-- 2. Linked profiles with matching roles -> LINKED; Inconsistencies -> RECONCILIATION_REQUIRED
UPDATE public.enterprise_users eu
SET invitation_status = CASE
  WHEN eu.is_active = false THEN 'RECONCILIATION_REQUIRED'::public.invitation_status
  WHEN ur.role IS NULL THEN 'RECONCILIATION_REQUIRED'::public.invitation_status
  WHEN eu.imported_role IS NOT NULL AND ur.role <> eu.imported_role THEN 'RECONCILIATION_REQUIRED'::public.invitation_status
  ELSE 'LINKED'::public.invitation_status
END
FROM public.user_roles ur
WHERE eu.auth_user_id IS NOT NULL
  AND eu.auth_user_id = ur.user_id;

-- Flag linked profiles that have no role row at all
UPDATE public.enterprise_users
SET invitation_status = 'RECONCILIATION_REQUIRED'
WHERE auth_user_id IS NOT NULL
  AND auth_user_id NOT IN (SELECT user_id FROM public.user_roles);

-- ── 4. Case-Insensitive Unique Expression Index with 11-Point Catalog Audit ───
DO $$
DECLARE
  _idx_record RECORD;
  _col_type TEXT;
  _col_notnull BOOLEAN;
BEGIN
  -- Verify Referenced Column 'email' exists, is type text, and NOT NULL
  SELECT data_type, (is_nullable = 'NO')
  INTO _col_type, _col_notnull
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'enterprise_users'
    AND column_name = 'email';

  IF _col_type <> 'text' OR NOT _col_notnull THEN
    RAISE EXCEPTION 'Catalog Verification Failed: enterprise_users.email must be type text NOT NULL (found: %, notnull: %)', _col_type, _col_notnull
      USING ERRCODE = '42804';
  END IF;

  -- Check if existing index has the name but incompatible structure
  SELECT
    i.indisunique,
    i.indisvalid,
    i.indisready,
    (i.indpred IS NULL) AS is_non_partial,
    i.indnkeyatts,
    i.indnatts,
    pg_get_expr(i.indexprs, i.indrelid) AS expr,
    am.amname,
    c_idx.relkind AS idx_relkind,
    n_idx.nspname AS idx_schema,
    opc.opcname AS opclass_name
  INTO _idx_record
  FROM pg_index i
  JOIN pg_class c_idx ON c_idx.oid = i.indexrelid
  JOIN pg_class c_tbl ON c_tbl.oid = i.indrelid
  JOIN pg_namespace n_idx ON n_idx.oid = c_idx.relnamespace
  JOIN pg_namespace n_tbl ON n_tbl.oid = c_tbl.relnamespace
  JOIN pg_am am ON am.oid = c_idx.relam
  JOIN pg_opclass opc ON opc.oid = i.indclass[0]
  WHERE n_tbl.nspname = 'public'
    AND c_tbl.relname = 'enterprise_users'
    AND c_idx.relname = 'enterprise_users_lower_email_idx';

  IF FOUND THEN
    IF NOT (_idx_record.indisunique AND _idx_record.indisvalid AND _idx_record.indisready AND _idx_record.is_non_partial)
       OR _idx_record.indnkeyatts <> 1
       OR _idx_record.indnatts <> 1
       OR _idx_record.expr <> 'lower(email)'
       OR _idx_record.amname <> 'btree'
       OR _idx_record.idx_relkind <> 'i'
       OR _idx_record.idx_schema <> 'public'
       OR _idx_record.opclass_name <> 'text_ops' THEN
      RAISE EXCEPTION 'Catalog Verification Failed: Existing index enterprise_users_lower_email_idx is structurally incompatible. Drop it manually before applying migration.'
        USING ERRCODE = '42P07';
    END IF;
  ELSE
    EXECUTE 'CREATE UNIQUE INDEX enterprise_users_lower_email_idx ON public.enterprise_users USING btree (lower(email))';
  END IF;

  -- Strict Post-Creation Catalog Audit with Explicit FOUND Check
  SELECT
    i.indisunique,
    i.indisvalid,
    i.indisready,
    (i.indpred IS NULL) AS is_non_partial,
    i.indnkeyatts,
    i.indnatts,
    pg_get_expr(i.indexprs, i.indrelid) AS expr,
    am.amname,
    c_idx.relkind AS idx_relkind,
    n_idx.nspname AS idx_schema,
    opc.opcname AS opclass_name
  INTO _idx_record
  FROM pg_index i
  JOIN pg_class c_idx ON c_idx.oid = i.indexrelid
  JOIN pg_class c_tbl ON c_tbl.oid = i.indrelid
  JOIN pg_namespace n_idx ON n_idx.oid = c_idx.relnamespace
  JOIN pg_namespace n_tbl ON n_tbl.oid = c_tbl.relnamespace
  JOIN pg_am am ON am.oid = c_idx.relam
  JOIN pg_opclass opc ON opc.oid = i.indclass[0]
  WHERE n_tbl.nspname = 'public'
    AND c_tbl.relname = 'enterprise_users'
    AND c_idx.relname = 'enterprise_users_lower_email_idx';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Catalog Audit Failed: enterprise_users_lower_email_idx was not found after creation'
      USING ERRCODE = '42P01';
  END IF;

  IF NOT (_idx_record.indisunique AND _idx_record.indisvalid AND _idx_record.indisready AND _idx_record.is_non_partial)
     OR _idx_record.indnkeyatts <> 1
     OR _idx_record.indnatts <> 1
     OR _idx_record.expr <> 'lower(email)'
     OR _idx_record.amname <> 'btree'
     OR _idx_record.idx_relkind <> 'i'
     OR _idx_record.idx_schema <> 'public'
     OR _idx_record.opclass_name <> 'text_ops' THEN
    RAISE EXCEPTION 'Catalog Audit Failed: enterprise_users_lower_email_idx failed structural validation post-creation'
      USING ERRCODE = '42809';
  END IF;
END $$;

-- ── 5. Statement-Level & Row-Level Concurrency-Safe Last-Super-Admin Protection ──

-- 5A. Statement-Level Lock Acquisition Trigger Function
-- Acquires global_super_admin_lock BEFORE any row is evaluated, fetched, or row-locked
-- by PostgreSQL, completely preventing row-lock / advisory-lock deadlocks and TOCTOU races.
CREATE OR REPLACE FUNCTION public.acquire_global_super_admin_lock_stmt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('global_super_admin_lock'));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS user_roles_protect_admin_stmt ON public.user_roles;
CREATE TRIGGER user_roles_protect_admin_stmt
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.acquire_global_super_admin_lock_stmt();

DROP TRIGGER IF EXISTS enterprise_users_protect_admin_stmt ON public.enterprise_users;
CREATE TRIGGER enterprise_users_protect_admin_stmt
  BEFORE UPDATE OF is_active, invitation_status, auth_user_id OR DELETE ON public.enterprise_users
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.acquire_global_super_admin_lock_stmt();

-- 5B. Row-Level Super Admin Protection on user_roles
CREATE OR REPLACE FUNCTION public.protect_last_super_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  _active_admin_count pg_catalog.int8;
BEGIN
  -- ── 1. INSERT Operation ────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    -- If inserting a super_admin, verify target user has an active, linked enterprise profile
    IF NEW.role = 'super_admin'::public.app_role THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.enterprise_users
        WHERE auth_user_id = NEW.user_id
          AND is_active = true
          AND invitation_status = 'LINKED'::public.invitation_status
      ) THEN
        RAISE EXCEPTION 'Safety Violation: Super Admin role can only be granted to an active, linked enterprise profile'
          USING ERRCODE = '22000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- ── 2. DELETE Operation ────────────────────────────────────────────────────
  IF TG_OP = 'DELETE' THEN
    -- Only deleting a super_admin threatens the invariant
    IF OLD.role = 'super_admin'::public.app_role THEN
      -- Count remaining active super admins strictly excluding the one being deleted
      SELECT pg_catalog.count(*) INTO _active_admin_count
      FROM public.user_roles ur
      JOIN public.enterprise_users eu ON eu.auth_user_id = ur.user_id
      WHERE ur.role = 'super_admin'::public.app_role
        AND eu.is_active = true
        AND eu.invitation_status = 'LINKED'::public.invitation_status
        AND ur.user_id <> OLD.user_id;

      IF _active_admin_count = 0 THEN
        RAISE EXCEPTION 'Safety Violation: At least one active Super Admin must remain in the platform'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  -- ── 3. UPDATE Operation ────────────────────────────────────────────────────
  IF TG_OP = 'UPDATE' THEN
    -- If updating TO super_admin, verify active linked profile invariant
    IF NEW.role = 'super_admin'::public.app_role AND OLD.role <> 'super_admin'::public.app_role THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.enterprise_users
        WHERE auth_user_id = NEW.user_id
          AND is_active = true
          AND invitation_status = 'LINKED'::public.invitation_status
      ) THEN
        RAISE EXCEPTION 'Safety Violation: Super Admin role can only be granted to an active, linked enterprise profile'
          USING ERRCODE = '22000';
      END IF;
    END IF;

    -- Demoting away from super_admin: count remaining active super admins excluding this user
    IF OLD.role = 'super_admin'::public.app_role AND NEW.role <> 'super_admin'::public.app_role THEN
      SELECT pg_catalog.count(*) INTO _active_admin_count
      FROM public.user_roles ur
      JOIN public.enterprise_users eu ON eu.auth_user_id = ur.user_id
      WHERE ur.role = 'super_admin'::public.app_role
        AND eu.is_active = true
        AND eu.invitation_status = 'LINKED'::public.invitation_status
        AND ur.user_id <> OLD.user_id;

      IF _active_admin_count = 0 THEN
        RAISE EXCEPTION 'Safety Violation: Cannot demote the last remaining active Super Admin'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS user_roles_protect_last_admin ON public.user_roles;
CREATE TRIGGER user_roles_protect_last_admin
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_last_super_admin();

-- ── 5C. Row-Level Last-Active-Super-Admin Profile Deactivation Protection ──────
CREATE OR REPLACE FUNCTION public.protect_last_super_admin_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  _is_admin pg_catalog.bool;
  _active_admin_count pg_catalog.int8;
BEGIN
  -- Only operations that demote/remove an active, linked Super Admin profile threaten the operational invariant
  IF (OLD.auth_user_id IS NOT NULL
      AND (OLD.is_active IS NULL OR OLD.is_active = true)
      AND OLD.invitation_status = 'LINKED'::public.invitation_status) THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = OLD.auth_user_id AND role = 'super_admin'::public.app_role
    ) INTO _is_admin;

    IF _is_admin THEN
      -- Check if operation threatens operational status:
      -- DELETE or UPDATE altering is_active away from true, invitation_status away from LINKED, or altering auth_user_id
      IF TG_OP = 'DELETE'
         OR (TG_OP = 'UPDATE' AND (
              NEW.is_active IS DISTINCT FROM true
              OR NEW.invitation_status IS DISTINCT FROM 'LINKED'::public.invitation_status
              OR NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
            )) THEN
        -- Count remaining active, linked Super Admins strictly excluding the profile being altered/deleted
        SELECT pg_catalog.count(*) INTO _active_admin_count
        FROM public.user_roles ur
        JOIN public.enterprise_users eu ON eu.auth_user_id = ur.user_id
        WHERE ur.role = 'super_admin'::public.app_role
          AND eu.is_active = true
          AND eu.invitation_status = 'LINKED'::public.invitation_status
          AND eu.id <> OLD.id;

        IF _active_admin_count = 0 THEN
          RAISE EXCEPTION 'Safety Violation: Cannot deactivate, alter, or delete the last remaining active Super Admin profile'
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enterprise_users_protect_last_admin ON public.enterprise_users;
CREATE TRIGGER enterprise_users_protect_last_admin
  BEFORE UPDATE OF is_active, invitation_status, auth_user_id OR DELETE ON public.enterprise_users
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_last_super_admin_profile();

-- ── 6. Restricted Atomic Role Mutation RPC ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_user_role_atomic(
  _target_user_id pg_catalog.uuid,
  _new_role public.app_role,
  _expected_profile_id pg_catalog.uuid DEFAULT NULL
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  _caller_id pg_catalog.uuid;
  _is_service_role pg_catalog.bool;
  _existing_role public.app_role;
  _profile public.enterprise_users%ROWTYPE;
BEGIN
  -- 1. Identify Caller & Verify Super Admin Authorization
  _caller_id := auth.uid();
  _is_service_role := (coalesce(pg_catalog.current_setting('request.jwt.claim.role', true), '') = 'service_role');

  IF NOT _is_service_role THEN
    IF _caller_id IS NULL OR NOT public.has_role(_caller_id, 'super_admin'::public.app_role) THEN
      RAISE EXCEPTION 'Access Denied: Super Admin role required to mutate user roles'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2. Invariant: Standard RPC cannot grant super_admin
  IF _new_role = 'super_admin'::public.app_role THEN
    RAISE EXCEPTION 'Security Guard: Super Admin role cannot be granted via standard role assignment. Use controlled initial provisioning.'
      USING ERRCODE = '28000';
  END IF;

  -- 3. Acquire Consistent Global & Per-User Transaction Advisory Locks (Level 2 & Level 3)
  -- Following exact platform lock hierarchy: global_super_admin_lock -> user_role:<id> -> row locks
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('global_super_admin_lock'));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('user_role:' || _target_user_id::pg_catalog.text));

  -- 4. Validate Target Profile State & Row-Lock Profile
  SELECT * INTO _profile
  FROM public.enterprise_users
  WHERE auth_user_id = _target_user_id
  FOR UPDATE;

  IF _profile.id IS NULL THEN
    RAISE EXCEPTION 'Target employee profile not found or not linked to Auth User %', _target_user_id
      USING ERRCODE = 'P0002';
  END IF;

  IF _expected_profile_id IS NOT NULL AND _profile.id <> _expected_profile_id THEN
    RAISE EXCEPTION 'Integrity Failure: Target profile ID % does not match expected ID %', _profile.id, _expected_profile_id
      USING ERRCODE = 'P0004';
  END IF;

  IF _profile.is_active = false THEN
    RAISE EXCEPTION 'Administrative Rejection: Cannot assign roles to deactivated personnel'
      USING ERRCODE = '22000';
  END IF;

  IF _profile.invitation_status IS DISTINCT FROM 'LINKED'::public.invitation_status THEN
    RAISE EXCEPTION 'Administrative Rejection: Cannot assign roles to personnel in % status. Profile must be in LINKED status.', _profile.invitation_status
      USING ERRCODE = '22000';
  END IF;

  -- 5. Inspect Existing Role with Row-Lock
  SELECT role INTO _existing_role
  FROM public.user_roles
  WHERE user_id = _target_user_id
  FOR UPDATE;

  -- 6. Role Mutation
  IF _existing_role IS NULL THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (_target_user_id, _new_role);
  ELSIF _existing_role <> _new_role THEN
    -- Protect last super admin invariant if demoting a super_admin
    IF _existing_role = 'super_admin'::public.app_role THEN
      IF (
        SELECT pg_catalog.count(*)
        FROM public.user_roles ur
        JOIN public.enterprise_users eu ON eu.auth_user_id = ur.user_id
        WHERE ur.role = 'super_admin'::public.app_role
          AND eu.is_active = true
          AND eu.invitation_status = 'LINKED'::public.invitation_status
          AND ur.user_id <> _target_user_id
      ) = 0 THEN
        RAISE EXCEPTION 'Safety Guard: Cannot demote the last remaining active Super Admin'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    UPDATE public.user_roles
    SET role = _new_role
    WHERE user_id = _target_user_id;
  END IF;

  -- 7. Synchronize enterprise_users.imported_role
  UPDATE public.enterprise_users
  SET imported_role = _new_role
  WHERE id = _profile.id;

  -- 8. Atomic Audit Log Recording in the Same Transaction
  INSERT INTO public.admin_audit_logs (
    actor_id,
    action,
    entity_type,
    entity_id,
    metadata
  ) VALUES (
    _caller_id,
    'user_role.assigned',
    'user_roles',
    _target_user_id::pg_catalog.text,
    pg_catalog.jsonb_build_object(
      'previous_role', _existing_role,
      'new_role', _new_role,
      'employee_id', _profile.id,
      'email', _profile.email,
      'is_service_role', _is_service_role
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'user_id', _target_user_id,
    'role', _new_role,
    'profile_id', _profile.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_user_role_atomic(pg_catalog.uuid, public.app_role, pg_catalog.uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_user_role_atomic(pg_catalog.uuid, public.app_role, pg_catalog.uuid) TO authenticated, service_role;

-- Revoke direct DML on user_roles from general authenticated users to force all role mutations through the atomic function
REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated, anon;

-- ── 6B. Hardened Database-Level Authorization Boundary (has_role & has_any_role) ──
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _profile_valid BOOLEAN;
BEGIN
  IF _user_id IS NULL OR _role IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Fail closed: Profile must exist, be active, and be in authorized LINKED status
  SELECT EXISTS (
    SELECT 1 FROM public.enterprise_users
    WHERE auth_user_id = _user_id
      AND is_active = true
      AND invitation_status = 'LINKED'::public.invitation_status
  ) INTO _profile_valid;

  IF NOT _profile_valid THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.has_any_role(_user_id UUID, _roles public.app_role[])
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _profile_valid BOOLEAN;
BEGIN
  IF _user_id IS NULL OR _roles IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Fail closed: Profile must exist, be active, and be in authorized LINKED status
  SELECT EXISTS (
    SELECT 1 FROM public.enterprise_users
    WHERE auth_user_id = _user_id
      AND is_active = true
      AND invitation_status = 'LINKED'::public.invitation_status
  ) INTO _profile_valid;

  IF NOT _profile_valid THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = ANY(_roles)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_any_role(UUID, public.app_role[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_any_role(UUID, public.app_role[]) TO authenticated, service_role;

-- ── 7. Hardened Auth Confirmation Trigger Function ──────────────────────────
CREATE OR REPLACE FUNCTION public.handle_verified_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  _profile public.enterprise_users%ROWTYPE;
  _match_count pg_catalog.int4;
  _existing_role public.app_role;
  _intended_role public.app_role;
  _target_email pg_catalog.text;
BEGIN
  _target_email := pg_catalog.lower(pg_catalog.btrim(NEW.email));

  -- 1. Acquire Consistent Advisory Locks
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('global_super_admin_lock'));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('user_role:' || NEW.id::pg_catalog.text));

  -- 2. Branch A: Profile is already linked to this Auth User
  SELECT * INTO _profile
  FROM public.enterprise_users
  WHERE auth_user_id = NEW.id
  FOR UPDATE;

  IF _profile.id IS NOT NULL THEN
    -- Verify email consistency
    IF pg_catalog.lower(pg_catalog.btrim(_profile.email)) <> _target_email THEN
      UPDATE public.enterprise_users
      SET invitation_status = 'RECONCILIATION_REQUIRED'
      WHERE id = _profile.id;

      INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
      VALUES (
        NEW.id, 'auth.linkage_email_mismatch', 'enterprise_users', _profile.id::pg_catalog.text,
        pg_catalog.jsonb_build_object('profile_email', _profile.email, 'auth_email', NEW.email)
      );
      RETURN NEW;
    END IF;

    -- Verify active status
    IF _profile.is_active = false THEN
      UPDATE public.enterprise_users
      SET invitation_status = 'RECONCILIATION_REQUIRED'
      WHERE id = _profile.id;

      INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
      VALUES (
        NEW.id, 'auth.deactivated_user_confirmation_rejected', 'enterprise_users', _profile.id::pg_catalog.text,
        pg_catalog.jsonb_build_object('email', _profile.email)
      );
      RETURN NEW;
    END IF;

    -- Invariant: If profile is in quarantine (RECONCILIATION_REQUIRED), preserve quarantine!
    -- Never auto-promote or auto-assign roles without administrative intervention.
    IF _profile.invitation_status = 'RECONCILIATION_REQUIRED'::public.invitation_status THEN
      INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
      VALUES (
        NEW.id, 'auth.quarantined_user_confirmation_ignored', 'enterprise_users', _profile.id::pg_catalog.text,
        pg_catalog.jsonb_build_object('email', _profile.email, 'reason', 'Profile is in RECONCILIATION_REQUIRED quarantine; admin reconciliation required')
      );
      RETURN NEW;
    END IF;

    -- Inspect existing role
    SELECT role INTO _existing_role
    FROM public.user_roles
    WHERE user_id = NEW.id
    FOR UPDATE;

    _intended_role := coalesce(_profile.imported_role, 'employee'::public.app_role);

    -- Reject super_admin auto-grant
    IF _intended_role = 'super_admin'::public.app_role THEN
      UPDATE public.enterprise_users
      SET invitation_status = 'RECONCILIATION_REQUIRED'
      WHERE id = _profile.id;

      INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
      VALUES (
        NEW.id, 'auth.unauthorized_super_admin_grant_attempt', 'enterprise_users', _profile.id::pg_catalog.text,
        pg_catalog.jsonb_build_object('email', _profile.email)
      );
      RETURN NEW;
    END IF;

    IF _existing_role IS NULL THEN
      -- Role missing on already-linked profile: insert intended role inside protected subtransaction
      BEGIN
        INSERT INTO public.user_roles (user_id, role)
        VALUES (NEW.id, _intended_role);

        UPDATE public.enterprise_users
        SET invitation_status = 'LINKED'
        WHERE id = _profile.id;

        INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
        VALUES (
          NEW.id, 'auth.confirmation_role_established', 'enterprise_users', _profile.id::pg_catalog.text,
          pg_catalog.jsonb_build_object('role', _intended_role, 'mode', 'already_linked_repaired')
        );
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.enterprise_users
        SET invitation_status = 'RECONCILIATION_REQUIRED'
        WHERE id = _profile.id;

        INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
        VALUES (
          NEW.id, 'auth.confirmation_role_failed', 'enterprise_users', _profile.id::pg_catalog.text,
          pg_catalog.jsonb_build_object('error_code', SQLSTATE, 'error_message', SQLERRM, 'role', _intended_role)
        );
      END;
    ELSIF _existing_role <> _intended_role THEN
      -- Conflicting role: quarantine
      UPDATE public.enterprise_users
      SET invitation_status = 'RECONCILIATION_REQUIRED'
      WHERE id = _profile.id;

      INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
      VALUES (
        NEW.id, 'auth.role_profile_mismatch', 'enterprise_users', _profile.id::pg_catalog.text,
        pg_catalog.jsonb_build_object('existing_role', _existing_role, 'intended_role', _intended_role)
      );
    ELSE
      -- Role matches: advance status to LINKED
      UPDATE public.enterprise_users
      SET invitation_status = 'LINKED'
      WHERE id = _profile.id;
    END IF;

    RETURN NEW;
  END IF;

  -- 3. Branch B: Profile is unlinked (auth_user_id IS NULL)
  SELECT pg_catalog.count(*) INTO _match_count
  FROM public.enterprise_users
  WHERE pg_catalog.lower(email) = _target_email AND auth_user_id IS NULL;

  IF _match_count = 0 THEN
    -- Uninvited signup: zero roles, zero profiles created. Strict corporate boundary.
    INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      NEW.id, 'auth.uninvited_signup_quarantined', 'auth.users', NEW.id::pg_catalog.text,
      pg_catalog.jsonb_build_object('email', NEW.email)
    );
    RETURN NEW;
  ELSIF _match_count > 1 THEN
    -- Ambiguous duplicates: leave unlinked and flag for admin resolution
    INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      NEW.id, 'auth.ambiguous_duplicate_profiles', 'auth.users', NEW.id::pg_catalog.text,
      pg_catalog.jsonb_build_object('email', NEW.email, 'duplicate_count', _match_count)
    );
    RETURN NEW;
  END IF;

  -- Exactly 1 matching unlinked profile: lock and validate
  SELECT * INTO _profile
  FROM public.enterprise_users
  WHERE pg_catalog.lower(email) = _target_email AND auth_user_id IS NULL
  FOR UPDATE;

  -- Inactive check
  IF _profile.is_active = false THEN
    UPDATE public.enterprise_users
    SET invitation_status = 'RECONCILIATION_REQUIRED'
    WHERE id = _profile.id;

    INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      NEW.id, 'auth.deactivated_user_confirmation_rejected', 'enterprise_users', _profile.id::pg_catalog.text,
      pg_catalog.jsonb_build_object('email', _profile.email)
    );
    RETURN NEW;
  END IF;

  -- Strict NULL-safe invitation status check: ONLY profiles in DISPATCHED status are authorized for onboarding.
  -- STAGED, DISPATCH_PENDING, NULL, or RECONCILIATION_REQUIRED must NEVER receive an automated role.
  IF _profile.invitation_status IS DISTINCT FROM 'DISPATCHED'::public.invitation_status THEN
    -- Pre-dispatch claim anomaly or incomplete invitation flow: quarantine with zero roles
    UPDATE public.enterprise_users
    SET auth_user_id = NEW.id,
        invitation_status = 'RECONCILIATION_REQUIRED'
    WHERE id = _profile.id;

    INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      NEW.id, 'auth.unauthorized_status_claim_quarantined', 'enterprise_users', _profile.id::pg_catalog.text,
      pg_catalog.jsonb_build_object(
        'email', _profile.email,
        'found_status', _profile.invitation_status,
        'reason', 'Auth confirmed but profile was not in DISPATCHED status'
      )
    );
    RETURN NEW;
  END IF;

  -- Reconcile role
  _intended_role := coalesce(_profile.imported_role, 'employee'::public.app_role);

  IF _intended_role = 'super_admin'::public.app_role THEN
    UPDATE public.enterprise_users
    SET auth_user_id = NEW.id,
        invitation_status = 'RECONCILIATION_REQUIRED'
    WHERE id = _profile.id;

    INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      NEW.id, 'auth.unauthorized_super_admin_grant_attempt', 'enterprise_users', _profile.id::pg_catalog.text,
      pg_catalog.jsonb_build_object('email', _profile.email)
    );
    RETURN NEW;
  END IF;

  -- Inspect existing role on target Auth identity before attempting insert
  SELECT role INTO _existing_role
  FROM public.user_roles
  WHERE user_id = NEW.id;

  IF _existing_role IS NOT NULL THEN
    IF _existing_role <> _intended_role THEN
      -- Existing role conflict: quarantine profile, NEVER overwrite existing role
      UPDATE public.enterprise_users
      SET auth_user_id = NEW.id,
          invitation_status = 'RECONCILIATION_REQUIRED'
      WHERE id = _profile.id;

      INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
      VALUES (
        NEW.id, 'auth.existing_role_conflict_quarantined', 'enterprise_users', _profile.id::pg_catalog.text,
        pg_catalog.jsonb_build_object('existing_role', _existing_role, 'intended_role', _intended_role)
      );
      RETURN NEW;
    ELSE
      -- Existing role matches: advance profile status to LINKED
      UPDATE public.enterprise_users
      SET auth_user_id = NEW.id,
          invitation_status = 'LINKED'
      WHERE id = _profile.id;
      RETURN NEW;
    END IF;
  END IF;

  -- Link auth_user_id and advance to LINKED
  UPDATE public.enterprise_users
  SET auth_user_id = NEW.id,
      invitation_status = 'LINKED'
  WHERE id = _profile.id;

  -- Insert role inside protected subtransaction
  BEGIN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, _intended_role);

    INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      NEW.id, 'auth.confirmation_role_established', 'enterprise_users', _profile.id::pg_catalog.text,
      pg_catalog.jsonb_build_object('role', _intended_role, 'employee_id', _profile.id)
    );
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.enterprise_users
    SET invitation_status = 'RECONCILIATION_REQUIRED'
    WHERE id = _profile.id;

    INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      NEW.id, 'auth.confirmation_role_failed', 'enterprise_users', _profile.id::pg_catalog.text,
      pg_catalog.jsonb_build_object('error_code', SQLSTATE, 'error_message', SQLERRM, 'role', _intended_role)
    );
  END;

  RETURN NEW;
END;
$$;

-- ── 8. Dedicated PostgreSQL Triggers on auth.users ───────────────────────────
DROP TRIGGER IF EXISTS on_auth_user_verified ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_created_confirmed ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users;

CREATE TRIGGER on_auth_user_created_confirmed
  AFTER INSERT ON auth.users
  FOR EACH ROW
  WHEN (NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.handle_verified_auth_user();

CREATE TRIGGER on_auth_user_email_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.handle_verified_auth_user();
