import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { rejectUnlessDevice } from "@/lib/device-key";

const BoundingBoxSchema = z
  .object({
    x: z.number().min(0).max(4000),
    y: z.number().min(0).max(4000),
    w: z.number().min(1).max(4000),
    h: z.number().min(1).max(4000),
  })
  .refine((box) => box.x + box.w <= 4000 && box.y + box.h <= 4000, {
    message: "Bounding box coordinates exceed frame boundary limits",
  });

const DetectedFaceItemSchema = z.object({
  bbox: BoundingBoxSchema,
  identity_status: z.enum(["VERIFIED", "UNKNOWN", "VERIFYING"]),
  matched_name: z.string().trim().max(120).nullable().optional(),
  matched_person_id: z.string().uuid().nullable().optional(),
  sc_score: z.number().min(0).max(1).optional(),
  track_id: z.union([z.string(), z.number()]).nullable().optional(),
  candidate_employee_id: z.string().trim().max(120).nullable().optional(),
  candidate_name: z.string().trim().max(120).nullable().optional(),
  similarity_score: z.number().min(0).max(1).optional(),
  matching_threshold: z.number().min(0).max(1).optional(),
  confirmation_count: z.number().int().min(0).optional(),
  required_confirmation_count: z.number().int().min(0).optional(),
  last_match_timestamp: z.string().datetime().nullable().optional(),
  time_to_verified_ms: z.number().min(0).optional(),
  detection_latency_ms: z.number().min(0).optional(),
  recognition_latency_ms: z.number().min(0).optional(),
});

const TelemetryPayloadSchema = z.object({
  camera_id: z.string().trim().min(1).max(64),
  is_live: z.boolean(),
  face_detected: z.boolean(),
  face_bounding_box: BoundingBoxSchema.nullable().optional(),
  detected_faces: z.array(DetectedFaceItemSchema).optional(),
  sc_score: z.number().min(0).max(1).optional(),
  match_score: z.number().min(0).max(1).optional(),
  identity_status: z.enum(["VERIFIED", "UNKNOWN", "VERIFYING", "NO_FACE", "STALE", "OFFLINE"]).optional(),
  track_id: z.union([z.string(), z.number()]).nullable().optional(),
  consent_valid: z.boolean().optional(),
  template_match_confirmed: z.boolean().optional(),
  consecutive_match_frames: z.number().int().min(0).optional(),
  matching_threshold: z.number().min(0).max(1).optional(),
  required_confirmation_count: z.number().int().min(0).optional(),
  matched_name: z.string().trim().max(120).nullable().optional(),
  matched_person_id: z.string().uuid().nullable().optional(),
  person_count: z.number().int().min(0).max(100).optional(),
  active_tracks: z.number().int().min(0).max(100).optional(),
  last_event: z.string().trim().max(64).nullable().optional(),
  timestamp: z.string().datetime().optional(),
  event_nonce: z.string().trim().max(64).optional(),
  is_stale: z.boolean().optional(),
  is_synthetic: z.boolean().optional(),
  real_frame_count: z.number().int().optional(),
  recovery_status: z.string().optional(),
  consecutive_failures: z.number().int().optional(),
  current_failure_reason: z.string().nullable().optional(),
  last_successful_frame_timestamp: z.string().nullable().optional(),
  last_diagnostic_timestamp: z.string().nullable().optional(),
  recovery_attempt_count: z.number().int().optional(),
  actual_fps: z.number().min(0).optional(),
  avg_frame_interval_ms: z.number().min(0).optional(),
  frame_processing_latency_ms: z.number().min(0).optional(),
  face_detection_latency_ms: z.number().min(0).optional(),
  face_recognition_latency_ms: z.number().min(0).optional(),
  dropped_frames: z.number().int().min(0).optional(),
  frame_queue_depth: z.number().int().min(0).optional(),
});

export interface DetectedFaceState {
  bbox: { x: number; y: number; w: number; h: number };
  identity_status: "VERIFIED" | "UNKNOWN" | "VERIFYING";
  matched_name?: string | null | undefined;
  matched_person_id?: string | null | undefined;
  sc_score?: number | undefined;
  track_id?: string | number | null | undefined;
  candidate_employee_id?: string | null | undefined;
  candidate_name?: string | null | undefined;
  similarity_score?: number | undefined;
  matching_threshold?: number | undefined;
  confirmation_count?: number | undefined;
  required_confirmation_count?: number | undefined;
  last_match_timestamp?: string | null | undefined;
  time_to_verified_ms?: number | undefined;
  detection_latency_ms?: number | undefined;
  recognition_latency_ms?: number | undefined;
}

export interface LiveTelemetryState {
  camera_id: string;
  is_live: boolean;
  face_detected: boolean;
  face_bounding_box: { x: number; y: number; w: number; h: number } | null;
  detected_faces?: DetectedFaceState[];
  sc_score: number;
  match_score: number;
  confidence_category: string;
  identity_status: "VERIFIED" | "UNKNOWN" | "VERIFYING" | "NO_FACE" | "STALE";
  track_id: string | number | null;
  consent_valid: boolean;
  template_match_confirmed: boolean;
  consecutive_match_frames: number;
  matching_threshold?: number | undefined;
  required_confirmation_count?: number | undefined;
  matched_name: string | null;
  matched_person_id: string | null;
  person_count: number;
  active_tracks: number;
  last_event: string | null;
  updated_at: string;
  is_stale: boolean;
  is_synthetic: boolean;
  real_frame_count: number;
  recovery_status?: string | null;
  consecutive_failures?: number;
  current_failure_reason?: string | null;
  last_successful_frame_timestamp?: string | null;
  last_diagnostic_timestamp?: string | null;
  recovery_attempt_count?: number;
  actual_fps?: number | undefined;
  avg_frame_interval_ms?: number | undefined;
  frame_processing_latency_ms?: number | undefined;
  face_detection_latency_ms?: number | undefined;
  face_recognition_latency_ms?: number | undefined;
  dropped_frames?: number | undefined;
  frame_queue_depth?: number | undefined;
}

// In-memory latest telemetry state from Edge Vision Gateway
let currentTelemetry: LiveTelemetryState = {
  camera_id: "ESP32-CAM-01-NORTH",
  is_live: false,
  face_detected: false,
  face_bounding_box: null,
  sc_score: 0,
  match_score: 0,
  confidence_category: "UNKNOWN",
  identity_status: "NO_FACE",
  track_id: null,
  consent_valid: false,
  template_match_confirmed: false,
  consecutive_match_frames: 0,
  matching_threshold: 0.45,
  required_confirmation_count: 2,
  matched_name: null,
  matched_person_id: null,
  person_count: 0,
  active_tracks: 0,
  last_event: null,
  updated_at: new Date().toISOString(),
  is_stale: false,
  is_synthetic: false,
  real_frame_count: 0,
  recovery_status: "IDLE",
  consecutive_failures: 0,
  current_failure_reason: null,
  last_successful_frame_timestamp: null,
  last_diagnostic_timestamp: null,
  recovery_attempt_count: 0,
  actual_fps: 0,
  avg_frame_interval_ms: 0,
  frame_processing_latency_ms: 0,
  face_detection_latency_ms: 0,
  face_recognition_latency_ms: 0,
  dropped_frames: 0,
  frame_queue_depth: 0,
};

// Seen nonce cache for replay protection
const seenNonces = new Map<string, number>();

function pruneOldNonces() {
  const cutoff = Date.now() - 60000; // 60 seconds (strictly exceeds the 30s skew window)
  for (const [nonce, ts] of seenNonces.entries()) {
    if (ts < cutoff) {
      seenNonces.delete(nonce);
    }
  }
}

export const Route = createFileRoute("/api/public/esp32/telemetry")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Enforce strict authorization: Security or Super Admin session required
        // Device keys are strictly prohibited from retrieving optical perimeter telemetry
        const deviceKeyHeader = request.headers.get("x-device-key");
        const authHeader = request.headers.get("authorization");
        const cookieHeader = request.headers.get("cookie");

        if (deviceKeyHeader && !authHeader && !cookieHeader) {
          return Response.json(
            {
              success: false,
              error:
                "Device key cannot authorize telemetry retrieval; Security or Super Admin session required",
            },
            { status: 403 },
          );
        }

        if (!authHeader && !cookieHeader) {
          return Response.json(
            {
              success: false,
              error: "Unauthorized access to optical perimeter telemetry: Session required",
            },
            { status: 401 },
          );
        }

        let token: string | null = null;
        if (authHeader?.startsWith("Bearer ")) {
          token = authHeader.slice(7).trim();
        } else if (cookieHeader) {
          const match = cookieHeader.match(
            /(?:sb-[^;]+-auth-token|sb-access-token|access_token)=([^;]+)/,
          );
          if (match && match[1]) {
            token = decodeURIComponent(match[1]);
          }
        }

        if (!token) {
          return Response.json(
            { success: false, error: "Unauthorized: Invalid session credentials" },
            { status: 401 },
          );
        }

        const { hasSupabaseAdminConfigured, supabaseAdmin } =
          await import("@/integrations/supabase/client.server");

        if (hasSupabaseAdminConfigured()) {
          const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
          if (userError || !userData?.user) {
            return Response.json(
              { success: false, error: "Unauthorized: Invalid or expired session token" },
              { status: 401 },
            );
          }

          const { data: hasRole, error: roleError } = await supabaseAdmin.rpc("has_any_role", {
            _user_id: userData.user.id,
            _roles: ["security", "super_admin"],
          });

          if (roleError || !hasRole) {
            return Response.json(
              {
                success: false,
                error:
                  "Forbidden: Security or Super Admin role required to retrieve optical perimeter telemetry",
              },
              { status: 403 },
            );
          }
        }

        // Telemetry must be fresh (updated within 4 seconds); otherwise mark offline/stale
        const isTelemetryFresh =
          Date.now() - new Date(currentTelemetry.updated_at).getTime() <= 4000;
        const isStale = currentTelemetry.is_stale || !isTelemetryFresh;
        const liveStatus = currentTelemetry.is_live && isTelemetryFresh && !currentTelemetry.is_stale;

        // Return sanitized telemetry (sensitive biometric vectors are strictly omitted)
        return Response.json(
          {
            success: true,
            telemetry: {
              camera_id: currentTelemetry.camera_id,
              is_live: liveStatus,
              is_stale: isStale,
              is_synthetic: currentTelemetry.is_synthetic,
              real_frame_count: currentTelemetry.real_frame_count,
              face_detected: liveStatus ? currentTelemetry.face_detected : false,
              face_bounding_box: liveStatus ? currentTelemetry.face_bounding_box : null,
              detected_faces: liveStatus ? (currentTelemetry.detected_faces ?? []) : [],
              sc_score: liveStatus ? currentTelemetry.sc_score : 0,
              match_score: liveStatus ? currentTelemetry.match_score : 0,
              confidence_category: liveStatus ? currentTelemetry.confidence_category : "UNKNOWN",
              identity_status: liveStatus ? currentTelemetry.identity_status : (isStale ? "STALE" : "NO_FACE"),
              track_id: liveStatus ? currentTelemetry.track_id : null,
              consent_valid: liveStatus ? currentTelemetry.consent_valid : false,
              template_match_confirmed: liveStatus ? currentTelemetry.template_match_confirmed : false,
              consecutive_match_frames: liveStatus ? currentTelemetry.consecutive_match_frames : 0,
              matching_threshold: currentTelemetry.matching_threshold ?? 0.45,
              required_confirmation_count: currentTelemetry.required_confirmation_count ?? 2,
              matched_name: liveStatus ? currentTelemetry.matched_name : null,
              matched_person_id: liveStatus ? currentTelemetry.matched_person_id : null,
              person_count: liveStatus ? currentTelemetry.person_count : 0,
              active_tracks: liveStatus ? currentTelemetry.active_tracks : 0,
              last_event: currentTelemetry.last_event,
              updated_at: currentTelemetry.updated_at,
              recovery_status: currentTelemetry.recovery_status ?? "IDLE",
              consecutive_failures: currentTelemetry.consecutive_failures ?? 0,
              current_failure_reason: currentTelemetry.current_failure_reason ?? null,
              last_successful_frame_timestamp: currentTelemetry.last_successful_frame_timestamp ?? null,
              last_diagnostic_timestamp: currentTelemetry.last_diagnostic_timestamp ?? null,
              recovery_attempt_count: currentTelemetry.recovery_attempt_count ?? 0,
              actual_fps: liveStatus ? (currentTelemetry.actual_fps ?? 0) : 0,
              avg_frame_interval_ms: liveStatus ? (currentTelemetry.avg_frame_interval_ms ?? 0) : 0,
              frame_processing_latency_ms: liveStatus ? (currentTelemetry.frame_processing_latency_ms ?? 0) : 0,
              face_detection_latency_ms: liveStatus ? (currentTelemetry.face_detection_latency_ms ?? 0) : 0,
              face_recognition_latency_ms: liveStatus ? (currentTelemetry.face_recognition_latency_ms ?? 0) : 0,
              dropped_frames: currentTelemetry.dropped_frames ?? 0,
              frame_queue_depth: liveStatus ? (currentTelemetry.frame_queue_depth ?? 0) : 0,
            },
          },
          {
            headers: {
              "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
              Pragma: "no-cache",
            },
          },
        );
      },
      POST: async ({ request }) => {
        const denied = rejectUnlessDevice(request, process.env["ESP32_DEVICE_KEY"]);
        if (denied) return denied;

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
        }

        const parsed = TelemetryPayloadSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            {
              success: false,
              error: "Invalid telemetry payload or out-of-bounds coordinates",
              details: parsed.error.format(),
            },
            { status: 400 },
          );
        }

        const d = parsed.data;

        // Replay protection: validate timestamp within ±30s window
        if (d.timestamp) {
          const ts = new Date(d.timestamp).getTime();
          const now = Date.now();
          if (Number.isNaN(ts) || Math.abs(now - ts) > 30000) {
            return Response.json(
              {
                success: false,
                error: "Expired or skewed telemetry timestamp (replay protection: window is ±30s)",
              },
              { status: 400 },
            );
          }
        }

        // Out-of-order telemetry suppression: if incoming timestamp is older than currentTelemetry.updated_at by > 1000ms
        if (d.timestamp && currentTelemetry.updated_at) {
          const incomingTime = new Date(d.timestamp).getTime();
          const currentTime = new Date(currentTelemetry.updated_at).getTime();
          if (incomingTime < currentTime - 1000) {
            return Response.json(
              { success: true, debounced: true, message: "Out-of-order telemetry suppressed" },
              { status: 200 },
            );
          }
        }

        // Nonce deduplication
        if (d.event_nonce) {
          pruneOldNonces();
          if (seenNonces.has(d.event_nonce)) {
            return Response.json(
              { success: true, debounced: true, message: "Duplicate telemetry nonce suppressed" },
              { status: 200 },
            );
          }
          seenNonces.set(d.event_nonce, Date.now());
        }

        // Verify employee association and derive strict confidence category and identity status
        let verifiedPersonId: string | null = null;
        let verifiedName: string | null = null;
        let verifiedCategory = "UNKNOWN";
        let verifiedConsent = false;
        let matchConfirmed = false;

        const score = d.sc_score ?? d.match_score ?? 0;

        const isEligibleForVerification =
          Boolean(
            (d.identity_status === "VERIFIED" && score >= 0.45) ||
            (d.template_match_confirmed && score >= 0.45) ||
            (score >= 0.70 && d.identity_status !== "VERIFYING" && d.identity_status !== "UNKNOWN")
          );

        if (d.matched_person_id && isEligibleForVerification) {
          const { hasSupabaseAdminConfigured, supabaseAdmin } =
            await import("@/integrations/supabase/client.server");

          if (hasSupabaseAdminConfigured()) {
            const { data: person } = await supabaseAdmin
              .from("enterprise_users")
              .select("id, name, is_active, consent_revoked")
              .eq("id", d.matched_person_id)
              .maybeSingle();

            if (person && person.is_active && !person.consent_revoked) {
              verifiedPersonId = person.id;
              // Canonical name from database prevents arbitrary identity spoofing
              verifiedName = person.name;
              verifiedCategory = score >= 0.85 ? "HIGH" : "MATCHED";
              verifiedConsent = true;
              matchConfirmed = true;
            } else {
              // Inactive, unknown, or revoked consent: reject match association
              verifiedPersonId = null;
              verifiedName = null;
              verifiedCategory = person?.consent_revoked ? "CONSENT_REVOKED" : "UNKNOWN";
              verifiedConsent = false;
              matchConfirmed = false;
            }
          } else {
            verifiedPersonId = d.matched_person_id;
            verifiedName = d.matched_name ?? null;
            verifiedCategory = score >= 0.85 ? "HIGH" : "MATCHED";
            verifiedConsent = true;
            matchConfirmed = true;
          }
        } else if (!d.matched_person_id && d.matched_name && isEligibleForVerification) {
          verifiedName = d.matched_name;
          verifiedCategory = score >= 0.85 ? "HIGH" : "MATCHED";
          verifiedConsent = true;
          matchConfirmed = true;
        } else if (score >= 0.363) {
          verifiedCategory = "UNCERTAIN";
        }

        // Derive strict identity_status:
        let resolvedIdentityStatus: "VERIFIED" | "UNKNOWN" | "VERIFYING" | "NO_FACE" | "STALE" = "UNKNOWN";

        if (d.is_stale) {
          resolvedIdentityStatus = "STALE";
        } else if (!d.face_detected) {
          resolvedIdentityStatus = "NO_FACE";
        } else if (
          (verifiedPersonId || verifiedName) &&
          score >= 0.45 &&
          verifiedConsent &&
          matchConfirmed &&
          (d.identity_status === "VERIFIED" || !d.identity_status)
        ) {
          resolvedIdentityStatus = "VERIFIED";
        } else if (d.identity_status === "VERIFYING" || (score >= 0.363 && score < 0.45)) {
          resolvedIdentityStatus = "VERIFYING";
          verifiedPersonId = null;
          verifiedName = null;
        } else {
          resolvedIdentityStatus = "UNKNOWN";
          verifiedPersonId = null;
          verifiedName = null;
        }

        currentTelemetry = {
          camera_id: d.camera_id,
          is_live: d.is_live,
          face_detected: d.face_detected,
          face_bounding_box: d.face_bounding_box ?? null,
          detected_faces: d.detected_faces
            ? d.detected_faces.map((f) => ({
                bbox: f.bbox,
                identity_status: f.identity_status,
                matched_name: f.identity_status === "VERIFIED" ? (f.matched_name ?? null) : null,
                matched_person_id: f.identity_status === "VERIFIED" ? (f.matched_person_id ?? null) : null,
                sc_score: f.sc_score ?? 0,
                track_id: f.track_id ?? null,
                candidate_employee_id: f.candidate_employee_id ?? null,
                candidate_name: f.identity_status === "VERIFIED" ? (f.candidate_name ?? null) : null,
                similarity_score: f.similarity_score ?? f.sc_score ?? 0,
                matching_threshold: f.matching_threshold ?? 0.45,
                confirmation_count: f.confirmation_count ?? 0,
                required_confirmation_count: f.required_confirmation_count ?? 2,
                last_match_timestamp: f.last_match_timestamp ?? null,
                time_to_verified_ms: f.time_to_verified_ms ?? 0,
                detection_latency_ms: f.detection_latency_ms ?? 0,
                recognition_latency_ms: f.recognition_latency_ms ?? 0,
              }))
            : [],
          sc_score: score,
          match_score: score,
          confidence_category: verifiedCategory,
          identity_status: resolvedIdentityStatus,
          track_id: d.track_id ?? (resolvedIdentityStatus === "UNKNOWN" ? "UNKNOWN-TRACK" : null),
          consent_valid: verifiedConsent,
          template_match_confirmed: matchConfirmed,
          consecutive_match_frames: d.consecutive_match_frames ?? (resolvedIdentityStatus === "VERIFIED" ? 2 : 0),
          matching_threshold: d.matching_threshold ?? 0.45,
          required_confirmation_count: d.required_confirmation_count ?? 2,
          matched_name: verifiedName,
          matched_person_id: verifiedPersonId,
          person_count: d.person_count ?? 0,
          active_tracks: d.active_tracks ?? 0,
          last_event: d.last_event ?? null,
          updated_at: new Date().toISOString(),
          is_stale: d.is_stale ?? false,
          is_synthetic: d.is_synthetic ?? false,
          real_frame_count: d.real_frame_count ?? 0,
          recovery_status: d.recovery_status ?? currentTelemetry.recovery_status ?? "IDLE",
          consecutive_failures: d.consecutive_failures ?? currentTelemetry.consecutive_failures ?? 0,
          current_failure_reason: d.current_failure_reason ?? currentTelemetry.current_failure_reason ?? null,
          last_successful_frame_timestamp: d.last_successful_frame_timestamp ?? currentTelemetry.last_successful_frame_timestamp ?? null,
          last_diagnostic_timestamp: d.last_diagnostic_timestamp ?? currentTelemetry.last_diagnostic_timestamp ?? null,
          recovery_attempt_count: d.recovery_attempt_count ?? currentTelemetry.recovery_attempt_count ?? 0,
          actual_fps: d.actual_fps ?? currentTelemetry.actual_fps ?? 0,
          avg_frame_interval_ms: d.avg_frame_interval_ms ?? currentTelemetry.avg_frame_interval_ms ?? 0,
          frame_processing_latency_ms: d.frame_processing_latency_ms ?? currentTelemetry.frame_processing_latency_ms ?? 0,
          face_detection_latency_ms: d.face_detection_latency_ms ?? currentTelemetry.face_detection_latency_ms ?? 0,
          face_recognition_latency_ms: d.face_recognition_latency_ms ?? currentTelemetry.face_recognition_latency_ms ?? 0,
          dropped_frames: d.dropped_frames ?? currentTelemetry.dropped_frames ?? 0,
          frame_queue_depth: d.frame_queue_depth ?? currentTelemetry.frame_queue_depth ?? 0,
        };

        return Response.json({ success: true, message: "Telemetry received" });
      },
    },
  },
});
