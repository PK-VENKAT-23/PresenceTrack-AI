import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  Wifi,
  Power,
  RotateCcw,
} from "lucide-react";
import { GATEWAY_VIDEO_FEED_URL, Esp32CanvasOverlay } from "./Esp32CanvasOverlay";
import { CameraDiagnosticsModal } from "./CameraDiagnosticsModal";
import { refreshCameraStream, rebootCameraStream } from "@/lib/camera.functions";
import type { Esp32Node } from "@/lib/ambient";
import type { LiveTelemetry } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface Esp32CameraControlCardProps {
  nodes: Esp32Node[];
  activeNode: Esp32Node | null | undefined;
  isNodeAttested: boolean;
  isCameraLive: boolean;
  live: number;
  telemetry?: LiveTelemetry | undefined;
  onRefreshTelemetry?: (() => void) | undefined;
}

export type DisplayCameraState =
  | "LIVE"
  | "CHECKING"
  | "BACKEND STARTING"
  | "RECONNECTING"
  | "VERIFYING FRESH FRAMES"
  | "STREAM STALE"
  | "CAMERA OFFLINE"
  | "CAMERA REBOOTING"
  | "GATEWAY OFFLINE"
  | "RECOVERY FAILED"
  | "PHYSICAL POWER CYCLE REQUIRED";

export function Esp32CameraControlCard({
  nodes,
  activeNode,
  isNodeAttested,
  isCameraLive,
  live,
  telemetry,
  onRefreshTelemetry,
}: Esp32CameraControlCardProps) {
  const refreshStreamFn = useServerFn(refreshCameraStream);
  const rebootStreamFn = useServerFn(rebootCameraStream);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRebooting, setIsRebooting] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [streamState, setStreamState] = useState<
    "active" | "connecting" | "error" | "timeout" | "offline"
  >("offline");

  // Determine state strictly following requirements:
  // LIVE, CHECKING, BACKEND STARTING, CAMERA REBOOTING, RECONNECTING, VERIFYING FRESH FRAMES,
  // STREAM STALE, CAMERA OFFLINE, GATEWAY OFFLINE, RECOVERY FAILED, PHYSICAL POWER CYCLE REQUIRED
  const recoveryStatus = telemetry?.recovery_status?.toUpperCase() || "IDLE";
  const isTelemetryTimeStale = telemetry?.updated_at
    ? Date.now() - new Date(telemetry.updated_at).getTime() > 4000
    : false;
  const isStale = Boolean(telemetry?.is_stale) || isTelemetryTimeStale;
  const failureReason = telemetry?.current_failure_reason || null;
  const attempts = telemetry?.recovery_attempt_count ?? 0;
  const consecutiveFailures = telemetry?.consecutive_failures ?? 0;

  let displayState: DisplayCameraState;

  if (recoveryStatus === "PHYSICAL_POWER_CYCLE_REQUIRED") {
    displayState = "PHYSICAL POWER CYCLE REQUIRED";
  } else if (isRebooting || recoveryStatus === "CAMERA_REBOOTING") {
    displayState = "CAMERA REBOOTING";
  } else if (isRefreshing || recoveryStatus === "RECONNECTING") {
    displayState = "RECONNECTING";
  } else if (recoveryStatus === "VERIFYING_FRESH_FRAMES" || recoveryStatus === "VERIFYING") {
    displayState = "VERIFYING FRESH FRAMES";
  } else if (recoveryStatus === "RECOVERY_FAILED" || consecutiveFailures >= 5) {
    displayState = "RECOVERY FAILED";
  } else if (recoveryStatus === "GATEWAY_OFFLINE" || (streamState === "error" && !isNodeAttested)) {
    displayState = "GATEWAY OFFLINE";
  } else if (recoveryStatus === "BACKEND_STARTING") {
    displayState = "BACKEND STARTING";
  } else if (isStale || recoveryStatus === "STREAM_STALE") {
    displayState = "STREAM STALE";
  } else if (!isCameraLive || !isNodeAttested || recoveryStatus === "CAMERA_OFFLINE") {
    displayState = "CAMERA OFFLINE";
  } else if (recoveryStatus === "CHECKING") {
    displayState = "CHECKING";
  } else if (isCameraLive && (recoveryStatus === "LIVE" || streamState === "active")) {
    displayState = "LIVE";
  } else {
    displayState = "CHECKING";
  }

  const handleRefresh = async () => {
    try {
      setIsRefreshing(true);
      const res = await refreshStreamFn({ data: { force: true } });

      if (res.success && (res.new_frames_received > 0 || res.is_synthetic)) {
        toast.success(
          res.is_synthetic
            ? "Camera stream refreshed (synthetic stream active)"
            : `Camera stream refreshed: ${res.new_frames_received} fresh frames in ${res.time_taken_sec}s`,
        );
      } else {
        toast.error(res.message || res.failure_reason || "Camera refresh failed: No fresh real frames received");
      }

      onRefreshTelemetry?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to refresh camera stream");
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleReboot = async () => {
    try {
      setIsRebooting(true);
      toast.info("Sending authenticated reboot request to ESP32-CAM...");
      const res = await rebootStreamFn();
      if (res.success && res.status !== "FIRMWARE_RESTART_NOT_SUPPORTED") {
        toast.success(res.message || "ESP32-CAM rebooted and stream restored successfully");
      } else {
        toast.error(res.message || "Camera reboot request failed or firmware does not support remote restart");
      }
      onRefreshTelemetry?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to trigger camera reboot");
    } finally {
      setIsRebooting(false);
    }
  };

  const getStateBadge = (st: DisplayCameraState) => {
    switch (st) {
      case "LIVE":
        return (
          <div className="flex items-center gap-1.5 rounded bg-success-soft/90 px-2 py-0.5 font-mono text-xs font-semibold text-success-strong">
            <span className="h-2 w-2 rounded-full animate-pulse bg-success" />
            LIVE
          </div>
        );
      case "CHECKING":
        return (
          <div className="flex items-center gap-1.5 rounded bg-penna/20 px-2 py-0.5 font-mono text-xs font-semibold text-penna">
            <span className="h-2 w-2 rounded-full animate-pulse bg-penna" />
            CHECKING
          </div>
        );
      case "RECONNECTING":
        return (
          <div className="flex items-center gap-1.5 rounded bg-warning-soft/90 px-2 py-0.5 font-mono text-xs font-semibold text-warning-strong">
            <RefreshCw className="h-3 w-3 animate-spin text-warning" />
            RECONNECTING
          </div>
        );
      case "VERIFYING FRESH FRAMES":
        return (
          <div className="flex items-center gap-1.5 rounded bg-penna/20 px-2 py-0.5 font-mono text-xs font-semibold text-penna">
            <RefreshCw className="h-3 w-3 animate-spin text-penna" />
            VERIFYING FRAMES
          </div>
        );
      case "CAMERA REBOOTING":
        return (
          <div className="flex items-center gap-1.5 rounded bg-warning-soft/90 px-2 py-0.5 font-mono text-xs font-semibold text-warning-strong">
            <RotateCcw className="h-3 w-3 animate-spin text-warning" />
            CAMERA REBOOTING
          </div>
        );
      case "BACKEND STARTING":
        return (
          <div className="flex items-center gap-1.5 rounded bg-penna/20 px-2 py-0.5 font-mono text-xs font-semibold text-penna">
            <Server className="h-3 w-3 animate-pulse text-penna" />
            BACKEND STARTING
          </div>
        );
      case "STREAM STALE":
        return (
          <div className="flex items-center gap-1.5 rounded bg-warning-soft/90 px-2 py-0.5 font-mono text-xs font-semibold text-warning-strong">
            <span className="h-2 w-2 rounded-full animate-pulse bg-warning" />
            STREAM STALE
          </div>
        );
      case "RECOVERY FAILED":
        return (
          <div className="flex items-center gap-1.5 rounded bg-destructive-soft px-2 py-0.5 font-mono text-xs font-bold text-destructive">
            <AlertOctagon className="h-3 w-3 text-destructive" />
            RECOVERY FAILED
          </div>
        );
      case "PHYSICAL POWER CYCLE REQUIRED":
        return (
          <div className="flex items-center gap-1.5 rounded bg-destructive-soft px-2 py-0.5 font-mono text-xs font-bold text-destructive">
            <Power className="h-3 w-3 text-destructive animate-pulse" />
            POWER CYCLE REQUIRED
          </div>
        );
      case "GATEWAY OFFLINE":
        return (
          <div className="flex items-center gap-1.5 rounded bg-destructive-soft px-2 py-0.5 font-mono text-xs font-semibold text-destructive">
            <Server className="h-3 w-3 text-destructive" />
            GATEWAY OFFLINE
          </div>
        );
      case "CAMERA OFFLINE":
      default:
        return (
          <div className="flex items-center gap-1.5 rounded bg-muted px-2 py-0.5 font-mono text-xs font-semibold text-sage">
            <span className="h-2 w-2 rounded-full bg-sage" />
            CAMERA OFFLINE
          </div>
        );
    }
  };

  return (
    <div className="glass-card">
      {/* Header with Title and Control Buttons */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-umbra">
            Optical security matrix — ESP32-CAM-01-NORTH
          </h3>
          {getStateBadge(displayState)}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing || isRebooting}
            className="glass-btn flex items-center gap-1.5 py-1 px-2.5 text-xs text-penna hover:bg-muted/50"
            title="Trigger safe gateway stream reconnect and verify fresh real frames"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin text-warning")} />
            {isRefreshing ? "Refreshing…" : "Refresh Camera"}
          </button>
          {displayState !== "LIVE" && (
            <button
              type="button"
              onClick={handleReboot}
              disabled={isRebooting || isRefreshing}
              className="glass-btn flex items-center gap-1.5 py-1 px-2.5 text-xs text-penna hover:bg-muted/50"
              title="Request authenticated software restart of ESP32-CAM hardware"
            >
              <RotateCcw className={cn("h-3.5 w-3.5", isRebooting && "animate-spin text-warning")} />
              {isRebooting ? "Rebooting…" : "Reboot Camera"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowDiagnostics(true)}
            className="glass-btn flex items-center gap-1.5 py-1 px-2.5 text-xs text-penna hover:bg-muted/50"
            title="Inspect 9-point health checks, reachability, and diagnostic history"
          >
            <Activity className="h-3.5 w-3.5" />
            Run Diagnostics
          </button>
        </div>
      </div>

      {/* Primary Video Feed Overlay */}
      <Esp32CanvasOverlay
        isLive={isCameraLive && displayState !== "RECOVERY FAILED" && displayState !== "PHYSICAL POWER CYCLE REQUIRED"}
        isStale={isStale || isRefreshing || displayState === "RECONNECTING" || displayState === "CAMERA REBOOTING"}
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
        onStreamStatusChange={setStreamState}
        statusMessage={
          displayState === "PHYSICAL POWER CYCLE REQUIRED"
            ? "Camera unreachable · Physical power cycle required (unplug/replug)"
            : displayState === "CAMERA REBOOTING"
              ? "Rebooting ESP32-CAM · Awaiting Wi-Fi reconnection…"
              : displayState === "VERIFYING FRESH FRAMES"
                ? "Camera connected · Verifying fresh real frames…"
                : displayState === "RECONNECTING"
                  ? "Reconnecting to camera stream · Verifying fresh frames…"
                  : displayState === "BACKEND STARTING"
                    ? "Website backend starting on port 8080…"
                    : displayState === "RECOVERY FAILED"
                      ? "Automatic recovery failed · Manual Refresh required"
                      : displayState === "GATEWAY OFFLINE"
                        ? "Vision Gateway offline on port 8001"
                        : isStale
                          ? "Stream stale · Awaiting fresh camera frames…"
                          : !isCameraLive
                            ? "Waiting for edge camera stream…"
                            : !isStale && telemetry?.face_detected && telemetry.identity_status === "VERIFIED" && telemetry.matched_name
                              ? `Optical match: ${telemetry.matched_name}`
                              : !isStale && telemetry?.face_detected && telemetry.identity_status === "UNKNOWN"
                                ? `Unknown face detected (${(telemetry.sc_score ?? 0).toFixed(4)}) · No employee match`
                                : !isStale && telemetry?.face_detected && telemetry.identity_status === "VERIFYING"
                                  ? `Verifying identity (${(telemetry.sc_score ?? 0).toFixed(4)})…`
                                  : "Optical boundary active · Standby for transit"
        }
      />

      {/* Human-Readable Failure Banner when in degraded or failed state */}
      {failureReason && displayState !== "LIVE" && (
        <div className="mt-2.5 rounded-lg border border-warning/40 bg-warning-soft/30 p-2.5 text-xxs font-mono text-warning-strong flex items-start gap-2">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-semibold uppercase tracking-wider">Failure Cause: </span>
            <span>{failureReason}</span>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="shrink-0 underline hover:text-umbra font-sans text-xxs font-medium"
          >
            Retry now
          </button>
        </div>
      )}

      {/* Telemetry & Recovery Health Metadata Strip */}
      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4 rounded-lg bg-card/60 p-2 font-mono text-xxs text-sage border border-border/40">
        <div>
          <span className="text-muted-foreground block text-[10px] uppercase">Auto-Recovery</span>
          <span
            className={cn(
              "font-semibold",
              consecutiveFailures >= 5
                ? "text-destructive"
                : consecutiveFailures > 0
                  ? "text-warning-strong"
                  : "text-success-strong",
            )}
          >
            {consecutiveFailures >= 5
              ? "HALTED (FAILED)"
              : displayState === "RECONNECTING"
                ? "ACTIVE (RECOVERING)"
                : `MONITORING (${attempts} tries)`}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground block text-[10px] uppercase">Last Real Frame</span>
          <span className="text-umbra">
            {telemetry?.last_successful_frame_timestamp
              ? new Date(telemetry.last_successful_frame_timestamp).toLocaleTimeString("en-IN")
              : telemetry?.updated_at
                ? new Date(telemetry.updated_at).toLocaleTimeString("en-IN")
                : "None"}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground block text-[10px] uppercase">Last Diagnostics</span>
          <span className="text-umbra">
            {telemetry?.last_diagnostic_timestamp
              ? new Date(telemetry.last_diagnostic_timestamp).toLocaleTimeString("en-IN")
              : "Continuous (15s)"}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground block text-[10px] uppercase">Reconnections</span>
          <span className="text-umbra">
            {attempts} attempt{attempts === 1 ? "" : "s"} ({consecutiveFailures} failed)
          </span>
        </div>
      </div>

      {/* Real-time Pipeline Latency & Diagnostic Metrics */}
      {isCameraLive && (
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 rounded bg-surface/50 px-2 py-1 font-mono text-[10px] text-muted-foreground border border-border/30">
          <span>
            FPS: <strong className="text-foreground">{telemetry?.actual_fps ?? 0}</strong> ({telemetry?.avg_frame_interval_ms ?? 0}ms)
          </span>
          <span>
            Pipeline: <strong className="text-foreground">{telemetry?.frame_processing_latency_ms ?? 0}ms</strong> (Det: {telemetry?.face_detection_latency_ms ?? 0}ms · Rec: {telemetry?.face_recognition_latency_ms ?? 0}ms)
          </span>
          <span>
            Queue: <strong className="text-foreground">{telemetry?.frame_queue_depth ?? 0}</strong> · Drops: <strong className="text-foreground">{telemetry?.dropped_frames ?? 0}</strong>
          </span>
        </div>
      )}

      {/* Node Attestation & Stream Footer */}
      <div className="mt-2 flex items-center justify-between font-mono text-xs text-sage">
        <span className="truncate">
          {activeNode ? (
            <span>
              {activeNode.id} — {activeNode.boundary_name} · Gateway Relay
            </span>
          ) : (
            "No registered camera nodes"
          )}
        </span>
        <span className="shrink-0 pl-2">
          {isCameraLive
            ? `${live} / ${nodes.length} Nodes Attested · ${
                streamState === "active"
                  ? `Live (${activeNode?.fps ?? 15} FPS)`
                  : streamState === "connecting"
                    ? "Negotiating stream…"
                    : "Video stream standby"
              }`
            : `${live} / ${nodes.length} Nodes Attested · Stream Standby`}
        </span>
      </div>

      {/* Diagnostics Modal */}
      {showDiagnostics && (
        <CameraDiagnosticsModal
          onClose={() => setShowDiagnostics(false)}
          onRefreshRequested={handleRefresh}
        />
      )}
    </div>
  );
}
