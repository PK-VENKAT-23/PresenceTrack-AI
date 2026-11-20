import { useState, type ChangeEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  FileText,
  UploadCloud,
  X,
  ShieldCheck,
  AlertCircle,
  Paperclip,
  CheckCircle2,
} from "lucide-react";
import { Modal } from "@/components/presence/layout/Modal";
import { submitEmployeeGrievance } from "@/lib/grievance.functions";
import {
  GRIEVANCE_CATEGORIES,
  type GrievanceCategory,
} from "@/lib/grievance.types";
import { playClick, playSweep } from "@/lib/sound-engine";
import { cn } from "@/lib/utils";

interface SubmitGrievanceModalProps {
  onClose: () => void;
  onSubmitted: (referenceNumber: string) => void;
}

interface AttachedFile {
  file_name: string;
  file_size: number;
  file_type: string;
  file_url: string;
}

export function SubmitGrievanceModal({ onClose, onSubmitted }: SubmitGrievanceModalProps) {
  const submitFn = useServerFn(submitEmployeeGrievance);

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<GrievanceCategory>("Workplace Issue");
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedRef, setSubmittedRef] = useState<string | null>(null);

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
        setAttachments((prev) => [
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
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || title.trim().length < 3) {
      toast.error("Please provide a descriptive complaint title (min 3 chars).");
      return;
    }
    if (!description.trim() || description.trim().length < 10) {
      toast.error("Please provide a detailed description (min 10 chars).");
      return;
    }

    try {
      setIsSubmitting(true);
      playClick();

      const res = await submitFn({
        data: {
          title: title.trim(),
          category,
          description: description.trim(),
          attachments: attachments.map((a) => ({
            ...a,
            is_internal: false,
          })),
        },
      });

      if (res.success && res.reference_number) {
        playSweep();
        setSubmittedRef(res.reference_number);
        toast.success(`Complaint registered under ref #${res.reference_number}`);
        onSubmitted(res.reference_number);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit grievance");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="submit-grievance-title">
      <div className="flex items-center justify-between border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-umbra" />
          <h3 id="submit-grievance-title" className="text-base font-semibold text-umbra">
            {submittedRef ? "Grievance Registered" : "Submit a Complaint or Grievance"}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-sage hover:bg-muted hover:text-umbra"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {submittedRef ? (
        <div className="py-6 text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success-strong">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <div className="space-y-1">
            <h4 className="text-lg font-semibold text-umbra">Complaint Received by DPO</h4>
            <p className="text-xs text-sage max-w-sm mx-auto">
              Your grievance has been assigned a unique reference code. The Data Protection Officer
              has been notified and will investigate according to statutory protocol.
            </p>
          </div>

          <div className="mx-auto inline-block rounded-xl border border-success/30 bg-success-soft/40 px-4 py-2 font-mono text-sm font-bold text-success-strong">
            {submittedRef}
          </div>

          <div className="pt-2">
            <button
              type="button"
              onClick={onClose}
              className="glass-btn-primary px-6 py-2 text-xs font-semibold"
            >
              Back to My Grievances
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* Statutory DPDP notice banner */}
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-2.5 text-xxs text-sage flex items-start gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-primary mt-0.5" />
            <div>
              <span className="font-semibold text-umbra">DPDP Statutory Grievance Redressal:</span>{" "}
              This complaint is submitted directly to the enterprise Data Protection Officer (DPO).
              Your identity and supporting evidence are cryptographically isolated from unauthorized
              peers.
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-umbra mb-1">
              Complaint Subject / Title <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Inaccurate optical attendance tracking or privacy concern"
              className="w-full rounded-lg border border-border bg-card/60 px-3 py-2 text-xs text-umbra placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs font-medium text-umbra mb-1">
              Grievance Category <span className="text-destructive">*</span>
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as GrievanceCategory)}
              className="w-full rounded-lg border border-border bg-card/60 px-3 py-2 text-xs text-umbra focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {GRIEVANCE_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-umbra mb-1">
              Detailed Description <span className="text-destructive">*</span>
            </label>
            <textarea
              required
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Provide a comprehensive statement explaining the incident, relevant dates, affected systems, or personnel..."
              className="w-full rounded-lg border border-border bg-card/60 px-3 py-2 text-xs text-umbra placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Attachments Upload */}
          <div>
            <label className="block text-xs font-medium text-umbra mb-1">
              Supporting Evidence / Documents (Optional)
            </label>
            <div className="flex items-center gap-2">
              <label className="glass-btn cursor-pointer text-xs py-1.5 px-3 hover:bg-muted">
                <UploadCloud className="h-3.5 w-3.5" /> Attach Files
                <input
                  type="file"
                  multiple
                  accept=".pdf,.png,.jpg,.jpeg"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
              <span className="text-xxs text-sage">PDF, PNG, JPEG evidence only (Max 10MB each)</span>
            </div>

            {attachments.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {attachments.map((file, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded border border-border/50 bg-card/40 px-2.5 py-1 text-xxs text-umbra"
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Paperclip className="h-3 w-3 text-sage shrink-0" />
                      <span className="truncate">{file.file_name}</span>
                      <span className="text-sage font-mono">
                        ({(file.file_size / 1024).toFixed(1)} KB)
                      </span>
                    </div>
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
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-border/40">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="glass-btn px-4 py-2 text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="glass-btn-primary px-5 py-2 text-xs font-semibold"
            >
              {isSubmitting ? "Submitting…" : "Submit Grievance to DPO"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
