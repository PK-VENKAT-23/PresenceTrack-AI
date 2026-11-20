-- ============================================================================
-- Migration: 0003_operational_security_fixes
-- Fixes:
--   1. Restrict admin_audit_logs INSERT policy (Drop permissive policy, install strict role check)
--   2. departments table write privileges and granular per-operation RLS policies
--   3. Case-insensitive recursive JSONB PII sanitization function
--   4. dpdp_backup_tombstones table (ON DELETE RESTRICT, keyed hash identifiers)
--   5. approve_erasure_request() full scope validation, verification & tombstones
--   6. Full apply_transit() parity with authoritative EXCLUDED conflict resolution
-- ============================================================================

-- ── 1. Restrict admin_audit_logs Insert Policy ──────────────────────────────
DROP POLICY IF EXISTS "Admins insert audit logs" ON public.admin_audit_logs;

CREATE POLICY "Admins insert audit logs" ON public.admin_audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = actor_id
    AND public.has_any_role(auth.uid(), ARRAY['super_admin', 'security']::public.app_role[])
  );

-- ── 2. Departments Write Grants & Granular RLS Policies ─────────────────────
GRANT INSERT, UPDATE, DELETE ON public.departments TO authenticated;

DROP POLICY IF EXISTS "Admins manage departments" ON public.departments;

CREATE POLICY "Admins insert departments" ON public.departments
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'::public.app_role));

CREATE POLICY "Admins update departments" ON public.departments
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'::public.app_role));

CREATE POLICY "Admins delete departments" ON public.departments
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'::public.app_role));

-- ── 3. Case-Insensitive Recursive JSONB PII Sanitization Function ────────────
CREATE OR REPLACE FUNCTION public.sanitize_jsonb_pii(
  _data JSONB,
  _keys_to_remove TEXT[] DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  _effective_keys TEXT[];
  _key TEXT;
  _result JSONB := '{}'::jsonb;
  _elem JSONB;
  _item JSONB;
BEGIN
  IF _data IS NULL OR jsonb_typeof(_data) = 'null' THEN
    RETURN 'null'::jsonb;
  END IF;

  IF _keys_to_remove IS NULL OR array_length(_keys_to_remove, 1) IS NULL THEN
    _effective_keys := ARRAY['email', 'name', 'phone', 'badge_id', 'ip_address', 'client_ip', 'user_agent', 'device_id'];
  ELSE
    SELECT array_agg(lower(k)) INTO _effective_keys FROM unnest(_keys_to_remove) k;
  END IF;

  IF jsonb_typeof(_data) = 'object' THEN
    FOR _key, _elem IN SELECT * FROM jsonb_each(_data) LOOP
      IF NOT (lower(_key) = ANY(_effective_keys)) THEN
        _result := _result || jsonb_build_object(_key, public.sanitize_jsonb_pii(_elem, _effective_keys));
      END IF;
    END LOOP;
    RETURN _result;
  ELSIF jsonb_typeof(_data) = 'array' THEN
    _result := '[]'::jsonb;
    FOR _item IN SELECT * FROM jsonb_array_elements(_data) LOOP
      _result := _result || jsonb_build_array(public.sanitize_jsonb_pii(_item, _effective_keys));
    END LOOP;
    RETURN _result;
  ELSE
    RETURN _data;
  END IF;
END;
$$;

-- ── 4. DPDP Backup Tombstones Table (Durable Retention) ─────────────────────
CREATE TABLE IF NOT EXISTS public.dpdp_backup_tombstones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.dpo_erasure_requests(id) ON DELETE RESTRICT,
  subject_enterprise_id UUID NOT NULL,
  subject_auth_id UUID,
  subject_identifier_hashes TEXT[] NOT NULL DEFAULT '{}',
  erasure_scope JSONB NOT NULL,
  tombstone_timestamp TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  merkle_block_height BIGINT REFERENCES public.merkle_audit_blocks(block_height),
  status TEXT NOT NULL DEFAULT 'ACTIVE_TOMBSTONE'
);
GRANT SELECT ON public.dpdp_backup_tombstones TO authenticated;
GRANT ALL ON public.dpdp_backup_tombstones TO service_role;
ALTER TABLE public.dpdp_backup_tombstones ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Admins manage tombstones" ON public.dpdp_backup_tombstones
    FOR ALL TO authenticated
    USING (public.has_role(auth.uid(), 'super_admin'::public.app_role))
    WITH CHECK (public.has_role(auth.uid(), 'super_admin'::public.app_role));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 5. Hardened approve_erasure_request Function ────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_erasure_request(_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _req public.dpo_erasure_requests%ROWTYPE;
  _auth_id UUID;
  _subject_profile public.enterprise_users%ROWTYPE;
  _raw_scope JSONB;
  _elem JSONB;
  _valid_scopes TEXT[] := ARRAY['biometric_embeddings', 'transit_history', 'dwell_records', 'audit_ledger', 'compliant_backup'];
  _normalized_scopes TEXT[] := '{}';
  _scope_text TEXT;
  _has_backup BOOLEAN := FALSE;
  _tombstone_id UUID;
  _id_hashes TEXT[];
  _salt_secret TEXT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'super_admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden: Only super_admin may approve erasure requests' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _req FROM public.dpo_erasure_requests WHERE id = _request_id;
  IF _req.id IS NULL THEN
    RAISE EXCEPTION 'Request not found' USING ERRCODE = 'P0002';
  END IF;

  -- 1. Strict Scope Validation & Deduplication (SQLSTATE 22023)
  _raw_scope := _req.erasure_scope;
  IF _raw_scope IS NULL OR jsonb_typeof(_raw_scope) <> 'array' OR jsonb_array_length(_raw_scope) = 0 THEN
    RAISE EXCEPTION 'Invalid erasure scope: must be a non-empty JSON array' USING ERRCODE = '22023';
  END IF;

  FOR _elem IN SELECT * FROM jsonb_array_elements(_raw_scope) LOOP
    IF jsonb_typeof(_elem) <> 'string' THEN
      RAISE EXCEPTION 'Invalid erasure scope element: all elements must be strings' USING ERRCODE = '22023';
    END IF;
    _scope_text := _elem #>> '{}';
    IF NOT (_scope_text = ANY(_valid_scopes)) THEN
      RAISE EXCEPTION 'Invalid erasure scope value: %', _scope_text USING ERRCODE = '22023';
    END IF;
    IF NOT (_scope_text = ANY(_normalized_scopes)) THEN
      _normalized_scopes := array_append(_normalized_scopes, _scope_text);
    END IF;
  END LOOP;

  -- 2. Verify Subject Identity Resolution
  IF _req.user_id IS NULL THEN
    RAISE EXCEPTION 'Subject profile missing on erasure request; operational scopes cannot be processed' USING ERRCODE = 'P0009';
  END IF;

  SELECT * INTO _subject_profile FROM public.enterprise_users WHERE id = _req.user_id;
  IF _subject_profile.id IS NULL THEN
    RAISE EXCEPTION 'Subject profile % not found in enterprise_users', _req.user_id USING ERRCODE = 'P0009';
  END IF;
  _auth_id := _subject_profile.auth_user_id;

  -- 3. Execute Operational Scopes with Independent Verification
  IF 'biometric_embeddings' = ANY(_normalized_scopes) THEN
    UPDATE public.enterprise_users
    SET enrolled_embedding = NULL, is_active = false
    WHERE id = _req.user_id;
    IF EXISTS (SELECT 1 FROM public.enterprise_users WHERE id = _req.user_id AND enrolled_embedding IS NOT NULL) THEN
      RAISE EXCEPTION 'Verification Failure: Biometric embedding purge failed' USING ERRCODE = 'P0008';
    END IF;
  END IF;

  IF 'transit_history' = ANY(_normalized_scopes) THEN
    DELETE FROM public.passive_transits WHERE user_id = _req.user_id;
    IF EXISTS (SELECT 1 FROM public.passive_transits WHERE user_id = _req.user_id) THEN
      RAISE EXCEPTION 'Verification Failure: Passive transits purge failed' USING ERRCODE = 'P0008';
    END IF;
  END IF;

  IF 'dwell_records' = ANY(_normalized_scopes) THEN
    DELETE FROM public.employee_daily_dwell WHERE user_id = _req.user_id;
    DELETE FROM public.attendance_records WHERE employee_id = _req.user_id;
    IF EXISTS (SELECT 1 FROM public.employee_daily_dwell WHERE user_id = _req.user_id)
       OR EXISTS (SELECT 1 FROM public.attendance_records WHERE employee_id = _req.user_id) THEN
      RAISE EXCEPTION 'Verification Failure: Dwell/attendance purge failed' USING ERRCODE = 'P0008';
    END IF;
  END IF;

  -- 4. Execute Audit Ledger Pseudonymization with Verification
  IF 'audit_ledger' = ANY(_normalized_scopes) THEN
    UPDATE public.admin_audit_logs
    SET actor_id = NULL,
        entity_id = CASE WHEN entity_type = 'enterprise_users' AND entity_id = _req.user_id::text THEN '[REDACTED_DPDP]' ELSE entity_id END,
        metadata = public.sanitize_jsonb_pii(metadata) || jsonb_build_object('dpdp_pseudonymized', true, 'redacted_at', clock_timestamp())
    WHERE (_auth_id IS NOT NULL AND actor_id = _auth_id)
       OR (entity_type = 'enterprise_users' AND entity_id = _req.user_id::text);

    -- Actual Audit Ledger Verification Query
    IF EXISTS (
      SELECT 1 FROM public.admin_audit_logs
      WHERE (_auth_id IS NOT NULL AND actor_id = _auth_id)
         OR (entity_type = 'enterprise_users' AND entity_id = _req.user_id::text)
    ) THEN
      RAISE EXCEPTION 'Verification Failure: Audit ledger pseudonymization incomplete' USING ERRCODE = 'P0008';
    END IF;
  END IF;

  -- 5. Execute Backup Tombstone Creation with Verification
  IF 'compliant_backup' = ANY(_normalized_scopes) THEN
    _has_backup := TRUE;

    -- Retrieve enclave salt secret from Supabase Vault (fail closed if unavailable)
    BEGIN
      SELECT decrypted_secret INTO _salt_secret
      FROM vault.decrypted_secrets
      WHERE name = 'enclave_salt_secret'
      LIMIT 1;
    EXCEPTION WHEN undefined_table OR invalid_schema_name THEN
      RAISE EXCEPTION 'Configuration Error: Supabase Vault is not initialized; cannot derive tombstone hashes'
        USING ERRCODE = '55000';
    END;

    IF _salt_secret IS NULL OR pg_catalog.length(pg_catalog.btrim(_salt_secret)) = 0 THEN
      RAISE EXCEPTION 'Configuration Error: Required secret "enclave_salt_secret" is missing from vault.decrypted_secrets'
        USING ERRCODE = '55000';
    END IF;

    -- Keyed hash derivation using subject profile identity with vault salt
    _id_hashes := ARRAY[
      encode(sha256(convert_to(_subject_profile.email || ':' || _salt_secret, 'UTF8')), 'hex'),
      encode(sha256(convert_to(_subject_profile.badge_id || ':' || _salt_secret, 'UTF8')), 'hex'),
      encode(sha256(convert_to(_subject_profile.name || ':' || _salt_secret, 'UTF8')), 'hex')
    ];

    INSERT INTO public.dpdp_backup_tombstones (
      request_id, subject_enterprise_id, subject_auth_id,
      subject_identifier_hashes, erasure_scope, tombstone_timestamp, status
    ) VALUES (
      _req.id, _req.user_id, _auth_id,
      _id_hashes, to_jsonb(_normalized_scopes), clock_timestamp(), 'ACTIVE_TOMBSTONE'
    ) RETURNING id INTO _tombstone_id;

    IF _tombstone_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.dpdp_backup_tombstones WHERE id = _tombstone_id) THEN
      RAISE EXCEPTION 'Verification Failure: Backup tombstone registration failed' USING ERRCODE = 'P0008';
    END IF;
  END IF;

  -- 6. Assign Terminal Status Based on Processed & Verified Scopes
  UPDATE public.dpo_erasure_requests
  SET status = CASE WHEN _has_backup THEN 'PURGED_TOMBSTONE_REGISTERED' ELSE 'VERIFIED_PURGED' END,
      completed_at = clock_timestamp()
  WHERE id = _request_id;
END;
$$;

-- ── 6. Full apply_transit() with Complete Business Rule Parity ───────────────
CREATE OR REPLACE FUNCTION public.apply_transit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _day DATE := (NEW."timestamp" AT TIME ZONE 'Asia/Kolkata')::date;
  _first_in TIMESTAMPTZ := NULL;
  _last_out TIMESTAMPTZ := NULL;
  _cur_state TEXT := 'OUT';
  _state_start TIMESTAMPTZ := NULL;
  _work_min INT := 0;
  _break_min INT := 0;
  _dur INT := 0;
  _t RECORD;
  _continuous_work INT := 0;
BEGIN
  -- Rule 1: Debounce duplicate transits (exact match on user, direction, zone within 3s)
  IF EXISTS (
    SELECT 1 FROM public.passive_transits
    WHERE user_id = NEW.user_id
      AND id <> NEW.id
      AND direction = NEW.direction
      AND zone_to = NEW.zone_to
      AND abs(extract(epoch FROM (NEW."timestamp" - "timestamp"))) < 3
  ) THEN
    RETURN NEW;
  END IF;

  -- Rule 2: Chronological evaluation over all transits for this employee on this IST date
  FOR _t IN (
    SELECT "timestamp", direction, zone_from, zone_to
    FROM public.passive_transits
    WHERE user_id = NEW.user_id
      AND (("timestamp" AT TIME ZONE 'Asia/Kolkata')::date) = _day
    ORDER BY "timestamp" ASC
  ) LOOP
    IF _first_in IS NULL AND _t.direction = 'ZONE_ENTER' AND _t.zone_to = 'WORKSPACE_FLOOR' THEN
      _first_in := _t."timestamp";
    END IF;

    IF _t.direction = 'ZONE_EXIT' OR _t.zone_to = 'CORRIDOR_TRANSIT' THEN
      _last_out := _t."timestamp";
    END IF;

    -- Rule 3: Interval State Machine
    IF _state_start IS NOT NULL AND _t."timestamp" > _state_start THEN
      _dur := greatest(0, floor(extract(epoch FROM (_t."timestamp" - _state_start)) / 60)::int);
      IF _cur_state = 'WORKSPACE' THEN
        _work_min := _work_min + _dur;
        _continuous_work := _continuous_work + _dur;
      ELSIF _cur_state = 'BREAK' THEN
        _break_min := _break_min + _dur;
        _continuous_work := 0;
      ELSE
        _continuous_work := 0;
      END IF;
    END IF;

    IF _t.zone_to = 'WORKSPACE_FLOOR' THEN
      _cur_state := 'WORKSPACE';
      _state_start := _t."timestamp";
    ELSIF _t.zone_to IN ('CAFETERIA_LOUNGE', 'OUTDOOR_TERRACE') THEN
      _cur_state := 'BREAK';
      _state_start := _t."timestamp";
    ELSE
      _cur_state := 'OUT';
      _state_start := _t."timestamp";
    END IF;
  END LOOP;

  -- Rule 4 & 5: Upsert Canonical Attendance Record with Authoritative EXCLUDED Resolution
  INSERT INTO public.attendance_records (
    employee_id, attendance_date, first_in, last_out,
    total_work_minutes, total_break_minutes, status, missed_exit, updated_at
  ) VALUES (
    NEW.user_id, _day, _first_in, _last_out,
    _work_min, _break_min,
    CASE WHEN _work_min >= 240 THEN 'PRESENT'::public.attendance_status
         WHEN _work_min > 0 THEN 'HALF_DAY'::public.attendance_status
         ELSE 'PRESENT'::public.attendance_status END,
    false, now()
  )
  ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
    first_in = EXCLUDED.first_in,
    last_out = EXCLUDED.last_out,
    total_work_minutes = EXCLUDED.total_work_minutes,
    total_break_minutes = EXCLUDED.total_break_minutes,
    status = EXCLUDED.status,
    updated_at = now();

  -- Rule 6: Maintain Legacy employee_daily_dwell for OSH Compliance
  INSERT INTO public.employee_daily_dwell (
    user_id, record_date, workspace_minutes, break_minutes,
    continuous_workspace_minutes, last_transition_time, osh_compliance_flag
  ) VALUES (
    NEW.user_id, _day, _work_min, _break_min,
    _continuous_work, NEW."timestamp", _continuous_work <= 270
  )
  ON CONFLICT (user_id, record_date) DO UPDATE SET
    workspace_minutes = EXCLUDED.workspace_minutes,
    break_minutes = EXCLUDED.break_minutes,
    continuous_workspace_minutes = EXCLUDED.continuous_workspace_minutes,
    last_transition_time = EXCLUDED.last_transition_time,
    osh_compliance_flag = public.employee_daily_dwell.osh_compliance_flag AND (EXCLUDED.continuous_workspace_minutes <= 270);

  -- Rule 7: Maintain Live Presence Zone on enterprise_users
  UPDATE public.enterprise_users
  SET current_zone = NEW.zone_to,
      is_in_workspace = (NEW.zone_to = 'WORKSPACE_FLOOR')
  WHERE id = NEW.user_id;

  RETURN NEW;
END;
$$;
