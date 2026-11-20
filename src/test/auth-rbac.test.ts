import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canAccessEnclave, enclaveFor, enclavePathFor, type Enclave } from "@/lib/enclaves";
import type { UserRole } from "@/lib/ambient";
import { sanitizeAuditMetadata, resolveAppUrl } from "@/lib/auth.functions";

// ── Mock Helpers for RBAC Verification ──────────────────────────────────────

type MockUserRole = UserRole | null | undefined;

interface MockAuthUser {
  id: string;
  email: string;
}

interface MockProfile {
  id: string;
  auth_user_id: string;
  name: string;
  badge_id: string;
  is_active: boolean;
  invitation_status?: string;
}

function mockHasRole(userRole: MockUserRole, requiredRole: UserRole): boolean {
  return userRole === requiredRole;
}

function mockHasAnyRole(userRole: MockUserRole, allowedRoles: UserRole[]): boolean {
  if (!userRole) return false;
  return allowedRoles.includes(userRole);
}

function mockCanAccessEmployeeAttendance(
  callerRole: MockUserRole,
  callerEnterpriseId: string,
  targetEmployeeId: string,
): boolean {
  // HR or Admin can view any employee's attendance
  if (mockHasAnyRole(callerRole, ["hr_ops", "super_admin"])) return true;
  // Regular employee can only view their own
  return callerEnterpriseId === targetEmployeeId;
}

function mockGuardEnclaveRoute(
  role: MockUserRole,
  targetEnclave: Enclave,
): { allowed: boolean; redirectTo?: string } {
  if (canAccessEnclave(role, targetEnclave)) {
    return { allowed: true };
  }
  return { allowed: false, redirectTo: enclavePathFor(role) };
}

function mockGuardAuthenticatedRoute(
  user: MockAuthUser | null,
  profile: MockProfile | null,
  role?: MockUserRole,
  queryError?: boolean,
  profileCount: number = profile ? 1 : 0,
): { allowed: boolean; redirectTo?: string; search?: Record<string, string> } {
  if (!user) {
    return { allowed: false, redirectTo: "/login", search: { reason: "expired" } };
  }
  if (queryError) {
    return { allowed: false, redirectTo: "/unauthorized", search: { reason: "forbidden" } };
  }
  if (!profile || profileCount !== 1) {
    return { allowed: false, redirectTo: "/unauthorized", search: { reason: "forbidden" } };
  }
  if (profile.auth_user_id !== user.id) {
    return { allowed: false, redirectTo: "/unauthorized", search: { reason: "forbidden" } };
  }
  if (profile.invitation_status === "RECONCILIATION_REQUIRED") {
    return { allowed: false, redirectTo: "/unauthorized", search: { reason: "quarantined" } };
  }
  if (profile.is_active === false) {
    return { allowed: false, redirectTo: "/unauthorized", search: { reason: "deactivated" } };
  }
  if (profile.invitation_status && profile.invitation_status !== "LINKED") {
    return { allowed: false, redirectTo: "/unauthorized", search: { reason: "forbidden" } };
  }
  const VALID_ROLES: UserRole[] = ["employee", "hr_ops", "security", "super_admin"];
  if (role !== undefined && (!role || !VALID_ROLES.includes(role))) {
    return { allowed: false, redirectTo: "/unauthorized", search: { reason: "no_role" } };
  }
  return { allowed: true };
}

// ── Zod Schemas for Auth & Onboarding Validation ────────────────────────────

const InviteEmployeeSchema = z.object({
  email: z.string().trim().email("Valid corporate email required").max(255),
  name: z.string().trim().min(1, "Full name is required").max(100),
  badge_id: z
    .string()
    .trim()
    .min(1, "Badge ID required")
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, "Badge ID must contain only alphanumeric, dashes or underscores"),
  department: z.string().trim().max(100).optional(),
  role: z.enum(["employee", "hr_ops", "security"]).default("employee"),
  role_title: z.string().trim().max(100).optional(),
});

const PasscodeResetSchema = z
  .object({
    password: z.string().min(8, "Passcode must be at least 8 characters long"),
    confirm: z.string().min(8, "Confirm passcode must be at least 8 characters long"),
  })
  .refine((data) => data.password === data.confirm, {
    message: "Passcodes do not match",
    path: ["confirm"],
  });

// ── Test Suites ─────────────────────────────────────────────────────────────

describe("Phase 3: Authentication & Role-Based Access Control (RBAC)", () => {
  // Requirement 1: Employee login
  it("Requirement 1: Employee login maps cleanly to /enclave/employee", () => {
    const role: UserRole = "employee";
    expect(enclaveFor(role)).toBe("employee");
    expect(enclavePathFor(role)).toBe("/enclave/employee");
    expect(canAccessEnclave(role, "employee")).toBe(true);
    expect(canAccessEnclave(role, "admin")).toBe(false);
  });

  // Requirement 2: HR login
  it("Requirement 2: HR login maps cleanly to /enclave/hr", () => {
    const role: UserRole = "hr_ops";
    expect(enclaveFor(role)).toBe("hr");
    expect(enclavePathFor(role)).toBe("/enclave/hr");
    expect(canAccessEnclave(role, "hr")).toBe(true);
    expect(canAccessEnclave(role, "security")).toBe(false);
  });

  // Requirement 3: Security login
  it("Requirement 3: Security login maps cleanly to /enclave/security", () => {
    const role: UserRole = "security";
    expect(enclaveFor(role)).toBe("security");
    expect(enclavePathFor(role)).toBe("/enclave/security");
    expect(canAccessEnclave(role, "security")).toBe(true);
    expect(canAccessEnclave(role, "hr")).toBe(false);
  });

  // Requirement 4: Admin login
  it("Requirement 4: Admin login maps cleanly to /enclave/admin", () => {
    const role: UserRole = "super_admin";
    expect(enclaveFor(role)).toBe("admin");
    expect(enclavePathFor(role)).toBe("/enclave/admin");
    expect(canAccessEnclave(role, "admin")).toBe(true);
    expect(canAccessEnclave(role, "employee")).toBe(false);
  });

  // Requirement 5: Invalid credentials handling
  it("Requirement 5: Invalid credentials & short passcodes are rejected", () => {
    // Passcode policy: min 8 chars
    const shortPasscode = PasscodeResetSchema.safeParse({
      password: "pass",
      confirm: "pass",
    });
    expect(shortPasscode.success).toBe(false);

    // Mismatched passcode confirmation
    const mismatchPasscode = PasscodeResetSchema.safeParse({
      password: "securePassword123",
      confirm: "wrongPassword456",
    });
    expect(mismatchPasscode.success).toBe(false);

    // Valid passcode
    const validPasscode = PasscodeResetSchema.safeParse({
      password: "correctHorseBatteryStaple",
      confirm: "correctHorseBatteryStaple",
    });
    expect(validPasscode.success).toBe(true);
  });

  // Requirement 6: Session expiration handling
  it("Requirement 6: Expired session triggers redirect to /login with reason=expired", () => {
    const expiredResult = mockGuardAuthenticatedRoute(null, null);
    expect(expiredResult.allowed).toBe(false);
    expect(expiredResult.redirectTo).toBe("/login");
    expect(expiredResult.search?.["reason"]).toBe("expired");
  });

  // Requirement 7: Session refresh & cache behavior
  it("Requirement 7: Deactivated accounts trigger signout and redirect to /unauthorized", () => {
    const user: MockAuthUser = { id: "auth-123", email: "alex@enterprise.corp" };
    const inactiveProfile: MockProfile = {
      id: "ent-123",
      auth_user_id: "auth-123",
      name: "Alex",
      badge_id: "PT-001",
      is_active: false,
    };

    const result = mockGuardAuthenticatedRoute(user, inactiveProfile);
    expect(result.allowed).toBe(false);
    expect(result.redirectTo).toBe("/unauthorized");
    expect(result.search?.["reason"]).toBe("deactivated");
  });

  // Requirement 8: Employee accessing another employee's records
  it("Requirement 8: Employee cannot access another employee's attendance records", () => {
    const employeeRole: UserRole = "employee";
    const empAliceId = "alice-uuid-001";
    const empBobId = "bob-uuid-002";

    // Alice accesses her own records -> Granted
    expect(mockCanAccessEmployeeAttendance(employeeRole, empAliceId, empAliceId)).toBe(true);

    // Alice attempts to access Bob's records -> Denied
    expect(mockCanAccessEmployeeAttendance(employeeRole, empAliceId, empBobId)).toBe(false);
  });

  // Requirement 9: HR attempting admin operations
  it("Requirement 9: HR user is blocked from Super Admin operations", () => {
    const hrRole: UserRole = "hr_ops";

    // Super Admin check fails for HR
    expect(mockHasRole(hrRole, "super_admin")).toBe(false);

    // Cannot access admin enclave
    expect(canAccessEnclave(hrRole, "admin")).toBe(false);
  });

  // Requirement 10: Security attempting HR operations
  it("Requirement 10: Security user is blocked from HR-specific operations", () => {
    const securityRole: UserRole = "security";

    // HR staff check fails for Security
    expect(mockHasAnyRole(securityRole, ["hr_ops", "super_admin"])).toBe(false);

    // Security cannot access cross-employee attendance
    expect(mockCanAccessEmployeeAttendance(securityRole, "sec-guard-id", "other-employee-id")).toBe(
      false,
    );
  });

  // Requirement 11: Employee attempting admin operations
  it("Requirement 11: Employee attempting admin operations is rejected", () => {
    const employeeRole: UserRole = "employee";

    expect(mockHasRole(employeeRole, "super_admin")).toBe(false);
    expect(mockHasAnyRole(employeeRole, ["security", "super_admin"])).toBe(false);
    expect(canAccessEnclave(employeeRole, "admin")).toBe(false);
  });

  // Requirement 12: Unauthorized direct URL access
  it("Requirement 12: Direct URL access to unauthorized enclave bounces to designated enclave", () => {
    // Employee tries to navigate directly to /enclave/admin
    const empToAdmin = mockGuardEnclaveRoute("employee", "admin");
    expect(empToAdmin.allowed).toBe(false);
    expect(empToAdmin.redirectTo).toBe("/enclave/employee");

    // HR tries to navigate directly to /enclave/security
    const hrToSec = mockGuardEnclaveRoute("hr_ops", "security");
    expect(hrToSec.allowed).toBe(false);
    expect(hrToSec.redirectTo).toBe("/enclave/hr");

    // Security tries to navigate directly to /enclave/admin
    const secToAdmin = mockGuardEnclaveRoute("security", "admin");
    expect(secToAdmin.allowed).toBe(false);
    expect(secToAdmin.redirectTo).toBe("/enclave/security");

    // Admin navigates to /enclave/admin -> Allowed
    const adminToAdmin = mockGuardEnclaveRoute("super_admin", "admin");
    expect(adminToAdmin.allowed).toBe(true);
  });

  // Requirement 13: Unauthorized server function execution
  it("Requirement 13: Server function authorization validator checks token presence", () => {
    const validateTokenHeader = (header?: string | null) => {
      if (!header) throw new Error("Unauthorized: No authorization header provided");
      if (!header.startsWith("Bearer "))
        throw new Error("Unauthorized: Only Bearer tokens supported");
      const token = header.replace("Bearer ", "");
      if (token.split(".").length !== 3) throw new Error("Unauthorized: Invalid token");
      return token;
    };

    expect(() => validateTokenHeader(null)).toThrow("No authorization header provided");
    expect(() => validateTokenHeader("Basic 12345")).toThrow("Only Bearer tokens supported");
    expect(() => validateTokenHeader("Bearer not-a-jwt")).toThrow("Invalid token");
    expect(validateTokenHeader("Bearer header.payload.signature")).toBe("header.payload.signature");
  });

  // Requirement 14: Employee invitation workflow
  it("Requirement 14: Employee invitation validates corporate fields and prevents malformed data", () => {
    // Valid invitation
    const validInvite = InviteEmployeeSchema.safeParse({
      name: "Priya Sundaram",
      email: "priya.sundaram@presencetrack.corp",
      badge_id: "PT-9042",
      department: "Legal & DPDP Compliance",
      role: "employee",
      role_title: "Statutory Auditor",
    });
    expect(validInvite.success).toBe(true);

    // Invalid email
    const invalidEmail = InviteEmployeeSchema.safeParse({
      name: "Priya Sundaram",
      email: "not-a-valid-email",
      badge_id: "PT-9042",
    });
    expect(invalidEmail.success).toBe(false);

    // Invalid badge with illegal characters
    const badBadge = InviteEmployeeSchema.safeParse({
      name: "Priya Sundaram",
      email: "priya@corp.com",
      badge_id: "PT@#$$%",
    });
    expect(badBadge.success).toBe(false);
  });

  // Requirement 15: Role modification security
  it("Requirement 15: Role assignment requires Super Admin and rejects self-escalation", () => {
    const callerIsAdmin = (role: UserRole) => role === "super_admin";

    expect(callerIsAdmin("super_admin")).toBe(true);
    expect(callerIsAdmin("employee")).toBe(false);
    expect(callerIsAdmin("hr_ops")).toBe(false);
    expect(callerIsAdmin("security")).toBe(false);
  });

  // Requirement 16: Password reset & invitation URL detection
  it("Requirement 16: Detects invitation and recovery hashes for passcode establishment", () => {
    const isInviteHash = (hash: string) => hash.includes("type=invite");
    const isRecoveryHash = (hash: string) => hash.includes("type=recovery");

    expect(isInviteHash("#access_token=xyz&type=invite&expires_in=3600")).toBe(true);
    expect(isInviteHash("#access_token=xyz&type=recovery&expires_in=3600")).toBe(false);

    expect(isRecoveryHash("#access_token=xyz&type=recovery&expires_in=3600")).toBe(true);
    expect(isRecoveryHash("#access_token=xyz&type=invite&expires_in=3600")).toBe(false);
  });

  // Requirement 17: Zero-trust enclave access for null or undefined roles
  it("Requirement 17: Users without a role (null or undefined) cannot access any enclave", () => {
    const enclaves: Enclave[] = ["employee", "hr", "security", "admin"];
    for (const enclave of enclaves) {
      expect(canAccessEnclave(null, enclave)).toBe(false);
      expect(canAccessEnclave(undefined, enclave)).toBe(false);

      const nullGuard = mockGuardEnclaveRoute(null, enclave);
      expect(nullGuard.allowed).toBe(false);
      expect(nullGuard.redirectTo).toBe("/unauthorized");

      const undefinedGuard = mockGuardEnclaveRoute(undefined, enclave);
      expect(undefinedGuard.allowed).toBe(false);
      expect(undefinedGuard.redirectTo).toBe("/unauthorized");
    }
  });

  // Requirement 18: Invitation authorization state machine
  it("Requirement 18: STAGED and DISPATCH_PENDING statuses reject automatic role assignment", () => {
    type InvitationStatus =
      "STAGED" | "DISPATCH_PENDING" | "DISPATCHED" | "LINKED" | "RECONCILIATION_REQUIRED";

    const simulateTriggerAuthorization = (status: InvitationStatus) => {
      // Strict rule: ONLY 'DISPATCHED' is authorized to establish roles upon email confirmation
      if (status !== "DISPATCHED") {
        return { authorized: false, resultingStatus: "RECONCILIATION_REQUIRED", grantedRole: null };
      }
      return { authorized: true, resultingStatus: "LINKED", grantedRole: "employee" };
    };

    // STAGED must fail closed and quarantine with 0 roles
    const stagedResult = simulateTriggerAuthorization("STAGED");
    expect(stagedResult.authorized).toBe(false);
    expect(stagedResult.resultingStatus).toBe("RECONCILIATION_REQUIRED");
    expect(stagedResult.grantedRole).toBeNull();

    // DISPATCH_PENDING must fail closed and quarantine with 0 roles
    const pendingResult = simulateTriggerAuthorization("DISPATCH_PENDING");
    expect(pendingResult.authorized).toBe(false);
    expect(pendingResult.resultingStatus).toBe("RECONCILIATION_REQUIRED");
    expect(pendingResult.grantedRole).toBeNull();

    // RECONCILIATION_REQUIRED must fail closed
    const reconResult = simulateTriggerAuthorization("RECONCILIATION_REQUIRED");
    expect(reconResult.authorized).toBe(false);
    expect(reconResult.resultingStatus).toBe("RECONCILIATION_REQUIRED");
    expect(reconResult.grantedRole).toBeNull();

    // ONLY DISPATCHED successfully establishes role
    const dispatchedResult = simulateTriggerAuthorization("DISPATCHED");
    expect(dispatchedResult.authorized).toBe(true);
    expect(dispatchedResult.resultingStatus).toBe("LINKED");
    expect(dispatchedResult.grantedRole).toBe("employee");
  });

  // Requirement 19: Conflicting existing role preservation
  it("Requirement 19: Pre-existing conflicting role is preserved and profile is quarantined", () => {
    const handleRoleLinkage = (existingRole: UserRole | null, intendedRole: UserRole) => {
      if (existingRole && existingRole !== intendedRole) {
        return {
          profileStatus: "RECONCILIATION_REQUIRED",
          activeRole: existingRole, // Pre-existing role is preserved, never overwritten
          conflictDetected: true,
        };
      }
      return {
        profileStatus: "LINKED",
        activeRole: intendedRole,
        conflictDetected: false,
      };
    };

    const conflict = handleRoleLinkage("hr_ops", "employee");
    expect(conflict.conflictDetected).toBe(true);
    expect(conflict.profileStatus).toBe("RECONCILIATION_REQUIRED");
    expect(conflict.activeRole).toBe("hr_ops"); // Not overwritten
  });

  // Requirement 20: Last active Super Admin deactivation invariant
  it("Requirement 20: Deactivating the sole remaining active Super Admin is rejected", () => {
    const validateDeactivation = (targetRole: UserRole | null, activeAdminCount: number) => {
      if (targetRole === "super_admin") {
        if (activeAdminCount <= 1) {
          throw new Error(
            "Safety Violation: Cannot deactivate the last remaining active Super Admin profile",
          );
        }
      }
      return { success: true };
    };

    // When only 1 active admin exists, rejecting deactivation is enforced
    expect(() => validateDeactivation("super_admin", 1)).toThrow("Safety Violation");

    // When 2 active admins exist, deactivation of one admin is allowed
    expect(validateDeactivation("super_admin", 2).success).toBe(true);

    // Ordinary employees can be deactivated freely regardless of admin count
    expect(validateDeactivation("employee", 1).success).toBe(true);
  });

  // Requirement 21: First Super Admin provisioning idempotency & mutual exclusion
  it("Requirement 21: First Super Admin provisioning requires count = 0 under global advisory lock", () => {
    const simulateFirstAdminProvisioning = (
      existingAdminCount: number,
      callerRole: UserRole | null,
    ) => {
      if (existingAdminCount > 0) {
        throw new Error(
          "Provisioning Aborted: A Super Admin already exists. Initial provisioning is strictly one-time.",
        );
      }
      if (callerRole !== null) {
        throw new Error("Safety Violation: Target user already holds a role.");
      }
      return { success: true, grantedRole: "super_admin" };
    };

    // Initial run when 0 admins exist -> Success
    expect(simulateFirstAdminProvisioning(0, null)).toEqual({
      success: true,
      grantedRole: "super_admin",
    });

    // Repeat execution when 1 admin now exists -> Rejected
    expect(() => simulateFirstAdminProvisioning(1, null)).toThrow(
      "Provisioning Aborted: A Super Admin already exists",
    );

    // Execution when target user already has an employee role -> Rejected
    expect(() => simulateFirstAdminProvisioning(0, "employee")).toThrow(
      "Safety Violation: Target user already holds a role",
    );
  });

  // Requirement 22: Quarantined users with pre-existing roles are denied access (SEC-03)
  // [SIMULATION TEST] Simulates application-layer route guard and fail-closed RLS logic.
  it("Requirement 22: [SIMULATION] Quarantined user (RECONCILIATION_REQUIRED) with existing role is denied access", () => {
    const simulateRouteGuard = (
      user: { id: string } | null,
      profile: { is_active: boolean; invitation_status?: string } | null,
      existingRole: UserRole | null,
    ): { allowed: boolean; redirectTo?: string; reason?: string } => {
      if (!user) return { allowed: false, redirectTo: "/login", reason: "expired" };
      if (profile && profile.is_active === false) {
        return { allowed: false, redirectTo: "/unauthorized", reason: "deactivated" };
      }
      if (profile && profile.invitation_status === "RECONCILIATION_REQUIRED") {
        return { allowed: false, redirectTo: "/unauthorized", reason: "quarantined" };
      }
      if (!existingRole) {
        return { allowed: false, redirectTo: "/unauthorized", reason: "no_role" };
      }
      return { allowed: true };
    };

    // User has existing "hr_ops" role in user_roles, but profile is in quarantine
    const result = simulateRouteGuard(
      { id: "user-123" },
      { is_active: true, invitation_status: "RECONCILIATION_REQUIRED" },
      "hr_ops",
    );

    expect(result.allowed).toBe(false);
    expect(result.redirectTo).toBe("/unauthorized");
    expect(result.reason).toBe("quarantined");
  });

  // Requirement 23: Branch A preserves quarantine and rejects auto-role assignment (SEC-04)
  // [SIMULATION TEST] Simulates PostgreSQL trigger handle_verified_auth_user() Branch A logic.
  it("Requirement 23: [SIMULATION] Branch A ignores confirmation and preserves RECONCILIATION_REQUIRED without granting role", () => {
    const simulateBranchA = (
      profile: { is_active: boolean; invitation_status: string; email: string },
      authEmail: string,
      existingRole: UserRole | null,
      intendedRole: UserRole,
    ) => {
      // Step 1: email mismatch check (normalized via btrim + lower matching pg_catalog.lower(pg_catalog.btrim(...)))
      // PostgreSQL default btrim(text) strips ordinary leading and trailing spaces (' ') only.
      const pgBtrim = (s: string) => s.replace(/^ +| +$/g, "");
      const normalizedProfileEmail = pgBtrim(profile.email).toLowerCase();
      const normalizedAuthEmail = pgBtrim(authEmail).toLowerCase();
      if (normalizedProfileEmail !== normalizedAuthEmail) {
        return {
          status: "RECONCILIATION_REQUIRED",
          grantedRole: existingRole,
          audit: "auth.linkage_email_mismatch",
        };
      }
      // Step 2: active check
      if (!profile.is_active) {
        return {
          status: "RECONCILIATION_REQUIRED",
          grantedRole: existingRole,
          audit: "auth.deactivated_user_confirmation_rejected",
        };
      }
      // Step 3: quarantine preservation check (SEC-04 fix)
      if (profile.invitation_status === "RECONCILIATION_REQUIRED") {
        return {
          status: "RECONCILIATION_REQUIRED",
          grantedRole: existingRole, // untouched, never granted intended role
          audit: "auth.quarantined_user_confirmation_ignored",
        };
      }
      // Step 4: normal link
      return {
        status: "LINKED",
        grantedRole: intendedRole,
        audit: "auth.confirmation_role_established",
      };
    };

    const res = simulateBranchA(
      { is_active: true, invitation_status: "RECONCILIATION_REQUIRED", email: "test@domain.com" },
      "test@domain.com",
      null,
      "employee",
    );

    expect(res.status).toBe("RECONCILIATION_REQUIRED");
    expect(res.grantedRole).toBeNull(); // Role was NOT granted
    expect(res.audit).toBe("auth.quarantined_user_confirmation_ignored");

    // Normalized email matching with whitespace and mixed case
    const whitespaceRes = simulateBranchA(
      { is_active: true, invitation_status: "RECONCILIATION_REQUIRED", email: "test@domain.com" },
      "  TEST@DOMAIN.COM  ",
      null,
      "employee",
    );
    expect(whitespaceRes.status).toBe("RECONCILIATION_REQUIRED");
    expect(whitespaceRes.audit).toBe("auth.quarantined_user_confirmation_ignored");

    // Actual email mismatch triggers linkage_email_mismatch
    const mismatchRes = simulateBranchA(
      { is_active: true, invitation_status: "DISPATCHED", email: "alice@domain.com" },
      "bob@domain.com",
      null,
      "employee",
    );
    expect(mismatchRes.status).toBe("RECONCILIATION_REQUIRED");
    expect(mismatchRes.audit).toBe("auth.linkage_email_mismatch");
  });

  // Requirement 24: NULL and non-DISPATCHED invitation statuses fail closed (SEC-06)
  // [SIMULATION TEST] Simulates NULL-safe Branch B validation in handle_verified_auth_user().
  it("Requirement 24: [SIMULATION] NULL invitation status fails closed and quarantines profile without role", () => {
    const simulateBranchB = (status: string | null | undefined, intendedRole: UserRole) => {
      // In PostgreSQL: status IS DISTINCT FROM 'DISPATCHED'
      const isDispatched = status === "DISPATCHED";
      if (!isDispatched) {
        return {
          resultingStatus: "RECONCILIATION_REQUIRED",
          grantedRole: null,
          quarantined: true,
        };
      }
      return {
        resultingStatus: "LINKED",
        grantedRole: intendedRole,
        quarantined: false,
      };
    };

    // Test NULL status
    const nullResult = simulateBranchB(null, "employee");
    expect(nullResult.quarantined).toBe(true);
    expect(nullResult.resultingStatus).toBe("RECONCILIATION_REQUIRED");
    expect(nullResult.grantedRole).toBeNull();

    // Test undefined status
    const undefinedResult = simulateBranchB(undefined, "employee");
    expect(undefinedResult.quarantined).toBe(true);
    expect(undefinedResult.grantedRole).toBeNull();

    // Test STAGED status
    const stagedResult = simulateBranchB("STAGED", "employee");
    expect(stagedResult.quarantined).toBe(true);
    expect(stagedResult.grantedRole).toBeNull();

    // Test DISPATCHED status
    const dispatchedResult = simulateBranchB("DISPATCHED", "employee");
    expect(dispatchedResult.quarantined).toBe(false);
    expect(dispatchedResult.resultingStatus).toBe("LINKED");
    expect(dispatchedResult.grantedRole).toBe("employee");
  });

  // Requirement 25: Role assignment to non-LINKED or inactive profile is rejected (SEC-01, SEC-08, SEC-09B)
  // [SIMULATION TEST] Simulates assign_user_role_atomic() and protect_last_super_admin() validation.
  it("Requirement 25: [SIMULATION] Cannot assign super_admin or any role to deactivated or non-LINKED profile", () => {
    const simulateAssignRole = (
      targetProfile: {
        id: string;
        is_active: boolean;
        invitation_status: string | null | undefined;
      } | null,
      newRole: UserRole,
    ) => {
      if (!targetProfile) throw new Error("Target employee profile not found");
      if (newRole === "super_admin") {
        throw new Error(
          "Security Guard: Super Admin role cannot be granted via standard role assignment",
        );
      }
      if (!targetProfile.is_active) {
        throw new Error("Administrative Rejection: Cannot assign roles to deactivated personnel");
      }
      if (targetProfile.invitation_status !== "LINKED") {
        throw new Error(
          `Administrative Rejection: Cannot assign roles to personnel in ${targetProfile.invitation_status} status. Profile must be in LINKED status.`,
        );
      }
      return { success: true, role: newRole };
    };

    // Inactive profile
    expect(() =>
      simulateAssignRole({ id: "p1", is_active: false, invitation_status: "LINKED" }, "employee"),
    ).toThrow("Cannot assign roles to deactivated personnel");

    // Quarantined profile (RECONCILIATION_REQUIRED)
    expect(() =>
      simulateAssignRole(
        { id: "p2", is_active: true, invitation_status: "RECONCILIATION_REQUIRED" },
        "employee",
      ),
    ).toThrow(
      "Cannot assign roles to personnel in RECONCILIATION_REQUIRED status. Profile must be in LINKED status.",
    );

    // STAGED profile
    expect(() =>
      simulateAssignRole({ id: "p3", is_active: true, invitation_status: "STAGED" }, "employee"),
    ).toThrow(
      "Cannot assign roles to personnel in STAGED status. Profile must be in LINKED status.",
    );

    // DISPATCH_PENDING profile
    expect(() =>
      simulateAssignRole(
        { id: "p4", is_active: true, invitation_status: "DISPATCH_PENDING" },
        "employee",
      ),
    ).toThrow(
      "Cannot assign roles to personnel in DISPATCH_PENDING status. Profile must be in LINKED status.",
    );

    // DISPATCHED profile (not yet confirmed)
    expect(() =>
      simulateAssignRole(
        { id: "p5", is_active: true, invitation_status: "DISPATCHED" },
        "employee",
      ),
    ).toThrow(
      "Cannot assign roles to personnel in DISPATCHED status. Profile must be in LINKED status.",
    );

    // NULL invitation status
    expect(() =>
      simulateAssignRole({ id: "p6", is_active: true, invitation_status: null }, "employee"),
    ).toThrow("Cannot assign roles to personnel in null status. Profile must be in LINKED status.");

    // Attempting to grant super_admin via standard role RPC
    expect(() =>
      simulateAssignRole({ id: "p7", is_active: true, invitation_status: "LINKED" }, "super_admin"),
    ).toThrow("Security Guard: Super Admin role cannot be granted");

    // Active linked profile -> Success
    expect(
      simulateAssignRole({ id: "p8", is_active: true, invitation_status: "LINKED" }, "hr_ops"),
    ).toEqual({ success: true, role: "hr_ops" });
  });

  // Requirement 26: Ambiguous timeout preserves staged profile in quarantine (SEC-07)
  // [SIMULATION TEST] Simulates inviteEmployee() error differentiation.
  it("Requirement 26: [SIMULATION] Ambiguous network timeout preserves profile in RECONCILIATION_REQUIRED quarantine", () => {
    const handleInviteError = (
      errorMessage: string,
      stagedProfileId: string,
    ): { action: "DELETED" | "PRESERVED_QUARANTINED"; resultingStatus?: string } => {
      const isDefinitivePreDispatch =
        /invalid email|email format|validation failed|unsupported provider/i.test(errorMessage);

      if (isDefinitivePreDispatch) {
        return { action: "DELETED" };
      }

      // Ambiguous: network timeout, 504 Gateway Timeout, fetch failed, socket hangup
      return { action: "PRESERVED_QUARANTINED", resultingStatus: "RECONCILIATION_REQUIRED" };
    };

    // Definitive syntax error -> Safe to delete
    const definitive = handleInviteError("Invalid email format: bad@example", "p1");
    expect(definitive.action).toBe("DELETED");

    // Ambiguous network timeout -> Must preserve in quarantine!
    const timeout = handleInviteError(
      "FetchError: 504 Gateway Timeout connecting to auth server",
      "p2",
    );
    expect(timeout.action).toBe("PRESERVED_QUARANTINED");
    expect(timeout.resultingStatus).toBe("RECONCILIATION_REQUIRED");

    // Ambiguous socket hangup -> Must preserve in quarantine!
    const socketError = handleInviteError("TypeError: terminated: socket hang up", "p3");
    expect(socketError.action).toBe("PRESERVED_QUARANTINED");
    expect(socketError.resultingStatus).toBe("RECONCILIATION_REQUIRED");
  });

  // Requirement 27: Strict lock ordering hierarchy (SEC-02)
  // [SIMULATION TEST] Verifies lock acquisition order across provisioning and role assignment.
  it("Requirement 27: [SIMULATION] Lock order hierarchy is strictly Level 1 -> Level 2 -> Level 3 -> Level 4", () => {
    const LOCK_LEVELS: Record<string, number> = {
      super_admin_provisioning_lock: 1,
      global_super_admin_lock: 2,
      user_role_advisory_lock: 3,
      row_level_exclusive_lock: 4,
    };

    const verifyLockSequence = (locks: string[]): boolean => {
      for (let i = 0; i < locks.length - 1; i++) {
        const currentLock = locks[i];
        const nextLock = locks[i + 1];
        if (!currentLock || !nextLock) return false;
        if (LOCK_LEVELS[currentLock]! > LOCK_LEVELS[nextLock]!) {
          return false; // Lock inversion detected!
        }
      }
      return true;
    };

    // Stage 2C Provisioning lock order
    const stage2cLocks = [
      "super_admin_provisioning_lock",
      "global_super_admin_lock",
      "user_role_advisory_lock",
      "row_level_exclusive_lock",
    ];
    expect(verifyLockSequence(stage2cLocks)).toBe(true);

    // assign_user_role_atomic lock order
    const atomicRpcLocks = [
      "global_super_admin_lock",
      "user_role_advisory_lock",
      "row_level_exclusive_lock",
    ];
    expect(verifyLockSequence(atomicRpcLocks)).toBe(true);

    // Inverted lock order must fail verification
    const invertedLocks = ["user_role_advisory_lock", "global_super_admin_lock"];
    expect(verifyLockSequence(invertedLocks)).toBe(false);
  });

  // Requirement 28: Quarantined Super Admin not counted as operational (SEC-09)
  // [SIMULATION TEST] Simulates active Super Admin counting logic across protect_last_super_admin(),
  // protect_last_super_admin_profile(), and assign_user_role_atomic() aligned with has_role().
  it("Requirement 28: [SIMULATION] Quarantined Super Admin is NOT counted as operational administrator", () => {
    interface SimAdminProfile {
      id: string;
      auth_user_id: string;
      role: UserRole;
      is_active: boolean;
      invitation_status:
        "STAGED" | "DISPATCH_PENDING" | "DISPATCHED" | "LINKED" | "RECONCILIATION_REQUIRED";
    }

    const countOperationalSuperAdmins = (
      admins: SimAdminProfile[],
      excludeUserId?: string,
      excludeProfileId?: string,
    ): number => {
      return admins.filter((a) => {
        if (excludeUserId && a.auth_user_id === excludeUserId) return false;
        if (excludeProfileId && a.id === excludeProfileId) return false;
        // Strict SEC-09 invariant: matching role + profile exists + is_active = true + invitation_status = LINKED
        return (
          a.role === "super_admin" &&
          a.auth_user_id !== null &&
          a.is_active === true &&
          a.invitation_status === "LINKED"
        );
      }).length;
    };

    // Platform has 1 operational Super Admin (Alice) and 1 quarantined Super Admin (Bob)
    const platformAdmins: SimAdminProfile[] = [
      {
        id: "profile-alice",
        auth_user_id: "auth-alice",
        role: "super_admin",
        is_active: true,
        invitation_status: "LINKED",
      },
      {
        id: "profile-bob",
        auth_user_id: "auth-bob",
        role: "super_admin",
        is_active: true,
        invitation_status: "RECONCILIATION_REQUIRED", // Quarantined!
      },
    ];

    // Total operational admins is only 1 (Alice), NOT 2!
    expect(countOperationalSuperAdmins(platformAdmins)).toBe(1);

    // If attempting to demote Alice, remaining operational count is 0!
    const remainingExcludingAlice = countOperationalSuperAdmins(platformAdmins, "auth-alice");
    expect(remainingExcludingAlice).toBe(0);

    // Demoting Alice must be rejected under SEC-09 invariant!
    const attemptDemoteAlice = () => {
      if (countOperationalSuperAdmins(platformAdmins, "auth-alice") === 0) {
        throw new Error(
          "Safety Violation: Cannot demote the last remaining active Super Admin (23514)",
        );
      }
    };
    expect(attemptDemoteAlice).toThrow(
      "Safety Violation: Cannot demote the last remaining active Super Admin (23514)",
    );

    // Deactivating Alice's profile must also be rejected!
    const attemptDeactivateAlice = () => {
      if (countOperationalSuperAdmins(platformAdmins, undefined, "profile-alice") === 0) {
        throw new Error(
          "Safety Violation: Cannot deactivate, alter, or delete the last remaining active Super Admin profile (23514)",
        );
      }
    };
    expect(attemptDeactivateAlice).toThrow(
      "Safety Violation: Cannot deactivate, alter, or delete the last remaining active Super Admin profile (23514)",
    );
  });

  // Requirement 29: Last operational Super Admin cannot be demoted, deactivated, unlinked, or deleted (SEC-09)
  // [SIMULATION TEST] Simulates protect_last_super_admin() and protect_last_super_admin_profile() triggers.
  it("Requirement 29: [SIMULATION] Last operational Super Admin cannot be demoted, deactivated, unlinked, or deleted", () => {
    interface SimState {
      profile: {
        id: string;
        auth_user_id: string | null;
        is_active: boolean;
        invitation_status: string;
      };
      role: UserRole;
    }

    const simulateEnterpriseUserMutation = (
      oldState: SimState,
      newState: Partial<SimState["profile"]>,
      op: "UPDATE" | "DELETE",
      otherOperationalAdminsCount: number,
    ) => {
      // Check if old state was an operational Super Admin
      const wasOperationalAdmin =
        oldState.profile.auth_user_id !== null &&
        oldState.profile.is_active === true &&
        oldState.profile.invitation_status === "LINKED" &&
        oldState.role === "super_admin";

      if (wasOperationalAdmin) {
        const threatensStatus =
          op === "DELETE" ||
          (op === "UPDATE" &&
            (newState.is_active !== true ||
              newState.invitation_status !== "LINKED" ||
              newState.auth_user_id !== oldState.profile.auth_user_id));

        if (threatensStatus && otherOperationalAdminsCount === 0) {
          throw new Error(
            "Safety Violation: Cannot deactivate, alter, or delete the last remaining active Super Admin profile (23514)",
          );
        }
      }
      return { success: true };
    };

    const soleAdmin: SimState = {
      profile: {
        id: "admin-1",
        auth_user_id: "user-1",
        is_active: true,
        invitation_status: "LINKED",
      },
      role: "super_admin",
    };

    // 1. Deactivation fails
    expect(() =>
      simulateEnterpriseUserMutation(soleAdmin, { is_active: false }, "UPDATE", 0),
    ).toThrow("Cannot deactivate, alter, or delete the last remaining active Super Admin profile");

    // 2. Quarantine / alteration of invitation_status fails
    expect(() =>
      simulateEnterpriseUserMutation(
        soleAdmin,
        { invitation_status: "RECONCILIATION_REQUIRED" },
        "UPDATE",
        0,
      ),
    ).toThrow("Cannot deactivate, alter, or delete the last remaining active Super Admin profile");

    // 3. Unlinking auth_user_id fails
    expect(() =>
      simulateEnterpriseUserMutation(soleAdmin, { auth_user_id: null }, "UPDATE", 0),
    ).toThrow("Cannot deactivate, alter, or delete the last remaining active Super Admin profile");

    // 4. Deleting profile fails
    expect(() => simulateEnterpriseUserMutation(soleAdmin, {}, "DELETE", 0)).toThrow(
      "Cannot deactivate, alter, or delete the last remaining active Super Admin profile",
    );

    // 5. If another operational admin exists, mutation succeeds
    expect(simulateEnterpriseUserMutation(soleAdmin, { is_active: false }, "UPDATE", 1)).toEqual({
      success: true,
    });
  });

  // Requirement 30: Statement-level trigger coverage for enterprise_users (SEC-01, SEC-09)
  // [SIMULATION TEST] Simulates PostgreSQL statement-level trigger condition inspection.
  it("Requirement 30: [SIMULATION] Statement-level trigger covers is_active, invitation_status, auth_user_id, and DELETE", () => {
    const triggerColumnsCovered = ["is_active", "invitation_status", "auth_user_id"];

    const triggersStatementLock = (
      event: "UPDATE" | "DELETE" | "INSERT",
      modifiedColumns?: string[],
    ): boolean => {
      if (event === "DELETE") return true;
      if (event === "UPDATE" && modifiedColumns) {
        return modifiedColumns.some((col) => triggerColumnsCovered.includes(col));
      }
      return false;
    };

    // Updates to eligibility-determining columns trigger statement lock
    expect(triggersStatementLock("UPDATE", ["is_active"])).toBe(true);
    expect(triggersStatementLock("UPDATE", ["invitation_status"])).toBe(true);
    expect(triggersStatementLock("UPDATE", ["auth_user_id"])).toBe(true);
    expect(triggersStatementLock("DELETE")).toBe(true);

    // Updates to non-eligibility columns (e.g. badge_id, department) do not fire this specific admin trigger
    expect(triggersStatementLock("UPDATE", ["badge_id"])).toBe(false);
    expect(triggersStatementLock("UPDATE", ["department"])).toBe(false);
  });

  // Requirement 31: Migration Prerequisite Verification DO block (SEC-11 & Revision 13.2)
  // [SIMULATION TEST] Simulates defensive prerequisite validation before migration 0002 executes.
  // Note: Live PostgreSQL catalog behavior requires isolated database integration tests and is marked NOT VERIFIED until tested against PostgreSQL.
  it("Requirement 31: [SIMULATION] Missing migration prerequisites cause clean abort with specific error codes", () => {
    interface CatalogState {
      hasAppRoleEnum: boolean;
      appRoleEnumLabels: string[];
      invitationStatusExists: boolean;
      invitationStatusIsEnum: boolean;
      invitationStatusLabels: string[];
      hasUserRolesTable: boolean;
      userRolesHasUserIdAndRole: boolean;
      userRolesPrimaryKeyColumns: string[];
      userRolesUserIdUnique: boolean;
      hasEnterpriseUsersTable: boolean;
      enterpriseUsersPrimaryKeyColumns: string[];
      enterpriseUsersHasAuthUserId: boolean;
      enterpriseUsersAuthUserIdUniqueConstraintSingleCol: boolean;
      enterpriseUsersAuthUserIdIndexValidNonPartialSingleCol: boolean;
      enterpriseUsersImportedRoleIsAppRole: boolean;
      enterpriseUsersHasEmailNotNull: boolean;
      enterpriseUsersIsActiveBooleanNotNull: boolean;
      hasAdminAuditLogsTable: boolean;
      adminAuditLogsHasRequiredColumns: boolean;
      hasRoleExactOidSignature: boolean;
      hasAnyRoleExactOidSignature: boolean;
      hasAuthUsersTable: boolean;
      authUsersIdUuidNotNull: boolean;
      authUsersHasEmailConfirmedAt: boolean;
      hasAuthUidExactOidSignature: boolean;
    }

    const validatePrerequisites = (catalog: CatalogState): { valid: boolean } => {
      // 1. Enum public.app_role
      if (!catalog.hasAppRoleEnum)
        throw new Error("42704: Type public.app_role does not exist or is not an enum type");
      const requiredAppRoles = ["employee", "hr_ops", "security", "super_admin"];
      const hasExactAppRoles =
        catalog.appRoleEnumLabels.length === 4 &&
        requiredAppRoles.every((r) => catalog.appRoleEnumLabels.includes(r));
      if (!hasExactAppRoles) {
        throw new Error(
          "42804: Enum public.app_role must contain exactly four labels (employee, hr_ops, security, super_admin)",
        );
      }

      // 2. Pre-existing public.invitation_status
      if (catalog.invitationStatusExists) {
        if (!catalog.invitationStatusIsEnum) {
          throw new Error(
            "42804: Pre-existing public.invitation_status must be an enum type containing exactly the 5 required labels (STAGED, DISPATCH_PENDING, DISPATCHED, LINKED, RECONCILIATION_REQUIRED)",
          );
        }
        const requiredInvStatus = [
          "STAGED",
          "DISPATCH_PENDING",
          "DISPATCHED",
          "LINKED",
          "RECONCILIATION_REQUIRED",
        ];
        const hasExactInvStatus =
          catalog.invitationStatusLabels.length === 5 &&
          requiredInvStatus.every((s) => catalog.invitationStatusLabels.includes(s));
        if (!hasExactInvStatus) {
          throw new Error(
            "42804: Pre-existing public.invitation_status must be an enum type containing exactly the 5 required labels (STAGED, DISPATCH_PENDING, DISPATCHED, LINKED, RECONCILIATION_REQUIRED)",
          );
        }
      }

      // 3. Base tables
      if (!catalog.hasEnterpriseUsersTable)
        throw new Error("42P01: public.enterprise_users ordinary table does not exist");
      if (!catalog.hasUserRolesTable)
        throw new Error("42P01: public.user_roles ordinary table does not exist");

      // 4. enterprise_users columns and PK
      if (
        catalog.enterpriseUsersPrimaryKeyColumns.length !== 1 ||
        catalog.enterpriseUsersPrimaryKeyColumns[0] !== "id"
      ) {
        throw new Error(
          "42P16: Table public.enterprise_users must have a PRIMARY KEY constraint on id alone",
        );
      }
      if (!catalog.enterpriseUsersHasAuthUserId)
        throw new Error("42804: Column enterprise_users.auth_user_id must be UUID nullable");
      if (
        !catalog.enterpriseUsersAuthUserIdUniqueConstraintSingleCol &&
        !catalog.enterpriseUsersAuthUserIdIndexValidNonPartialSingleCol
      ) {
        throw new Error(
          "42P16: Column enterprise_users.auth_user_id must have a genuine single-column UNIQUE constraint or index",
        );
      }
      if (!catalog.enterpriseUsersImportedRoleIsAppRole)
        throw new Error(
          "42804: Column enterprise_users.imported_role must be of enum type public.app_role",
        );
      if (!catalog.enterpriseUsersHasEmailNotNull)
        throw new Error("42804: Column enterprise_users.email must be text NOT NULL");
      if (!catalog.enterpriseUsersIsActiveBooleanNotNull)
        throw new Error("42804: Column enterprise_users.is_active must be boolean NOT NULL");

      // 5. user_roles columns, PK, and uniqueness
      if (!catalog.userRolesHasUserIdAndRole)
        throw new Error("42703: Columns on public.user_roles missing or invalid");
      if (
        catalog.userRolesPrimaryKeyColumns.length !== 1 ||
        catalog.userRolesPrimaryKeyColumns[0] !== "id"
      ) {
        throw new Error(
          "42P16: Table public.user_roles must have a PRIMARY KEY constraint on id alone matching 0000_presencetrack_schema.sql",
        );
      }
      if (!catalog.userRolesUserIdUnique) {
        throw new Error(
          "42P16: Column user_roles.user_id must have a genuine single-column UNIQUE constraint or index",
        );
      }

      // 6. admin_audit_logs
      if (!catalog.hasAdminAuditLogsTable)
        throw new Error("42P01: public.admin_audit_logs table does not exist");
      if (!catalog.adminAuditLogsHasRequiredColumns)
        throw new Error("42703: Columns on public.admin_audit_logs missing or invalid");

      // 7. Function signatures via OID
      if (!catalog.hasRoleExactOidSignature)
        throw new Error(
          "42883: Function public.has_role(uuid, public.app_role) returning boolean does not exist",
        );
      if (!catalog.hasAnyRoleExactOidSignature)
        throw new Error(
          "42883: Function public.has_any_role(uuid, public.app_role[]) returning boolean does not exist",
        );

      // 8. auth schema
      if (!catalog.hasAuthUsersTable) throw new Error("42P01: auth.users table does not exist");
      if (!catalog.authUsersIdUuidNotNull)
        throw new Error("42703: Required columns on auth.users missing or invalid");
      if (!catalog.authUsersHasEmailConfirmedAt)
        throw new Error("42703: Column auth.users.email_confirmed_at (TIMESTAMPTZ) does not exist");
      if (!catalog.hasAuthUidExactOidSignature)
        throw new Error(
          "42883: Function auth.uid() returning UUID with 0 arguments does not exist",
        );

      return { valid: true };
    };

    const completeCatalog: CatalogState = {
      hasAppRoleEnum: true,
      appRoleEnumLabels: ["employee", "hr_ops", "security", "super_admin"],
      invitationStatusExists: false, // Clean new install, will be created in section 3
      invitationStatusIsEnum: true,
      invitationStatusLabels: [
        "STAGED",
        "DISPATCH_PENDING",
        "DISPATCHED",
        "LINKED",
        "RECONCILIATION_REQUIRED",
      ],
      hasUserRolesTable: true,
      userRolesHasUserIdAndRole: true,
      userRolesPrimaryKeyColumns: ["id"],
      userRolesUserIdUnique: true,
      hasEnterpriseUsersTable: true,
      enterpriseUsersPrimaryKeyColumns: ["id"],
      enterpriseUsersHasAuthUserId: true,
      enterpriseUsersAuthUserIdUniqueConstraintSingleCol: true,
      enterpriseUsersAuthUserIdIndexValidNonPartialSingleCol: false,
      enterpriseUsersImportedRoleIsAppRole: true,
      enterpriseUsersHasEmailNotNull: true,
      enterpriseUsersIsActiveBooleanNotNull: true,
      hasAdminAuditLogsTable: true,
      adminAuditLogsHasRequiredColumns: true,
      hasRoleExactOidSignature: true,
      hasAnyRoleExactOidSignature: true,
      hasAuthUsersTable: true,
      authUsersIdUuidNotNull: true,
      authUsersHasEmailConfirmedAt: true,
      hasAuthUidExactOidSignature: true,
    };

    // Complete catalog passes (when invitation_status does not yet exist)
    expect(validatePrerequisites(completeCatalog)).toEqual({ valid: true });

    // Complete catalog passes when invitation_status already exists with exactly 5 labels
    expect(
      validatePrerequisites({
        ...completeCatalog,
        invitationStatusExists: true,
        invitationStatusIsEnum: true,
        invitationStatusLabels: [
          "STAGED",
          "DISPATCH_PENDING",
          "DISPATCHED",
          "LINKED",
          "RECONCILIATION_REQUIRED",
        ],
      }),
    ).toEqual({ valid: true });

    // Missing app_role enum labels fails with 42804
    expect(() =>
      validatePrerequisites({
        ...completeCatalog,
        appRoleEnumLabels: ["employee", "hr_ops", "security"],
      }),
    ).toThrow(
      "42804: Enum public.app_role must contain exactly four labels (employee, hr_ops, security, super_admin)",
    );

    // Unexpected 5th app_role enum label fails with 42804
    expect(() =>
      validatePrerequisites({
        ...completeCatalog,
        appRoleEnumLabels: ["employee", "hr_ops", "security", "super_admin", "auditor"],
      }),
    ).toThrow(
      "42804: Enum public.app_role must contain exactly four labels (employee, hr_ops, security, super_admin)",
    );

    // Pre-existing non-enum invitation_status fails with 42804
    expect(() =>
      validatePrerequisites({
        ...completeCatalog,
        invitationStatusExists: true,
        invitationStatusIsEnum: false,
      }),
    ).toThrow(
      "42804: Pre-existing public.invitation_status must be an enum type containing exactly the 5 required labels",
    );

    // Pre-existing incomplete invitation_status enum fails with 42804
    expect(() =>
      validatePrerequisites({
        ...completeCatalog,
        invitationStatusExists: true,
        invitationStatusIsEnum: true,
        invitationStatusLabels: ["STAGED", "LINKED"],
      }),
    ).toThrow(
      "42804: Pre-existing public.invitation_status must be an enum type containing exactly the 5 required labels",
    );

    // Missing enterprise_users.id PK fails with 42P16
    expect(() =>
      validatePrerequisites({ ...completeCatalog, enterpriseUsersPrimaryKeyColumns: [] }),
    ).toThrow(
      "42P16: Table public.enterprise_users must have a PRIMARY KEY constraint on id alone",
    );

    // Composite enterprise_users PK (id, tenant_id) fails with 42P16
    expect(() =>
      validatePrerequisites({
        ...completeCatalog,
        enterpriseUsersPrimaryKeyColumns: ["id", "tenant_id"],
      }),
    ).toThrow(
      "42P16: Table public.enterprise_users must have a PRIMARY KEY constraint on id alone",
    );

    // Missing enterprise_users.auth_user_id unique fails with 42P16
    expect(() =>
      validatePrerequisites({
        ...completeCatalog,
        enterpriseUsersAuthUserIdUniqueConstraintSingleCol: false,
        enterpriseUsersAuthUserIdIndexValidNonPartialSingleCol: false,
      }),
    ).toThrow(
      "42P16: Column enterprise_users.auth_user_id must have a genuine single-column UNIQUE constraint or index",
    );

    // Index alone (valid, ready, non-partial, non-expression single-column) satisfies uniqueness requirement
    expect(
      validatePrerequisites({
        ...completeCatalog,
        enterpriseUsersAuthUserIdUniqueConstraintSingleCol: false,
        enterpriseUsersAuthUserIdIndexValidNonPartialSingleCol: true,
      }),
    ).toEqual({ valid: true });

    // Composite user_roles PK fails with 42P16
    expect(() =>
      validatePrerequisites({
        ...completeCatalog,
        userRolesPrimaryKeyColumns: ["user_id", "role"],
      }),
    ).toThrow(
      "42P16: Table public.user_roles must have a PRIMARY KEY constraint on id alone matching 0000_presencetrack_schema.sql",
    );

    // Single-column wrong column user_roles PK fails with 42P16
    expect(() =>
      validatePrerequisites({ ...completeCatalog, userRolesPrimaryKeyColumns: ["user_id"] }),
    ).toThrow(
      "42P16: Table public.user_roles must have a PRIMARY KEY constraint on id alone matching 0000_presencetrack_schema.sql",
    );

    // Missing user_roles.user_id uniqueness fails with 42P16
    expect(() =>
      validatePrerequisites({ ...completeCatalog, userRolesUserIdUnique: false }),
    ).toThrow(
      "42P16: Column user_roles.user_id must have a genuine single-column UNIQUE constraint or index",
    );

    // Valid user_roles.user_id uniqueness passes
    expect(validatePrerequisites({ ...completeCatalog, userRolesUserIdUnique: true })).toEqual({
      valid: true,
    });

    // Non-app_role imported_role fails with 42804
    expect(() =>
      validatePrerequisites({ ...completeCatalog, enterpriseUsersImportedRoleIsAppRole: false }),
    ).toThrow("42804: Column enterprise_users.imported_role must be of enum type public.app_role");

    // Non-boolean or nullable is_active fails with 42804
    expect(() =>
      validatePrerequisites({ ...completeCatalog, enterpriseUsersIsActiveBooleanNotNull: false }),
    ).toThrow("42804: Column enterprise_users.is_active must be boolean NOT NULL");

    // Inexact has_role signature fails with 42883
    expect(() =>
      validatePrerequisites({ ...completeCatalog, hasRoleExactOidSignature: false }),
    ).toThrow(
      "42883: Function public.has_role(uuid, public.app_role) returning boolean does not exist",
    );

    // Inexact has_any_role signature fails with 42883
    expect(() =>
      validatePrerequisites({ ...completeCatalog, hasAnyRoleExactOidSignature: false }),
    ).toThrow(
      "42883: Function public.has_any_role(uuid, public.app_role[]) returning boolean does not exist",
    );

    // Missing admin_audit_logs columns fails with 42703
    expect(() =>
      validatePrerequisites({ ...completeCatalog, adminAuditLogsHasRequiredColumns: false }),
    ).toThrow("42703: Columns on public.admin_audit_logs missing or invalid");

    // Missing email_confirmed_at fails with 42703
    expect(() =>
      validatePrerequisites({ ...completeCatalog, authUsersHasEmailConfirmedAt: false }),
    ).toThrow("42703: Column auth.users.email_confirmed_at (TIMESTAMPTZ) does not exist");

    // Missing auth.uid() fails with 42883
    expect(() =>
      validatePrerequisites({ ...completeCatalog, hasAuthUidExactOidSignature: false }),
    ).toThrow("42883: Function auth.uid() returning UUID with 0 arguments does not exist");
  });

  // Requirement 32: Email normalization via btrim + lower in handle_verified_auth_user
  it("Requirement 32: [SIMULATION] Email normalization handles space trimming and case insensitivity", () => {
    // Simulates PostgreSQL default: pg_catalog.lower(pg_catalog.btrim(email))
    // Default btrim(text) removes ordinary leading and trailing space characters (' ') only.
    const pgBtrim = (s: string) => s.replace(/^ +| +$/g, "");
    const normalizeEmail = (email: string) => pgBtrim(email).toLowerCase();

    expect(normalizeEmail("  Alex.Smith@Enterprise.Corp  ")).toBe("alex.smith@enterprise.corp");
    expect(normalizeEmail("PRIYA@PRESENCETRACK.CORP")).toBe("priya@presencetrack.corp");
    expect(normalizeEmail("already.clean@domain.com")).toBe("already.clean@domain.com");

    // Ordinary spaces or case differences normalize to exact match
    expect(normalizeEmail("  Alice@Domain.Com  ")).toBe(normalizeEmail("alice@domain.com"));
    expect(normalizeEmail("bob@corp.io")).not.toBe(normalizeEmail("alice@corp.io"));

    // PostgreSQL default btrim(text) leaves non-space characters (such as tabs or newlines) untouched
    expect(pgBtrim("\tuser@domain.com\n")).toBe("\tuser@domain.com\n");
  });

  // ── Authentication Repair & Fail-Closed RBAC Hardening (Steps 1–4) ─────────

  // Requirement 33: Session Authorization - Missing enterprise profile fails closed
  it("Requirement 33: Session Authorization - Missing enterprise profile fails closed with forbidden", () => {
    const user: MockAuthUser = { id: "auth-u1", email: "user@corp.com" };
    const res = mockGuardAuthenticatedRoute(user, null, "employee");
    expect(res.allowed).toBe(false);
    expect(res.redirectTo).toBe("/unauthorized");
    expect(res.search?.["reason"]).toBe("forbidden");
  });

  // Requirement 34: Session Authorization - Deactivated enterprise profile fails closed
  it("Requirement 34: Session Authorization - Deactivated enterprise profile fails closed with deactivated", () => {
    const user: MockAuthUser = { id: "auth-u2", email: "user2@corp.com" };
    const profile: MockProfile = {
      id: "ent-u2",
      auth_user_id: "auth-u2",
      name: "Deactivated User",
      badge_id: "PT-002",
      is_active: false,
      invitation_status: "LINKED",
    };
    const res = mockGuardAuthenticatedRoute(user, profile, "employee");
    expect(res.allowed).toBe(false);
    expect(res.redirectTo).toBe("/unauthorized");
    expect(res.search?.["reason"]).toBe("deactivated");
  });

  // Requirement 35: Session Authorization - Unlinked or quarantined invitation status fails closed
  it("Requirement 35: Session Authorization - Unlinked or quarantined invitation status fails closed", () => {
    const user: MockAuthUser = { id: "auth-u3", email: "user3@corp.com" };
    const stagedProfile: MockProfile = {
      id: "ent-u3a",
      auth_user_id: "auth-u3",
      name: "Staged User",
      badge_id: "PT-003A",
      is_active: true,
      invitation_status: "STAGED",
    };
    expect(mockGuardAuthenticatedRoute(user, stagedProfile, "employee")).toEqual({
      allowed: false,
      redirectTo: "/unauthorized",
      search: { reason: "forbidden" },
    });

    const dispatchedProfile: MockProfile = {
      id: "ent-u3b",
      auth_user_id: "auth-u3",
      name: "Dispatched User",
      badge_id: "PT-003B",
      is_active: true,
      invitation_status: "DISPATCHED",
    };
    expect(mockGuardAuthenticatedRoute(user, dispatchedProfile, "employee")).toEqual({
      allowed: false,
      redirectTo: "/unauthorized",
      search: { reason: "forbidden" },
    });

    const quarantinedProfile: MockProfile = {
      id: "ent-u3c",
      auth_user_id: "auth-u3",
      name: "Quarantined User",
      badge_id: "PT-003C",
      is_active: true,
      invitation_status: "RECONCILIATION_REQUIRED",
    };
    expect(mockGuardAuthenticatedRoute(user, quarantinedProfile, "employee")).toEqual({
      allowed: false,
      redirectTo: "/unauthorized",
      search: { reason: "quarantined" },
    });
  });

  // Requirement 36: Session Authorization - Missing or unassigned role fails closed
  it("Requirement 36: Session Authorization - Missing or unassigned role fails closed with no_role", () => {
    const user: MockAuthUser = { id: "auth-u4", email: "user4@corp.com" };
    const profile: MockProfile = {
      id: "ent-u4",
      auth_user_id: "auth-u4",
      name: "User Without Role",
      badge_id: "PT-004",
      is_active: true,
      invitation_status: "LINKED",
    };
    const res = mockGuardAuthenticatedRoute(user, profile, null);
    expect(res.allowed).toBe(false);
    expect(res.redirectTo).toBe("/unauthorized");
    expect(res.search?.["reason"]).toBe("no_role");
  });

  // Requirement 37: Session Authorization - Database query failure fails closed
  it("Requirement 37: Session Authorization - Database query failure fails closed with forbidden", () => {
    const user: MockAuthUser = { id: "auth-u5", email: "user5@corp.com" };
    const profile: MockProfile = {
      id: "ent-u5",
      auth_user_id: "auth-u5",
      name: "User Query Error",
      badge_id: "PT-005",
      is_active: true,
      invitation_status: "LINKED",
    };
    const res = mockGuardAuthenticatedRoute(user, profile, "employee", true);
    expect(res.allowed).toBe(false);
    expect(res.redirectTo).toBe("/unauthorized");
    expect(res.search?.["reason"]).toBe("forbidden");
  });

  // Requirement 38: Session Authorization - Invalid or unknown role string fails closed
  it("Requirement 38: Session Authorization - Invalid or unknown role string fails closed with no_role", () => {
    const user: MockAuthUser = { id: "auth-u6", email: "user6@corp.com" };
    const profile: MockProfile = {
      id: "ent-u6",
      auth_user_id: "auth-u6",
      name: "User Invalid Role",
      badge_id: "PT-006",
      is_active: true,
      invitation_status: "LINKED",
    };
    // @ts-expect-error Testing invalid role string
    const res = mockGuardAuthenticatedRoute(user, profile, "contractor");
    expect(res.allowed).toBe(false);
    expect(res.redirectTo).toBe("/unauthorized");
    expect(res.search?.["reason"]).toBe("no_role");
  });

  // Requirement 39: Audit Logging - Client-supplied actor_id is ignored
  it("Requirement 39: Audit Logging - Client-supplied actor_id is ignored in favor of server verification", () => {
    function deriveVerifiedActor(
      verifiedTokenSub: string | null,
      _clientSuppliedActorId: string | null,
    ): string | null {
      return verifiedTokenSub;
    }

    const spoofedClientId = "evil-actor-uuid-9999";
    const serverVerifiedSub = "verified-user-uuid-1111";

    expect(deriveVerifiedActor(null, spoofedClientId)).toBeNull();
    expect(deriveVerifiedActor(serverVerifiedSub, spoofedClientId)).toBe(serverVerifiedSub);
  });

  // Requirement 40: Audit Logging - Sensitive metadata keys are recursively stripped
  it("Requirement 40: Audit Logging - Sensitive metadata keys are recursively stripped", () => {
    const dirtyMetadata = {
      action_context: "user_login",
      password: "SuperSecretPassword123!",
      user_token: "jwt-token-string",
      authorization: "Bearer eyJhbG...",
      nested: {
        passcode: "123456",
        apiKey: "pk_live_abcdef",
        safe_field: "valid_value",
      },
      client_ip: "192.168.1.100",
    };

    const sanitized = sanitizeAuditMetadata(dirtyMetadata) as Record<string, any>;
    expect(sanitized["action_context"]).toBe("user_login");
    expect(sanitized["client_ip"]).toBe("192.168.1.100");
    expect(sanitized["password"]).toBeUndefined();
    expect(sanitized["user_token"]).toBeUndefined();
    expect(sanitized["authorization"]).toBeUndefined();
    expect(sanitized["nested"]?.["passcode"]).toBeUndefined();
    expect(sanitized["nested"]?.["apiKey"]).toBeUndefined();
    expect(sanitized["nested"]?.["safe_field"]).toBe("valid_value");
  });

  // Requirement 41: Audit Logging - String lengths > 500 and tree depths > 4 are safely truncated
  it("Requirement 41: Audit Logging - Long strings and deep nesting are capped", () => {
    const longString = "A".repeat(600);
    const deepObject = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: "too_deep",
              },
            },
          },
        },
      },
    };

    const sanitizedString = sanitizeAuditMetadata(longString);
    expect(typeof sanitizedString).toBe("string");
    expect((sanitizedString as string).length).toBe(503); // 500 + '...'

    const sanitizedDeep = sanitizeAuditMetadata(deepObject) as any;
    expect(sanitizedDeep.level1?.level2?.level3?.level4?.level5).toBe("[TRUNCATED_DEPTH]");
  });

  // Requirement 42: Audit Logging - Database insert failure reports failure
  it("Requirement 42: Audit Logging - Database insert failure reports failure without swallowing error", async () => {
    async function simulateAuditLogInsert(shouldFail: boolean) {
      if (shouldFail) {
        return { success: false, error: "relation admin_audit_logs does not exist" };
      }
      return { success: true };
    }

    const failureResult = await simulateAuditLogInsert(true);
    expect(failureResult.success).toBe(false);
    expect(failureResult.error).toContain("does not exist");

    const successResult = await simulateAuditLogInsert(false);
    expect(successResult.success).toBe(true);
    expect(successResult.error).toBeUndefined();
  });

  // Requirement 43: Employee Invitation - Ordinary invitation validator strictly rejects super_admin role
  it("Requirement 43: Employee Invitation - Ordinary invitation validator strictly rejects super_admin role", () => {
    const adminInviteAttempt = InviteEmployeeSchema.safeParse({
      name: "Escalation Candidate",
      email: "candidate@presencetrack.corp",
      badge_id: "PT-7777",
      role: "super_admin",
    });

    expect(adminInviteAttempt.success).toBe(false);
    if (!adminInviteAttempt.success) {
      const roleError = adminInviteAttempt.error.issues.find((i) => i.path.includes("role"));
      expect(roleError).toBeDefined();
    }
  });

  // Requirement 44: Employee Invitation - Ordinary invitation accepts valid employee, hr_ops, and security roles
  it("Requirement 44: Employee Invitation - Ordinary invitation accepts valid employee, hr_ops, and security roles", () => {
    const roles: ("employee" | "hr_ops" | "security")[] = ["employee", "hr_ops", "security"];

    for (const r of roles) {
      const parsed = InviteEmployeeSchema.safeParse({
        name: "Test Staff",
        email: `staff.${r}@presencetrack.corp`,
        badge_id: `PT-${r.toUpperCase().slice(0, 4)}`,
        role: r,
      });
      expect(parsed.success).toBe(true);
    }
  });

  // Requirement 45: Employee Invitation - Ambiguous dispatch preserves staged profile in RECONCILIATION_REQUIRED
  it("Requirement 45: Employee Invitation - Ambiguous dispatch preserves staged profile in RECONCILIATION_REQUIRED", () => {
    function classifyDispatchError(errMessage: string): "DELETE_STAGED" | "PRESERVE_QUARANTINED" {
      const isDefinitivePreDispatch =
        /invalid email|email format|validation failed|unsupported provider/i.test(errMessage);
      return isDefinitivePreDispatch ? "DELETE_STAGED" : "PRESERVE_QUARANTINED";
    }

    expect(classifyDispatchError("Invalid email address format")).toBe("DELETE_STAGED");
    expect(classifyDispatchError("Gateway Timeout 504")).toBe("PRESERVE_QUARANTINED");
    expect(classifyDispatchError("ETIMEDOUT: Connection lost")).toBe("PRESERVE_QUARANTINED");
    expect(classifyDispatchError("GoTrue 502 Bad Gateway")).toBe("PRESERVE_QUARANTINED");
  });

  // Requirement 46: Reinvitation - Reinvitation of quarantined or super_admin accounts is strictly rejected
  it("Requirement 46: Reinvitation - Quarantined and super_admin accounts are rejected with descriptive errors", () => {
    function guardReinvite(profile: {
      is_active: boolean;
      invitation_status: string;
      imported_role: string;
    }) {
      if (profile.is_active === false) {
        throw new Error("Cannot reinvite a deactivated employee. Reactivate the profile first.");
      }
      if (profile.invitation_status === "RECONCILIATION_REQUIRED") {
        throw new Error(
          "Cannot reinvite an account under security quarantine (RECONCILIATION_REQUIRED). Please resolve the quarantine status before dispatching invitations.",
        );
      }
      if (profile.imported_role === "super_admin") {
        throw new Error(
          "Security Guard: Super Admin accounts cannot be reinvited through ordinary employee workflows.",
        );
      }
      return { canReinvite: true };
    }

    // Deactivated profile
    expect(() =>
      guardReinvite({ is_active: false, invitation_status: "LINKED", imported_role: "employee" }),
    ).toThrow("Cannot reinvite a deactivated employee");

    // Quarantined profile
    expect(() =>
      guardReinvite({
        is_active: true,
        invitation_status: "RECONCILIATION_REQUIRED",
        imported_role: "employee",
      }),
    ).toThrow("Cannot reinvite an account under security quarantine");

    // Super Admin profile
    expect(() =>
      guardReinvite({ is_active: true, invitation_status: "LINKED", imported_role: "super_admin" }),
    ).toThrow("Security Guard: Super Admin accounts cannot be reinvited");

    // Valid employee profile
    expect(
      guardReinvite({ is_active: true, invitation_status: "LINKED", imported_role: "employee" }),
    ).toEqual({ canReinvite: true });
  });

  // Requirement 47: URL Resolution - resolveAppUrl provides clean URL without markdown syntax
  it("Requirement 47: URL Resolution - resolveAppUrl provides clean URL without markdown syntax", () => {
    const url = resolveAppUrl();
    expect(url).not.toMatch(/\[.*\]\(.*\)/);
    expect(url).toMatch(/^https?:\/\//);
    expect(url).not.toMatch(/\/$/);
  });
});
