import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import type { EnterpriseUser, UserRole } from "@/lib/ambient";

const VALID_ROLES: UserRole[] = ["employee", "hr_ops", "security", "super_admin"];

// Session lives in browser storage, so the gate runs client-side only.
export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      throw redirect({
        to: "/login",
        search: { reason: "expired" },
      });
    }

    const [{ data: roleRow, error: roleErr }, { data: profiles, error: profileErr }] =
      await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle(),
        supabase.from("enterprise_users").select("*").eq("auth_user_id", user.id),
      ]);

    // Database query errors -> fail closed, terminate session, redirect
    if (roleErr || profileErr) {
      await supabase.auth.signOut();
      throw redirect({
        to: "/unauthorized",
        search: { reason: "forbidden" },
      });
    }

    // Missing enterprise profile or duplicate profiles -> fail closed, terminate session, redirect
    if (!profiles || profiles.length !== 1) {
      await supabase.auth.signOut();
      throw redirect({
        to: "/unauthorized",
        search: { reason: "forbidden" },
      });
    }

    const profile = profiles[0];
    if (!profile) {
      await supabase.auth.signOut();
      throw redirect({
        to: "/unauthorized",
        search: { reason: "forbidden" },
      });
    }

    // Linkage mismatch -> fail closed, terminate session
    if (profile.auth_user_id !== user.id) {
      await supabase.auth.signOut();
      throw redirect({
        to: "/unauthorized",
        search: { reason: "forbidden" },
      });
    }

    // Security quarantine check - immediately terminate session and redirect to reconciliation
    if (profile.invitation_status === "RECONCILIATION_REQUIRED") {
      await supabase.auth.signOut();
      throw redirect({
        to: "/unauthorized",
        search: { reason: "quarantined" },
      });
    }

    // Deactivated account check - immediately terminate session and redirect
    if (profile.is_active === false) {
      await supabase.auth.signOut();
      throw redirect({
        to: "/unauthorized",
        search: { reason: "deactivated" },
      });
    }

    // Invitation status check - must be fully LINKED
    if (profile.invitation_status !== "LINKED") {
      await supabase.auth.signOut();
      throw redirect({
        to: "/unauthorized",
        search: { reason: "forbidden" },
      });
    }

    // Missing or invalid role check
    const roleCandidate = roleRow?.role as UserRole | undefined;
    if (!roleCandidate || !VALID_ROLES.includes(roleCandidate)) {
      await supabase.auth.signOut();
      throw redirect({
        to: "/unauthorized",
        search: { reason: "no_role" },
      });
    }

    const profileData: EnterpriseUser = {
      ...profile,
      is_active: profile.is_active ?? true,
      department_id: (profile as { department_id?: string | null }).department_id ?? null,
    };

    return { user, role: roleCandidate, profile: profileData };
  },
  component: () => <Outlet />,
});
