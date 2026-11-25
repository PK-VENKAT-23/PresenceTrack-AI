/**
 * PresenceTrack AI — shared type contracts and constants (browser-safe).
 */
import type { Database } from "@/integrations/supabase/types";

type Tables = Database["public"]["Tables"];

export type UserRole = Database["public"]["Enums"]["app_role"];
export type ZoneType = Database["public"]["Enums"]["zone_type"];
export type TransitDirection = Database["public"]["Enums"]["transit_direction"];
export type AttendanceStatus = Database["public"]["Enums"]["attendance_status"];

export type EnterpriseUser = Tables["enterprise_users"]["Row"];
export type Esp32Node = Tables["esp32_camera_nodes"]["Row"];
export type PassiveTransit = Tables["passive_transits"]["Row"];
export type EmployeeDailyDwell = Tables["employee_daily_dwell"]["Row"];
export type MerkleAuditBlock = Tables["merkle_audit_blocks"]["Row"];
export type DpoErasureRequest = Tables["dpo_erasure_requests"]["Row"];
export type Department = Tables["departments"]["Row"];
export type AttendanceRecord = Tables["attendance_records"]["Row"];
export type AdminAuditLog = Tables["admin_audit_logs"]["Row"];
export type UnknownDetection = Tables["unknown_detections"]["Row"];

export type AttendanceWithEmployee = AttendanceRecord & {
  enterprise_users?: Pick<
    EnterpriseUser,
    "id" | "name" | "badge_id" | "department" | "avatar_url"
  > | null;
};

export type TransitWithPerson = PassiveTransit & {
  enterprise_users: { name: string; badge_id: string } | null;
};

export type ErasureScope =
  | "biometric_embeddings"
  | "transit_history"
  | "dwell_records"
  | "audit_ledger"
  | "compliant_backup";

export const ZONE_LABELS: Record<ZoneType, string> = {
  WORKSPACE_FLOOR: "Workspace Floor",
  CAFETERIA_LOUNGE: "Cafeteria / Lounge",
  OUTDOOR_TERRACE: "Outdoor Terrace",
  CORRIDOR_TRANSIT: "Corridor",
};

export const ZONES: ZoneType[] = [
  "WORKSPACE_FLOOR",
  "CAFETERIA_LOUNGE",
  "OUTDOOR_TERRACE",
  "CORRIDOR_TRANSIT",
];

export const ROLE_LABELS: Record<UserRole, string> = {
  employee: "Employee",
  hr_ops: "HR Operations",
  security: "Physical Security",
  super_admin: "Super Admin & Governance",
  dpo: "Data Protection Officer",
};

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  PRESENT: "Present",
  ABSENT: "Absent",
  HALF_DAY: "Half Day",
  ON_LEAVE: "On Leave",
  HOLIDAY: "Holiday",
};

export const APP_CONFIG = {
  appName: "PresenceTrack AI",
  appVersion: "v1.0.0-PROD",
  dpdpStandard: "DPDP Act 2023 Statutory Standard",
  dramTargetMs: 18,
  cosineThreshold: 0.7,
  workspaceTargetMinutes: 480,
  oshSittingThresholdMinutes: 270,
  /** A node is considered online if it pinged within this window (firmware pings every 15s). */
  nodeOnlineWindowMs: 60_000,
} as const;

export function isNodeLive(
  node: Pick<Esp32Node, "is_online" | "last_ping">,
  now = Date.now(),
): boolean {
  if (!node.is_online || !node.last_ping) return false;
  return now - new Date(node.last_ping).getTime() <= APP_CONFIG.nodeOnlineWindowMs;
}

/** Calendar day in India Standard Time (matches the database dwell accounting). */
export function todayIST(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${m}m`;
}

export function shortHash(hash: string | null | undefined, len = 16): string {
  if (!hash) return "—";
  return hash.length > len ? `${hash.slice(0, len)}…` : hash;
}

export interface AttendanceCalculationResult {
  first_in: string | null;
  last_out: string | null;
  total_work_minutes: number;
  total_break_minutes: number;
  work_seconds: number;
  break_seconds: number;
  current_state: "OUT" | "WORKSPACE" | "BREAK";
  is_in_workspace: boolean;
  is_on_break: boolean;
  is_clocked_out: boolean;
  status: AttendanceStatus;
  missed_exit: boolean;
  is_overnight_shift?: boolean;
  has_unresolved_historical_session?: boolean;
  unresolved_session_date?: string | null;
  unresolved_session_timestamp?: string | null;
}

/**
 * Calculates start, end, and next-day boundary millisecond timestamps for a given IST date string (YYYY-MM-DD).
 */
export function getISTDayBounds(dateStr: string): { startMs: number; endMs: number; nextDayStartMs: number } {
  const startMs = new Date(`${dateStr}T00:00:00.000+05:30`).getTime();
  const nextDayStartMs = startMs + 24 * 3600 * 1000;
  const endMs = nextDayStartMs - 1;
  return { startMs, endMs, nextDayStartMs };
}

/**
 * Canonical calculation of employee attendance and dwell intervals from chronological transits.
 * Handles:
 *   1. Clean intra-day transitions (corridor, workspace, cafeteria, terrace).
 *   2. Active overnight shifts crossing midnight (cleanly splits intervals at 00:00:00 IST).
 *   3. Unresolved historical sessions (>16h open from prior calendar days, flagged with missed_exit).
 *   4. Deterministic recalculation across browser refresh and re-login.
 */
export function calculateAttendanceFromTransits(
  transits: Array<{
    timestamp: string;
    direction?: string;
    zone_from?: string;
    zone_to: string;
  }>,
  nowMs = Date.now(),
  targetDateIST?: string,
): AttendanceCalculationResult {
  const sorted = [...transits].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  let effectiveDate = targetDateIST;
  if (!effectiveDate) {
    if (sorted.length > 0) {
      const latestTransit = sorted[sorted.length - 1]!;
      const latestDate = todayIST(new Date(latestTransit.timestamp));
      const today = todayIST(new Date(nowMs));
      // If all transits are from an earlier single date and no transit occurred today, use latestDate
      const hasTodayTransits = sorted.some((t) => todayIST(new Date(t.timestamp)) === today);
      effectiveDate = hasTodayTransits ? today : latestDate;
    } else {
      effectiveDate = todayIST(new Date(nowMs));
    }
  }

  const { startMs, endMs, nextDayStartMs } = getISTDayBounds(effectiveDate);

  // Partition transits into prior-history and target-day transits
  const priorTransits = sorted.filter((t) => new Date(t.timestamp).getTime() < startMs);
  const dayTransits = sorted.filter((t) => {
    const time = new Date(t.timestamp).getTime();
    return time >= startMs && time <= endMs;
  });

  let curState: "OUT" | "WORKSPACE" | "BREAK" = "OUT";
  let isOvernightShift = false;
  let hasUnresolvedSession = false;
  let unresolvedDate: string | null = null;
  let unresolvedTimestamp: string | null = null;

  // Evaluate prior state immediately before startMs
  if (priorTransits.length > 0) {
    let priorState: "OUT" | "WORKSPACE" | "BREAK" = "OUT";
    let priorStateStart: number | null = null;
    let lastPriorTransit = priorTransits[0];

    for (const t of priorTransits) {
      lastPriorTransit = t;
      if (t.zone_to === "WORKSPACE_FLOOR") {
        priorState = "WORKSPACE";
        priorStateStart = new Date(t.timestamp).getTime();
      } else if (t.zone_to === "CAFETERIA_LOUNGE" || t.zone_to === "OUTDOOR_TERRACE") {
        priorState = "BREAK";
        priorStateStart = new Date(t.timestamp).getTime();
      } else {
        priorState = "OUT";
        priorStateStart = new Date(t.timestamp).getTime();
      }
    }

    if (priorState !== "OUT" && priorStateStart !== null) {
      const elapsedPriorHours = (startMs - priorStateStart) / (1000 * 3600);
      if (elapsedPriorHours <= 16) {
        // Legitimate overnight shift entering targetDateIST across midnight
        curState = priorState;
        isOvernightShift = true;
      } else {
        // Stale unclosed historical session from a previous day
        hasUnresolvedSession = true;
        unresolvedDate = todayIST(new Date(priorStateStart));
        unresolvedTimestamp = lastPriorTransit?.timestamp ?? null;
        curState = "OUT"; // Do not inflate today's work minutes with multi-day time
      }
    }
  }

  let firstIn: string | null = null;
  let lastOut: string | null = null;
  let stateStart: number | null = curState !== "OUT" ? startMs : null;
  let workSeconds = 0;
  let breakSeconds = 0;

  if (curState === "WORKSPACE" && isOvernightShift) {
    firstIn = new Date(startMs).toISOString();
  }

  // Evaluate transits on the target day
  for (const t of dayTransits) {
    const tTime = new Date(t.timestamp).getTime();

    if (
      !firstIn &&
      (t.direction === "ZONE_ENTER" || t.zone_to === "WORKSPACE_FLOOR") &&
      t.zone_to === "WORKSPACE_FLOOR"
    ) {
      firstIn = t.timestamp;
    }

    if (t.direction === "ZONE_EXIT" || t.zone_to === "CORRIDOR_TRANSIT") {
      lastOut = t.timestamp;
    }

    if (stateStart !== null && tTime > stateStart) {
      const durSec = Math.max(0, Math.floor((tTime - stateStart) / 1000));
      if (curState === "WORKSPACE") {
        workSeconds += durSec;
      } else if (curState === "BREAK") {
        breakSeconds += durSec;
      }
    }

    if (t.zone_to === "WORKSPACE_FLOOR") {
      curState = "WORKSPACE";
      stateStart = tTime;
    } else if (t.zone_to === "CAFETERIA_LOUNGE" || t.zone_to === "OUTDOOR_TERRACE") {
      curState = "BREAK";
      stateStart = tTime;
    } else {
      curState = "OUT";
      stateStart = tTime;
    }
  }

  // Calculate active open interval on target day up to min(nowMs, endMs)
  if (curState !== "OUT" && stateStart !== null) {
    const limitMs = nowMs >= endMs - 1000 ? nextDayStartMs : Math.min(nowMs, nextDayStartMs);
    if (limitMs > stateStart) {
      const openSec = Math.max(0, Math.floor((limitMs - stateStart) / 1000));
      if (curState === "WORKSPACE") {
        workSeconds += openSec;
      } else if (curState === "BREAK") {
        breakSeconds += openSec;
      }
    }
  }

  const workMin = Math.floor(workSeconds / 60);
  const breakMin = Math.floor(breakSeconds / 60);
  const missedExit = hasUnresolvedSession || (curState === "WORKSPACE" && lastOut === null && dayTransits.length > 0);
  const status: AttendanceStatus =
    workMin >= 240 ? "PRESENT" : workMin > 0 ? "HALF_DAY" : "ABSENT";

  return {
    first_in: firstIn,
    last_out: lastOut,
    total_work_minutes: workMin,
    total_break_minutes: breakMin,
    work_seconds: workSeconds,
    break_seconds: breakSeconds,
    current_state: curState,
    is_in_workspace: curState === "WORKSPACE",
    is_on_break: curState === "BREAK",
    is_clocked_out: curState === "OUT",
    status,
    missed_exit: missedExit,
    is_overnight_shift: isOvernightShift,
    has_unresolved_historical_session: hasUnresolvedSession,
    unresolved_session_date: unresolvedDate,
    unresolved_session_timestamp: unresolvedTimestamp,
  };
}
