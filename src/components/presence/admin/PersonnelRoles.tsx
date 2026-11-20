import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserPlus, Building2, Edit2, ShieldAlert, Camera, Fingerprint } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { ROLE_LABELS, type EnterpriseUser, type UserRole } from "@/lib/ambient";
import { cn } from "@/lib/utils";
import { assignEmployeeRole, getEmployeeBiometricStatus } from "@/lib/employee.functions";
import { InviteEmployeeModal } from "./InviteEmployeeModal";
import { EmployeeEditModal } from "./EmployeeEditModal";
import { DepartmentManagerModal } from "./DepartmentManagerModal";
import { FaceEnrollmentModal } from "./FaceEnrollmentModal";

const ROLES: UserRole[] = ["employee", "hr_ops", "security", "super_admin"];

interface PersonnelRolesProps {
  people: EnterpriseUser[];
  roles: Record<string, UserRole>;
  selfAuthId: string;
  onChanged: () => void;
}

/** Super Admin assigns each person to exactly one enclave & manages employee records. */
export function PersonnelRoles({ people, roles, selfAuthId, onChanged }: PersonnelRolesProps) {
  const queryClient = useQueryClient();
  const assignRoleServerFn = useServerFn(assignEmployeeRole);
  const getBiometricStatusFn = useServerFn(getEmployeeBiometricStatus);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showDeptModal, setShowDeptModal] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<EnterpriseUser | null>(null);
  const [enrollingEmployee, setEnrollingEmployee] = useState<EnterpriseUser | null>(null);

  // Live Biometric Statuses for all personnel
  const { data: biometricStatuses, refetch: refetchBiometrics } = useQuery({
    queryKey: ["biometric-statuses"],
    queryFn: async () => {
      try {
        const res = await getBiometricStatusFn({ data: {} });
        return res.statuses ?? {};
      } catch (err) {
        console.error("Failed to fetch biometric statuses:", err);
        return {};
      }
    },
  });

  const handleRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["biometric-statuses"] });
    await queryClient.invalidateQueries({ queryKey: ["personnel"] });
    await refetchBiometrics();
    onChanged();
  };

  const q = search.toLowerCase();
  const filtered = people.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.email.toLowerCase().includes(q) ||
      p.badge_id.toLowerCase().includes(q) ||
      p.department?.toLowerCase().includes(q),
  );

  const departments = Array.from(
    new Set(people.map((p) => p.department).filter(Boolean)),
  ) as string[];

  const adminCount = Object.values(roles).filter((r) => r === "super_admin").length;

  const assign = async (authId: string, role: UserRole) => {
    // Prevent accidental removal of the final administrator
    if (
      authId === selfAuthId &&
      roles[authId] === "super_admin" &&
      role !== "super_admin" &&
      adminCount <= 1
    ) {
      toast.error("Cannot remove administrative access: You are the sole Super Admin.");
      return;
    }

    setSaving(authId);
    try {
      const res = await assignRoleServerFn({ data: { auth_user_id: authId, role } });
      if (res.success) {
        toast.success(`Enclave updated to ${ROLE_LABELS[role]}`);
        onChanged();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update role clearance");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="stat-card-label">Personnel Directory & Enclave Access</span>
          <p className="text-xxs text-sage">
            Manage profiles, assign departments, and configure enclave clearances
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, badge or dept…"
            className="glass-input w-48 py-1.5 text-xs sm:w-56"
          />
          <button
            type="button"
            onClick={() => setShowDeptModal(true)}
            className="glass-btn flex items-center gap-1.5 py-1.5 text-xs"
          >
            <Building2 className="h-3.5 w-3.5" />
            Departments
          </button>
          <button
            type="button"
            onClick={() => setShowInviteModal(true)}
            className="glass-btn-primary flex items-center gap-1.5 py-1.5 text-xs"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Invite Personnel
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="table-glass text-xs">
          <thead>
            <tr>
              <th>Personnel</th>
              <th>Badge ID</th>
              <th>Department</th>
              <th>Account</th>
              <th>Biometric Status</th>
              <th>Enclave Clearance</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-sage">
                  No matching personnel found.
                </td>
              </tr>
            ) : (
              filtered.map((p) => {
                const authId = p.auth_user_id;
                const current = authId ? roles[authId] : undefined;
                const bioStatus = biometricStatuses?.[p.id];
                const isActive = bioStatus ? bioStatus.is_active : (p.is_active ?? true);
                const consentRevoked = bioStatus ? bioStatus.consent_revoked : Boolean(p.consent_revoked);
                const isEnrolled = bioStatus
                  ? bioStatus.is_enrolled
                  : (p.enrolled_embedding !== null && p.enrolled_embedding !== undefined);

                return (
                  <tr key={p.id}>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <img
                          src={
                            p.avatar_url ??
                            `https://ui-avatars.com/api/?name=${encodeURIComponent(
                              p.name,
                            )}&background=10B981&color=fff&bold=true`
                          }
                          alt={p.name}
                          className="h-7 w-7 rounded-full border border-border/50 object-cover"
                        />
                        <div>
                          <div className="font-semibold text-umbra">{p.name}</div>
                          <div className="text-xxs text-sage">
                            {p.email} · {p.role_title}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="font-mono text-sage">{p.badge_id}</td>
                    <td className="text-sage">{p.department}</td>
                    <td>
                      {isActive ? (
                        <span className="pill bg-success-soft text-xxs font-semibold text-success-strong">
                          ACTIVE
                        </span>
                      ) : (
                        <span className="pill bg-destructive-soft text-xxs font-semibold text-destructive">
                          ACCOUNT DEACTIVATED
                        </span>
                      )}
                    </td>
                    <td>
                      {!isActive ? (
                        <span className="pill bg-destructive-soft text-xxs font-semibold text-destructive">
                          ACCOUNT DEACTIVATED
                        </span>
                      ) : consentRevoked ? (
                        <span className="pill bg-destructive-soft text-xxs font-semibold text-destructive">
                          CONSENT REVOKED
                        </span>
                      ) : isEnrolled ? (
                        <span className="pill bg-success-soft text-xxs font-semibold text-success-strong">
                          ENROLLED
                        </span>
                      ) : (
                        <span className="pill bg-warning-soft text-xxs font-semibold text-warning-strong">
                          NOT ENROLLED
                        </span>
                      )}
                    </td>
                    <td>
                      {!authId ? (
                        <span className="pill bg-warning-soft text-warning-strong">
                          Awaiting first sign-in
                        </span>
                      ) : authId === selfAuthId ? (
                        <span className="pill bg-muted text-umbra">
                          {current ? ROLE_LABELS[current] : "—"} (you)
                        </span>
                      ) : (
                        <select
                          value={current ?? "employee"}
                          disabled={saving === authId}
                          onChange={(e) => assign(authId, e.target.value as UserRole)}
                          className={cn(
                            "glass-input py-1 text-xs",
                            saving === authId && "opacity-50",
                          )}
                          aria-label={`Enclave for ${p.name}`}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        {!isActive ? (
                          <button
                            type="button"
                            disabled
                            className="glass-btn flex items-center gap-1 py-1 px-2.5 text-xxs opacity-50 cursor-not-allowed text-sage"
                            title="Enrollment disabled: Employee account is deactivated"
                          >
                            <Camera className="h-3 w-3" />
                            Register Face
                          </button>
                        ) : consentRevoked ? (
                          <button
                            type="button"
                            onClick={() => setEnrollingEmployee(p)}
                            className="glass-btn flex items-center gap-1 py-1 px-2.5 text-xxs text-warning-strong hover:bg-warning-soft/50 font-semibold"
                            title={`Manage biometric consent for ${p.name}`}
                          >
                            <ShieldAlert className="h-3 w-3" />
                            Manage Consent
                          </button>
                        ) : isEnrolled ? (
                          <button
                            type="button"
                            onClick={() => setEnrollingEmployee(p)}
                            className="glass-btn flex items-center gap-1 py-1 px-2.5 text-xxs text-penna hover:bg-muted/50 font-semibold"
                            title={`Manage facial biometrics for ${p.name}`}
                          >
                            <Fingerprint className="h-3 w-3" />
                            Manage Face
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEnrollingEmployee(p)}
                            className="glass-btn flex items-center gap-1 py-1 px-2.5 text-xxs text-success-strong hover:bg-success-soft/50 font-semibold"
                            title={`Register facial biometrics for ${p.name}`}
                          >
                            <Camera className="h-3 w-3" />
                            Register Face
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditingEmployee(p)}
                          className="glass-btn flex items-center gap-1 py-1 px-2.5 text-xxs"
                        >
                          <Edit2 className="h-3 w-3" />
                          Edit Profile
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showInviteModal && (
        <InviteEmployeeModal onClose={() => setShowInviteModal(false)} onSuccess={handleRefresh} />
      )}

      {showDeptModal && (
        <DepartmentManagerModal onClose={() => setShowDeptModal(false)} onChanged={handleRefresh} />
      )}

      {editingEmployee && (
        <EmployeeEditModal
          employee={editingEmployee}
          departments={departments}
          onClose={() => setEditingEmployee(null)}
          onSuccess={handleRefresh}
        />
      )}

      {enrollingEmployee && (
        <FaceEnrollmentModal
          employee={enrollingEmployee}
          onClose={() => setEnrollingEmployee(null)}
          onSuccess={handleRefresh}
        />
      )}
    </div>
  );
}
