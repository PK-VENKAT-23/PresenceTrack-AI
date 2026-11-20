-- ==============================================================================
-- PresenceTrack AI — Migration 0004: Employee Grievance & DPO System
-- Secure, end-to-end Employee Grievance Management and Statutory DPO Workflow
-- ==============================================================================

-- 1. Employee Grievances Table
CREATE TABLE IF NOT EXISTS public.employee_grievances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_number TEXT NOT NULL UNIQUE,
  employee_id UUID NOT NULL REFERENCES public.enterprise_users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
      'Workplace Issue',
      'Harassment or Misconduct',
      'Privacy or Data Protection',
      'Biometric Data Concern',
      'Attendance Dispute',
      'Other'
    )
  ),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (
    status IN (
      'SUBMITTED',
      'UNDER_REVIEW',
      'ADDITIONAL_INFORMATION_REQUIRED',
      'RESPONSE_SENT',
      'RESOLVED',
      'REJECTED'
    )
  ),
  resolution_reason TEXT,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT chk_grievance_resolution_reason CHECK (
    (status = 'RESOLVED' AND resolution_reason IS NOT NULL AND length(trim(resolution_reason)) > 0) OR
    (status <> 'RESOLVED')
  ),
  CONSTRAINT chk_grievance_rejection_reason CHECK (
    (status = 'REJECTED' AND rejection_reason IS NOT NULL AND length(trim(rejection_reason)) > 0) OR
    (status <> 'REJECTED')
  )
);

CREATE INDEX IF NOT EXISTS idx_employee_grievances_emp_id ON public.employee_grievances (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_grievances_status ON public.employee_grievances (status);
CREATE INDEX IF NOT EXISTS idx_employee_grievances_created_at ON public.employee_grievances (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_employee_grievances_ref ON public.employee_grievances (reference_number);

-- 2. Grievance Messages Table (Two-Way Communication + Internal Notes)
CREATE TABLE IF NOT EXISTS public.grievance_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grievance_id UUID NOT NULL REFERENCES public.employee_grievances(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('employee', 'dpo', 'super_admin')),
  sender_name TEXT NOT NULL,
  message TEXT NOT NULL,
  is_internal_note BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grievance_messages_grievance ON public.grievance_messages (grievance_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_grievance_messages_sender ON public.grievance_messages (sender_id);

-- 3. Grievance Attachments Table (Supporting Evidence)
CREATE TABLE IF NOT EXISTS public.grievance_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grievance_id UUID NOT NULL REFERENCES public.employee_grievances(id) ON DELETE CASCADE,
  message_id UUID REFERENCES public.grievance_messages(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  is_internal BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grievance_attachments_grievance ON public.grievance_attachments (grievance_id);

-- 4. Grievance Notifications Table (In-App Status & Feedback Alerts)
CREATE TABLE IF NOT EXISTS public.grievance_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  grievance_id UUID NOT NULL REFERENCES public.employee_grievances(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (
    type IN (
      'SUBMISSION_CONFIRMED',
      'DPO_RESPONSE',
      'INFO_REQUESTED',
      'STATUS_CHANGED',
      'RESOLVED',
      'REJECTED'
    )
  ),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grievance_notifications_user ON public.grievance_notifications (user_id, is_read, created_at DESC);

-- 5. Row Level Security & Permissions
GRANT SELECT, INSERT ON public.employee_grievances TO authenticated;
GRANT UPDATE ON public.employee_grievances TO authenticated;
GRANT ALL ON public.employee_grievances TO service_role;
ALTER TABLE public.employee_grievances ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.grievance_messages TO authenticated;
GRANT ALL ON public.grievance_messages TO service_role;
ALTER TABLE public.grievance_messages ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.grievance_attachments TO authenticated;
GRANT ALL ON public.grievance_attachments TO service_role;
ALTER TABLE public.grievance_attachments ENABLE ROW LEVEL SECURITY;

GRANT SELECT, UPDATE ON public.grievance_notifications TO authenticated;
GRANT ALL ON public.grievance_notifications TO service_role;
ALTER TABLE public.grievance_notifications ENABLE ROW LEVEL SECURITY;

-- 6. RLS Policies

-- Grievances: Employees view only their own; DPO/Super Admin views all
DO $$ BEGIN
  CREATE POLICY "Grievances employee or admin select" ON public.employee_grievances
    FOR SELECT TO authenticated
    USING (
      employee_id = public.current_enterprise_user_id()
      OR public.has_role(auth.uid(), 'super_admin')
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY "Grievances employee insert" ON public.employee_grievances
    FOR INSERT TO authenticated
    WITH CHECK (
      employee_id = public.current_enterprise_user_id()
      OR public.has_role(auth.uid(), 'super_admin')
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY "Grievances dpo update" ON public.employee_grievances
    FOR UPDATE TO authenticated
    USING (public.has_role(auth.uid(), 'super_admin'))
    WITH CHECK (public.has_role(auth.uid(), 'super_admin'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Messages: Employees can view only non-internal messages on their own grievances
-- Super Admin / DPO can view all messages including internal notes
DO $$ BEGIN
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
      OR public.has_role(auth.uid(), 'super_admin')
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
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
      OR public.has_role(auth.uid(), 'super_admin')
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Attachments: Employees only view non-internal attachments on their own grievances
DO $$ BEGIN
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
      OR public.has_role(auth.uid(), 'super_admin')
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
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
      OR public.has_role(auth.uid(), 'super_admin')
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Notifications: Only recipient can select and mark as read
DO $$ BEGIN
  CREATE POLICY "Notifications recipient select" ON public.grievance_notifications
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY "Notifications recipient update" ON public.grievance_notifications
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 7. Automated Timestamps & Touch Triggers

-- Trigger function: Update updated_at on employee_grievances row modification
CREATE OR REPLACE FUNCTION public.handle_employee_grievance_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employee_grievances_updated_at ON public.employee_grievances;
CREATE TRIGGER trg_employee_grievances_updated_at
  BEFORE UPDATE ON public.employee_grievances
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_employee_grievance_updated_at();

-- Trigger function: Touch parent grievance updated_at when a new grievance message is inserted
CREATE OR REPLACE FUNCTION public.handle_grievance_message_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.employee_grievances
  SET updated_at = now()
  WHERE id = NEW.grievance_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_grievance_messages_touch_updated_at ON public.grievance_messages;
CREATE TRIGGER trg_grievance_messages_touch_updated_at
  AFTER INSERT ON public.grievance_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_grievance_message_touch_updated_at();
