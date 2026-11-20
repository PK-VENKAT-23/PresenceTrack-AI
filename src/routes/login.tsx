import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Building2,
  ShieldCheck,
  Users,
  Video,
  Eye,
  EyeOff,
  Clock,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AuthShell } from "@/components/presence/layout/AuthShell";
import { playClick, playTransitBlip } from "@/lib/sound-engine";
import { enclavePathFor } from "@/lib/enclaves";
import { recordAuthEvent } from "@/lib/auth.functions";
import type { UserRole } from "@/lib/ambient";

type LoginSearch = {
  reason?: "expired" | "deactivated" | "logged_out";
};

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => {
    const reason = search["reason"];
    const validReason =
      reason === "expired" || reason === "deactivated" || reason === "logged_out"
        ? (reason as "expired" | "deactivated" | "logged_out")
        : undefined;
    return {
      ...(validReason ? { reason: validReason } : {}),
    };
  },
  head: () => ({
    meta: [
      { title: "Secure Access — PresenceTrack AI" },
      { name: "description", content: "Sign in to your designated PresenceTrack AI enclave." },
      { property: "og:title", content: "Secure Access — PresenceTrack AI" },
      {
        property: "og:description",
        content: "Sign in to your designated PresenceTrack AI enclave.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LoginPage,
});

const ENCLAVES = [
  {
    icon: Building2,
    label: "Employee",
    text: "Personal dwell time, transit ledger and DPDP vault",
  },
  {
    icon: Users,
    label: "HR Operations",
    text: "Concourse presence, team Gantt, OSH alerts, CSV export",
  },
  {
    icon: Video,
    label: "Physical Security",
    text: "ESP32-CAM matrix, node configuration, live transits",
  },
  {
    icon: ShieldCheck,
    label: "Super Admin",
    text: "Merkle ledger, attestation, DPO queue, role assignment",
  },
];

const VALID_ROLES: UserRole[] = ["employee", "hr_ops", "security", "super_admin"];

function LoginPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Already signed in → route straight to assigned enclave (unless explicit logout or expired reason)
  useEffect(() => {
    if (search.reason === "logged_out" || search.reason === "expired") {
      void supabase.auth.signOut();
      return;
    }

    supabase.auth.getUser().then(async ({ data, error: userErr }) => {
      if (userErr || !data?.user) return;

      const [{ data: roleRow, error: roleErr }, { data: profiles, error: profileErr }] =
        await Promise.all([
          supabase.from("user_roles").select("role").eq("user_id", data.user.id).maybeSingle(),
          supabase
            .from("enterprise_users")
            .select("id, auth_user_id, is_active, invitation_status")
            .eq("auth_user_id", data.user.id),
        ]);

      if (roleErr || profileErr || !profiles || profiles.length !== 1) {
        await supabase.auth.signOut();
        navigate({ to: "/unauthorized", search: { reason: "forbidden" }, replace: true });
        return;
      }

      const profile = profiles[0];
    if (!profile) {
      await supabase.auth.signOut();
      navigate({ to: "/unauthorized", search: { reason: "forbidden" }, replace: true });
      return;
    }
      if (!profile) {
        await supabase.auth.signOut();
        navigate({ to: "/unauthorized", search: { reason: "forbidden" }, replace: true });
        return;
      }
      if (profile.invitation_status === "RECONCILIATION_REQUIRED") {
        await supabase.auth.signOut();
        navigate({ to: "/unauthorized", search: { reason: "quarantined" }, replace: true });
      } else if (profile.is_active === false) {
        await supabase.auth.signOut();
        navigate({ to: "/unauthorized", search: { reason: "deactivated" }, replace: true });
      } else if (profile.invitation_status !== "LINKED") {
        await supabase.auth.signOut();
        navigate({ to: "/unauthorized", search: { reason: "forbidden" }, replace: true });
      } else {
        const candidateRole = roleRow?.role as UserRole | undefined;
        if (!candidateRole || !VALID_ROLES.includes(candidateRole)) {
          await supabase.auth.signOut();
          navigate({ to: "/unauthorized", search: { reason: "no_role" }, replace: true });
        } else {
          navigate({ to: enclavePathFor(candidateRole), replace: true });
        }
      }
    });
  }, [navigate, search.reason]);

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const emailTrimmed = email.trim();
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
      email: emailTrimmed,
      password,
    });

    setLoading(false);

    if (authErr || !authData?.user) {
      // Record failed authentication attempt safely (no password in logs)
      recordAuthEvent({
        data: {
          action: "auth.login_failed",
          email: emailTrimmed,
          metadata: { reason: authErr?.message ?? "Authentication failed" },
        },
      }).catch(() => {});

      setError(
        authErr && /confirm/i.test(authErr.message)
          ? "Please verify your email first — open the verification link we sent you."
          : "Invalid corporate email or passcode.",
      );
      return;
    }

    // Fail-closed authorization check: query role and enterprise profile
    const [{ data: roleRow, error: roleErr }, { data: profiles, error: profileErr }] =
      await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", authData.user.id).maybeSingle(),
        supabase
          .from("enterprise_users")
          .select("id, auth_user_id, is_active, invitation_status")
          .eq("auth_user_id", authData.user.id),
      ]);

    // Query errors, missing profile, or duplicate profiles -> fail closed
    if (roleErr || profileErr || !profiles || profiles.length !== 1) {
      await supabase.auth.signOut();
      recordAuthEvent({
        data: {
          action: "auth.unauthorized_access",
          email: emailTrimmed,
          metadata: { reason: "forbidden_profile_defect" },
        },
      }).catch(() => {});
      navigate({ to: "/unauthorized", search: { reason: "forbidden" }, replace: true });
      return;
    }

    const profile = profiles[0];
    if (!profile) {
      await supabase.auth.signOut();
      navigate({ to: "/unauthorized", search: { reason: "forbidden" }, replace: true });
      return;
    }

    // Check if account is in security quarantine
    if (profile.invitation_status === "RECONCILIATION_REQUIRED") {
      await supabase.auth.signOut();
      recordAuthEvent({
        data: {
          action: "auth.unauthorized_access",
          email: emailTrimmed,
          metadata: { reason: "quarantined" },
        },
      }).catch(() => {});
      navigate({ to: "/unauthorized", search: { reason: "quarantined" }, replace: true });
      return;
    }

    // Check if account is deactivated
    if (profile.is_active === false) {
      await supabase.auth.signOut();
      recordAuthEvent({
        data: {
          action: "auth.unauthorized_access",
          email: emailTrimmed,
          metadata: { reason: "deactivated" },
        },
      }).catch(() => {});
      navigate({ to: "/unauthorized", search: { reason: "deactivated" }, replace: true });
      return;
    }

    // Check if invitation is fully linked
    if (profile.invitation_status !== "LINKED") {
      await supabase.auth.signOut();
      recordAuthEvent({
        data: {
          action: "auth.unauthorized_access",
          email: emailTrimmed,
          metadata: { reason: "unlinked" },
        },
      }).catch(() => {});
      navigate({ to: "/unauthorized", search: { reason: "forbidden" }, replace: true });
      return;
    }

    const candidateRole = roleRow?.role as UserRole | undefined;
    if (!candidateRole || !VALID_ROLES.includes(candidateRole)) {
      await supabase.auth.signOut();
      recordAuthEvent({
        data: {
          action: "auth.unauthorized_access",
          email: emailTrimmed,
          metadata: { reason: "no_role" },
        },
      }).catch(() => {});
      navigate({ to: "/unauthorized", search: { reason: "no_role" }, replace: true });
      return;
    }

    // Record successful login audit only after all authorization checks pass
    recordAuthEvent({
      data: {
        action: "auth.login_success",
        email: emailTrimmed,
        metadata: { role: candidateRole },
      },
    }).catch(() => {});

    playClick();
    playTransitBlip();

    const target = enclavePathFor(candidateRole);
    navigate({ to: target, replace: true });
  };

  return (
    <AuthShell>
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1 text-sm text-sage hover:text-umbra"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to welcome
      </Link>

      {/* Reason banner alerts */}
      {search.reason === "expired" && (
        <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-warning-strong/30 bg-warning-soft p-3.5 text-xs text-warning-strong">
          <Clock className="h-4 w-4 shrink-0" />
          <span>
            Your cryptographic session has expired in compliance with DPDP Act 2023. Please
            authenticate again.
          </span>
        </div>
      )}

      {search.reason === "deactivated" && (
        <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-destructive/30 bg-destructive-soft p-3.5 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>
            Your enterprise profile has been deactivated by Super Admin. Contact HR Operations for
            assistance.
          </span>
        </div>
      )}

      {search.reason === "logged_out" && (
        <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-success-strong/30 bg-success-soft p-3.5 text-xs text-success-strong">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>You have securely signed out of your enclave.</span>
        </div>
      )}

      <div className="glass-card p-6 sm:p-8">
        <form onSubmit={handleSignIn} className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-umbra">Enclave Access</h2>
            <p className="text-sm text-sage">
              Enter your corporate credentials to access your designated enclave.
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-umbra">
              Corporate email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alex.rivera@presencetrack.corp"
              className="glass-input w-full"
              disabled={loading}
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="password" className="block text-sm font-medium text-umbra">
                Passcode
              </label>
              <Link to="/recovery" className="text-xs text-sage underline hover:text-umbra">
                Forgot passcode?
              </Link>
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="glass-input w-full pr-10"
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Hide passcode" : "Show passcode"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-sage hover:text-umbra transition"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <button type="submit" disabled={loading} className="glass-btn-primary w-full py-3">
            {loading ? "Authenticating…" : "Authenticate and enter enclave"}
          </button>
        </form>

        <div className="mt-6 border-t border-border/40 pt-4">
          <p className="text-xs text-sage leading-relaxed text-center">
            New to PresenceTrack? Personnel onboarding is strictly by corporate invitation. Check
            your mailbox for your activation link or contact HR Operations.
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ENCLAVES.map(({ icon: Icon, label, text }) => (
          <div key={label} className="stat-card p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-umbra">
              <Icon className="h-4 w-4 text-success-strong" />
              {label}
            </div>
            <p className="mt-1 text-xs text-sage">{text}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-center text-xs text-sage">
        Strict Enclave Isolation: your console is assigned by your corporate role.
      </p>
    </AuthShell>
  );
}
