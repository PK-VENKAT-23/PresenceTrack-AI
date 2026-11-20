-- ==============================================================================
-- PresenceTrack AI — Migration 0005: Dedicated DPO Role Definition & Scoped RBAC
-- Adds 'dpo' to app_role enum and configures scoped RLS policies for Grievances
-- ==============================================================================

-- 1. Safely add 'dpo' to the app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'dpo';

-- 2. Update RLS policies on employee_grievances to allow 'dpo' alongside 'super_admin'
DO $$ BEGIN
  DROP POLICY IF EXISTS "Grievances employee or admin select" ON public.employee_grievances;
  DROP POLICY IF EXISTS "Grievances employee or dpo select" ON public.employee_grievances;
  CREATE POLICY "Grievances employee or dpo select" ON public.employee_grievances
    FOR SELECT TO authenticated
    USING (
      employee_id = public.current_enterprise_user_id()
      OR public.has_any_role(auth.uid(), ARRAY['super_admin', 'dpo']::public.app_role[])
    );
EXCEPTION WHEN undefined_object THEN null; END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "Grievances dpo update" ON public.employee_grievances;
  CREATE POLICY "Grievances dpo update" ON public.employee_grievances
    FOR UPDATE TO authenticated
    USING (public.has_any_role(auth.uid(), ARRAY['super_admin', 'dpo']::public.app_role[]))
    WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin', 'dpo']::public.app_role[]));
EXCEPTION WHEN undefined_object THEN null; END $$;

-- 3. Update RLS policies on grievance_messages to include 'dpo'
DO $$ BEGIN
  DROP POLICY IF EXISTS "Messages employee or dpo select" ON public.grievance_messages;
  CREATE POLICY "Messages employee or dpo select" ON public.grievance_messages
    FOR SELECT TO authenticated
    USING (
      (
        is_internal_note = false
        AND grievance_id IN (
          SELECT id FROM public.employee_grievances
          WHERE employee_id = public.current_enterprise_user_id()
        )
      )
      OR public.has_any_role(auth.uid(), ARRAY['super_admin', 'dpo']::public.app_role[])
    );
EXCEPTION WHEN undefined_object THEN null; END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "Messages employee or dpo insert" ON public.grievance_messages;
  CREATE POLICY "Messages employee or dpo insert" ON public.grievance_messages
    FOR INSERT TO authenticated
    WITH CHECK (
      (
        is_internal_note = false
        AND grievance_id IN (
          SELECT id FROM public.employee_grievances
          WHERE employee_id = public.current_enterprise_user_id()
        )
      )
      OR public.has_any_role(auth.uid(), ARRAY['super_admin', 'dpo']::public.app_role[])
    );
EXCEPTION WHEN undefined_object THEN null; END $$;

-- 4. Update RLS policies on grievance_attachments to include 'dpo'
DO $$ BEGIN
  DROP POLICY IF EXISTS "Attachments employee or dpo select" ON public.grievance_attachments;
  CREATE POLICY "Attachments employee or dpo select" ON public.grievance_attachments
    FOR SELECT TO authenticated
    USING (
      (
        is_internal = false
        AND grievance_id IN (
          SELECT id FROM public.employee_grievances
          WHERE employee_id = public.current_enterprise_user_id()
        )
      )
      OR public.has_any_role(auth.uid(), ARRAY['super_admin', 'dpo']::public.app_role[])
    );
EXCEPTION WHEN undefined_object THEN null; END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "Attachments employee or dpo insert" ON public.grievance_attachments;
  CREATE POLICY "Attachments employee or dpo insert" ON public.grievance_attachments
    FOR INSERT TO authenticated
    WITH CHECK (
      (
        is_internal = false
        AND grievance_id IN (
          SELECT id FROM public.employee_grievances
          WHERE employee_id = public.current_enterprise_user_id()
        )
      )
      OR public.has_any_role(auth.uid(), ARRAY['super_admin', 'dpo']::public.app_role[])
    );
EXCEPTION WHEN undefined_object THEN null; END $$;

-- 5. Enterprise users: allow DPO to read employee profiles (needed for complainant details in grievance review)
DO $$ BEGIN
  DROP POLICY IF EXISTS "Self or staff read profiles" ON public.enterprise_users;
  CREATE POLICY "Self or staff read profiles" ON public.enterprise_users
    FOR SELECT TO authenticated
    USING (
      auth_user_id = auth.uid()
      OR public.has_any_role(auth.uid(), ARRAY['hr_ops','security','super_admin','dpo']::public.app_role[])
    );
EXCEPTION WHEN undefined_object THEN null; END $$;

-- 6. Storage bucket private access policies for grievance-evidence
INSERT INTO storage.buckets (id, name, public)
VALUES ('grievance-evidence', 'grievance-evidence', false)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  CREATE POLICY "Evidence private select authorized" ON storage.objects
    FOR SELECT TO authenticated
    USING (
      bucket_id = 'grievance-evidence'
      AND (
        public.has_any_role(auth.uid(), ARRAY['super_admin', 'dpo']::public.app_role[])
        OR auth.uid() IN (
          SELECT uploaded_by FROM public.grievance_attachments WHERE file_url = name AND is_internal = false
        )
      )
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY "Evidence private insert authorized" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
      bucket_id = 'grievance-evidence'
      AND (
        public.has_any_role(auth.uid(), ARRAY['super_admin', 'dpo']::public.app_role[])
        OR auth.uid() IS NOT NULL
      )
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;
