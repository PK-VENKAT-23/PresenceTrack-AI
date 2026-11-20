import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { encryptBiometricTemplate, isValidEmbedding } from "@/lib/biometric";

type UserRole = Database["public"]["Enums"]["app_role"];

/**
 * Audit log helper: records administrative activity to admin_audit_logs.
 */
async function recordAdminAudit(
  supabase: SupabaseClient<Database>,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  try {
    await supabase.from("admin_audit_logs").insert({
      actor_id: actorId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      metadata: metadata as Json,
    });
  } catch (err) {
    console.error("Failed to record admin audit log:", err);
  }
}

/** Check if current caller has super_admin role */
async function requireSuperAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data: isAdmin } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: "super_admin",
  });
  if (!isAdmin) throw new Error("Forbidden: Super Admin access required");
}

/** Check if current caller has HR or Admin role */
async function requireHrOrAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data: isAllowed } = await supabase.rpc("has_any_role", {
    _user_id: userId,
    _roles: ["hr_ops", "super_admin"],
  });
  if (!isAllowed) throw new Error("Forbidden: HR or Admin access required");
}

// ── Employee CRUD Server Functions ──────────────────────────────────────────

/** Create a new enterprise employee profile (Super Admin only). */
export const createEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        name: z.string().trim().min(1, "Name is required").max(100),
        email: z.string().trim().email("Valid email required").max(255),
        badge_id: z.string().trim().min(1, "Badge ID required").max(64),
        department_id: z.string().uuid().optional().nullable(),
        department_name: z.string().trim().max(100).optional(),
        role_title: z.string().trim().min(1).max(100).default("Staff"),
        employment_type: z.string().trim().default("FULL_TIME"),
        shift_start: z
          .string()
          .regex(/^\d{2}:\d{2}(:\d{2})?$/)
          .default("09:00:00"),
        shift_end: z
          .string()
          .regex(/^\d{2}:\d{2}(:\d{2})?$/)
          .default("18:00:00"),
        initial_role: z.enum(["employee", "hr_ops", "security", "super_admin"]).default("employee"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    // Resolve department name if department_id provided
    let deptName = data.department_name || "Unassigned";
    if (data.department_id) {
      const { data: dept } = await context.supabase
        .from("departments")
        .select("name")
        .eq("id", data.department_id)
        .maybeSingle();
      if (dept) deptName = dept.name;
    }

    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(data.name)}&background=10B981&color=fff&bold=true`;

    const { data: created, error } = await context.supabase
      .from("enterprise_users")
      .insert({
        name: data.name,
        email: data.email.toLowerCase(),
        badge_id: data.badge_id.toUpperCase(),
        department: deptName,
        role_title: data.role_title,
        avatar_url: avatarUrl,
        imported_role: data.initial_role,
      })
      .select("id, name, email, badge_id, department, role_title, created_at")
      .single();

    if (error || !created) {
      if (error?.code === "23505") {
        throw new Error("An employee with this email or badge ID already exists.");
      }
      throw new Error(error?.message || "Failed to create employee profile");
    }

    await recordAdminAudit(
      context.supabase,
      context.userId,
      "CREATE_EMPLOYEE",
      "enterprise_users",
      created.id,
      { name: created.name, email: created.email, badge_id: created.badge_id },
    );

    return { success: true, employee: created };
  });

/** Update an existing employee profile (HR or Admin). */
export const updateEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(100).optional(),
        badge_id: z.string().trim().min(1).max(64).optional(),
        department_id: z.string().uuid().optional().nullable(),
        department_name: z.string().trim().max(100).optional(),
        role_title: z.string().trim().max(100).optional(),
        employment_type: z.string().trim().optional(),
        shift_start: z
          .string()
          .regex(/^\d{2}:\d{2}(:\d{2})?$/)
          .optional(),
        shift_end: z
          .string()
          .regex(/^\d{2}:\d{2}(:\d{2})?$/)
          .optional(),
        avatar_url: z.string().url().max(500).optional().nullable(),
        is_active: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireHrOrAdmin(context.supabase, context.userId);

    const updates: Database["public"]["Tables"]["enterprise_users"]["Update"] = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.badge_id !== undefined) updates.badge_id = data.badge_id.toUpperCase();
    if (data.role_title !== undefined) updates.role_title = data.role_title;
    if (data.employment_type !== undefined) updates.employment_type = data.employment_type;
    if (data.shift_start !== undefined) updates.shift_start = data.shift_start;
    if (data.shift_end !== undefined) updates.shift_end = data.shift_end;
    if (data.avatar_url !== undefined) updates.avatar_url = data.avatar_url;
    if (data.is_active !== undefined) updates.is_active = data.is_active;

    if (data.department_id !== undefined) {
      updates.department_id = data.department_id;
      if (data.department_id) {
        const { data: dept } = await context.supabase
          .from("departments")
          .select("name")
          .eq("id", data.department_id)
          .maybeSingle();
        if (dept) updates.department = dept.name;
      }
    } else if (data.department_name !== undefined) {
      updates.department = data.department_name;
    }

    const { data: updated, error } = await context.supabase
      .from("enterprise_users")
      .update(updates)
      .eq("id", data.id)
      .select("id, name, email, badge_id, department, role_title")
      .single();

    if (error || !updated) {
      throw new Error(error?.message || "Failed to update employee");
    }

    await recordAdminAudit(
      context.supabase,
      context.userId,
      "UPDATE_EMPLOYEE",
      "enterprise_users",
      data.id,
      updates,
    );

    return { success: true, employee: updated };
  });

/** Deactivate an employee profile (Super Admin only). */
export const deactivateEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ id: z.string().uuid(), reason: z.string().trim().max(255).optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    // 1. Guard against deactivating the last active Super Admin profile
    const { data: targetProfile, error: targetErr } = await context.supabase
      .from("enterprise_users")
      .select("id, email, auth_user_id, is_active")
      .eq("id", data.id)
      .maybeSingle();

    if (targetErr || !targetProfile) throw new Error("Employee profile not found");

    if (targetProfile.auth_user_id) {
      const { data: roleRow } = await context.supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", targetProfile.auth_user_id)
        .maybeSingle();

      if (roleRow?.role === "super_admin") {
        // Count active Super Admins across roles and enterprise profiles
        const { data: activeSuperAdmins, error: countErr } = await context.supabase
          .from("user_roles")
          .select("user_id, enterprise_users!inner(is_active)")
          .eq("role", "super_admin")
          .eq("enterprise_users.is_active", true);

        if (countErr) {
          throw new Error(`Failed to verify active Super Admin count: ${countErr.message}`);
        }

        if (activeSuperAdmins && activeSuperAdmins.length <= 1) {
          throw new Error(
            "Safety Violation: Cannot deactivate the last remaining active Super Admin profile in the platform.",
          );
        }
      }
    }

    const { error } = await context.supabase
      .from("enterprise_users")
      .update({ is_active: false })
      .eq("id", data.id);

    if (error) throw new Error("Failed to deactivate employee");

    await recordAdminAudit(
      context.supabase,
      context.userId,
      "DEACTIVATE_EMPLOYEE",
      "enterprise_users",
      data.id,
      { reason: data.reason || "Administrative deactivation" },
    );

    return { success: true, message: "Employee deactivated successfully" };
  });

/** Retrieve single employee profile (omitting biometric embedding). */
export const getEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: emp, error } = await context.supabase
      .from("enterprise_users")
      .select(
        "id, auth_user_id, email, name, badge_id, department, role_title, avatar_url, current_zone, is_in_workspace, consent_revoked, created_at",
      )
      .eq("id", data.id)
      .maybeSingle();

    if (error || !emp) throw new Error("Employee not found");
    const fullEmp = {
      ...emp,
      is_active: (emp as { is_active?: boolean }).is_active ?? true,
      department_id: (emp as { department_id?: string | null }).department_id ?? null,
      employment_type: (emp as { employment_type?: string }).employment_type ?? "FULL_TIME",
      shift_start: (emp as { shift_start?: string }).shift_start ?? "09:00:00",
      shift_end: (emp as { shift_end?: string }).shift_end ?? "18:00:00",
    };
    return { success: true, employee: fullEmp };
  });

/** List employees with optional filters (strips biometric embeddings). */
export const listEmployees = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        department_id: z.string().uuid().optional(),
        search: z.string().trim().max(100).optional(),
        include_inactive: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const query = context.supabase
      .from("enterprise_users")
      .select(
        "id, auth_user_id, email, name, badge_id, department, role_title, avatar_url, current_zone, is_in_workspace, consent_revoked, created_at",
      )
      .order("name", { ascending: true });

    const { data: employees, error } = await query;
    if (error) throw new Error("Failed to list employees");

    const mapped = (employees ?? []).map((emp) => ({
      ...emp,
      is_active: (emp as { is_active?: boolean }).is_active ?? true,
      department_id: (emp as { department_id?: string | null }).department_id ?? null,
      employment_type: (emp as { employment_type?: string }).employment_type ?? "FULL_TIME",
      shift_start: (emp as { shift_start?: string }).shift_start ?? "09:00:00",
      shift_end: (emp as { shift_end?: string }).shift_end ?? "18:00:00",
    }));

    let filtered = mapped;
    if (!data.include_inactive) {
      filtered = filtered.filter((e) => e.is_active);
    }
    if (data.department_id) {
      filtered = filtered.filter((e) => e.department_id === data.department_id);
    }
    if (data.search) {
      const q = data.search.toLowerCase();
      filtered = filtered.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.email.toLowerCase().includes(q) ||
          e.badge_id.toLowerCase().includes(q) ||
          e.department.toLowerCase().includes(q),
      );
    }

    return { success: true, employees: filtered, count: filtered.length };
  });

/** Assign enclave role to an authorized user (Super Admin only). */
export const assignEmployeeRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        auth_user_id: z.string().uuid(),
        role: z.enum(["employee", "hr_ops", "security", "super_admin"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    const { error } = await context.supabase.rpc("assign_user_role_atomic", {
      _target_user_id: data.auth_user_id,
      _new_role: data.role,
    });

    if (error) throw new Error(error.message);

    return { success: true, role: data.role };
  });

// ── Department Management Server Functions (Task 5) ─────────────────────────

/** List all departments with employee headcounts. */
export const listDepartments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [{ data: depts, error: dError }, { data: people, error: pError }] = await Promise.all([
      context.supabase.from("departments").select("*").order("name", { ascending: true }),
      context.supabase.from("enterprise_users").select("id, department"),
    ]);

    if (dError) throw new Error("Failed to load departments");

    const counts = new Map<string, number>();
    for (const p of people ?? []) {
      const deptKey = (p as { department_id?: string }).department_id ?? p.department;
      if (deptKey) {
        counts.set(deptKey, (counts.get(deptKey) ?? 0) + 1);
      }
    }

    const items = (depts ?? []).map((d) => ({
      ...d,
      active_employees: counts.get(d.id) ?? counts.get(d.name) ?? 0,
    }));

    return { success: true, departments: items };
  });

/** Create a new department (Super Admin only). */
export const createDepartment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        name: z.string().trim().min(1, "Department name is required").max(100),
        description: z.string().trim().max(255).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    const { data: dept, error } = await context.supabase
      .from("departments")
      .insert({
        name: data.name,
        description: data.description || null,
      })
      .select("*")
      .single();

    if (error || !dept) {
      if (error?.code === "23505") throw new Error("A department with this name already exists.");
      throw new Error(error?.message || "Failed to create department");
    }

    await recordAdminAudit(
      context.supabase,
      context.userId,
      "CREATE_DEPARTMENT",
      "departments",
      dept.id,
      { name: dept.name },
    );

    return { success: true, department: dept };
  });

/** Update department details (Super Admin only). */
export const updateDepartment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().trim().max(255).optional().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    const updates: Database["public"]["Tables"]["departments"]["Update"] = { updated_at: new Date().toISOString() };
    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;

    const { data: dept, error } = await context.supabase
      .from("departments")
      .update(updates)
      .eq("id", data.id)
      .select("*")
      .single();

    if (error || !dept) throw new Error(error?.message || "Failed to update department");

    await recordAdminAudit(
      context.supabase,
      context.userId,
      "UPDATE_DEPARTMENT",
      "departments",
      dept.id,
      updates,
    );

    return { success: true, department: dept };
  });

function notifyGatewayTemplateSync(): void {
  const deviceKey = process.env["ESP32_DEVICE_KEY"];
  const gatewayUrl = process.env["VISION_GATEWAY_URL"] || "http://localhost:8001";
  if (deviceKey && typeof fetch !== "undefined") {
    fetch(`${gatewayUrl}/api/sync-templates`, {
      method: "POST",
      headers: { "x-device-key": deviceKey },
    }).catch(() => {
      // Non-blocking: periodic background sync loop will catch updates
    });
  }
}

/**
 * Enroll or update an employee's facial biometric template (Super Admin only).
 * Complies with DPDP Act 2023:
 * - Templates are validated (128-d or 512-d float vectors)
 * - Templates are encrypted at rest using AES-256-GCM via encryptBiometricTemplate()
 * - Plaintext vectors are never persisted to database or returned to client
 */
export const enrollEmployeeBiometrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        employee_id: z.string().uuid("Valid employee ID required"),
        embedding: z
          .array(z.number())
          .refine(
            (vec) => isValidEmbedding(vec, 128) || isValidEmbedding(vec, 512),
            "Embedding must be a valid 128 or 512 dimensional floating point vector",
          ),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    // Verify target employee exists
    const { data: emp, error: empErr } = await context.supabase
      .from("enterprise_users")
      .select("id, name, badge_id, consent_revoked, is_active")
      .eq("id", data.employee_id)
      .maybeSingle();

    if (empErr || !emp) {
      throw new Error("Employee not found");
    }

    if (!emp.is_active) {
      throw new Error("Cannot enroll biometrics for deactivated employee");
    }

    if (emp.consent_revoked) {
      throw new Error(
        "Cannot enroll biometrics for employee with revoked consent (DPDP Section 6)",
      );
    }

    // Encrypt template via AES-256-GCM before storage
    const encryptedTemplate = await encryptBiometricTemplate(data.embedding);
    const enrolledAt = new Date().toISOString();
    const storedEnvelope = {
      ...encryptedTemplate,
      enrolled_at: enrolledAt,
    };

    const { error: updateErr } = await context.supabase
      .from("enterprise_users")
      .update({
        enrolled_embedding: storedEnvelope as unknown as Json,
      })
      .eq("id", data.employee_id);

    if (updateErr) {
      throw new Error(`Failed to store biometric template: ${updateErr.message}`);
    }

    await recordAdminAudit(
      context.supabase,
      context.userId,
      "BIOMETRICS_ENROLLED",
      "enterprise_users",
      emp.id,
      {
        embedding_dim: data.embedding.length,
        encrypted: encryptedTemplate.encrypted,
        enrolled_at: enrolledAt,
      },
    );

    notifyGatewayTemplateSync();

    return {
      success: true,
      employee_id: emp.id,
      encrypted: encryptedTemplate.encrypted,
      message: "Biometric template securely encrypted and enrolled",
    };
  });

/**
 * Remove an employee's facial biometric template (Super Admin only).
 * Complies with DPDP Act 2023 Sec. 12 right to erasure:
 * - Immediately clears encrypted template from database
 * - Records audit log
 */
export const removeEmployeeBiometrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        employee_id: z.string().uuid("Valid employee ID required"),
        reason: z.string().trim().max(255).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    const { data: emp, error: empErr } = await context.supabase
      .from("enterprise_users")
      .select("id, name, badge_id")
      .eq("id", data.employee_id)
      .maybeSingle();

    if (empErr || !emp) {
      throw new Error("Employee not found");
    }

    const { error: updateErr } = await context.supabase
      .from("enterprise_users")
      .update({
        enrolled_embedding: null,
      })
      .eq("id", data.employee_id);

    if (updateErr) {
      throw new Error(`Failed to remove biometric template: ${updateErr.message}`);
    }

    await recordAdminAudit(
      context.supabase,
      context.userId,
      "BIOMETRICS_REMOVED",
      "enterprise_users",
      emp.id,
      {
        reason: data.reason || "Administrative removal of biometric template",
        removed_at: new Date().toISOString(),
      },
    );

    notifyGatewayTemplateSync();

    return {
      success: true,
      employee_id: emp.id,
      message: "Biometric template securely erased from database",
    };
  });

/**
 * Update an employee's biometric consent status (Super Admin only).
 * If consent is revoked, any enrolled biometric template is invalidated and cleared.
 */
export const updateEmployeeConsent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        employee_id: z.string().uuid("Valid employee ID required"),
        consent_revoked: z.boolean(),
        reason: z.string().trim().max(255).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    const { data: emp, error: empErr } = await context.supabase
      .from("enterprise_users")
      .select("id, name, badge_id, consent_revoked")
      .eq("id", data.employee_id)
      .maybeSingle();

    if (empErr || !emp) {
      throw new Error("Employee not found");
    }

    const updates: { consent_revoked: boolean; enrolled_embedding?: null } = {
      consent_revoked: data.consent_revoked,
    };

    if (data.consent_revoked) {
      updates.enrolled_embedding = null;
    }

    const { error: updateErr } = await context.supabase
      .from("enterprise_users")
      .update(updates)
      .eq("id", data.employee_id);

    if (updateErr) {
      throw new Error(`Failed to update consent status: ${updateErr.message}`);
    }

    await recordAdminAudit(
      context.supabase,
      context.userId,
      data.consent_revoked ? "CONSENT_REVOKED" : "CONSENT_RESTORED",
      "enterprise_users",
      emp.id,
      {
        consent_revoked: data.consent_revoked,
        reason: data.reason || (data.consent_revoked ? "Consent revoked" : "Consent restored"),
        timestamp: new Date().toISOString(),
      },
    );

    notifyGatewayTemplateSync();

    return {
      success: true,
      employee_id: emp.id,
      consent_revoked: data.consent_revoked,
      message: data.consent_revoked
        ? "Consent revoked. Biometric template invalidated."
        : "Consent restored successfully.",
    };
  });

/**
 * Query an employee's biometric enrollment and consent status (Super Admin only).
 * If employee_id is provided, returns that employee's status.
 * If employee_id is omitted, returns statuses for all personnel in the directory.
 * Returns boolean statuses and timestamps without exposing any biometric vectors.
 */
export const getEmployeeBiometricStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input?: unknown) => {
    if (!input || typeof input !== "object") {
      return { employee_id: undefined };
    }
    return z
      .object({
        employee_id: z.string().uuid("Valid employee ID required").optional(),
      })
      .parse(input);
  })
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    if (data?.employee_id) {
      const { data: emp, error: empErr } = await context.supabase
        .from("enterprise_users")
        .select("id, name, badge_id, consent_revoked, is_active, enrolled_embedding")
        .eq("id", data.employee_id)
        .maybeSingle();

      if (empErr || !emp) {
        throw new Error("Employee not found");
      }

      const enrolledAt =
        emp.enrolled_embedding &&
        typeof emp.enrolled_embedding === "object" &&
        "enrolled_at" in (emp.enrolled_embedding as Record<string, unknown>)
          ? String((emp.enrolled_embedding as Record<string, unknown>)["enrolled_at"])
          : null;

      return {
        success: true,
        employee_id: emp.id,
        is_enrolled: emp.enrolled_embedding !== null,
        consent_revoked: emp.consent_revoked ?? false,
        is_active: emp.is_active ?? true,
        enrolled_at: enrolledAt,
      };
    }

    // Query all employee biometric statuses for directory
    const { data: users, error: usersErr } = await context.supabase
      .from("enterprise_users")
      .select("id, name, badge_id, consent_revoked, is_active, enrolled_embedding");

    if (usersErr) {
      throw new Error(`Failed to query biometric statuses: ${usersErr.message}`);
    }

    const statuses: Record<
      string,
      {
        employee_id: string;
        is_enrolled: boolean;
        consent_revoked: boolean;
        is_active: boolean;
        enrolled_at: string | null;
      }
    > = {};

    for (const u of users ?? []) {
      const uEnrolledAt =
        u.enrolled_embedding &&
        typeof u.enrolled_embedding === "object" &&
        "enrolled_at" in (u.enrolled_embedding as Record<string, unknown>)
          ? String((u.enrolled_embedding as Record<string, unknown>)["enrolled_at"])
          : null;

      statuses[u.id] = {
        employee_id: u.id,
        is_enrolled: u.enrolled_embedding !== null,
        consent_revoked: u.consent_revoked ?? false,
        is_active: u.is_active ?? true,
        enrolled_at: uEnrolledAt,
      };
    }

    return {
      success: true,
      statuses,
    };
  });

/**
 * Extract face embedding from a base64-encoded frame via Vision Gateway (Super Admin only).
 * Raw image is forwarded to the edge vision gateway in ephemeral memory,
 * where YuNet detects the face and SFace extracts the 128-d unit vector.
 * Raw images are never stored in database or filesystem.
 */
export const extractFaceEmbedding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        image_base64: z.string().min(10, "Valid image base64 data required"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    const deviceKey = process.env["ESP32_DEVICE_KEY"];
    const gatewayUrl = process.env["VISION_GATEWAY_URL"] || "http://localhost:8001";

    try {
      const resp = await fetch(`${gatewayUrl}/api/extract-face-embedding`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(deviceKey ? { "x-device-key": deviceKey } : {}),
        },
        body: JSON.stringify({ image_base64: data.image_base64 }),
      });

      if (!resp.ok) {
        const errorData = (await resp.json().catch(() => ({ detail: `HTTP error ${resp.status}` }))) as {
          detail?: string;
          error?: string;
        };
        const message = errorData.detail || errorData.error || `Gateway extraction failed (${resp.status})`;
        throw new Error(message);
      }

      const res = (await resp.json()) as {
        success: boolean;
        embedding: number[];
        embedding_dim?: number;
        confidence?: number;
        bbox?: { x: number; y: number; w: number; h: number };
        model?: string;
        error?: string;
      };

      if (!res.success || !Array.isArray(res.embedding)) {
        throw new Error(res.error || "No valid embedding returned from vision gateway");
      }

      return {
        success: true,
        embedding: res.embedding,
        embedding_dim: res.embedding_dim ?? res.embedding.length,
        confidence: res.confidence,
        bbox: res.bbox,
        model: res.model,
      };
    } catch (err: unknown) {
      if (err instanceof Error) {
        throw err;
      }
      throw new Error("Failed to communicate with Vision Gateway for face extraction");
    }
  });

// Re-export onboarding & account lifecycle functions
export { inviteEmployee, reinviteEmployee, activateEmployee } from "@/lib/auth.functions";
