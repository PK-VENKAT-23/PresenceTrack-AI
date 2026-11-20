import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  FileText,
  Search,
  Filter,
  ShieldCheck,
  Lock,
  Send,
  UploadCloud,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  User,
  Paperclip,
  Download,
  Eye,
  RefreshCw,
  FolderLock,
  ChevronRight,
  ShieldAlert,
} from "lucide-react";
import {
  getDpoGrievanceQueue,
  getGrievanceDetails,
  sendGrievanceMessage,
  updateGrievanceStatus,
  getGrievanceAttachmentDownloadUrl,
} from "@/lib/grievance.functions";
import { DpoErasureQueue } from "./DpoErasureQueue";
import { Modal } from "@/components/presence/layout/Modal";
import type {
  EmployeeGrievance,
  GrievanceMessage,
  GrievanceAttachment,
  GrievanceStatus,
  GrievanceCategory,
} from "@/lib/grievance.types";
import {
  GRIEVANCE_CATEGORIES,
  GRIEVANCE_STATUSES,
  GRIEVANCE_STATUS_LABELS,
} from "@/lib/grievance.types";
import type { DpoErasureRequest } from "@/lib/ambient";
import { playClick, playSweep } from "@/lib/sound-engine";
import { cn } from "@/lib/utils";

interface DpoGrievanceManagerProps {
  erasureRequests: DpoErasureRequest[];
  onErasureChanged: () => void;
}

export function DpoGrievanceManager({
  erasureRequests,
  onErasureChanged,
}: DpoGrievanceManagerProps) {
  const [activeTab, setActiveTab] = useState<"grievances" | "erasure">("grievances");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [inspectingGrievanceId, setInspectingGrievanceId] = useState<string | null>(null);

  const getQueueFn = useServerFn(getDpoGrievanceQueue);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["dpo-grievance-queue", search, categoryFilter, statusFilter],
    queryFn: () =>
      getQueueFn({
        data: {
          search: search.trim() || undefined,
          category: categoryFilter === "ALL" ? undefined : categoryFilter,
          status: statusFilter === "ALL" ? undefined : statusFilter,
        },
      }),
    refetchInterval: 10_000,
  });

  const grievances = data?.grievances ?? [];
  const metrics = data?.metrics ?? {
    total_active: 0,
    pending_review: 0,
    additional_info_required: 0,
    resolved_count: 0,
    rejected_count: 0,
    total: 0,
  };

  const getStatusBadge = (st: GrievanceStatus) => {
    switch (st) {
      case "SUBMITTED":
        return <span className="pill bg-muted text-sage font-mono text-xxs">SUBMITTED</span>;
      case "UNDER_REVIEW":
        return <span className="pill bg-primary/20 text-primary font-mono text-xxs">UNDER REVIEW</span>;
      case "ADDITIONAL_INFORMATION_REQUIRED":
        return (
          <span className="pill bg-warning-soft text-warning-strong font-mono text-xxs animate-pulse">
            MORE INFO NEEDED
          </span>
        );
      case "RESPONSE_SENT":
        return <span className="pill bg-success-soft text-success-strong font-mono text-xxs">RESPONSE SENT</span>;
      case "RESOLVED":
        return <span className="pill bg-success text-primary-foreground font-mono text-xxs">RESOLVED ✓</span>;
      case "REJECTED":
        return <span className="pill bg-destructive text-primary-foreground font-mono text-xxs">REJECTED ✗</span>;
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Level Nav Tabs: Keeps Statutory Privacy Erasure cleanly separated from General Grievances */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 pb-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              playClick();
              setActiveTab("grievances");
            }}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg transition",
              activeTab === "grievances"
                ? "bg-primary text-primary-foreground"
                : "text-sage hover:bg-muted hover:text-umbra",
            )}
          >
            <FileText className="h-4 w-4" />
            Employee Grievance Queue
            {metrics.total_active > 0 && (
              <span className="rounded-full bg-primary-foreground/20 px-1.5 py-0.2 text-[10px] font-mono">
                {metrics.total_active}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              playClick();
              setActiveTab("erasure");
            }}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg transition",
              activeTab === "erasure"
                ? "bg-primary text-primary-foreground"
                : "text-sage hover:bg-muted hover:text-umbra",
            )}
          >
            <FolderLock className="h-4 w-4" />
            Statutory Data Erasure (Sec. 12)
            {erasureRequests.filter((r) => r.status !== "VERIFIED_PURGED").length > 0 && (
              <span className="rounded-full bg-warning-soft text-warning-strong px-1.5 py-0.2 text-[10px] font-mono">
                {erasureRequests.filter((r) => r.status !== "VERIFIED_PURGED").length}
              </span>
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            playClick();
            void refetch();
          }}
          disabled={isFetching}
          className="glass-btn flex items-center gap-1.5 py-1 px-2.5 text-xs text-sage hover:text-umbra"
          title="Refresh queue"
        >
          <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
          Sync Queue
        </button>
      </div>

      {activeTab === "erasure" ? (
        <DpoErasureQueue requests={erasureRequests} onChanged={onErasureChanged} />
      ) : (
        <div className="space-y-4">
          {/* Metrics Summary Strip */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 font-mono text-xxs">
            <div className="rounded-lg border border-border/40 bg-card/60 p-2.5">
              <span className="text-sage block uppercase text-[10px]">Active Grievances</span>
              <span className="text-base font-bold text-umbra">{metrics.total_active}</span>
              <span className="text-sage block text-[10px]">open cases</span>
            </div>

            <div className="rounded-lg border border-border/40 bg-card/60 p-2.5">
              <span className="text-sage block uppercase text-[10px]">Pending Review</span>
              <span className="text-base font-bold text-primary">{metrics.pending_review}</span>
              <span className="text-sage block text-[10px]">new or under review</span>
            </div>

            <div className="rounded-lg border border-border/40 bg-card/60 p-2.5">
              <span className="text-sage block uppercase text-[10px]">Action Required</span>
              <span className="text-base font-bold text-warning-strong">
                {metrics.additional_info_required}
              </span>
              <span className="text-sage block text-[10px]">awaiting employee info</span>
            </div>

            <div className="rounded-lg border border-border/40 bg-card/60 p-2.5">
              <span className="text-sage block uppercase text-[10px]">Resolved / Closed</span>
              <span className="text-base font-bold text-success-strong">
                {metrics.resolved_count}
              </span>
              <span className="text-sage block text-[10px]">
                {metrics.rejected_count} rejected
              </span>
            </div>
          </div>

          {/* Search and Filters */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-sage" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by ref #, name, badge, email..."
                className="w-full rounded-lg border border-border bg-card/60 pl-8 pr-3 py-1.5 text-xs text-umbra placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={categoryFilter}
                onChange={(e) => {
                  playClick();
                  setCategoryFilter(e.target.value);
                }}
                className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5 text-xs text-umbra focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="ALL">All Categories</option>
                {GRIEVANCE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <select
                value={statusFilter}
                onChange={(e) => {
                  playClick();
                  setStatusFilter(e.target.value);
                }}
                className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5 text-xs text-umbra focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="ALL">All Statuses</option>
                {GRIEVANCE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {GRIEVANCE_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Grievance Table */}
          {isLoading ? (
            <div className="py-8 text-center text-xs text-sage animate-pulse font-mono">
              Loading statutory grievance records…
            </div>
          ) : grievances.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/60 bg-card/30 p-8 text-center space-y-2">
              <FileText className="mx-auto h-8 w-8 text-sage/60" />
              <p className="text-xs font-medium text-umbra">No grievances match criteria</p>
              <p className="text-xxs text-sage max-w-sm mx-auto">
                No active employee complaints found in this category or search query.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {grievances.map((g) => (
                <div
                  key={g.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 p-3 hover:border-primary/40 transition"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-bold text-umbra">
                        {g.reference_number}
                      </span>
                      {getStatusBadge(g.status)}
                      <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-sage">
                        {g.category}
                      </span>
                    </div>

                    <h4 className="text-xs font-semibold text-umbra truncate">{g.title}</h4>

                    <div className="flex flex-wrap items-center gap-3 text-xxs text-sage">
                      <span className="font-medium text-umbra">
                        {g.employee_name} ({g.employee_badge})
                      </span>
                      <span>·</span>
                      <span>{g.employee_email}</span>
                      <span>·</span>
                      <span className="font-mono">
                        {new Date(g.created_at).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                        })}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                    <span className="text-xxs text-sage font-mono">
                      {g.message_count ?? 1} msg{g.message_count === 1 ? "" : "s"}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        playClick();
                        setInspectingGrievanceId(g.id);
                      }}
                      className="glass-btn flex items-center gap-1.5 py-1 px-3 text-xs font-semibold hover:bg-muted"
                    >
                      <Eye className="h-3.5 w-3.5 text-primary" />
                      Investigate
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* DPO Investigation Detail & Response Modal */}
      {inspectingGrievanceId && (
        <DpoInvestigationModal
          grievanceId={inspectingGrievanceId}
          onClose={() => setInspectingGrievanceId(null)}
          onUpdated={() => {
            void refetch();
          }}
        />
      )}
    </div>
  );
}

// ── DPO Investigation Modal ────────────────────────────────────────────────
interface DpoInvestigationModalProps {
  grievanceId: string;
  onClose: () => void;
  onUpdated: () => void;
}

interface AttachedFile {
  file_name: string;
  file_size: number;
  file_type: string;
  file_url: string;
}

function DpoInvestigationModal({ grievanceId, onClose, onUpdated }: DpoInvestigationModalProps) {
  const getDetailsFn = useServerFn(getGrievanceDetails);
  const sendMessageFn = useServerFn(sendGrievanceMessage);
  const updateStatusFn = useServerFn(updateGrievanceStatus);
  const downloadUrlFn = useServerFn(getGrievanceAttachmentDownloadUrl);

  const [loading, setLoading] = useState(true);
  const [grievance, setGrievance] = useState<EmployeeGrievance | null>(null);
  const [messages, setMessages] = useState<GrievanceMessage[]>([]);
  const [employeeInfo, setEmployeeInfo] = useState<any>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const handleDownloadAttachment = async (attachmentId: string, fileName: string, fallbackUrl?: string) => {
    try {
      setDownloadingId(attachmentId);
      playClick();
      const res = await downloadUrlFn({ data: { attachment_id: attachmentId } });
      const targetUrl = res.download_url || fallbackUrl;
      if (targetUrl) {
        const link = document.createElement("a");
        link.href = targetUrl;
        link.download = fileName;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to download attachment");
    } finally {
      setDownloadingId(null);
    }
  };

  // Response form states
  const [responseMode, setResponseMode] = useState<"public_reply" | "internal_note">(
    "public_reply",
  );
  const [replyText, setReplyText] = useState("");
  const [statusChange, setStatusChange] = useState<
    "UNDER_REVIEW" | "ADDITIONAL_INFORMATION_REQUIRED" | "RESPONSE_SENT"
  >("RESPONSE_SENT");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [sending, setSending] = useState(false);

  // Status prompt states
  const [statusPromptOpen, setStatusPromptOpen] = useState(false);
  const [targetStatus, setTargetStatus] = useState<GrievanceStatus>("RESOLVED");
  const [statusReason, setStatusReason] = useState("");
  const [updatingStatus, setUpdatingStatus] = useState(false);

  const loadDetails = async () => {
    try {
      setLoading(true);
      const res = await getDetailsFn({ data: { grievance_id: grievanceId } });
      setGrievance(res.grievance);
      setMessages(res.messages);
      setEmployeeInfo(res.employee_info);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load grievance details");
    } finally {
      setLoading(false);
    }
  };

  useState(() => {
    void loadDetails();
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file) => {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!["pdf", "png", "jpg", "jpeg"].includes(ext)) {
        toast.error(`"${file.name}" has invalid format. Only PDF, PNG, and JPEG files are permitted.`);
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        toast.error(`File "${file.name}" exceeds 10MB limit.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments((prev) => [
          ...prev,
          {
            file_name: file.name,
            file_size: file.size,
            file_type: file.type || "application/octet-stream",
            file_url: reader.result as string,
          },
        ]);
        playClick();
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  const handleSendResponse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim()) return;

    try {
      setSending(true);
      playClick();

      const isInternal = responseMode === "internal_note";
      const res = await sendMessageFn({
        data: {
          grievance_id: grievanceId,
          message: replyText.trim(),
          is_internal_note: isInternal,
          status_change: isInternal ? undefined : statusChange,
          attachments: attachments.map((a) => ({
            ...a,
            is_internal: isInternal,
          })),
        },
      });

      if (res.success) {
        playSweep();
        toast.success(isInternal ? "Confidential internal note logged" : "Official DPO response dispatched");
        setReplyText("");
        setAttachments([]);
        await loadDetails();
        onUpdated();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to dispatch message");
    } finally {
      setSending(false);
    }
  };

  const openStatusPrompt = (st: GrievanceStatus) => {
    setTargetStatus(st);
    setStatusReason("");
    setStatusPromptOpen(true);
  };

  const handleExecuteStatusChange = async () => {
    if (targetStatus === "RESOLVED" || targetStatus === "REJECTED") {
      if (!statusReason.trim()) {
        toast.error(`A statutory reason is required when marking as ${targetStatus}.`);
        return;
      }
    }

    try {
      setUpdatingStatus(true);
      playClick();

      const res = await updateStatusFn({
        data: {
          grievance_id: grievanceId,
          new_status: targetStatus,
          reason: statusReason.trim() || undefined,
        },
      });

      if (res.success) {
        playSweep();
        toast.success(`Status updated to ${targetStatus}`);
        setStatusPromptOpen(false);
        await loadDetails();
        onUpdated();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update grievance status");
    } finally {
      setUpdatingStatus(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="dpo-investigation-title">
      <div className="flex items-center justify-between border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <div>
            <h3 id="dpo-investigation-title" className="text-base font-semibold text-umbra">
              DPO Statutory Investigation — {grievance?.reference_number}
            </h3>
            <span className="text-xxs text-sage font-mono">
              Ref #{grievance?.reference_number} · Category: {grievance?.category}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-sage hover:bg-muted hover:text-umbra"
        >
          <XCircle className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-xs text-sage animate-pulse font-mono">
          Loading comprehensive complaint audit file…
        </div>
      ) : !grievance ? (
        <div className="py-8 text-center text-xs text-destructive">Grievance not found.</div>
      ) : (
        <div className="mt-3 space-y-4 max-h-[78vh] overflow-y-auto pr-1">
          {/* Employee Demographics Card */}
          {employeeInfo && (
            <div className="rounded-lg border border-border/50 bg-card/70 p-3 text-xs space-y-2">
              <span className="text-[10px] font-semibold text-sage uppercase tracking-wider block">
                Complainant Identity Profile
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xxs font-mono">
                <div>
                  <span className="text-muted-foreground block text-[9px]">NAME</span>
                  <span className="text-umbra font-sans font-semibold">{employeeInfo.name}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-[9px]">BADGE ID</span>
                  <span className="text-umbra">{employeeInfo.badge_id}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-[9px]">DEPARTMENT</span>
                  <span className="text-umbra">{employeeInfo.department || "General"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-[9px]">CURRENT ZONE</span>
                  <span className="text-umbra">{employeeInfo.current_zone || "NOT IN PREMISES"}</span>
                </div>
              </div>
            </div>
          )}

          {/* Grievance Summary & Closure Notice */}
          <div className="rounded-lg border border-border/40 bg-card/40 p-3 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-umbra">{grievance.title}</span>
              <span className="text-xxs font-mono text-sage">
                {new Date(grievance.created_at).toLocaleString("en-IN")}
              </span>
            </div>
            <p className="text-xxs text-sage whitespace-pre-wrap leading-relaxed">
              {grievance.description}
            </p>

            {grievance.status === "RESOLVED" && grievance.resolution_reason && (
              <div className="mt-2 rounded border border-success/40 bg-success-soft/30 p-2 text-xxs text-success-strong">
                <span className="font-semibold uppercase">Resolution Reason: </span>
                {grievance.resolution_reason}
              </div>
            )}
            {grievance.status === "REJECTED" && grievance.rejection_reason && (
              <div className="mt-2 rounded border border-destructive/40 bg-destructive-soft/30 p-2 text-xxs text-destructive">
                <span className="font-semibold uppercase">Rejection Reason: </span>
                {grievance.rejection_reason}
              </div>
            )}
          </div>

          {/* Status Lifecycle Action Buttons */}
          <div className="rounded-lg border border-border/40 bg-card/60 p-2.5 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-xxs font-semibold uppercase text-sage">Current Status:</span>
              <span className="pill bg-stage font-mono text-xs">{grievance.status}</span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xxs font-mono">
              <button
                type="button"
                onClick={() => openStatusPrompt("UNDER_REVIEW")}
                className="glass-btn py-1 px-2 hover:bg-muted"
              >
                Mark Under Review
              </button>
              <button
                type="button"
                onClick={() => openStatusPrompt("ADDITIONAL_INFORMATION_REQUIRED")}
                className="glass-btn py-1 px-2 hover:bg-muted text-warning-strong"
              >
                Request More Info
              </button>
              <button
                type="button"
                onClick={() => openStatusPrompt("RESOLVED")}
                className="glass-btn-primary py-1 px-2.5 text-success-strong"
              >
                Resolve Grievance ✓
              </button>
              <button
                type="button"
                onClick={() => openStatusPrompt("REJECTED")}
                className="glass-btn py-1 px-2 text-destructive hover:bg-destructive/10"
              >
                Reject ✗
              </button>
            </div>
          </div>

          {/* Status Change Dialog with Required Reason */}
          {statusPromptOpen && (
            <div className="rounded-lg border border-primary/40 bg-card p-3 space-y-2 text-xs">
              <div className="font-semibold text-umbra">
                Update Status to: <span className="font-mono text-primary">{targetStatus}</span>
              </div>
              <p className="text-xxs text-sage">
                {targetStatus === "RESOLVED" || targetStatus === "REJECTED"
                  ? "A mandatory statutory justification reason is required for compliance audits."
                  : "Optional note explaining the status transition:"}
              </p>
              <textarea
                rows={2}
                required={targetStatus === "RESOLVED" || targetStatus === "REJECTED"}
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                placeholder={
                  targetStatus === "RESOLVED"
                    ? "Explain the corrective action or resolution applied..."
                    : targetStatus === "REJECTED"
                      ? "Explain the statutory or policy grounds for rejection..."
                      : "Optional note..."
                }
                className="w-full rounded border border-border bg-card/60 p-2 text-xxs text-umbra placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setStatusPromptOpen(false)}
                  className="glass-btn py-1 px-2 text-xxs"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleExecuteStatusChange}
                  disabled={updatingStatus}
                  className="glass-btn-primary py-1 px-3 text-xxs font-semibold"
                >
                  {updatingStatus ? "Updating…" : `Confirm ${targetStatus}`}
                </button>
              </div>
            </div>
          )}

          {/* Chronological Communication & Internal Investigation Stream */}
          <div className="space-y-2.5 pt-1">
            <h4 className="text-xs font-semibold text-umbra uppercase tracking-wider flex items-center justify-between">
              <span>Complete Investigation History</span>
              <span className="text-[10px] text-sage font-mono">
                {messages.length} record{messages.length === 1 ? "" : "s"}
              </span>
            </h4>

            <div className="space-y-2.5">
              {messages.map((m) => {
                const isInternal = m.is_internal_note;
                const isDpo = m.sender_role === "dpo" || m.sender_role === "super_admin";

                return (
                  <div
                    key={m.id}
                    className={cn(
                      "rounded-lg p-3 text-xs border space-y-1.5",
                      isInternal
                        ? "border-warning/50 bg-warning-soft/30"
                        : isDpo
                          ? "border-primary/30 bg-primary/5"
                          : "border-border bg-card/60",
                    )}
                  >
                    <div className="flex items-center justify-between text-xxs border-b border-border/30 pb-1">
                      <div className="flex items-center gap-1.5 font-semibold">
                        {isInternal ? (
                          <>
                            <Lock className="h-3 w-3 text-warning-strong" />
                            <span className="text-warning-strong">
                              CONFIDENTIAL DPO NOTE (Private / Non-Employee)
                            </span>
                          </>
                        ) : isDpo ? (
                          <>
                            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                            <span className="text-primary">Official DPO Feedback (Dispatched)</span>
                          </>
                        ) : (
                          <>
                            <User className="h-3.5 w-3.5 text-sage" />
                            <span className="text-umbra">Employee: {m.sender_name}</span>
                          </>
                        )}
                      </div>

                      <span className="text-sage font-mono">
                        {new Date(m.created_at).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          day: "numeric",
                          month: "short",
                        })}
                      </span>
                    </div>

                    <p className="whitespace-pre-wrap text-umbra/95 text-xs leading-relaxed">
                      {m.message}
                    </p>

                    {m.attachments && m.attachments.length > 0 && (
                      <div className="pt-1 flex flex-wrap gap-1.5">
                        {m.attachments.map((att) => (
                          <button
                            key={att.id}
                            type="button"
                            disabled={downloadingId === att.id}
                            onClick={() => void handleDownloadAttachment(att.id, att.file_name, att.file_url)}
                            className="inline-flex items-center gap-1 rounded bg-muted/80 px-2 py-0.5 text-xxs font-mono text-umbra hover:bg-muted disabled:opacity-50"
                          >
                            <Paperclip className="h-3 w-3 text-sage" />
                            <span className="truncate max-w-[140px]">{att.file_name}</span>
                            <Download className="h-2.5 w-2.5 text-sage ml-1" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* DPO Response & Confidential Internal Notes Composer */}
          <div className="rounded-lg border border-border/50 bg-card/70 p-3 space-y-3">
            <div className="flex items-center gap-2 border-b border-border/30 pb-2">
              <button
                type="button"
                onClick={() => {
                  playClick();
                  setResponseMode("public_reply");
                }}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded transition",
                  responseMode === "public_reply"
                    ? "bg-primary text-primary-foreground"
                    : "text-sage hover:bg-muted",
                )}
              >
                <Send className="h-3 w-3" />
                Official DPO Response (Employee-Visible)
              </button>

              <button
                type="button"
                onClick={() => {
                  playClick();
                  setResponseMode("internal_note");
                }}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded transition",
                  responseMode === "internal_note"
                    ? "bg-warning text-primary-foreground"
                    : "text-sage hover:bg-muted",
                )}
              >
                <Lock className="h-3 w-3" />
                Confidential Internal Note
              </button>
            </div>

            <form onSubmit={handleSendResponse} className="space-y-2">
              {responseMode === "internal_note" ? (
                <div className="rounded border border-warning/30 bg-warning-soft/20 p-2 text-xxs text-warning-strong flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Confidential Investigation Note: Strictly shielded from employee view. Only visible
                    to Super Admin & DPO governance console.
                  </span>
                </div>
              ) : (
                <div className="flex items-center justify-between text-xxs">
                  <span className="text-sage font-medium">Update Status on Send:</span>
                  <select
                    value={statusChange}
                    onChange={(e) => setStatusChange(e.target.value as any)}
                    className="rounded border border-border bg-card px-2 py-0.5 text-xxs text-umbra"
                  >
                    <option value="RESPONSE_SENT">RESPONSE SENT</option>
                    <option value="ADDITIONAL_INFORMATION_REQUIRED">
                      ADDITIONAL INFORMATION REQUIRED
                    </option>
                    <option value="UNDER_REVIEW">UNDER REVIEW</option>
                  </select>
                </div>
              )}

              <textarea
                rows={3}
                required
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder={
                  responseMode === "internal_note"
                    ? "Document internal investigative findings, evidentiary reviews, or policy assessments..."
                    : "Write official response, findings, or information request to the employee..."
                }
                className="w-full rounded-lg border border-border bg-card/60 p-2.5 text-xs text-umbra placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <label className="glass-btn cursor-pointer text-xxs py-1 px-2.5 hover:bg-muted">
                    <UploadCloud className="h-3 w-3" /> Attach Files
                    <input
                      type="file"
                      multiple
                      accept=".pdf,.png,.jpg,.jpeg"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </label>
                  {attachments.length > 0 && (
                    <span className="text-xxs text-sage font-mono">
                      {attachments.length} file(s) attached
                    </span>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={sending || !replyText.trim()}
                  className={cn(
                    "flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg shadow-sm transition",
                    responseMode === "internal_note"
                      ? "bg-warning text-primary-foreground hover:bg-warning/90"
                      : "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                >
                  {responseMode === "internal_note" ? (
                    <>
                      <Lock className="h-3.5 w-3.5" />
                      {sending ? "Saving…" : "Save Confidential Note"}
                    </>
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5" />
                      {sending ? "Dispatching…" : "Dispatch Official Response"}
                    </>
                  )}
                </button>
              </div>

              {attachments.length > 0 && (
                <div className="space-y-1 pt-1">
                  {attachments.map((file, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between rounded border border-border/40 bg-card/30 px-2 py-0.5 text-xxs text-umbra"
                    >
                      <span className="truncate">{file.file_name}</span>
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-sage hover:text-destructive ml-2"
                      >
                        <XCircle className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </Modal>
  );
}
