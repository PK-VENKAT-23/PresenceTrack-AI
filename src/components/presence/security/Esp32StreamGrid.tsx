import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { isNodeLive, type Esp32Node } from "@/lib/ambient";
import { cn } from "@/lib/utils";
import { GATEWAY_VIDEO_FEED_URL } from "./Esp32CanvasOverlay";

/** Quadrant grid of ESP32-CAM boundary feeds. Streams are on the local network and open in a new tab. */
export function Esp32StreamGrid({
  nodes,
  isLive,
  isStale = false,
  recoveryStatus,
}: {
  nodes: Esp32Node[];
  isLive?: boolean | undefined;
  isStale?: boolean | undefined;
  recoveryStatus?: string | null | undefined;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  if (nodes.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-sage">No ESP32-CAM nodes registered yet.</div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {nodes.map((node, i) => {
        const isNorthCamera = node.id === "ESP32-CAM-01-NORTH";
        const hasHeartbeat = isNodeLive(node);

        type NodeStreamStatus =
          | "LIVE"
          | "CHECKING"
          | "RECONNECTING"
          | "STREAM STALE"
          | "CAMERA OFFLINE"
          | "GATEWAY OFFLINE"
          | "RECOVERY FAILED"
          | "POWER CYCLE REQUIRED"
          | "NODE OFFLINE";
        let status: NodeStreamStatus;

        if (!isNorthCamera) {
          // Reserved cameras remain offline per system specifications
          status = "NODE OFFLINE";
        } else if (recoveryStatus === "PHYSICAL_POWER_CYCLE_REQUIRED") {
          status = "POWER CYCLE REQUIRED";
        } else if (recoveryStatus === "RECOVERY_FAILED") {
          status = "RECOVERY FAILED";
        } else if (recoveryStatus === "RECONNECTING") {
          status = "RECONNECTING";
        } else if (recoveryStatus === "GATEWAY_OFFLINE") {
          status = "GATEWAY OFFLINE";
        } else if (recoveryStatus === "CHECKING") {
          status = "CHECKING";
        } else if (!hasHeartbeat) {
          status = "NODE OFFLINE";
        } else if (isStale || recoveryStatus === "STREAM_STALE") {
          status = "STREAM STALE";
        } else if (isLive === false || recoveryStatus === "CAMERA_OFFLINE") {
          status = "CAMERA OFFLINE";
        } else {
          status = "LIVE";
        }

        const isLiveFeed = status === "LIVE";
        const isSel = selected === node.id;
        const isFailed = status === "RECOVERY FAILED" || status === "GATEWAY OFFLINE" || status === "POWER CYCLE REQUIRED";
        const isWarning = status === "STREAM STALE" || status === "RECONNECTING" || status === "CHECKING";
        return (
          <div key={node.id} className="group overflow-hidden rounded-xl border border-border">
            <button
              type="button"
              onClick={() => setSelected(isSel ? null : node.id)}
              className="relative block aspect-video w-full overflow-hidden bg-stage text-left"
            >
              <div className="absolute inset-0 flex items-center justify-center text-center font-mono text-sm text-stage-foreground/30">
                ESP32-CAM Node {i + 1}
                <br />
                {status}
              </div>
              {isLiveFeed ? (
                <img
                  src={GATEWAY_VIDEO_FEED_URL}
                  alt={node.boundary_name || node.id}
                  className="absolute inset-0 h-full w-full object-cover"
                  loading="lazy"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : null}
              {isLiveFeed && <div className="absolute inset-0 border-2 border-penna/30 pointer-events-none" />}
              <div
                className={cn(
                  "absolute top-2 left-2 flex items-center gap-1.5 text-xs font-medium font-mono",
                  isLiveFeed
                    ? "text-success"
                    : isFailed
                      ? "text-destructive"
                      : isWarning
                        ? "text-warning"
                        : "text-sage",
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    isLiveFeed
                      ? "animate-pulse bg-success"
                      : isFailed
                        ? "bg-destructive"
                        : isWarning
                          ? "animate-pulse bg-warning"
                          : "bg-sage",
                  )}
                />
                {status}
              </div>
              <div className="absolute right-2 bottom-2 left-2 flex items-center justify-between rounded bg-stage/90 px-2 py-1 text-xs text-stage-foreground">
                <span className="truncate">{node.id} — {node.boundary_name}</span>
                <span
                  className={cn(
                    "ml-2 shrink-0 rounded px-1.5 py-0.5 text-xxs font-mono font-medium",
                    isNorthCamera
                      ? "bg-primary/20 text-penna border border-penna/30"
                      : "bg-muted/60 text-sage",
                  )}
                >
                  {isNorthCamera ? "PHYSICAL (HW)" : "RESERVED SLOT"}
                </span>
              </div>
              <div className="absolute inset-0 flex items-center justify-center bg-stage/0 opacity-0 transition group-hover:bg-stage/30 group-hover:opacity-100">
                <span className="flex items-center gap-2 rounded bg-stage/60 px-3 py-1.5 text-sm text-stage-foreground">
                  {isSel ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {isSel ? "Hide details" : "View node"}
                </span>
              </div>
            </button>
            {isSel && (
              <div className="space-y-1 bg-card p-3 text-xs">
                <div className="flex justify-between">
                  <span className="text-sage">FPS</span>
                  <span className="font-mono">{node.fps}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sage">Last ping</span>
                  <span className="font-mono">
                    {node.last_ping
                      ? new Date(node.last_ping).toLocaleTimeString("en-IN")
                      : "never"}
                  </span>
                </div>
                {isNorthCamera ? (
                  <>
                    <a
                      href={GATEWAY_VIDEO_FEED_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate font-mono text-success-strong underline"
                    >
                      Gateway Stream Relay ({GATEWAY_VIDEO_FEED_URL})
                    </a>
                    <p className="text-xxs text-sage">
                      Direct hardware access (:81/stream) is reserved for the Vision Gateway relay to prevent single-client hardware contention.
                    </p>
                  </>
                ) : (
                  <p className="text-xxs text-sage font-mono">
                    Reserved camera node slot. Optical matrix standby.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
