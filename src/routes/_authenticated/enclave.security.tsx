import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Settings, ShieldCheck, Activity } from "lucide-react";
import { isNodeLive } from "@/lib/ambient";
import { canAccessEnclave, enclavePathFor } from "@/lib/enclaves";
import { liveTelemetryQuery, nodesQuery, recentTransitsQuery } from "@/lib/queries";
import { useRealtimeRefresh } from "@/hooks/use-realtime";
import { Esp32StreamGrid } from "@/components/presence/security/Esp32StreamGrid";
import { Esp32CanvasOverlay, GATEWAY_VIDEO_FEED_URL } from "@/components/presence/security/Esp32CanvasOverlay";
import { CameraConfigModal } from "@/components/presence/security/CameraConfigModal";
import { LiveTransitFeed } from "@/components/presence/security/LiveTransitFeed";
import { UnknownDetectionsList } from "@/components/presence/security/UnknownDetectionsList";
import { playTransitBlip } from "@/lib/sound-engine";

export const Route = createFileRoute("/_authenticated/enclave/security")({
  head: () => ({
    meta: [
      { title: "Physical Security Console — PresenceTrack AI" },
      {
        name: "description",
        content: "ESP32-CAM node matrix, boundary configuration and live optical transit stream.",
      },
      { property: "og:title", content: "Physical Security Console — PresenceTrack AI" },
      {
        property: "og:description",
        content: "ESP32-CAM node matrix, boundary configuration and live optical transit stream.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canAccessEnclave(context.role, "security"))
      throw redirect({ to: enclavePathFor(context.role) });
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(nodesQuery()),
      context.queryClient.ensureQueryData(recentTransitsQuery()),
    ]);
  },
  component: SecurityEnclave,
});

function SecurityEnclave() {
  const { data: nodes } = useSuspenseQuery(nodesQuery());
  const { data: transits } = useSuspenseQuery(recentTransitsQuery());
  const { data: telemetry } = useQuery(liveTelemetryQuery());
  const queryClient = useQueryClient();
  const [showConfig, setShowConfig] = useState(false);
  const [clearedAt, setClearedAt] = useState<number | null>(null);

  useRealtimeRefresh("esp32_camera_nodes", [["nodes"]]);
  useRealtimeRefresh("passive_transits", [["transits", "recent"]], { onInsert: playTransitBlip });
  useRealtimeRefresh("unknown_detections", [["unknown_detections"]]);

  const online = nodes.filter((n) => n.id === "ESP32-CAM-01-NORTH" && isNodeLive(n)).length;
  const activeNode =
    nodes.find((n) => n.id === "ESP32-CAM-01-NORTH" && isNodeLive(n)) ??
    nodes.find((n) => isNodeLive(n)) ??
    nodes.find((n) => n.id === "ESP32-CAM-01-NORTH") ??
    nodes[0] ??
    null;
  const isNodeAttested = Boolean(
    activeNode && activeNode.id === "ESP32-CAM-01-NORTH" && isNodeLive(activeNode),
  );
  const isTelemetryTimeStale = telemetry?.updated_at
    ? Date.now() - new Date(telemetry.updated_at).getTime() > 4000
    : false;
  const isStale = Boolean(telemetry?.is_stale) || isTelemetryTimeStale;
  const isCameraLive = Boolean(isNodeAttested && !isStale);
  const feed = useMemo(
    () =>
      transits
        .filter((t) => clearedAt === null || new Date(t.timestamp).getTime() > clearedAt)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 100),
    [transits, clearedAt],
  );

  return (
    <div className="space-y-6">
      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span
              className={`h-3 w-3 rounded-full ${online ? "animate-pulse bg-success" : "bg-warning"}`}
            />
            <span className="text-sm font-semibold text-umbra">
              {online}/{nodes.length} ESP32-CAM NODES ONLINE
            </span>
          </div>
          <div className="font-mono text-sm text-sage">
            Live telemetry stream | FPS: {nodes[0]?.fps ?? 15}
          </div>
        </div>
        <button type="button" onClick={() => setShowConfig(true)} className="glass-btn">
          <Settings className="h-4 w-4" /> Configure IP nodes
        </button>
      </div>

      <div className="glass-card">
        <Esp32StreamGrid
          nodes={nodes}
          isLive={isCameraLive}
          isStale={isStale}
          recoveryStatus={telemetry?.recovery_status}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="glass-card lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <span className="stat-card-label">Optical Perimeter Monitor</span>
            <span className="flex items-center gap-1 text-xs text-sage">
              <Activity className="h-3.5 w-3.5 text-success-strong" /> Matrix Active
            </span>
          </div>
          <Esp32CanvasOverlay
            isLive={isCameraLive}
            isStale={isStale}
            recoveryStatus={telemetry?.recovery_status}
            streamUrl={isNodeAttested ? GATEWAY_VIDEO_FEED_URL : null}
            faceDetected={!isStale && isCameraLive && (telemetry?.face_detected ?? false)}
            faceBoundingBox={!isCameraLive || isStale ? null : (telemetry?.face_bounding_box ?? null)}
            scScore={!isCameraLive || isStale ? 0 : (telemetry?.sc_score ?? 0)}
            matchScore={!isCameraLive || isStale ? 0 : (telemetry?.match_score ?? telemetry?.sc_score ?? 0)}
            identityStatus={!isCameraLive ? "NO_FACE" : (isStale ? "STALE" : telemetry?.identity_status)}
            matchedName={!isCameraLive || isStale || telemetry?.identity_status !== "VERIFIED" ? null : telemetry?.matched_name}
            trackId={!isCameraLive || isStale ? null : telemetry?.track_id}
            consecutiveMatchFrames={!isCameraLive || isStale ? 0 : (telemetry?.consecutive_match_frames ?? 0)}
            detectedFaces={
              !isCameraLive || isStale
                ? []
                : (telemetry?.detected_faces?.map((f) => ({
                    bbox: f.bbox,
                    identityStatus: f.identity_status,
                    matchedName: f.matched_name,
                    scScore: f.sc_score,
                    trackId: f.track_id,
                    candidateEmployeeId: f.candidate_employee_id,
                    candidateName: f.candidate_name,
                    similarityScore: f.similarity_score,
                    matchingThreshold: f.matching_threshold,
                    confirmationCount: f.confirmation_count,
                    requiredConfirmationCount: f.required_confirmation_count,
                    lastMatchTimestamp: f.last_match_timestamp,
                    timeToVerifiedMs: f.time_to_verified_ms,
                    detectionLatencyMs: f.detection_latency_ms,
                    recognitionLatencyMs: f.recognition_latency_ms,
                  })) ?? [])
            }
            statusMessage={
              !isCameraLive
                ? isStale
                  ? "Stream stale · Awaiting fresh camera frames…"
                  : "Camera node offline · Stream interrupted"
                : !isStale && telemetry?.face_detected && telemetry.identity_status === "VERIFIED" && telemetry.matched_name
                  ? `Optical match: ${telemetry.matched_name}`
                  : !isStale && telemetry?.face_detected && telemetry.identity_status === "UNKNOWN"
                    ? `Unknown face detected (${(telemetry.sc_score ?? 0).toFixed(4)}) · No employee match`
                    : !isStale && telemetry?.face_detected && telemetry.identity_status === "VERIFYING"
                      ? `Verifying identity (${(telemetry.sc_score ?? 0).toFixed(4)})…`
                      : "Perimeter Active · Standby for transits"
            }
          />
          <div className="mt-2 flex justify-between text-xs text-sage">
            <span
              className={
                isCameraLive ? "text-success-strong" : "text-warning-strong"
              }
            >
              {isCameraLive
                ? "Sensor stream connected"
                : "Awaiting hardware node heartbeat"}
            </span>
            <span className="font-mono">
              {telemetry?.active_tracks
                ? `${telemetry.active_tracks} track${telemetry.active_tracks > 1 ? "s" : ""} active`
                : "Real-time edge telemetry"}
            </span>
          </div>
        </div>

        <div className="space-y-3 lg:col-span-3">
          <h3 className="text-sm font-semibold text-umbra">
            Sub-millisecond optical transit stream
          </h3>
          <LiveTransitFeed
            transits={feed}
            onClear={() => {
              setClearedAt(Date.now());
            }}
          />
        </div>
      </div>

      {/* Unknown Detections & Alert Triage Feed */}
      <UnknownDetectionsList />

      <CameraConfigModal
        open={showConfig}
        onClose={() => setShowConfig(false)}
        nodes={nodes}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ["nodes"] })}
      />
    </div>
  );
}
