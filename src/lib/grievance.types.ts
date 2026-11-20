import { z } from "zod";

export const GRIEVANCE_CATEGORIES = [
  "Workplace Issue",
  "Harassment or Misconduct",
  "Privacy or Data Protection",
  "Biometric Data Concern",
  "Attendance Dispute",
  "Other",
] as const;

export type GrievanceCategory = (typeof GRIEVANCE_CATEGORIES)[number];

export const GRIEVANCE_STATUSES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "ADDITIONAL_INFORMATION_REQUIRED",
  "RESPONSE_SENT",
  "RESOLVED",
  "REJECTED",
] as const;

export type GrievanceStatus = (typeof GRIEVANCE_STATUSES)[number];

export const GRIEVANCE_STATUS_LABELS: Record<GrievanceStatus, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under Investigation",
  ADDITIONAL_INFORMATION_REQUIRED: "Action Required / More Info",
  RESPONSE_SENT: "Response Sent",
  RESOLVED: "Resolved",
  REJECTED: "Rejected",
};

export interface GrievanceAttachment {
  id: string;
  grievance_id: string;
  message_id?: string | null;
  uploaded_by: string;
  file_name: string;
  file_size: number;
  file_type: string;
  file_url: string;
  is_internal: boolean;
  created_at: string;
}

export interface GrievanceMessage {
  id: string;
  grievance_id: string;
  sender_id: string;
  sender_role: "employee" | "dpo" | "super_admin";
  sender_name: string;
  message: string;
  is_internal_note: boolean;
  created_at: string;
  attachments?: GrievanceAttachment[];
}

export interface GrievanceNotification {
  id: string;
  user_id: string;
  grievance_id: string;
  reference_number: string;
  type:
    | "SUBMISSION_CONFIRMED"
    | "DPO_RESPONSE"
    | "INFO_REQUESTED"
    | "STATUS_CHANGED"
    | "RESOLVED"
    | "REJECTED";
  title: string;
  content: string;
  is_read: boolean;
  created_at: string;
}

export interface EmployeeGrievance {
  id: string;
  reference_number: string;
  employee_id: string;
  title: string;
  category: GrievanceCategory;
  description: string;
  status: GrievanceStatus;
  resolution_reason?: string | null;
  rejection_reason?: string | null;
  created_at: string;
  updated_at: string;
  resolved_at?: string | null;
  // Associated employee context for DPO inspection
  employee_name?: string | null;
  employee_email?: string | null;
  employee_badge?: string | null;
  employee_department?: string | null;
  employee_zone?: string | null;
  // Summary aggregations
  latest_message?: GrievanceMessage | null;
  message_count?: number;
  has_unread_response?: boolean;
}

export const ALLOWED_ATTACHMENT_EXTENSIONS = ["pdf", "png", "jpg", "jpeg"] as const;
export type AllowedAttachmentExtension = (typeof ALLOWED_ATTACHMENT_EXTENSIONS)[number];

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
] as const;
export type AllowedAttachmentMimeType = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

export const AttachmentInputSchema = z
  .object({
    file_name: z.string().trim().min(1).max(255),
    file_size: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024, "File size must not exceed 10MB"),
    file_type: z.string().trim().min(1).max(100),
    file_url: z.string().min(1).optional(),
    file_data: z.string().min(1).optional(),
    is_internal: z.boolean().default(false),
  })
  .refine((data) => Boolean(data.file_data || data.file_url), {
    message: "Either file_data or file_url must be provided for attachment upload",
  });

export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

export const CreateGrievanceSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, "Title must be at least 3 characters")
    .max(120, "Title must not exceed 120 characters"),
  category: z.enum(GRIEVANCE_CATEGORIES, {
    errorMap: () => ({ message: "Select a valid category" }),
  }),
  description: z
    .string()
    .trim()
    .min(10, "Detailed description must be at least 10 characters")
    .max(4000, "Description must not exceed 4000 characters"),
  attachments: z.array(AttachmentInputSchema).optional().default([]),
});

export const SendMessageSchema = z.object({
  grievance_id: z.string().uuid(),
  message: z
    .string()
    .trim()
    .min(1, "Message cannot be empty")
    .max(4000, "Message cannot exceed 4000 characters"),
  is_internal_note: z.boolean().default(false),
  attachments: z.array(AttachmentInputSchema).optional().default([]),
  status_change: z
    .enum(["UNDER_REVIEW", "ADDITIONAL_INFORMATION_REQUIRED", "RESPONSE_SENT"])
    .optional(),
});

export const UpdateStatusSchema = z.object({
  grievance_id: z.string().uuid(),
  new_status: z.enum(GRIEVANCE_STATUSES),
  reason: z.string().trim().max(1000).optional(),
});
