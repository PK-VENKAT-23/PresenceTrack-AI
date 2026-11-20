import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { enclaveFor, type Enclave } from "@/lib/enclaves";
import type { UserRole } from "@/lib/ambient";

/**
 * Recursive metadata sanitizer: removes passwords, tokens, secrets,
 * and restricts keys and value sizes.
 */
export function sanitizeAuditMetadata(input: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED_DEPTH]";
  if (input === null || input === undefined) return null;
  if (typeof input === "string") {
    return input.length > 500 ? input.slice(0, 500) + "..." : input;
  }
  if (typeof input === "number" || typeof input === "boolean") {
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 25).map((item) => sanitizeAuditMetadata(item, depth + 1));
  }
  if (typeof input === "object") {
    const sanitized: Record<string, unknown> = {};
    const sensitivePattern =
      /password|passcode|token|secret|authorization|bearer|cookie|apiKey|private_key/i;
    for (const [key, value] of Object.entries(input)) {
      if (sensitivePattern.test(key)) {
        continue; // Strip sensitive key entirely
      }
      const safeKey = key.slice(0, 64);
      sanitized[safeKey] = sanitizeAuditMetadata(value, depth + 1);
    }
    return sanitized;
  }
  return String(input);
}

/**
 * Audit log helper: records administrative & auth activity to admin_audit_logs.
 * Never logs passwords, secrets or authorization bearer tokens.
 * Explicitly checks and reports Supabase insert errors.
 */
async function recordAuditLog(
  supabase: SupabaseClient<Database>,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    const sanitizedMeta = (sanitizeAuditMetadata(metadata) ?? {}) as Record<string, unknown>;

    const { error } = await supabase.from("admin_audit_logs").insert({
      actor_id: actorId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      metadata: sanitizedMeta as Json,
    });

    if (error) {
      console.error("Failed to insert admin_audit_log:", error.message);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    const msg = (err as Error)?.message ?? "Unknown audit failure";
    console.error("Exception in recordAuditLog:", msg);
    return { success: false, error: msg };
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

/**
 * Resolves the public base URL for emails and redirect callbacks.
 * Fail-closed: Throws in production if not explicitly configured.
 */
export function resolveAppUrl(): string {
  const configured =
    process.env["APP_URL"] || process.env["VITE_APP_URL"] || process.env["PUBLIC_APP_URL"];

  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const isProd = process.env["NODE_ENV"] === "production";
  if (isProd) {
    throw new Error(
      "Configuration Error: APP_URL must be configured in production environment variables to dispatch valid invitation and password reset links.",
    );
  }

  // Safe development fallback: matches actual local dev server port (8080)
  return "http://localhost:8080";
}

// ── Auth Audit Logging ────────────────────────────────────────────────────────

const ALLOWED_AUTH_ACTIONS = [
  "auth.login_success",
  "auth.login_failed",
  "auth.logout",
  "auth.password_reset_request",
  "auth.password_changed",
  "auth.session_expired",
  "auth.unauthorized_access",
] as const;

export const recordAuthEvent = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        action: z.enum(ALLOWED_AUTH_ACTIONS),
        // Accepted for API compatibility, but NEVER trusted as server-side actor identity
        actor_id: z.string().uuid().optional(),
        email: z.string().trim().email().max(255).optional(),
        metadata: z.record(z.unknown()).default({}),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { hasSupabaseAdminConfigured, supabaseAdmin } =
      await import("@/integrations/supabase/client.server");

    if (!hasSupabaseAdminConfigured()) {
      return { success: false, reason: "Service role client unavailable" };
    }

    // Server-side verification of actor identity:
    // Derive actor identity exclusively from verified session token, never from client body
    let verifiedActorId: string | null = null;
    try {
      const request = getRequest();
      const authHeader = request?.headers?.get("authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.replace("Bearer ", "").trim();
        if (token && token.split(".").length === 3) {
          const { data: claimsData } = await supabaseAdmin.auth.getClaims(token);
          if (claimsData?.claims?.sub) {
            verifiedActorId = claimsData.claims.sub as string;
          } else {
            const { data: userData } = await supabaseAdmin.auth.getUser(token);
            if (userData?.user?.id) {
              verifiedActorId = userData.user.id;
            }
          }
        }
      }
    } catch {
      // Failed token verification -> actorId remains null
    }

    // For unauthenticated events (e.g. auth.login_failed, auth.password_reset_request),
    // actor_id MUST be null.
    // For authenticated events (e.g. auth.logout, auth.login_success),
    // actor_id is derived from verified token if available.
    // Client-supplied data.actor_id is NEVER trusted or used.
    const effectiveActorId = verifiedActorId;

    const sanitizedMeta = {
      ...((sanitizeAuditMetadata(data.metadata) as Record<string, unknown>) ?? {}),
      ...(data.email ? { email_domain: data.email.split("@")[1] } : {}),
      logged_at: new Date().toISOString(),
    };

    const res = await recordAuditLog(
      supabaseAdmin,
      effectiveActorId,
      data.action,
      "auth",
      effectiveActorId,
      sanitizedMeta,
    );

    if (!res.success) {
      return { success: false, error: res.error };
    }

    return { success: true };
  });

// ── Admin-Initiated Employee Invitation ──────────────────────────────────────

export const inviteEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        email: z.string().trim().email("Valid corporate email required").max(255),
        name: z.string().trim().min(1, "Full name is required").max(100),
        badge_id: z
          .string()
          .trim()
          .min(1, "Employee/Badge ID is required")
          .max(32)
          .regex(
            /^[A-Za-z0-9_-]+$/,
            "Badge ID must contain only alphanumeric, dashes or underscores",
          ),
        department: z.string().trim().max(100).optional(),
        department_id: z.string().uuid().optional(),
        role: z.enum(["employee", "hr_ops", "security"]).default("employee"),
        role_title: z.string().trim().max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    // 1. Enforce Super Admin authorization
    await requireSuperAdmin(context.supabase, context.userId);

    // Defense-in-depth: explicitly reject super_admin assignment via employee invitation
    if ((data.role as string) === "super_admin") {
      throw new Error(
        "Security Guard: Super Admin role cannot be assigned through employee invitation.",
      );
    }

    const { hasSupabaseAdminConfigured, supabaseAdmin } =
      await import("@/integrations/supabase/client.server");

    if (!hasSupabaseAdminConfigured()) {
      throw new Error(
        "Configuration Error: SUPABASE_SERVICE_ROLE_KEY is required on server for user invitations",
      );
    }

    const emailNormalized = data.email.toLowerCase().trim();
    const badgeNormalized = data.badge_id.toUpperCase().trim();

    // 2. Validate email and badge uniqueness
    const { data: existingUsers } = await supabaseAdmin
      .from("enterprise_users")
      .select("id, email, badge_id, is_active")
      .or(`email.ilike.${emailNormalized},badge_id.ilike.${badgeNormalized}`);

    if (existingUsers && existingUsers.length > 0) {
      for (const u of existingUsers) {
        if (u.email.toLowerCase() === emailNormalized) {
          throw new Error(`An employee with email '${data.email}' already exists.`);
        }
        if (u.badge_id.toUpperCase() === badgeNormalized) {
          throw new Error(`An employee with Badge ID '${data.badge_id}' already exists.`);
        }
      }
    }

    // 3. Resolve department name
    let departmentName = data.department?.trim() || "General";
    if (data.department_id) {
      const { data: dept } = await supabaseAdmin
        .from("departments")
        .select("name")
        .eq("id", data.department_id)
        .maybeSingle();
      if (dept?.name) departmentName = dept.name;
    }

    // 4. Pre-stage the enterprise_users record
    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(
      data.name,
    )}&background=10B981&color=fff&bold=true`;

    const { data: stagedProfile, error: profileErr } = await supabaseAdmin
      .from("enterprise_users")
      .insert({
        name: data.name.trim(),
        email: emailNormalized,
        badge_id: badgeNormalized,
        department: departmentName,
        role_title: data.role_title?.trim() || "Staff",
        imported_role: data.role,
        avatar_url: avatarUrl,
        invitation_status: "STAGED",
      })
      .select()
      .single();

    if (profileErr) {
      throw new Error(`Failed to stage employee profile: ${profileErr.message}`);
    }

    // 5. Send invitation via Supabase Auth with explicit ?flow=invite
    const appUrl = resolveAppUrl();

    let inviteData;
    try {
      const res = await supabaseAdmin.auth.admin.inviteUserByEmail(emailNormalized, {
        data: {
          name: data.name.trim(),
          badge_id: badgeNormalized,
          department: departmentName,
          role: data.role,
        },
        redirectTo: `${appUrl}/reset-password?flow=invite`,
      });
      if (res.error) throw res.error;
      inviteData = res.data;
    } catch (inviteErr) {
      const errMessage = (inviteErr as Error)?.message ?? "";
      const isDefinitivePreDispatch =
        /invalid email|email format|validation failed|unsupported provider/i.test(errMessage);

      if (isDefinitivePreDispatch) {
        // Safe to delete newly staged profile because email was definitively not sent
        await supabaseAdmin.from("enterprise_users").delete().eq("id", stagedProfile.id);
        throw new Error(`Supabase invite dispatch failed: ${errMessage}`);
      }

      // Ambiguous outcome (timeout, 504, 502, socket hangup, fetch failure):
      // The email may have been dispatched by GoTrue before the client timed out.
      // Mark profile as RECONCILIATION_REQUIRED and preserve it for administrator reconciliation.
      await supabaseAdmin
        .from("enterprise_users")
        .update({ invitation_status: "RECONCILIATION_REQUIRED" })
        .eq("id", stagedProfile.id);

      await recordAuditLog(
        context.supabase,
        context.userId,
        "employee.invite_dispatch_ambiguous",
        "enterprise_users",
        stagedProfile.id,
        {
          email: emailNormalized,
          reason: errMessage,
          note: "Dispatch outcome ambiguous. Profile preserved in RECONCILIATION_REQUIRED quarantine.",
        },
      );

      throw new Error(
        `Invitation dispatch encountered an ambiguous network error or timeout: ${errMessage}. Staged profile preserved in quarantine (RECONCILIATION_REQUIRED) to prevent orphaned credentials.`,
      );
    }

    // 6. Post-Dispatch Linking & Verification (Durable Staging: Profile is preserved on failure)
    // NOTE: In strict adherence to project RBAC architecture, we do NOT directly insert into
    // public.user_roles here. Role creation is handled upon email verification by the database
    // trigger `handle_verified_auth_user()` when the invited user accepts the invitation.
    const authUserId = inviteData?.user?.id;
    if (!authUserId) {
      await supabaseAdmin
        .from("enterprise_users")
        .update({ invitation_status: "RECONCILIATION_REQUIRED" })
        .eq("id", stagedProfile.id);
      throw new Error(
        "Invitation dispatched, but Auth gateway returned no user ID. Profile preserved for trigger reconciliation.",
      );
    }

    try {
      // Link auth_user_id, advance to DISPATCHED status, and verify affected rows
      const { data: updatedProfile, error: linkErr } = await supabaseAdmin
        .from("enterprise_users")
        .update({
          auth_user_id: authUserId,
          invitation_status: "DISPATCHED",
          invitation_dispatched_at: new Date().toISOString(),
        })
        .eq("id", stagedProfile.id)
        .select("id, auth_user_id, invitation_status");

      if (linkErr) throw new Error(`Profile link update failed: ${linkErr.message}`);
      if (
        !updatedProfile ||
        updatedProfile.length !== 1 ||
        updatedProfile[0]?.auth_user_id !== authUserId ||
        updatedProfile[0]?.invitation_status !== "DISPATCHED"
      ) {
        throw new Error(
          "Verification failed: Profile update affected 0 rows or linkage mismatched.",
        );
      }
    } catch (postDispatchErr) {
      // Staged profile is durable and marked RECONCILIATION_REQUIRED because email was already dispatched
      await supabaseAdmin
        .from("enterprise_users")
        .update({
          auth_user_id: authUserId,
          invitation_status: "RECONCILIATION_REQUIRED",
        })
        .eq("id", stagedProfile.id);

      throw new Error(
        `Invitation dispatched, but database finalization failed: ${(postDispatchErr as Error).message}. Profile preserved for trigger reconciliation.`,
      );
    }

    // 7. Audit log the invitation
    await recordAuditLog(
      context.supabase,
      context.userId,
      "employee.invited",
      "enterprise_users",
      stagedProfile.id,
      {
        email: emailNormalized,
        name: data.name.trim(),
        badge_id: badgeNormalized,
        role: data.role,
        department: departmentName,
        auth_user_id: inviteData?.user?.id ?? null,
      },
    );

    return {
      success: true,
      message: `Invitation successfully dispatched to ${data.email}`,
      employee: {
        id: stagedProfile.id,
        email: stagedProfile.email,
        name: stagedProfile.name,
        badge_id: stagedProfile.badge_id,
        department: stagedProfile.department,
        role: data.role,
      },
    };
  });

// ── Reinvite Employee ────────────────────────────────────────────────────────

export const reinviteEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ employee_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    const { hasSupabaseAdminConfigured, supabaseAdmin } =
      await import("@/integrations/supabase/client.server");

    if (!hasSupabaseAdminConfigured()) {
      throw new Error(
        "Configuration Error: SUPABASE_SERVICE_ROLE_KEY is required on server for invitations",
      );
    }

    const { data: emp, error: empErr } = await supabaseAdmin
      .from("enterprise_users")
      .select(
        "id, email, name, badge_id, department, imported_role, auth_user_id, is_active, invitation_status",
      )
      .eq("id", data.employee_id)
      .maybeSingle();

    if (empErr) throw new Error(`Database error during employee lookup: ${empErr.message}`);
    if (!emp) throw new Error("Employee not found");

    // Case 1: Reject deactivated employees
    if (emp.is_active === false) {
      throw new Error("Cannot reinvite a deactivated employee. Reactivate the profile first.");
    }

    // Case 1b: Reject accounts under security quarantine
    if (emp.invitation_status === "RECONCILIATION_REQUIRED") {
      throw new Error(
        "Cannot reinvite an account under security quarantine (RECONCILIATION_REQUIRED). Please resolve the quarantine status before dispatching invitations.",
      );
    }

    // Case 1c: Reject Super Admin accounts from ordinary reinvitation
    if (emp.imported_role === "super_admin") {
      throw new Error(
        "Security Guard: Super Admin accounts cannot be reinvited through ordinary employee workflows.",
      );
    }

    const appUrl = resolveAppUrl();

    // Case 2: Linked Auth User
    if (emp.auth_user_id) {
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.getUserById(
        emp.auth_user_id,
      );
      if (authErr || !authData?.user) {
        throw new Error("Linked Auth user record not found in Supabase Auth directory.");
      }

      // Case 3: Email Mismatch
      if (authData.user.email?.toLowerCase().trim() !== emp.email.toLowerCase().trim()) {
        throw new Error(
          "Critical linkage mismatch: Profile email does not match linked Auth user email.",
        );
      }

      // Inspect role row in user_roles
      const { data: roleRow, error: roleErr } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", emp.auth_user_id)
        .maybeSingle();

      if (roleErr) throw new Error(`Role lookup failure: ${roleErr.message}`);

      // Case 4: Missing Role Defect
      if (!roleRow) {
        throw new Error(
          "Integrity Defect: Active employee lacks an assigned role in public.user_roles. Please review and assign a role in Role Management before reinviting.",
        );
      }

      // Case 5: Role Mismatch
      if (emp.imported_role && roleRow.role !== emp.imported_role) {
        throw new Error(
          `Role mismatch detected: Staged profile imported_role ('${emp.imported_role}') does not match active enclave role ('${roleRow.role}'). Resolve role consistency in Role Management before reinviting.`,
        );
      }

      // Case 6: Confirmed Auth User -> Dispatch recovery email
      if (authData.user.email_confirmed_at !== null) {
        const { error: resetErr } = await supabaseAdmin.auth.resetPasswordForEmail(emp.email, {
          redirectTo: `${appUrl}/reset-password?flow=recovery`,
        });

        if (resetErr) {
          throw new Error(`Failed to dispatch password recovery link: ${resetErr.message}`);
        }

        await recordAuditLog(
          context.supabase,
          context.userId,
          "employee.reinvitation_dispatched",
          "enterprise_users",
          emp.id,
          { email: emp.email, badge_id: emp.badge_id, mode: "recovery" },
        );

        return {
          success: true,
          message: `Employee account is already activated. A credential reset link has been dispatched to ${emp.email}.`,
        };
      }

      // Case 7: Unconfirmed Auth User -> Resend invite email
      const { error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(emp.email, {
        data: {
          name: emp.name,
          badge_id: emp.badge_id,
          department: emp.department,
          role: emp.imported_role,
        },
        redirectTo: `${appUrl}/reset-password?flow=invite`,
      });

      if (inviteErr) {
        throw new Error(`Failed to resend invitation: ${inviteErr.message}`);
      }

      const { data: updatedEmp, error: updateErr } = await supabaseAdmin
        .from("enterprise_users")
        .update({
          invitation_status: "DISPATCHED",
          invitation_dispatched_at: new Date().toISOString(),
        })
        .eq("id", emp.id)
        .select("id, invitation_status");

      if (updateErr || !updatedEmp || updatedEmp.length !== 1) {
        throw new Error("Verification failed: Profile status update after reinvite failed.");
      }

      await recordAuditLog(
        context.supabase,
        context.userId,
        "employee.reinvitation_dispatched",
        "enterprise_users",
        emp.id,
        { email: emp.email, badge_id: emp.badge_id, mode: "invite" },
      );

      return { success: true, message: `Invitation resent to ${emp.email}` };
    }

    // Case 8 & 9: Unlinked profile (auth_user_id IS NULL)
    // Check if an Auth user already exists using bounded pagination
    const targetEmail = emp.email.toLowerCase().trim();
    let existingAuthUser = null;
    let page = 1;
    const perPage = 100;
    const maxPages = 20;

    while (page <= maxPages) {
      const { data: pageData, error: pageErr } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage,
      });

      if (pageErr) {
        throw new Error(`Auth directory scanning failed on page ${page}: ${pageErr.message}`);
      }

      const users = pageData?.users ?? [];
      const matches = users.filter((u) => u.email?.toLowerCase().trim() === targetEmail);

      if (matches.length > 1) {
        throw new Error(
          `Directory anomaly: Multiple Auth users detected with email '${emp.email}'. Manual administrative resolution required.`,
        );
      }

      if (matches.length === 1) {
        existingAuthUser = matches[0];
        break;
      }

      if (users.length < perPage) {
        // Last page reached with zero matches
        break;
      }

      page++;
    }

    if (page > maxPages && !existingAuthUser) {
      throw new Error(
        "User directory exceeds maximum automated scan ceiling (2,000 users). Please contact technical support.",
      );
    }

    if (existingAuthUser) {
      throw new Error(
        `An existing Auth identity (ID: ${existingAuthUser.id}) matches '${emp.email}', but is not linked to this profile. Please reconcile profile linkage before reinviting.`,
      );
    }

    // Fresh invitation dispatch
    const { error: freshInviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(emp.email, {
      data: {
        name: emp.name,
        badge_id: emp.badge_id,
        department: emp.department,
        role: emp.imported_role,
      },
      redirectTo: `${appUrl}/reset-password?flow=invite`,
    });

    if (freshInviteErr) {
      await supabaseAdmin
        .from("enterprise_users")
        .update({ invitation_status: "RECONCILIATION_REQUIRED" })
        .eq("id", emp.id);
      throw new Error(`Failed to dispatch invitation: ${freshInviteErr.message}`);
    }

    const { data: updatedProfile, error: updateErr } = await supabaseAdmin
      .from("enterprise_users")
      .update({
        invitation_status: "DISPATCHED",
        invitation_dispatched_at: new Date().toISOString(),
      })
      .eq("id", emp.id)
      .select("id, invitation_status");

    if (updateErr || !updatedProfile || updatedProfile.length !== 1) {
      throw new Error("Verification failed: Profile status update after fresh invite failed.");
    }

    await recordAuditLog(
      context.supabase,
      context.userId,
      "employee.invitation_dispatched",
      "enterprise_users",
      emp.id,
      { email: emp.email, badge_id: emp.badge_id, mode: "fresh_invite" },
    );

    return { success: true, message: `Fresh invitation dispatched to ${emp.email}` };
  });

// ── Activate Employee ────────────────────────────────────────────────────────

export const activateEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ employee_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireSuperAdmin(context.supabase, context.userId);

    const { data: emp, error } = await context.supabase
      .from("enterprise_users")
      .update({ is_active: true })
      .eq("id", data.employee_id)
      .select("id, name, email, badge_id")
      .single();

    if (error || !emp) throw new Error("Failed to activate employee");

    await recordAuditLog(
      context.supabase,
      context.userId,
      "employee.activated",
      "enterprise_users",
      emp.id,
      { email: emp.email, badge_id: emp.badge_id },
    );

    return { success: true, message: `Employee ${emp.name} has been activated.` };
  });

// ── Session Status & Enclave Resolver ────────────────────────────────────────

export const getSessionAuthDetails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [{ data: roleRow, error: roleErr }, { data: profiles, error: profileErr }] =
      await Promise.all([
        context.supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", context.userId)
          .maybeSingle(),
        context.supabase
          .from("enterprise_users")
          .select(
            "id, auth_user_id, email, name, badge_id, department, role_title, avatar_url, current_zone, is_in_workspace, consent_revoked, is_active, invitation_status, created_at",
          )
          .eq("auth_user_id", context.userId),
      ]);

    const VALID_ROLES: UserRole[] = ["employee", "hr_ops", "security", "super_admin"];
    const roleCandidate = roleRow?.role as UserRole | undefined;
    const isValidRole = Boolean(roleCandidate && VALID_ROLES.includes(roleCandidate));
    const role: UserRole | null = isValidRole ? (roleCandidate as UserRole) : null;
    const enclave: Enclave | null = enclaveFor(role);

    // Fail closed: Database query errors
    if (roleErr || profileErr) {
      return {
        authenticated: true,
        authorized: false,
        userId: context.userId,
        role: null,
        enclave: null,
        isActive: false,
        profile: null,
        reason: "query_error",
      };
    }

    // Fail closed: Missing enterprise profile (Supabase auth identity alone does NOT grant access)
    if (!profiles || profiles.length === 0) {
      return {
        authenticated: true,
        authorized: false,
        userId: context.userId,
        role,
        enclave,
        isActive: false,
        profile: null,
        reason: "missing_profile",
      };
    }

    // Fail closed: Multiple profiles linked to same auth user
    if (profiles.length > 1) {
      return {
        authenticated: true,
        authorized: false,
        userId: context.userId,
        role,
        enclave,
        isActive: false,
        profile: null,
        reason: "duplicate_profiles",
      };
    }

    const profile = profiles[0];
    if (!profile) {
      return {
        authenticated: true,
        authorized: false,
        userId: context.userId,
        role,
        enclave,
        isActive: false,
        profile: null,
        reason: "missing_profile",
      };
    }

    // Fail closed: Linkage mismatch
    if (profile.auth_user_id !== context.userId) {
      return {
        authenticated: true,
        authorized: false,
        userId: context.userId,
        role,
        enclave,
        isActive: false,
        profile,
        reason: "linkage_mismatch",
      };
    }

    // Fail closed: Security quarantine
    if (profile.invitation_status === "RECONCILIATION_REQUIRED") {
      return {
        authenticated: true,
        authorized: false,
        userId: context.userId,
        role,
        enclave,
        isActive: false,
        profile,
        reason: "quarantined",
      };
    }

    // Fail closed: Deactivated profile
    if (profile.is_active === false) {
      return {
        authenticated: true,
        authorized: false,
        userId: context.userId,
        role,
        enclave,
        isActive: false,
        profile,
        reason: "deactivated",
      };
    }

    // Fail closed: Invitation status must be LINKED
    if (profile.invitation_status !== "LINKED") {
      return {
        authenticated: true,
        authorized: false,
        userId: context.userId,
        role,
        enclave,
        isActive: false,
        profile,
        reason: "unlinked",
      };
    }

    // Fail closed: Missing or invalid role
    if (!isValidRole) {
      return {
        authenticated: true,
        authorized: false,
        userId: context.userId,
        role: null,
        enclave: null,
        isActive: true,
        profile,
        reason: "no_role",
      };
    }

    // All fail-closed security rules passed
    return {
      authenticated: true,
      authorized: true,
      userId: context.userId,
      role,
      enclave,
      isActive: true,
      profile,
      reason: null,
    };
  });
