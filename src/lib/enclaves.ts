import type { UserRole } from "@/lib/ambient";

/**
 * Strict enclave isolation: every role has exactly one console and may not open another.
 */
export type Enclave = "employee" | "hr" | "security" | "admin";

export const ROLE_ENCLAVE: Record<UserRole, Enclave> = {
  employee: "employee",
  hr_ops: "hr",
  security: "security",
  super_admin: "admin",
  dpo: "admin",
};

export const ENCLAVE_PATHS = {
  employee: "/enclave/employee",
  hr: "/enclave/hr",
  security: "/enclave/security",
  admin: "/enclave/admin",
} as const satisfies Record<Enclave, string>;

export type EnclavePath = (typeof ENCLAVE_PATHS)[Enclave];

/**
 * Resolves the enclave for an assigned role.
 * Returns null if the user has no role or an unrecognized role.
 */
export function enclaveFor(role: UserRole | null | undefined): Enclave | null {
  if (!role || !(role in ROLE_ENCLAVE)) return null;
  return ROLE_ENCLAVE[role];
}

/**
 * Resolves the route destination for a role.
 * If no role is assigned, redirects to /unauthorized.
 */
export function enclavePathFor(role: UserRole | null | undefined): string {
  const enclave = enclaveFor(role);
  if (!enclave) return "/unauthorized";
  return ENCLAVE_PATHS[enclave];
}

/**
 * Strict zero-trust gate:
 * Users with null, undefined, or unauthorized roles are denied access to ALL enclaves.
 */
export function canAccessEnclave(role: UserRole | null | undefined, enclave: Enclave): boolean {
  if (!role) return false;
  const assignedEnclave = enclaveFor(role);
  return assignedEnclave !== null && assignedEnclave === enclave;
}
