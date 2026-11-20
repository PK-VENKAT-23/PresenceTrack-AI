import { useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  History,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  Wifi,
  X,
} from "lucide-react";
import { Modal } from "@/components/presence/layout/Modal";
import {
  runCameraDiagnostics,
  getCameraDiagnostics,
  type CameraDiagnosticReport,
  type CameraDiagnosticHistoryEntry,
  type GetDiagnosticsResult,
  type RunDiagnosticsResult,
} from "@/lib/camera.functions";
import { cn } from "@/lib/utils";

interface CameraDiagnosticsModalProps {
  onClose: () => void;
  onRefreshRequested?: () => void;
}

export function CameraDiagnosticsModal({ onClose, onRefreshRequested }: CameraDiagnosticsModalProps) {
  const runDiagnosticsFn = useServerFn(runCameraDiagnostics);
  const getDiagnosticsFn = useServerFn(getCameraDiagnostics);

  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CameraDiagnosticReport | null>(null);
  const [history, setHistory] = useState<CameraDiagnosticHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = (await getDiagnosticsFn()) as GetDiagnosticsResult;
      if (res.success && res.latest_diagnostic) {
        setReport(res.latest_diagnostic);
        setHistory(res.history || []);
      } else {
        // Fallback to running live diagnostics
        await handleRun();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load camera diagnostics");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleRun = async () => {
    try {
      setRunning(true);
      setError(null);
      const res = (await runDiagnosticsFn()) as RunDiagnosticsResult;
      if (res.diagnostic) {
        setReport(res.diagnostic);
        // Also fetch updated history
        const histRes = (await getDiagnosticsFn()) as GetDiagnosticsResult;
        if (histRes.history) {
          setHistory(histRes.history);
        }
      } else {
        setError(res.error || "Diagnostic check failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run diagnostics check");
    } finally {
      setRunning(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "PASS":
      case "LIVE":
      case "HEALTHY":
        return <span className="inline-flex items-center gap-1 rounded bg-success-soft px-2 py-0.5 text-xxs font-mono font-semibold text-success-strong">PASS</span>;
      case "WARN":
      case "STREAM_STALE":
        return <span className="inline-flex items-center gap-1 rounded bg-warning-soft px-2 py-0.5 text-xxs font-mono font-semibold text-warning-strong">WARN</span>;
      case "RECOVERY_FAILED":
        return <span className="inline-flex items-center gap-1 rounded bg-destructive-soft px-2 py-0.5 text-xxs font-mono font-semibold text-destructive">RECOVERY FAILED</span>;
      case "GATEWAY_OFFLINE":
        return <span className="inline-flex items-center gap-1 rounded bg-destructive-soft px-2 py-0.5 text-xxs font-mono font-semibold text-destructive">GATEWAY OFFLINE</span>;
      default:
        return <span className="inline-flex items-center gap-1 rounded bg-destructive-soft px-2 py-0.5 text-xxs font-mono font-semibold text-destructive">FAIL</span>;
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="camera-diagnostics-title">
      <div className="space-y-5 max-w-2xl max-h-[85vh] overflow-y-auto pr-1">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border/50 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="camera-diagnostics-title" className="text-base font-semibold text-umbra flex items-center gap-2">
                <Activity className="h-4 w-4 text-penna" />
                Camera Health & Stream Diagnostics
              </h2>
              {report && getStatusBadge(report.overall_status)}
            </div>
            <p className="text-xs text-sage mt-0.5">
              Automated 9-point edge telemetry, network reachability, and stream decoding verification.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-sage hover:bg-muted hover:text-umbra transition"
            aria-label="Close diagnostics"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive-soft/30 p-3 text-xs text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Current Metrics Overview */}
        {report && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="rounded-lg border border-border/60 bg-card p-2.5">
              <div className="text-xxs text-sage uppercase tracking-wider font-mono">Stream Status</div>
              <div className="text-sm font-semibold font-mono mt-0.5 text-umbra">
                {report.overall_status.replace(/_/g, " ")}
              </div>
            </div>
            <div className="rounded-lg border border-border/60 bg-card p-2.5">
              <div className="text-xxs text-sage uppercase tracking-wider font-mono">Real Frames</div>
              <div className="text-sm font-semibold font-mono mt-0.5 text-umbra">
                {report.real_frame_count}
              </div>
            </div>
            <div className="rounded-lg border border-border/60 bg-card p-2.5">
              <div className="text-xxs text-sage uppercase tracking-wider font-mono">Recovery Attempts</div>
              <div className="text-sm font-semibold font-mono mt-0.5 text-umbra">
                {report.recovery_attempt_count} ({report.consecutive_failures} failed)
              </div>
            </div>
            <div className="rounded-lg border border-border/60 bg-card p-2.5">
              <div className="text-xxs text-sage uppercase tracking-wider font-mono">Last Real Frame</div>
              <div className="text-sm font-semibold font-mono mt-0.5 text-umbra truncate">
                {report.last_successful_frame_timestamp
                  ? new Date(report.last_successful_frame_timestamp).toLocaleTimeString("en-IN")
                  : "None"}
              </div>
            </div>
          </div>
        )}

        {report?.current_failure_reason && (
          <div className="rounded-lg border border-warning/40 bg-warning-soft/40 p-3 text-xs font-mono text-warning-strong flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Current Root Failure Reason:</div>
              <div className="text-xxs mt-0.5 leading-relaxed">{report.current_failure_reason}</div>
            </div>
          </div>
        )}

        {/* 9 Structured Checks */}
        <div>
          <h3 className="text-xs font-semibold text-umbra uppercase tracking-wider font-mono mb-2">
            Diagnostic Health Checks
          </h3>
          {loading && !report ? (
            <div className="p-8 text-center text-xs text-sage flex items-center justify-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin text-penna" />
              Running comprehensive diagnostic checks...
            </div>
          ) : report?.checks ? (
            <div className="space-y-1.5">
              {Object.entries(report.checks).map(([key, val]) => (
                <div
                  key={key}
                  className="flex items-center justify-between rounded-lg border border-border/50 bg-card px-3 py-2 text-xs"
                >
                  <div className="space-y-0.5 pr-2">
                    <div className="font-medium text-umbra capitalize">{key.replace(/_/g, " ")}</div>
                    <div className="font-mono text-xxs text-sage">{val.detail}</div>
                  </div>
                  <div>{getStatusBadge(val.status)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-center text-xs text-sage">No diagnostic data available.</div>
          )}
        </div>

        {/* Bounded Diagnostic History */}
        {history.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-umbra uppercase tracking-wider font-mono flex items-center gap-1.5">
                <History className="h-3.5 w-3.5 text-sage" />
                Recovery & Diagnostic History (Last {history.length})
              </h3>
            </div>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border/50 bg-card">
              <table className="w-full text-left text-xxs font-mono">
                <thead className="bg-muted/50 border-b border-border/50 sticky top-0">
                  <tr>
                    <th className="py-1.5 px-2">Time</th>
                    <th className="py-1.5 px-2">Category</th>
                    <th className="py-1.5 px-2">Action</th>
                    <th className="py-1.5 px-2">Attempt</th>
                    <th className="py-1.5 px-2">Result</th>
                    <th className="py-1.5 px-2">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {history.slice(-15).reverse().map((h, idx) => (
                    <tr key={idx} className="hover:bg-muted/20">
                      <td className="py-1 px-2 text-sage truncate max-w-[80px]">
                        {new Date(h.timestamp).toLocaleTimeString("en-IN")}
                      </td>
                      <td className="py-1 px-2 text-umbra truncate max-w-[120px]" title={h.failure_category}>
                        {h.failure_category}
                      </td>
                      <td className="py-1 px-2 text-sage">{h.recovery_action}</td>
                      <td className="py-1 px-2 text-sage">#{h.attempt_number}</td>
                      <td className="py-1 px-2">
                        <span
                          className={cn(
                            "font-semibold",
                            h.recovery_result === "SUCCESS"
                              ? "text-success-strong"
                              : "text-destructive",
                          )}
                        >
                          {h.recovery_result}
                        </span>
                      </td>
                      <td className="py-1 px-2 text-sage">{h.time_taken_sec}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Modal Actions */}
        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <div className="font-mono text-xxs text-sage">
            {report?.timestamp ? `Evaluated: ${new Date(report.timestamp).toLocaleTimeString("en-IN")}` : ""}
          </div>
          <div className="flex items-center gap-2">
            {onRefreshRequested && (
              <button
                type="button"
                onClick={() => {
                  onRefreshRequested();
                  onClose();
                }}
                className="glass-btn flex items-center gap-1.5 py-1 px-3 text-xs"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh Camera
              </button>
            )}
            <button
              type="button"
              disabled={running}
              onClick={handleRun}
              className="glass-btn-primary flex items-center gap-1.5 py-1 px-3 text-xs"
            >
              <Play className={cn("h-3.5 w-3.5", running && "animate-spin")} />
              {running ? "Diagnosing..." : "Run Diagnostics"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
