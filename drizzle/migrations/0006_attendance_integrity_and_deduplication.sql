-- ==============================================================================
-- PresenceTrack AI — Migration 0006: Attendance Integrity & Deduplication
-- Prevents duplicate passive_transits and provides atomic manual punch RPC
-- Target Project: ljmrmeivrjmhuoyzrqrz (LOCAL ONLY - DO NOT APPLY REMOTELY)
-- ==============================================================================

-- ── 1. BEFORE INSERT Trigger to cancel duplicate passive_transits ─────────────
-- In PostgreSQL, an AFTER trigger cannot cancel an insertion by returning NEW.
-- A BEFORE trigger returning NULL cancels the insertion cleanly before storage.
-- Under PostgreSQL READ COMMITTED isolation, simultaneous concurrent inserts
-- might both pass an EXISTS check unless serialized.
-- pg_advisory_xact_lock serializes all insertions for the same employee across
-- ALL insertion paths (ESP32 boundary transit, manual punch RPC, fallback insert, raw SQL).
CREATE OR REPLACE FUNCTION public.prevent_duplicate_passive_transit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  -- 1. Serialize all concurrent insertions for the same employee across ALL insertion paths.
  -- pg_advisory_xact_lock acquires an exclusive transaction-scoped lock on a 64-bit hash.
  -- Any simultaneous transaction for the same employee will wait until this transaction commits.
  PERFORM pg_advisory_xact_lock(hashtext('transit_employee:' || NEW.user_id::text));

  -- 2. Once the lock is acquired (and any preceding transaction committed),
  -- the SELECT below sees all committed rows in READ COMMITTED mode.
  IF EXISTS (
    SELECT 1 FROM public.passive_transits
    WHERE user_id = NEW.user_id
      AND direction = NEW.direction
      AND zone_to = NEW.zone_to
      AND abs(extract(epoch FROM (NEW."timestamp" - "timestamp"))) < 3
  ) THEN
    -- In a BEFORE INSERT row trigger, returning NULL prevents the row from being inserted
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS passive_transits_dedup_before ON public.passive_transits;
CREATE TRIGGER passive_transits_dedup_before
  BEFORE INSERT ON public.passive_transits
  FOR EACH ROW EXECUTE FUNCTION public.prevent_duplicate_passive_transit();

-- ── 2. Concurrency-Safe Atomic Manual Punch RPC ──────────────────────────────
-- Acquires transaction advisory lock and row lock to serialize simultaneous punches
CREATE OR REPLACE FUNCTION public.record_manual_punch_atomic(
  _employee_id UUID,
  _direction public.transit_direction,
  _notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  _profile public.enterprise_users%ROWTYPE;
  _zone_from public.zone_type;
  _zone_to public.zone_type;
  _iso_time TIMESTAMPTZ := now();
  _vector_hash TEXT;
  _transit_id UUID;
BEGIN
  -- 1. Acquire Per-Employee Transaction Advisory Lock to serialize concurrent requests.
  -- Matches the advisory lock in prevent_duplicate_passive_transit() (re-entrant within same xact).
  PERFORM pg_advisory_xact_lock(hashtext('transit_employee:' || _employee_id::text));

  -- 2. Lock and retrieve current profile row (SELECT FOR UPDATE)
  SELECT * INTO _profile
  FROM public.enterprise_users
  WHERE id = _employee_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No enterprise profile found for employee id %', _employee_id
      USING ERRCODE = 'P0002';
  END IF;

  IF _profile.is_active = FALSE THEN
    RAISE EXCEPTION 'Inactive employee account cannot record attendance'
      USING ERRCODE = '28000';
  END IF;

  -- 3. Concurrency-safe state transition validation
  IF _direction = 'ZONE_ENTER' THEN
    IF _profile.current_zone = 'WORKSPACE_FLOOR' THEN
      RAISE EXCEPTION 'Already clocked in. You are already in the workspace.'
        USING ERRCODE = '22000';
    END IF;
    _zone_from := 'CORRIDOR_TRANSIT';
    _zone_to := 'WORKSPACE_FLOOR';
  ELSIF _direction = 'ZONE_EXIT' THEN
    IF _profile.current_zone <> 'WORKSPACE_FLOOR' THEN
      RAISE EXCEPTION 'Cannot clock out: no active clock-in session found.'
        USING ERRCODE = '22000';
    END IF;
    _zone_from := 'WORKSPACE_FLOOR';
    _zone_to := 'CORRIDOR_TRANSIT';
  ELSE
    RAISE EXCEPTION 'Invalid transit direction: %', _direction
      USING ERRCODE = '22023';
  END IF;

  -- 4. Check for duplicate transit within 3 seconds
  IF EXISTS (
    SELECT 1 FROM public.passive_transits
    WHERE user_id = _employee_id
      AND direction = _direction
      AND zone_to = _zone_to
      AND abs(extract(epoch FROM (_iso_time - "timestamp"))) < 3
  ) THEN
    RAISE EXCEPTION 'Duplicate punch request detected within debounce window.'
      USING ERRCODE = '23505';
  END IF;

  -- 5. Insert canonical transit record
  -- The apply_transit() AFTER INSERT trigger automatically executes as the
  -- SINGLE AUTHORITATIVE WRITER:
  --   a) Evaluates intervals chronologically
  --   b) Upserts attendance_records
  --   c) Upserts employee_daily_dwell
  --   d) Updates enterprise_users.current_zone
  _vector_hash := encode(digest('manual:' || _employee_id::text || ':' || _iso_time::text, 'sha256'), 'hex');

  INSERT INTO public.passive_transits (
    user_id, camera_id, zone_from, zone_to, direction,
    cosine_score, dram_scrub_ms, vector_hash, "timestamp"
  ) VALUES (
    _employee_id, NULL, _zone_from, _zone_to, _direction,
    1.0000, 0, _vector_hash, _iso_time
  )
  RETURNING id INTO _transit_id;

  -- 6. Tag attendance_records as manual entry (does not alter calculated hours/status)
  UPDATE public.attendance_records
  SET is_manual_entry = TRUE,
      updated_at = _iso_time
  WHERE employee_id = _employee_id
    AND attendance_date = (_iso_time AT TIME ZONE 'Asia/Kolkata')::date;

  RETURN jsonb_build_object(
    'success', true,
    'transit_id', _transit_id,
    'direction', _direction,
    'current_zone', _zone_to,
    'is_in_workspace', (_zone_to = 'WORKSPACE_FLOOR'),
    'timestamp', _iso_time
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_manual_punch_atomic(UUID, public.transit_direction, TEXT) TO authenticated, service_role;
