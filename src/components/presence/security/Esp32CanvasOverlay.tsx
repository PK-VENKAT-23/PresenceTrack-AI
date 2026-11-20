import { useEffect, useRef, useState, useCallback } from "react";
import { cn } from "@/lib/utils";

export const GATEWAY_VIDEO_FEED_URL = "http://localhost:8001/video_feed";

type StreamStatus = "idle" | "connecting" | "active" | "error" | "timeout";

interface Esp32CanvasOverlayProps {
  isLive: boolean;
  isStale?: boolean | undefined;
  streamUrl?: string | null | undefined;
  faceDetected?: boolean | undefined;
  faceBoundingBox?: { x: number; y: number; w: number; h: number } | null | undefined;
  scScore?: number | undefined;
  statusMessage?: string | undefined;
  onStreamStatusChange?: ((status: "active" | "connecting" | "error" | "timeout" | "offline") => void) | undefined;
  recoveryStatus?: string | null | undefined;
}

// Canvas cannot read CSS variables per pixel; values mirror the Penna / Emerald / Umbra tokens.
const PENNA = "#BAC8E0";
const EMERALD = "#10B981";
const STAGE = "#161616";

/** Canvas overlay: alignment grid, boundary crossing line, dynamic facial bounding boxes, and active MJPEG video frame integration. */
export function Esp32CanvasOverlay({
  isLive,
  isStale = false,
  streamUrl,
  faceDetected = false,
  faceBoundingBox = null,
  scScore = 0,
  statusMessage,
  onStreamStatusChange,
  recoveryStatus,
}: Esp32CanvasOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("idle");
  const [retryKey, setRetryKey] = useState(0);
  const lastStatusRef = useRef<StreamStatus>("idle");

  // Relay video through Vision Gateway to avoid ESP32-CAM single-client contention.
  // Direct camera port 81 streams are intercepted and redirected to the gateway relay.
  const resolvedStreamUrl =
    streamUrl === null
      ? null
      : streamUrl && !streamUrl.includes(":81/stream")
        ? streamUrl
        : GATEWAY_VIDEO_FEED_URL;

  const updateStatus = useCallback(
    (newStatus: StreamStatus) => {
      if (lastStatusRef.current !== newStatus) {
        lastStatusRef.current = newStatus;
        setStreamStatus(newStatus);
        const mapped = newStatus === "idle" ? "offline" : newStatus;
        onStreamStatusChange?.(mapped);
      }
    },
    [onStreamStatusChange],
  );

  // Continuous frame monitoring: polls naturalWidth/naturalHeight without giving up after timeout
  useEffect(() => {
    if (!isLive || !resolvedStreamUrl) {
      updateStatus("idle");
      return;
    }

    console.info(`[Esp32Stream] Initializing connection to ${resolvedStreamUrl} (reconnect attempt #${retryKey + 1})`);
    updateStatus("connecting");

    const checkFrames = () => {
      const img = imgRef.current;
      if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
        console.info(`[Esp32Stream] Video frames active: ${img.naturalWidth}x${img.naturalHeight}px from ${resolvedStreamUrl}`);
        updateStatus("active");
        return true;
      }
      return false;
    };

    if (checkFrames()) return;

    let elapsedMs = 0;
    const intervalMs = 250;
    const timeoutThresholdMs = 8000; // 8 seconds before surfacing timeout notice

    const interval = setInterval(() => {
      elapsedMs += intervalMs;
      const hasFrames = checkFrames();

      if (hasFrames) {
        clearInterval(interval);
      } else if (elapsedMs >= timeoutThresholdMs) {
        // Crucial: Update status so operator is alerted, but DO NOT stop polling.
        // As soon as the ESP32 delivers frames, checkFrames will succeed.
        if (lastStatusRef.current !== "timeout" && lastStatusRef.current !== "error") {
          console.warn(`[Esp32Stream] Frame receipt pending: no frames decoded after ${elapsedMs / 1000}s from ${resolvedStreamUrl}. Continuing to listen...`);
          updateStatus("timeout");
        }
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }, [resolvedStreamUrl, isLive, retryKey, updateStatus]);

  // Automatic background reconnection when stream errors or times out while camera is live
  useEffect(() => {
    if (!isLive || (streamStatus !== "error" && streamStatus !== "timeout")) {
      return undefined;
    }
    const timer = setTimeout(() => {
      console.info("[Esp32Stream] Auto-retrying stream connection...");
      setRetryKey((k) => k + 1);
    }, 3000);
    return () => clearTimeout(timer);
  }, [streamStatus, isLive]);

  const hasActiveStream = streamStatus === "active";

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = 400;
    canvas.height = 300;

    if (hasActiveStream && !isStale) {
      // Clear canvas so the underlying MJPEG stream is completely visible
      if (typeof ctx.clearRect === "function") {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    } else {
      // Draw dark stage background when video stream is not actively displaying
      ctx.fillStyle = STAGE;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (!isLive) {
        ctx.fillStyle = "#F59E0B";
        ctx.font = "bold 13px 'JetBrains Mono', monospace";
        ctx.fillText(statusMessage || "Camera Offline · Stream Interrupted", 16, 32);
        ctx.fillStyle = "#888888";
        ctx.font = "11px 'Plus Jakarta Sans', sans-serif";
        ctx.fillText("Optical sensor stream disconnected · Auto-recovering…", 16, 56);
        return;
      }

      if (isStale) {
        ctx.fillStyle = "#F59E0B";
        ctx.font = "bold 13px 'JetBrains Mono', monospace";
        ctx.fillText("Stream Stale · Awaiting Fresh Frames", 16, 32);
        ctx.fillStyle = "#888888";
        ctx.font = "11px 'Plus Jakarta Sans', sans-serif";
        ctx.fillText("Optical sensor stream stalled · Auto-recovering…", 16, 56);
        return;
      }

      if (streamStatus === "error") {
        ctx.fillStyle = "#F59E0B";
        ctx.font = "bold 13px 'JetBrains Mono', monospace";
        ctx.fillText("Stream Error · Connection refused", 16, 32);
        ctx.fillStyle = "#888888";
        ctx.font = "11px 'Plus Jakarta Sans', sans-serif";
        ctx.fillText(`Could not reach ${streamUrl} on port 81`, 16, 56);
      } else if (streamStatus === "timeout") {
        ctx.fillStyle = "#F59E0B";
        ctx.font = "bold 13px 'JetBrains Mono', monospace";
        ctx.fillText("Stream Standby · Awaiting video frames", 16, 32);
        ctx.fillStyle = "#888888";
        ctx.font = "11px 'Plus Jakarta Sans', sans-serif";
        ctx.fillText(`Node attested; listening for MJPEG frames from ${streamUrl}`, 16, 56);
      } else {
        ctx.fillStyle = PENNA;
        ctx.font = "13px 'JetBrains Mono', monospace";
        ctx.fillText("Connecting to camera stream…", 16, 32);
        ctx.fillStyle = "#888888";
        ctx.font = "11px 'Plus Jakarta Sans', sans-serif";
        ctx.fillText(streamUrl || "Awaiting stream address", 16, 56);
      }
    }

    // Alignment grid & virtual boundary line
    ctx.strokeStyle = PENNA;
    ctx.globalAlpha = hasActiveStream ? 0.25 : 0.3;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    // Center vertical
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.stroke();

    // Virtual boundary line (tripwire baseline)
    ctx.strokeStyle = EMERALD;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(20, canvas.height / 2);
    ctx.lineTo(canvas.width - 20, canvas.height / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Boundary label with subtle backdrop for contrast over live video
    if (hasActiveStream) {
      ctx.fillStyle = "rgba(22, 22, 22, 0.65)";
      ctx.fillRect(20, canvas.height / 2 - 20, 164, 16);
    }
    ctx.fillStyle = EMERALD;
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillText("VIRTUAL BOUNDARY TRIPWIRE", 24, canvas.height / 2 - 8);

    if (faceDetected && faceBoundingBox) {
      const { x, y, w, h } = faceBoundingBox;
      ctx.strokeStyle = EMERALD;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, w, h);

      // Corner ticks
      ctx.lineWidth = 4;
      const t = 12;
      for (const [cx, cy, dx, dy] of [
        [x, y, 1, 1],
        [x + w, y, -1, 1],
        [x, y + h, 1, -1],
        [x + w, y + h, -1, -1],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(cx + dx * t, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + dy * t);
        ctx.stroke();
      }

      if (hasActiveStream) {
        ctx.fillStyle = "rgba(22, 22, 22, 0.7)";
        ctx.fillRect(12, 14, 105, 22);
      }
      ctx.fillStyle = EMERALD;
      ctx.font = "bold 14px 'JetBrains Mono', monospace";
      ctx.fillText(`Sc: ${scScore.toFixed(4)}`, 16, 30);
    } else if (!hasActiveStream) {
      ctx.fillStyle = PENNA;
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.fillText("Optical boundary active · Standby for transit", 16, 30);
    }
  }, [isLive, isStale, resolvedStreamUrl, hasActiveStream, streamStatus, faceDetected, faceBoundingBox, scScore, statusMessage]);

  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-stage">
      {isLive && resolvedStreamUrl && (
        <img
          ref={imgRef}
          key={`${resolvedStreamUrl}-${retryKey}`}
          src={resolvedStreamUrl}
          alt="ESP32-CAM live stream"
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-200",
            hasActiveStream && !isStale ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => {
            console.info(`[Esp32Stream] Image element onLoad dispatched for ${resolvedStreamUrl}`);
            updateStatus("active");
          }}
          onError={() => {
            console.error(`[Esp32Stream] HTTP error/connection refused for ${resolvedStreamUrl}`);
            updateStatus("error");
          }}
        />
      )}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full pointer-events-none"
      />
      {recoveryStatus === "RECOVERY_FAILED" ? (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-stage/90 px-2 py-1 font-mono text-xs font-bold text-destructive">
          <span className="h-2 w-2 rounded-full bg-destructive" />
          RECOVERY FAILED
        </div>
      ) : recoveryStatus === "RECONNECTING" ? (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-stage/90 px-2 py-1 font-mono text-xs text-warning">
          <span className="h-2 w-2 rounded-full bg-warning animate-pulse" />
          RECONNECTING…
        </div>
      ) : recoveryStatus === "GATEWAY_OFFLINE" ? (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-stage/90 px-2 py-1 font-mono text-xs text-destructive">
          <span className="h-2 w-2 rounded-full bg-destructive" />
          GATEWAY OFFLINE
        </div>
      ) : recoveryStatus === "CHECKING" ? (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-stage/90 px-2 py-1 font-mono text-xs text-penna">
          <span className="h-2 w-2 rounded-full bg-penna animate-pulse" />
          CHECKING…
        </div>
      ) : !isLive ? (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-stage/90 px-2 py-1 font-mono text-xs text-warning">
          <span className="h-2 w-2 rounded-full bg-warning" />
          CAMERA OFFLINE
        </div>
      ) : isStale ? (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-stage/90 px-2 py-1 font-mono text-xs text-warning">
          <span className="h-2 w-2 rounded-full bg-warning animate-pulse" />
          STREAM STALE
        </div>
      ) : hasActiveStream ? (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-stage/80 px-2 py-1 font-mono text-xs text-success">
          <span className="h-2 w-2 rounded-full animate-pulse bg-success" />
          LIVE STREAM
        </div>
      ) : streamStatus === "connecting" ? (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-stage/80 px-2 py-1 font-mono text-xs text-sage">
          <span className="h-2 w-2 rounded-full animate-pulse bg-sage" />
          CONNECTING…
        </div>
      ) : streamStatus === "error" ? (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-stage/80 px-2 py-1 font-mono text-xs text-warning">
          <span className="h-2 w-2 rounded-full bg-warning animate-pulse" />
          STREAM ERROR
        </div>
      ) : streamStatus === "timeout" ? (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-stage/80 px-2 py-1 font-mono text-xs text-warning">
          <span className="h-2 w-2 rounded-full bg-warning animate-pulse" />
          STREAM TIMEOUT
        </div>
      ) : null}
      {isLive && (streamStatus === "error" || streamStatus === "timeout") && (
        <button
          type="button"
          onClick={() => {
            console.info("[Esp32Stream] User triggered manual stream reconnect");
            setRetryKey((k) => k + 1);
          }}
          className="absolute bottom-2 right-2 rounded bg-stage/90 px-2.5 py-1 text-xxs font-mono text-penna border border-border/50 hover:bg-muted transition"
        >
          ↻ Reconnect Stream
        </button>
      )}
      {!isStale && isLive && faceDetected && scScore > 0 && (
        <>
          <div className="absolute top-2 right-2 rounded bg-stage/80 px-2 py-1 font-mono text-xs text-success">
            Sc {scScore.toFixed(4)}
          </div>
          <div className="absolute bottom-2 left-2 rounded bg-success/90 px-2 py-1 text-xs font-medium text-primary-foreground">
            Identity Verified
          </div>
        </>
      )}
      {!isStale && isLive && !faceDetected && (
        <div className="absolute bottom-2 left-2 rounded bg-muted/80 px-2.5 py-1 text-xxs font-mono text-sage">
          Awaiting boundary transit
        </div>
      )}
    </div>
  );
}
