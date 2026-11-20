import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  FileText,
  PlusCircle,
  Search,
  Filter,
  AlertCircle,
  CheckCircle2,
  Clock,
  MessageSquare,
  ShieldAlert,
  Bell,
  Check,
} from "lucide-react";
import {
  getMyGrievances,
  getMyGrievanceNotifications,
  markGrievanceNotificationRead,
} from "@/lib/grievance.functions";
import { SubmitGrievanceModal } from "./SubmitGrievanceModal";
import { GrievanceDetailsModal } from "./GrievanceDetailsModal";
import type { EmployeeGrievance, GrievanceStatus } from "@/lib/grievance.types";
import { playClick } from "@/lib/sound-engine";
import { cn } from "@/lib/utils";

interface EmployeeGrievancesSectionProps {
  employeeId: string;
}

export function EmployeeGrievancesSection({ employeeId }: EmployeeGrievancesSectionProps) {
  const getGrievancesFn = useServerFn(getMyGrievances);
  const getNotifsFn = useServerFn(getMyGrievanceNotifications);
  const markReadFn = useServerFn(markGrievanceNotificationRead);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [isSubmitModalOpen, setIsSubmitModalOpen] = useState(false);
  const [selectedGrievanceId, setSelectedGrievanceId] = useState<string | null>(null);

  const {
    data: grievanceData,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["my-grievances", employeeId, statusFilter],
    queryFn: () => getGrievancesFn({ data: { status: statusFilter === "ALL" ? undefined : statusFilter } }),
    refetchInterval: 10_000,
  });

  const { data: notifData, refetch: refetchNotifs } = useQuery({
    queryKey: ["my-grievance-notifs", employeeId],
    queryFn: () => getNotifsFn(),
    refetchInterval: 10_000,
  });

  const grievances = (grievanceData?.grievances ?? []) as EmployeeGrievance[];
  const notifications = notifData?.notifications ?? [];
  const unreadNotifs = notifications.filter((n) => !n.is_read);

  const filtered = grievances.filter((g) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase().trim();
    return (
      g.reference_number.toLowerCase().includes(q) ||
      g.title.toLowerCase().includes(q) ||
      g.category.toLowerCase().includes(q) ||
      g.description.toLowerCase().includes(q)
    );
  });

  const handleMarkNotifRead = async (id: string) => {
    playClick();
    await markReadFn({ data: { notification_id: id } });
    await refetchNotifs();
  };

  const getStatusBadge = (st: GrievanceStatus) => {
    switch (st) {
      case "SUBMITTED":
        return <span className="pill bg-muted text-sage font-mono text-xxs">SUBMITTED</span>;
      case "UNDER_REVIEW":
        return <span className="pill bg-primary/20 text-primary font-mono text-xxs">UNDER INVESTIGATION</span>;
      case "ADDITIONAL_INFORMATION_REQUIRED":
        return (
          <span className="pill bg-warning-soft text-warning-strong font-mono text-xxs animate-pulse">
            ACTION REQUIRED
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
    <div className="glass-card space-y-4">
      {/* Header Strip */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border/40 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-umbra">My Grievances & Statutory Inquiries</h3>
            <span className="pill bg-stage text-sage font-mono text-xxs">
              {grievances.length} total
            </span>
          </div>
          <p className="text-xs text-sage mt-0.5">
            DPDP Section 12 & Statutory Redressal · Two-way confidential channel with the Data Protection Officer.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            playClick();
            setIsSubmitModalOpen(true);
          }}
          className="glass-btn-primary flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold self-start sm:self-auto"
        >
          <PlusCircle className="h-4 w-4" />
          Submit a Complaint
        </button>
      </div>

      {/* In-App Notifications Banner */}
      {unreadNotifs.length > 0 && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-umbra">
            <span className="flex items-center gap-1.5 text-primary">
              <Bell className="h-4 w-4 animate-bounce" />
              {unreadNotifs.length} New Statutory Notification{unreadNotifs.length > 1 ? "s" : ""}
            </span>
          </div>
          <div className="space-y-1.5 max-h-32 overflow-y-auto">
            {unreadNotifs.map((n) => (
              <div
                key={n.id}
                className="flex items-center justify-between gap-2 rounded bg-card/60 p-2 text-xxs border border-border/30"
              >
                <div>
                  <span className="font-semibold text-umbra">{n.title}: </span>
                  <span className="text-sage">{n.content}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleMarkNotifRead(n.id)}
                  title="Mark as read"
                  className="shrink-0 p-1 rounded hover:bg-muted text-sage hover:text-umbra"
                >
                  <Check className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search and Filters */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-sage" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by ref # or subject..."
            className="w-full rounded-lg border border-border bg-card/60 pl-8 pr-3 py-1 text-xs text-umbra placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto text-xxs font-mono">
          {["ALL", "SUBMITTED", "UNDER_REVIEW", "ADDITIONAL_INFORMATION_REQUIRED", "RESPONSE_SENT", "RESOLVED"].map(
            (st) => (
              <button
                key={st}
                type="button"
                onClick={() => {
                  playClick();
                  setStatusFilter(st);
                }}
                className={cn(
                  "rounded-full px-2.5 py-1 transition border",
                  statusFilter === st
                    ? "border-primary bg-primary text-primary-foreground font-semibold"
                    : "border-border/60 bg-muted/60 text-sage hover:bg-muted",
                )}
              >
                {st.replace(/_/g, " ")}
              </button>
            ),
          )}
        </div>
      </div>

      {/* Grievance List Cards */}
      {isLoading ? (
        <div className="py-8 text-center text-xs text-sage animate-pulse font-mono">
          Loading grievance records…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-card/30 p-8 text-center space-y-2">
          <FileText className="mx-auto h-8 w-8 text-sage/60" />
          <p className="text-xs font-medium text-umbra">No grievances filed</p>
          <p className="text-xxs text-sage max-w-sm mx-auto">
            You currently have no active or historical complaints on record. Use the "Submit a
            Complaint" button above if you encounter an issue requiring DPO intervention.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((g) => (
            <div
              key={g.id}
              className="rounded-lg border border-border/60 bg-card/40 p-3 hover:border-primary/40 transition space-y-2"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-umbra">
                      {g.reference_number}
                    </span>
                    <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-sage">
                      {g.category}
                    </span>
                    {getStatusBadge(g.status)}
                  </div>
                  <h4 className="text-xs font-semibold text-umbra">{g.title}</h4>
                </div>

                <div className="flex items-center gap-2 text-xxs text-sage font-mono">
                  <Clock className="h-3 w-3" />
                  {new Date(g.created_at).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </div>
              </div>

              {/* Latest message preview */}
              {g.latest_message && (
                <div className="rounded bg-muted/60 p-2 text-xxs border border-border/30 text-sage">
                  <span className="font-semibold text-umbra">
                    {g.latest_message.sender_role === "dpo" || g.latest_message.sender_role === "super_admin"
                      ? "Latest DPO response: "
                      : "Your message: "}
                  </span>
                  <span className="italic">
                    "{g.latest_message.message.slice(0, 120)}
                    {g.latest_message.message.length > 120 ? "…" : ""}"
                  </span>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center justify-between pt-1 text-xxs">
                <span className="text-sage font-mono">
                  {g.message_count ?? 1} message{g.message_count === 1 ? "" : "s"} in log
                </span>
                <button
                  type="button"
                  onClick={() => {
                    playClick();
                    setSelectedGrievanceId(g.id);
                  }}
                  className="glass-btn flex items-center gap-1.5 py-1 px-3 text-xxs font-medium hover:bg-muted"
                >
                  <MessageSquare className="h-3 w-3 text-primary" />
                  View Thread & Reply
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {isSubmitModalOpen && (
        <SubmitGrievanceModal
          onClose={() => setIsSubmitModalOpen(false)}
          onSubmitted={() => {
            void refetch();
            void refetchNotifs();
          }}
        />
      )}

      {selectedGrievanceId && (
        <GrievanceDetailsModal
          grievanceId={selectedGrievanceId}
          onClose={() => setSelectedGrievanceId(null)}
          onUpdated={() => {
            void refetch();
            void refetchNotifs();
          }}
        />
      )}
    </div>
  );
}
