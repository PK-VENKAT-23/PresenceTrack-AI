import type { PassiveTransit } from "@/lib/ambient";
import { cn } from "@/lib/utils";

interface PersonalTimelineProps {
  transits: Pick<PassiveTransit, "timestamp" | "zone_to">[];
  oshCompliant: boolean;
}

const START_HOUR = 8;
const HOURS = 12;

function istHourMinutes(iso: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

function currentIstMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** 08:00–20:00 horizon populated strictly by ESP32-CAM and manual audit detections. */
export function PersonalTimeline({ transits, oshCompliant }: PersonalTimelineProps) {
  const ordered = [...transits]
    .map((t) => ({ minute: istHourMinutes(t.timestamp), zone: t.zone_to }))
    .sort((a, b) => a.minute - b.minute);

  const curIstMin = currentIstMinutes();

  const segments = Array.from({ length: HOURS }, (_, i) => {
    const hour = START_HOUR + i;
    const startMin = hour * 60;
    const endMin = (hour + 1) * 60;

    // Hours that have not started yet today in IST remain unrecorded/upcoming
    if (startMin > curIstMin) {
      return { hour, state: "future" as const, count: 0 };
    }

    const count = ordered.filter((t) => t.minute >= startMin && t.minute < endMin).length;
    const transitsInHour = ordered.filter((t) => t.minute >= startMin && t.minute < endMin);
    const lastBefore = ordered.filter((t) => t.minute < startMin).at(-1);

    let state: "workspace" | "break" | "absent" = "absent";
    if (transitsInHour.length > 0) {
      const hasWorkspace = transitsInHour.some((t) => t.zone === "WORKSPACE_FLOOR");
      const hasBreak = transitsInHour.some(
        (t) => t.zone === "CAFETERIA_LOUNGE" || t.zone === "OUTDOOR_TERRACE",
      );
      if (hasWorkspace) {
        state = "workspace";
      } else if (hasBreak) {
        state = "break";
      } else {
        const lastInHour = transitsInHour[transitsInHour.length - 1];
        state =
          lastInHour?.zone === "WORKSPACE_FLOOR"
            ? "workspace"
            : lastInHour?.zone === "CORRIDOR_TRANSIT"
              ? "absent"
              : "break";
      }
    } else if (lastBefore) {
      state =
        lastBefore.zone === "WORKSPACE_FLOOR"
          ? "workspace"
          : lastBefore.zone === "CORRIDOR_TRANSIT"
            ? "absent"
            : "break";
    }

    return { hour, state, count };
  });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="stat-card-label">
          Today ·{" "}
          {new Date().toLocaleDateString("en-IN", {
            month: "short",
            day: "numeric",
            timeZone: "Asia/Kolkata",
          })}
        </span>
        <span
          className={cn(
            "text-xs font-semibold",
            oshCompliant ? "text-success-strong" : "text-warning-strong",
          )}
        >
          OSH compliance: {oshCompliant ? "PASS" : "FLAG"}
        </span>
      </div>
      <div className="timeline-rail h-3 gap-px">
        {segments.map((s) => (
          <div
            key={s.hour}
            className={cn(
              "h-full flex-1 transition-colors rounded-sm",
              s.state === "workspace" && "bg-umbra",
              s.state === "break" && "bg-warning",
              s.state === "absent" && "bg-muted/50",
              s.state === "future" && "bg-muted/15 border border-dashed border-border/30",
            )}
            title={`${s.hour}:00 — ${s.state === "future" ? "Upcoming" : s.state} (${s.count} transits)`}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between font-mono text-xs text-sage">
        <span>08:00</span>
        <span>12:00</span>
        <span>16:00</span>
        <span>20:00</span>
      </div>
      <div className="mt-1 flex gap-4 text-xxs text-sage">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-umbra" /> Deep work
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-warning" /> Break / aux
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-muted/50 ring-1 ring-border" /> Off-site
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-muted/15 border border-dashed border-border/40" /> Upcoming
        </span>
      </div>
    </div>
  );
}
