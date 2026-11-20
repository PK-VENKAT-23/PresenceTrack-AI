import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  CreateGrievanceSchema,
  SendMessageSchema,
  UpdateStatusSchema,
  type EmployeeGrievance,
  type GrievanceAttachment,
  type GrievanceMessage,
  type GrievanceNotification,
  type GrievanceStatus,
} from "./grievance.types";

// ── Database Persistence Error ─────────────────────────────────────────────
// Explicit error thrown when database or private storage operations fail.
export class DatabasePersistenceError extends Error {
  public code?: string;
  public details?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DatabasePersistenceError";
    if (cause && typeof cause === "object") {
      if ("code" in cause && typeof (cause as any).code === "string") {
        this.code = (cause as any).code;
      }
      this.details = cause;
    }
  }
}

// ── File Signature & Magic Byte Validation ─────────────────────────────────
/** Detect binary file format from magic bytes */
export function detectMagicBytesFormat(buffer: Buffer): "pdf" | "png" | "jpeg" | null {
  if (!buffer || buffer.length < 3) return null;

  // PDF: %PDF- (0x25 0x50 0x44 0x46)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return "pdf";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  return null;
}

/** Validates file extension, MIME type, size limit, and genuine magic bytes */
export function validateAndProcessAttachment(att: {
  file_name: string;
  file_size: number;
  file_type: string;
  file_url?: string | undefined;
  file_data?: string | undefined;
}): { buffer: Buffer; validatedMime: string; extension: string } {
  // 1. Enforce extension allowlist (PDF, PNG, JPEG only)
  const ext = att.file_name.split(".").pop()?.toLowerCase() ?? "";
  if (!["pdf", "png", "jpg", "jpeg"].includes(ext)) {
    throw new Error(
      `Unsupported file extension '.${ext}'. Only PDF, PNG, and JPEG files are permitted as evidence.`,
    );
  }

  // 2. Extract Base64 binary payload
  const rawPayload = att.file_data || att.file_url;
  if (!rawPayload) {
    throw new Error(`File payload missing for attachment "${att.file_name}".`);
  }

  let base64Content = rawPayload;
  if (rawPayload.includes(";base64,")) {
    base64Content = rawPayload.split(";base64,")[1] ?? "";
  }

  const buffer = Buffer.from(base64Content, "base64");

  // 3. Enforce 10MB limit and non-empty check
  const MAX_SIZE = 10 * 1024 * 1024;
  if (buffer.length === 0) {
    throw new Error(`Attachment "${att.file_name}" is empty.`);
  }
  if (buffer.length > MAX_SIZE) {
    throw new Error(
      `File "${att.file_name}" (${buffer.length} bytes) exceeds maximum permitted limit of 10 MB.`,
    );
  }

  // 4. Verify file signatures (magic bytes)
  const detectedFormat = detectMagicBytesFormat(buffer);
  if (!detectedFormat) {
    throw new Error(
      `File signature validation failed for "${att.file_name}". File content does not match allowed PDF, PNG, or JPEG format.`,
    );
  }

  // 5. Cross-validate detected format against extension and declared MIME
  const declaredMime = att.file_type.toLowerCase();
  if (detectedFormat === "pdf") {
    if (ext !== "pdf") {
      throw new Error(`File "${att.file_name}" has extension '.${ext}' but contains PDF binary data.`);
    }
    if (declaredMime !== "application/pdf") {
      throw new Error(`Declared MIME type "${att.file_type}" does not match detected PDF content.`);
    }
    return { buffer, validatedMime: "application/pdf", extension: "pdf" };
  } else if (detectedFormat === "png") {
    if (ext !== "png") {
      throw new Error(`File "${att.file_name}" has extension '.${ext}' but contains PNG image data.`);
    }
    if (declaredMime !== "image/png") {
      throw new Error(`Declared MIME type "${att.file_type}" does not match detected PNG image data.`);
    }
    return { buffer, validatedMime: "image/png", extension: "png" };
  } else if (detectedFormat === "jpeg") {
    if (ext !== "jpg" && ext !== "jpeg") {
      throw new Error(`File "${att.file_name}" has extension '.${ext}' but contains JPEG image data.`);
    }
    if (declaredMime !== "image/jpeg" && declaredMime !== "image/jpg") {
      throw new Error(`Declared MIME type "${att.file_type}" does not match detected JPEG image content.`);
    }
    return { buffer, validatedMime: "image/jpeg", extension: ext === "jpg" ? "jpg" : "jpeg" };
  }

  throw new Error(`Unsupported or unrecognized file format for "${att.file_name}".`);
}

/** Helper: record administrative audit to admin_audit_logs */
async function recordGrievanceAudit(
  supabase: SupabaseClient<Database>,
  actorId: string,
  action: string,
  grievanceId: string | null,
  metadata: Record<string, unknown> = {},
) {
  try {
    await supabase.from("admin_audit_logs").insert({
      actor_id: actorId,
      action,
      entity_type: "employee_grievance",
      entity_id: grievanceId,
      metadata: metadata as Json,
    });
  } catch (err) {
    console.warn("[GrievanceAudit] Failed to insert audit log:", err);
  }
}

/** Helper: verify caller has dpo or super_admin role */
export async function isCallerDpoOrAdmin(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<{ isDpoOrAdmin: boolean; isSuperAdmin: boolean; isDpo: boolean }> {
  const { data: isSuperAdmin } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: "super_admin",
  });
  const { data: isDpo } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: "dpo",
  });
  return {
    isDpoOrAdmin: Boolean(isSuperAdmin || isDpo),
    isSuperAdmin: Boolean(isSuperAdmin),
    isDpo: Boolean(isDpo),
  };
}

/** Helper: resolve caller's enterprise profile */
async function getCallerProfile(supabase: SupabaseClient<Database>, authUserId: string) {
  const { data: profile } = await supabase
    .from("enterprise_users")
    .select("id, auth_user_id, name, email, badge_id, department, current_zone, is_active, consent_revoked")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  return profile;
}

/** Generate cryptographically secure reference number: GRV-YYYYMMDD-XXXXXXXX (8 hex chars) */
export function generateSecureReferenceNumber(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomSuffix = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `GRV-${dateStr}-${randomSuffix}`;
}

// ── 1. Submit Employee Grievance ───────────────────────────────────────────
export const submitEmployeeGrievance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => CreateGrievanceSchema.parse(input))
  .handler(async ({ data, context }) => {
    const profile = await getCallerProfile(context.supabase, context.userId);
    if (!profile) {
      throw new Error("Unauthorized: No linked enterprise profile found for current user");
    }
    if (profile.is_active === false) {
      throw new Error("Forbidden: Deactivated personnel cannot submit grievances");
    }

    const grievanceId = crypto.randomUUID();
    const initialMessageId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Validate and process attachments server-side with magic-byte verification
    const processedAttachments = (data.attachments ?? []).map((att) => {
      const { buffer, validatedMime, extension } = validateAndProcessAttachment(att);
      const attachmentId = crypto.randomUUID();
      const storagePath = `${grievanceId}/${attachmentId}.${extension}`;
      return {
        id: attachmentId,
        file_name: att.file_name,
        file_size: buffer.length,
        file_type: validatedMime,
        file_url: storagePath, // Private object storage path (NOT public URL, NOT base64)
        buffer,
        is_internal: false,
      };
    });

    // Bounded collision retry logic (up to 5 attempts) for reference number generation
    const MAX_REFERENCE_RETRIES = 5;
    let referenceNumber = "";
    let inserted = false;

    for (let attempt = 1; attempt <= MAX_REFERENCE_RETRIES; attempt++) {
      referenceNumber = generateSecureReferenceNumber();

      // Check collision in database
      const { data: existingGrievance } = await context.supabase
        .from("employee_grievances")
        .select("id")
        .eq("reference_number", referenceNumber)
        .maybeSingle();

      if (existingGrievance) {
        continue; // Collision detected, retry with new crypto suffix
      }

      // Attempt Supabase insert
      const { error: gErr } = await context.supabase.from("employee_grievances").insert({
        id: grievanceId,
        reference_number: referenceNumber,
        employee_id: profile.id,
        title: data.title,
        category: data.category,
        description: data.description,
        status: "SUBMITTED",
      });

      if (gErr) {
        const isUniqueViolation =
          gErr.code === "23505" ||
          gErr.message?.includes("23505") ||
          gErr.message?.includes("unique constraint") ||
          gErr.message?.includes("reference_number");

        if (isUniqueViolation) {
          if (attempt === MAX_REFERENCE_RETRIES) {
            throw new DatabasePersistenceError(
              "Exceeded maximum retries attempting to generate a unique grievance reference number.",
              gErr,
            );
          }
          continue;
        }

        throw new DatabasePersistenceError(`Failed to persist grievance record: ${gErr.message}`, gErr);
      }

      inserted = true;
      break;
    }

    if (!inserted) {
      throw new DatabasePersistenceError(
        "Exceeded maximum retries attempting to generate a unique grievance reference number.",
      );
    }

    // Insert initial message
    const { error: mErr } = await context.supabase.from("grievance_messages").insert({
      id: initialMessageId,
      grievance_id: grievanceId,
      sender_id: context.userId,
      sender_role: "employee",
      sender_name: profile.name,
      message: data.description,
      is_internal_note: false,
    });

    if (mErr) {
      throw new DatabasePersistenceError(`Failed to persist initial grievance message: ${mErr.message}`, mErr);
    }

    // Upload attachments to private storage bucket and persist attachment metadata
    if (processedAttachments.length > 0) {
      for (const att of processedAttachments) {
        if (context.supabase.storage) {
          const { error: uploadErr } = await context.supabase.storage
            .from("grievance-evidence")
            .upload(att.file_url, att.buffer, {
              contentType: att.file_type,
              upsert: true,
            });

          if (uploadErr) {
            throw new DatabasePersistenceError(
              `Failed to upload attachment "${att.file_name}" to storage: ${uploadErr.message}`,
              uploadErr,
            );
          }
        }
      }

      const { error: aErr } = await context.supabase.from("grievance_attachments").insert(
        processedAttachments.map((a) => ({
          id: a.id,
          grievance_id: grievanceId,
          message_id: initialMessageId,
          uploaded_by: context.userId,
          file_name: a.file_name,
          file_size: a.file_size,
          file_type: a.file_type,
          file_url: a.file_url,
          is_internal: false,
        })),
      );

      if (aErr) {
        throw new DatabasePersistenceError(`Failed to persist grievance attachments: ${aErr.message}`, aErr);
      }
    }

    // Insert confirmation notification for employee
    const notifId = crypto.randomUUID();
    const { error: nErr } = await context.supabase.from("grievance_notifications").insert({
      id: notifId,
      user_id: context.userId,
      grievance_id: grievanceId,
      type: "SUBMISSION_CONFIRMED",
      title: "Grievance Successfully Registered",
      content: `Your complaint (${referenceNumber}) has been submitted to the DPO queue and is pending review.`,
      is_read: false,
    });

    if (nErr) {
      throw new DatabasePersistenceError(`Failed to persist submission notification: ${nErr.message}`, nErr);
    }

    // Record audit trail
    await recordGrievanceAudit(context.supabase, context.userId, "GRIEVANCE_SUBMITTED", grievanceId, {
      reference_number: referenceNumber,
      category: data.category,
      employee_id: profile.id,
      attachment_count: processedAttachments.length,
    });

    const newGrievance: EmployeeGrievance = {
      id: grievanceId,
      reference_number: referenceNumber,
      employee_id: profile.id,
      title: data.title,
      category: data.category,
      description: data.description,
      status: "SUBMITTED",
      created_at: now,
      updated_at: now,
      resolved_at: null,
      employee_name: profile.name,
      employee_email: profile.email,
      employee_badge: profile.badge_id,
      employee_department: profile.department,
      employee_zone: profile.current_zone,
      message_count: 1,
      has_unread_response: false,
    };

    return {
      success: true,
      reference_number: referenceNumber,
      grievance: newGrievance,
    };
  });

// ── 2. Get Current Employee's Grievances ───────────────────────────────────
export const getMyGrievances = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        status: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const profile = await getCallerProfile(context.supabase, context.userId);
    if (!profile) return { grievances: [] };

    let query = context.supabase
      .from("employee_grievances")
      .select("*")
      .eq("employee_id", profile.id)
      .order("created_at", { ascending: false });

    if (data.status) {
      query = query.eq("status", data.status);
    }

    const { data: dbGrievances, error } = await query;
    if (error) {
      throw new DatabasePersistenceError(`Failed to retrieve employee grievances: ${error.message}`, error);
    }

    const grievances = dbGrievances ?? [];

    // Query messages to compute counts and latest response
    const grievanceIds = grievances.map((g) => g.id);
    let messagesMap = new Map<string, GrievanceMessage[]>();

    if (grievanceIds.length > 0) {
      const { data: dbMsgs } = await context.supabase
        .from("grievance_messages")
        .select("*")
        .in("grievance_id", grievanceIds)
        .eq("is_internal_note", false)
        .order("created_at", { ascending: true });

      if (dbMsgs) {
        for (const m of dbMsgs) {
          const list = messagesMap.get(m.grievance_id) ?? [];
          list.push({ ...m, sender_role: m.sender_role as any });
          messagesMap.set(m.grievance_id, list);
        }
      }
    }

    // Query notifications to compute unread responses
    const { data: notifs } = await context.supabase
      .from("grievance_notifications")
      .select("*")
      .eq("user_id", context.userId)
      .eq("is_read", false);

    const unreadGrievanceIds = new Set((notifs ?? []).map((n) => n.grievance_id));

    const enriched: EmployeeGrievance[] = grievances.map((g) => {
      const msgs = messagesMap.get(g.id) ?? [];
      const latestMsg = msgs[msgs.length - 1] ?? null;
      return {
        ...g,
        category: g.category as any,
        status: g.status as any,
        employee_name: profile.name,
        employee_email: profile.email,
        employee_badge: profile.badge_id,
        employee_department: profile.department,
        employee_zone: profile.current_zone,
        latest_message: latestMsg,
        message_count: msgs.length,
        has_unread_response: unreadGrievanceIds.has(g.id),
      };
    });

    return { grievances: enriched };
  });

// ── 3. Get Grievance Details (With Access Guard) ───────────────────────────
export const getGrievanceDetails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ grievance_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { isDpoOrAdmin } = await isCallerDpoOrAdmin(context.supabase, context.userId);
    const profile = await getCallerProfile(context.supabase, context.userId);

    const { data: dbG, error: gErr } = await context.supabase
      .from("employee_grievances")
      .select("*")
      .eq("id", data.grievance_id)
      .maybeSingle();

    if (gErr) {
      throw new DatabasePersistenceError(`Failed to fetch grievance details: ${gErr.message}`, gErr);
    }
    if (!dbG) {
      throw new Error("Grievance not found");
    }

    const grievance: EmployeeGrievance = {
      ...dbG,
      category: dbG.category as any,
      status: dbG.status as any,
    };

    // Strict Access Control:
    // If not DPO/Admin, the caller MUST be the employee who submitted this grievance!
    if (!isDpoOrAdmin) {
      if (!profile || grievance.employee_id !== profile.id) {
        throw new Error("Forbidden: Access denied to another employee's grievance");
      }
    }

    // Lookup messages
    let msgQuery = context.supabase
      .from("grievance_messages")
      .select("*")
      .eq("grievance_id", data.grievance_id)
      .order("created_at", { ascending: true });

    if (!isDpoOrAdmin) {
      msgQuery = msgQuery.eq("is_internal_note", false);
    }

    const { data: dbMsgs, error: msgErr } = await msgQuery;
    if (msgErr) {
      throw new DatabasePersistenceError(`Failed to fetch grievance messages: ${msgErr.message}`, msgErr);
    }

    // Lookup attachments
    let attQuery = context.supabase
      .from("grievance_attachments")
      .select("*")
      .eq("grievance_id", data.grievance_id);

    if (!isDpoOrAdmin) {
      attQuery = attQuery.eq("is_internal", false);
    }

    const { data: dbAtts, error: attErr } = await attQuery;
    if (attErr) {
      throw new DatabasePersistenceError(`Failed to fetch grievance attachments: ${attErr.message}`, attErr);
    }

    const attachments = dbAtts ?? [];
    const messages: GrievanceMessage[] = (dbMsgs ?? []).map((m) => ({
      ...m,
      sender_role: m.sender_role as any,
      attachments: attachments.filter((a) => a.message_id === m.id),
    }));

    // Lookup target employee profile if DPO is investigating
    let employeeInfo = null;
    if (isDpoOrAdmin) {
      const { data: empData } = await context.supabase
        .from("enterprise_users")
        .select("id, name, email, badge_id, department, current_zone, is_active, consent_revoked")
        .eq("id", grievance.employee_id)
        .maybeSingle();

      employeeInfo = empData ?? {
        id: grievance.employee_id,
        name: grievance.employee_name ?? "Employee",
        email: grievance.employee_email ?? "",
        badge_id: grievance.employee_badge ?? "",
        department: grievance.employee_department ?? "",
        current_zone: grievance.employee_zone ?? null,
        is_active: true,
        consent_revoked: false,
      };
    }

    return {
      grievance,
      messages,
      attachments,
      employee_info: employeeInfo,
      is_dpo: isDpoOrAdmin,
    };
  });

// ── 4. Get Grievance Attachment Download URL (Authorized & Short-Lived) ──────
export const getGrievanceAttachmentDownloadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ attachment_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { isDpoOrAdmin } = await isCallerDpoOrAdmin(context.supabase, context.userId);
    const profile = await getCallerProfile(context.supabase, context.userId);

    // 1. Fetch attachment record
    const { data: attachment, error: attErr } = await context.supabase
      .from("grievance_attachments")
      .select("*")
      .eq("id", data.attachment_id)
      .maybeSingle();

    if (attErr) {
      throw new DatabasePersistenceError(`Database error querying attachment: ${attErr.message}`, attErr);
    }
    if (!attachment) {
      throw new Error("Attachment not found");
    }

    // 2. Fetch associated grievance
    const { data: grievance, error: gErr } = await context.supabase
      .from("employee_grievances")
      .select("id, employee_id")
      .eq("id", attachment.grievance_id)
      .maybeSingle();

    if (gErr) {
      throw new DatabasePersistenceError(`Database error querying grievance for attachment: ${gErr.message}`, gErr);
    }
    if (!grievance) {
      throw new Error("Grievance for attachment not found");
    }

    // 3. Strict Authorization Checks:
    if (!isDpoOrAdmin) {
      // Rule 3a: Non-DPO employees can NEVER access confidential internal attachments!
      if (attachment.is_internal) {
        throw new Error("Forbidden: Unauthorized access to internal confidential attachment");
      }
      // Rule 3b: Employees can only access attachments belonging to their own grievance!
      if (!profile || grievance.employee_id !== profile.id) {
        throw new Error("Forbidden: Access denied to another employee's attachment");
      }
    }

    // 4. Generate short-lived signed download URL (15 minutes = 900 seconds)
    if (!context.supabase.storage) {
      throw new DatabasePersistenceError("Storage subsystem unavailable");
    }

    const { data: signedData, error: signErr } = await context.supabase.storage
      .from("grievance-evidence")
      .createSignedUrl(attachment.file_url, 900);

    if (signErr || !signedData?.signedUrl) {
      throw new DatabasePersistenceError(
        `Failed to generate secure signed download URL: ${signErr?.message ?? "Unknown storage error"}`,
        signErr,
      );
    }

    // 5. Audit Logging
    await recordGrievanceAudit(
      context.supabase,
      context.userId,
      "GRIEVANCE_ATTACHMENT_DOWNLOADED",
      attachment.grievance_id,
      {
        attachment_id: attachment.id,
        file_name: attachment.file_name,
        is_internal: attachment.is_internal,
        caller_role: isDpoOrAdmin ? "dpo_or_admin" : "employee",
      },
    );

    return {
      success: true,
      download_url: signedData.signedUrl,
      file_name: attachment.file_name,
    };
  });

// ── 5. Send Message / DPO Response / Internal Note ─────────────────────────
export const sendGrievanceMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => SendMessageSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { isDpoOrAdmin } = await isCallerDpoOrAdmin(context.supabase, context.userId);
    const profile = await getCallerProfile(context.supabase, context.userId);

    // Resolve grievance
    const { data: dbG, error: gErr } = await context.supabase
      .from("employee_grievances")
      .select("*")
      .eq("id", data.grievance_id)
      .maybeSingle();

    if (gErr) {
      throw new DatabasePersistenceError(`Failed to fetch grievance: ${gErr.message}`, gErr);
    }
    if (!dbG) {
      throw new Error("Grievance not found");
    }

    const grievance: EmployeeGrievance = {
      ...dbG,
      category: dbG.category as any,
      status: dbG.status as any,
    };

    // Role-specific validations
    if (!isDpoOrAdmin) {
      // Employees must own the grievance
      if (!profile || grievance.employee_id !== profile.id) {
        throw new Error("Forbidden: Cannot reply to another employee's complaint");
      }
      // Employees cannot create internal investigation notes!
      if (data.is_internal_note) {
        throw new Error("Forbidden: Employees cannot author confidential internal DPO notes");
      }
      // Closed grievances cannot receive employee messages
      if (grievance.status === "RESOLVED" || grievance.status === "REJECTED") {
        throw new Error("Cannot send messages on a resolved or closed grievance");
      }
    }

    const now = new Date().toISOString();
    const messageId = crypto.randomUUID();
    const senderRole = isDpoOrAdmin ? "dpo" : "employee";
    const senderName = isDpoOrAdmin ? "Data Protection Officer" : (profile?.name ?? "Employee");

    // Validate and process attachments server-side
    const processedAttachments = (data.attachments ?? []).map((att) => {
      const { buffer, validatedMime, extension } = validateAndProcessAttachment(att);
      const attachmentId = crypto.randomUUID();
      const storagePath = `${data.grievance_id}/${attachmentId}.${extension}`;
      return {
        id: attachmentId,
        file_name: att.file_name,
        file_size: buffer.length,
        file_type: validatedMime,
        file_url: storagePath,
        buffer,
        is_internal: Boolean(data.is_internal_note),
      };
    });

    // Upload attachments to private storage
    if (processedAttachments.length > 0) {
      for (const att of processedAttachments) {
        if (context.supabase.storage) {
          const { error: uploadErr } = await context.supabase.storage
            .from("grievance-evidence")
            .upload(att.file_url, att.buffer, {
              contentType: att.file_type,
              upsert: true,
            });

          if (uploadErr) {
            throw new DatabasePersistenceError(
              `Failed to upload reply attachment "${att.file_name}": ${uploadErr.message}`,
              uploadErr,
            );
          }
        }
      }
    }

    // Insert message into database
    const { error: mErr } = await context.supabase.from("grievance_messages").insert({
      id: messageId,
      grievance_id: data.grievance_id,
      sender_id: context.userId,
      sender_role: senderRole,
      sender_name: senderName,
      message: data.message,
      is_internal_note: Boolean(data.is_internal_note),
    });

    if (mErr) {
      throw new DatabasePersistenceError(`Failed to persist grievance message: ${mErr.message}`, mErr);
    }

    // Insert attachment rows
    if (processedAttachments.length > 0) {
      const { error: aErr } = await context.supabase.from("grievance_attachments").insert(
        processedAttachments.map((a) => ({
          id: a.id,
          grievance_id: data.grievance_id,
          message_id: messageId,
          uploaded_by: context.userId,
          file_name: a.file_name,
          file_size: a.file_size,
          file_type: a.file_type,
          file_url: a.file_url,
          is_internal: a.is_internal,
        })),
      );

      if (aErr) {
        throw new DatabasePersistenceError(`Failed to persist attachments metadata: ${aErr.message}`, aErr);
      }
    }

    // Determine status transition
    let updatedStatus: GrievanceStatus = grievance.status;
    let notifType: GrievanceNotification["type"] = "DPO_RESPONSE";
    let notifTitle = "DPO Response Received";

    if (isDpoOrAdmin && !data.is_internal_note) {
      if (data.status_change === "ADDITIONAL_INFORMATION_REQUIRED") {
        updatedStatus = "ADDITIONAL_INFORMATION_REQUIRED";
        notifType = "INFO_REQUESTED";
        notifTitle = "Action Required: Additional Information Requested";
      } else {
        updatedStatus = "RESPONSE_SENT";
        notifType = "DPO_RESPONSE";
        notifTitle = "DPO Feedback & Response Received";
      }
    } else if (!isDpoOrAdmin) {
      // When employee replies, status automatically transitions to UNDER_REVIEW
      if (grievance.status === "ADDITIONAL_INFORMATION_REQUIRED" || grievance.status === "RESPONSE_SENT") {
        updatedStatus = "UNDER_REVIEW";
      }
    }

    // Update parent grievance
    const { error: uErr } = await context.supabase
      .from("employee_grievances")
      .update({ status: updatedStatus, updated_at: now })
      .eq("id", data.grievance_id);

    if (uErr) {
      throw new DatabasePersistenceError(`Failed to update grievance status: ${uErr.message}`, uErr);
    }

    // Create in-app notification if message is visible to employee
    if (isDpoOrAdmin && !data.is_internal_note) {
      const { data: complainantProfile } = await context.supabase
        .from("enterprise_users")
        .select("auth_user_id")
        .eq("id", grievance.employee_id)
        .maybeSingle();

      const empAuthUserId = complainantProfile?.auth_user_id ?? context.userId;
      await context.supabase.from("grievance_notifications").insert({
        id: crypto.randomUUID(),
        user_id: empAuthUserId,
        grievance_id: data.grievance_id,
        type: notifType,
        title: notifTitle,
        content: `DPO sent an update on #${grievance.reference_number}: "${data.message.slice(0, 100)}${data.message.length > 100 ? "…" : ""}"`,
        is_read: false,
      });
    }

    // Audit logging
    await recordGrievanceAudit(
      context.supabase,
      context.userId,
      data.is_internal_note
        ? "GRIEVANCE_INTERNAL_NOTE_ADDED"
        : isDpoOrAdmin
          ? "GRIEVANCE_RESPONSE_SENT"
          : "GRIEVANCE_EMPLOYEE_REPLY",
      data.grievance_id,
      {
        reference_number: grievance.reference_number,
        is_internal_note: data.is_internal_note,
        status: updatedStatus,
        sender_role: senderRole,
      },
    );

    const newMessage: GrievanceMessage = {
      id: messageId,
      grievance_id: data.grievance_id,
      sender_id: context.userId,
      sender_role: senderRole,
      sender_name: senderName,
      message: data.message,
      is_internal_note: Boolean(data.is_internal_note),
      created_at: now,
      attachments: processedAttachments.map((a) => ({
        id: a.id,
        grievance_id: data.grievance_id,
        message_id: messageId,
        uploaded_by: context.userId,
        file_name: a.file_name,
        file_size: a.file_size,
        file_type: a.file_type,
        file_url: a.file_url,
        is_internal: a.is_internal,
        created_at: now,
      })),
    };

    return {
      success: true,
      message: newMessage,
      updated_status: updatedStatus,
    };
  });

// ── 6. Update Grievance Status (DPO Only) ───────────────────────────────────
export const updateGrievanceStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => UpdateStatusSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { isDpoOrAdmin } = await isCallerDpoOrAdmin(context.supabase, context.userId);
    if (!isDpoOrAdmin) {
      throw new Error("Forbidden: Only DPO / Super Admin can change grievance status");
    }

    // Require reason when rejecting or resolving (enforced both client & database CHECK constraints)
    if (data.new_status === "RESOLVED" || data.new_status === "REJECTED") {
      if (!data.reason || data.reason.trim().length === 0) {
        throw new Error(`A detailed statutory reason is mandatory when marking a grievance as ${data.new_status}`);
      }
    }

    const { data: dbG, error: gErr } = await context.supabase
      .from("employee_grievances")
      .select("*")
      .eq("id", data.grievance_id)
      .maybeSingle();

    if (gErr) {
      throw new DatabasePersistenceError(`Failed to fetch grievance: ${gErr.message}`, gErr);
    }
    if (!dbG) {
      throw new Error("Grievance not found");
    }

    const now = new Date().toISOString();
    const resolutionReason = data.new_status === "RESOLVED" ? data.reason?.trim() ?? null : null;
    const rejectionReason = data.new_status === "REJECTED" ? data.reason?.trim() ?? null : null;
    const resolvedAt = data.new_status === "RESOLVED" || data.new_status === "REJECTED" ? now : null;

    const { error: uErr } = await context.supabase
      .from("employee_grievances")
      .update({
        status: data.new_status,
        resolution_reason: resolutionReason,
        rejection_reason: rejectionReason,
        resolved_at: resolvedAt,
        updated_at: now,
      })
      .eq("id", data.grievance_id);

    if (uErr) {
      throw new DatabasePersistenceError(`Failed to update grievance status in database: ${uErr.message}`, uErr);
    }

    // Notify employee of status update
    const notifType: GrievanceNotification["type"] =
      data.new_status === "RESOLVED"
        ? "RESOLVED"
        : data.new_status === "REJECTED"
          ? "REJECTED"
          : data.new_status === "ADDITIONAL_INFORMATION_REQUIRED"
            ? "INFO_REQUESTED"
            : "STATUS_CHANGED";

    const notifTitle =
      data.new_status === "RESOLVED"
        ? `Grievance #${dbG.reference_number} Resolved`
        : data.new_status === "REJECTED"
          ? `Grievance #${dbG.reference_number} Rejected`
          : `Grievance Status: ${data.new_status}`;

    const notifContent = data.reason
      ? `Status changed to ${data.new_status}. Reason: ${data.reason}`
      : `Status updated to ${data.new_status} by Data Protection Officer.`;

    const { data: complainantProfile } = await context.supabase
      .from("enterprise_users")
      .select("auth_user_id")
      .eq("id", dbG.employee_id)
      .maybeSingle();

    if (complainantProfile?.auth_user_id) {
      await context.supabase.from("grievance_notifications").insert({
        id: crypto.randomUUID(),
        user_id: complainantProfile.auth_user_id,
        grievance_id: data.grievance_id,
        type: notifType,
        title: notifTitle,
        content: notifContent,
        is_read: false,
      });
    }

    // Record audit log
    await recordGrievanceAudit(
      context.supabase,
      context.userId,
      `GRIEVANCE_${data.new_status}`,
      data.grievance_id,
      {
        reference_number: dbG.reference_number,
        old_status: dbG.status,
        new_status: data.new_status,
        reason: data.reason,
      },
    );

    const updatedGrievance: EmployeeGrievance = {
      ...dbG,
      status: data.new_status,
      resolution_reason: resolutionReason,
      rejection_reason: rejectionReason,
      resolved_at: resolvedAt,
      updated_at: now,
      category: dbG.category as any,
    };

    return {
      success: true,
      grievance: updatedGrievance,
    };
  });

// ── 7. DPO Statutory Grievance Queue ───────────────────────────────────────
export const getDpoGrievanceQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        search: z.string().optional(),
        category: z.string().optional(),
        status: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { isDpoOrAdmin } = await isCallerDpoOrAdmin(context.supabase, context.userId);
    if (!isDpoOrAdmin) {
      throw new Error("Forbidden: DPO or Super Admin role required to access Grievance Queue");
    }

    let query = context.supabase
      .from("employee_grievances")
      .select(`
        *,
        enterprise_users (
          id, name, email, badge_id, department, current_zone, is_active
        )
      `)
      .order("created_at", { ascending: false });

    if (data.status && data.status !== "ALL") {
      query = query.eq("status", data.status);
    }
    if (data.category && data.category !== "ALL") {
      query = query.eq("category", data.category);
    }

    const { data: dbRows, error } = await query;
    if (error) {
      throw new DatabasePersistenceError(`Failed to retrieve DPO grievance queue: ${error.message}`, error);
    }

    let grievances: EmployeeGrievance[] = (dbRows ?? []).map((row: any) => ({
      ...row,
      category: row.category as any,
      status: row.status as any,
      employee_name: row.enterprise_users?.name ?? "Employee",
      employee_email: row.enterprise_users?.email ?? "",
      employee_badge: row.enterprise_users?.badge_id ?? "",
      employee_department: row.enterprise_users?.department ?? "",
      employee_zone: row.enterprise_users?.current_zone ?? null,
    }));

    // Compute metrics across raw query list
    const total_active = grievances.filter(
      (g) => g.status !== "RESOLVED" && g.status !== "REJECTED",
    ).length;
    const pending_review = grievances.filter(
      (g) => g.status === "SUBMITTED" || g.status === "UNDER_REVIEW",
    ).length;
    const additional_info_required = grievances.filter(
      (g) => g.status === "ADDITIONAL_INFORMATION_REQUIRED",
    ).length;
    const resolved_count = grievances.filter((g) => g.status === "RESOLVED").length;
    const rejected_count = grievances.filter((g) => g.status === "REJECTED").length;

    // Apply search filtering
    if (data.search && data.search.trim()) {
      const q = data.search.toLowerCase().trim();
      grievances = grievances.filter(
        (g) =>
          g.reference_number.toLowerCase().includes(q) ||
          g.title.toLowerCase().includes(q) ||
          g.description.toLowerCase().includes(q) ||
          (g.employee_name && g.employee_name.toLowerCase().includes(q)) ||
          (g.employee_email && g.employee_email.toLowerCase().includes(q)) ||
          (g.employee_badge && g.employee_badge.toLowerCase().includes(q)),
      );
    }

    return {
      grievances,
      metrics: {
        total_active,
        pending_review,
        additional_info_required,
        resolved_count,
        rejected_count,
        total: grievances.length,
      },
    };
  });

// ── 8. Get My Notifications ────────────────────────────────────────────────
export const getMyGrievanceNotifications = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: dbNotifs, error } = await context.supabase
      .from("grievance_notifications")
      .select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      throw new DatabasePersistenceError(`Failed to fetch notifications: ${error.message}`, error);
    }

    const notifications: GrievanceNotification[] = (dbNotifs ?? []).map((n) => ({
      ...n,
      reference_number: "",
      type: n.type as any,
    }));

    return {
      notifications,
      unread_count: notifications.filter((n) => !n.is_read).length,
    };
  });

// ── 9. Mark Notification As Read ───────────────────────────────────────────
export const markGrievanceNotificationRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ notification_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("grievance_notifications")
      .update({ is_read: true })
      .eq("id", data.notification_id)
      .eq("user_id", context.userId);

    if (error) {
      throw new DatabasePersistenceError(`Failed to mark notification as read: ${error.message}`, error);
    }

    return { success: true };
  });
