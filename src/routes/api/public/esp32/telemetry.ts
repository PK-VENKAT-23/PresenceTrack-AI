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

const TelemetryPayloadSchema = z.object({
  camera_id: z.string().trim().min(1).max(64),
  is_live: z.boolean(),
  face_detected: z.boolean(),
  face_bounding_box: BoundingBoxSchema.nullable().optional(),
  sc_score: z.number().min(0).max(1).optional(),
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
});

export interface LiveTelemetryState {
  camera_id: string;
  is_live: boolean;
  face_detected: boolean;
  face_bounding_box: { x: number; y: number; w: number; h: number } | null;
  sc_score: number;
  confidence_category: string;
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
}

// In-memory latest telemetry state from Edge Vision Gateway
let currentTelemetry: LiveTelemetryState = {
  camera_id: "ESP32-CAM-01-NORTH",
  is_live: false,
  face_detected: false,
  face_bounding_box: null,
  sc_score: 0,
  confidence_category: "UNKNOWN",
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
              sc_score: liveStatus ? currentTelemetry.sc_score : 0,
              confidence_category: liveStatus ? currentTelemetry.confidence_category : "UNKNOWN",
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

        // Verify employee association and derive strict confidence category
        let verifiedPersonId: string | null = null;
        let verifiedName: string | null = null;
        let verifiedCategory = "UNKNOWN";

        const score = d.sc_score ?? 0;

        if (d.matched_person_id && score >= 0.70) {
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
            } else {
              // Inactive, unknown, or revoked consent: reject match association
              verifiedPersonId = null;
              verifiedName = null;
              verifiedCategory = person?.consent_revoked ? "CONSENT_REVOKED" : "UNKNOWN";
            }
          } else {
            verifiedPersonId = d.matched_person_id;
            verifiedName = d.matched_name ?? null;
            verifiedCategory = score >= 0.85 ? "HIGH" : "MATCHED";
          }
        } else if (!d.matched_person_id && d.matched_name && score >= 0.70) {
          verifiedName = d.matched_name;
          verifiedCategory = score >= 0.85 ? "HIGH" : "MATCHED";
        } else if (score >= 0.50) {
          verifiedCategory = "UNCERTAIN";
        }

        currentTelemetry = {
          camera_id: d.camera_id,
          is_live: d.is_live,
          face_detected: d.face_detected,
          face_bounding_box: d.face_bounding_box ?? null,
          sc_score: score,
          confidence_category: verifiedCategory,
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
        };

        return Response.json({ success: true, message: "Telemetry received" });
      },
    },
  },
});
