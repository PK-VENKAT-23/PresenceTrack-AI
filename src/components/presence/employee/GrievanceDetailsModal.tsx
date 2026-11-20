import { useState, useEffect, type ChangeEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  FileText,
  Send,
  UploadCloud,
  X,
  Paperclip,
  ShieldCheck,
  User,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Download,
} from "lucide-react";
import { Modal } from "@/components/presence/layout/Modal";
import {
  getGrievanceDetails,
  sendGrievanceMessage,
  getGrievanceAttachmentDownloadUrl,
} from "@/lib/grievance.functions";
import type {
  EmployeeGrievance,
  GrievanceMessage,
  GrievanceAttachment,
  GrievanceStatus,
} from "@/lib/grievance.types";
import { GRIEVANCE_STATUS_LABELS } from "@/lib/grievance.types";
import { playClick, playSweep } from "@/lib/sound-engine";
import { cn } from "@/lib/utils";

interface GrievanceDetailsModalProps {
  grievanceId: string;
  onClose: () => void;
  onUpdated?: () => void;
}

interface AttachedFile {
  file_name: string;
  file_size: number;
  file_type: string;
  file_url: string;
}

export function GrievanceDetailsModal({
  grievanceId,
  onClose,
  onUpdated,
}: GrievanceDetailsModalProps) {
  const getDetailsFn = useServerFn(getGrievanceDetails);
  const sendMessageFn = useServerFn(sendGrievanceMessage);
  const downloadUrlFn = useServerFn(getGrievanceAttachmentDownloadUrl);

  const [loading, setLoading] = useState(true);
  const [grievance, setGrievance] = useState<EmployeeGrievance | null>(null);
  const [messages, setMessages] = useState<GrievanceMessage[]>([]);
  const [replyText, setReplyText] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<AttachedFile[]>([]);
  const [sending, setSending] = useState(false);
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

  const loadDetails = async () => {
    try {
      setLoading(true);
      const res = await getDetailsFn({ data: { grievance_id: grievanceId } });
      setGrievance(res.grievance);
      setMessages(res.messages);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load grievance details");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDetails();
  }, [grievanceId]);

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
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
        const dataUrl = reader.result as string;
        setReplyAttachments((prev) => [
          ...prev,
          {
            file_name: file.name,
            file_size: file.size,
            file_type: file.type || "application/octet-stream",
            file_url: dataUrl,
          },
        ]);
        playClick();
      };
      reader.readAsDataURL(file);
    });

    e.target.value = "";
  };

  const removeAttachment = (index: number) => {
    playClick();
    setReplyAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim()) return;

    try {
      setSending(true);
      playClick();

      const res = await sendMessageFn({
        data: {
          grievance_id: grievanceId,
          message: replyText.trim(),
          is_internal_note: false,
          attachments: replyAttachments.map((a) => ({
            ...a,
            is_internal: false,
          })),
        },
      });

      if (res.success) {
        playSweep();
        toast.success("Reply submitted to DPO");
        setReplyText("");
        setReplyAttachments([]);
        await loadDetails();
        onUpdated?.();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send reply");
    } finally {
      setSending(false);
    }
  };

  const getStatusBadge = (st: GrievanceStatus) => {
    switch (st) {
      case "SUBMITTED":
        return <span className="pill bg-muted text-sage font-mono">SUBMITTED</span>;
      case "UNDER_REVIEW":
        return <span className="pill bg-primary/20 text-primary font-mono">UNDER INVESTIGATION</span>;
      case "ADDITIONAL_INFORMATION_REQUIRED":
        return (
          <span className="pill bg-warning-soft text-warning-strong font-mono animate-pulse">
            ACTION REQUIRED
          </span>
        );
      case "RESPONSE_SENT":
        return <span className="pill bg-success-soft text-success-strong font-mono">RESPONSE SENT</span>;
      case "RESOLVED":
        return <span className="pill bg-success text-primary-foreground font-mono">RESOLVED ✓</span>;
      case "REJECTED":
        return <span className="pill bg-destructive text-primary-foreground font-mono">REJECTED ✗</span>;
    }
  };

  const isClosed = grievance?.status === "RESOLVED" || grievance?.status === "REJECTED";

  return (
    <Modal onClose={onClose} labelledBy="grievance-details-title">
      <div className="flex items-center justify-between border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-umbra" />
          <div>
            <h3 id="grievance-details-title" className="text-base font-semibold text-umbra">
              {grievance?.title ?? "Grievance Record"}
            </h3>
            {grievance && (
              <span className="text-xxs font-mono text-sage">
                Ref: {grievance.reference_number} · Category: {grievance.category}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-sage hover:bg-muted hover:text-umbra"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-xs text-sage animate-pulse">
          Retrieving encrypted communication log…
        </div>
      ) : !grievance ? (
        <div className="py-8 text-center text-xs text-destructive">Grievance not found.</div>
      ) : (
        <div className="mt-3 space-y-4 max-h-[75vh] overflow-y-auto pr-1">
          {/* Header Metadata Ribbon */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card/60 p-2.5 border border-border/40 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-sage text-xxs uppercase tracking-wider">Status:</span>
              {getStatusBadge(grievance.status)}
            </div>
            <div className="text-xxs text-sage font-mono">
              Submitted: {new Date(grievance.created_at).toLocaleString("en-IN")}
            </div>
          </div>

          {/* Action Required Banner */}
          {grievance.status === "ADDITIONAL_INFORMATION_REQUIRED" && (
            <div className="rounded-lg border border-warning/40 bg-warning-soft/40 p-3 text-xs text-warning-strong flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">DPO Action Required:</span> The Data Protection
                Officer has requested additional details or supporting evidence to proceed with the
                investigation. Please reply in the message box below.
              </div>
            </div>
          )}

          {/* Resolution or Rejection Notice */}
          {grievance.status === "RESOLVED" && grievance.resolution_reason && (
            <div className="rounded-lg border border-success/40 bg-success-soft/40 p-3 text-xs text-success-strong space-y-1">
              <div className="flex items-center gap-1.5 font-semibold">
                <CheckCircle2 className="h-4 w-4" />
                Grievance Concluded & Resolved
              </div>
              <p className="text-xxs pl-5 text-umbra/90 font-mono">
                {grievance.resolution_reason}
              </p>
              {grievance.resolved_at && (
                <div className="text-[10px] text-sage pl-5 font-mono">
                  Closed at: {new Date(grievance.resolved_at).toLocaleString("en-IN")}
                </div>
              )}
            </div>
          )}

          {grievance.status === "REJECTED" && grievance.rejection_reason && (
            <div className="rounded-lg border border-destructive/40 bg-destructive-soft/40 p-3 text-xs text-destructive space-y-1">
              <div className="flex items-center gap-1.5 font-semibold">
                <XCircle className="h-4 w-4" />
                Grievance Rejected
              </div>
              <p className="text-xxs pl-5 text-umbra/90 font-mono">
                {grievance.rejection_reason}
              </p>
              {grievance.resolved_at && (
                <div className="text-[10px] text-sage pl-5 font-mono">
                  Closed at: {new Date(grievance.resolved_at).toLocaleString("en-IN")}
                </div>
              )}
            </div>
          )}

          {/* Two-Way Message Stream */}
          <div className="space-y-3 pt-2">
            <h4 className="text-xs font-semibold text-umbra uppercase tracking-wider">
              Statutory Communication History
            </h4>

            <div className="space-y-3">
              {messages.map((msg) => {
                const isDpo = msg.sender_role === "dpo" || msg.sender_role === "super_admin";
                return (
                  <div
                    key={msg.id}
                    className={cn(
                      "rounded-lg p-3 text-xs border space-y-2",
                      isDpo
                        ? "border-primary/30 bg-primary/5 mr-4"
                        : "border-border bg-card/60 ml-4",
                    )}
                  >
                    <div className="flex items-center justify-between text-xxs border-b border-border/30 pb-1.5">
                      <div className="flex items-center gap-1.5 font-semibold">
                        {isDpo ? (
                          <>
                            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                            <span className="text-primary">Data Protection Officer (DPO)</span>
                          </>
                        ) : (
                          <>
                            <User className="h-3.5 w-3.5 text-sage" />
                            <span className="text-umbra">You ({msg.sender_name})</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-sage font-mono">
                        <Clock className="h-3 w-3" />
                        {new Date(msg.created_at).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          day: "numeric",
                          month: "short",
                        })}
                      </div>
                    </div>

                    <p className="whitespace-pre-wrap text-umbra/95 leading-relaxed text-xs">
                      {msg.message}
                    </p>

                    {/* Attachments if any */}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="pt-1.5 border-t border-border/20 space-y-1">
                        <span className="text-[10px] text-sage font-medium uppercase">
                          Attached Evidence:
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {msg.attachments.map((att) => (
                            <button
                              key={att.id}
                              type="button"
                              disabled={downloadingId === att.id}
                              onClick={() => void handleDownloadAttachment(att.id, att.file_name, att.file_url)}
                              className="inline-flex items-center gap-1 rounded bg-muted/80 px-2 py-1 text-xxs font-mono text-umbra hover:bg-muted disabled:opacity-50"
                            >
                              <Paperclip className="h-3 w-3 text-sage" />
                              <span className="truncate max-w-[150px]">{att.file_name}</span>
                              <Download className="h-2.5 w-2.5 text-sage ml-1" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Reply Form / Closed Status Notice */}
          {isClosed ? (
            <div className="rounded-lg border border-border bg-muted/50 p-3 text-center text-xs text-sage font-mono">
              This grievance thread is sealed and closed. To lodge a new query, submit a separate
              complaint.
            </div>
          ) : (
            <form onSubmit={handleSendReply} className="pt-3 border-t border-border/40 space-y-2">
              <label className="block text-xs font-medium text-umbra">
                Reply to DPO or Provide Requested Information
              </label>
              <textarea
                rows={3}
                required
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Type your response to the DPO here..."
                className="w-full rounded-lg border border-border bg-card/60 px-3 py-2 text-xs text-umbra placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
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
                  {replyAttachments.length > 0 && (
                    <span className="text-xxs text-sage font-mono">
                      {replyAttachments.length} file(s) attached
                    </span>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={sending || !replyText.trim()}
                  className="glass-btn-primary flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold"
                >
                  <Send className="h-3 w-3" />
                  {sending ? "Sending…" : "Send Reply"}
                </button>
              </div>

              {replyAttachments.length > 0 && (
                <div className="space-y-1 pt-1">
                  {replyAttachments.map((file, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between rounded border border-border/40 bg-card/30 px-2 py-0.5 text-xxs text-umbra"
                    >
                      <span className="truncate">{file.file_name}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(idx)}
                        className="text-sage hover:text-destructive ml-2"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </form>
          )}
        </div>
      )}
    </Modal>
  );
}
