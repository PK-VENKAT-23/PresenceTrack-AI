import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

/** Verify caller has Physical Security or Super Admin role */
async function requireSecurityOrAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data: isAllowed } = await supabase.rpc("has_any_role", {
    _user_id: userId,
    _roles: ["security", "super_admin"],
  });
  if (!isAllowed) throw new Error("Forbidden: Security or Super Admin role required for camera operations");
}

function getGatewayConfig() {
  const gatewayUrl = (process.env["VISION_GATEWAY_URL"] || "http://localhost:8001").replace(/\/+$/, "");
  const deviceKey = process.env["ESP32_DEVICE_KEY"] || "";
  return { gatewayUrl, deviceKey };
}

export interface CameraDiagnosticCheckItem {
  status: string;
  detail: string;
  is_synthetic?: boolean | undefined;
  real_frame_count?: number | undefined;
  delta_frames?: number | undefined;
  age_seconds?: number | null | undefined;
  is_stale?: boolean | undefined;
  actual_fps?: number | undefined;
}

export interface CameraDiagnosticReport {
  timestamp: string;
  overall_status: string;
  is_camera_live: boolean;
  is_stale: boolean;
  is_synthetic: boolean;
  real_frame_count: number;
  last_successful_frame_timestamp: string | null;
  recovery_attempt_count: number;
  consecutive_failures: number;
  recovery_status: string;
  current_failure_reason: string | null;
  recovery_backoff_sec: number;
  checks: Record<string, CameraDiagnosticCheckItem>;
}

export interface CameraDiagnosticHistoryEntry {
  timestamp: string;
  failure_category: string;
  error_details: string;
  recovery_action: string;
  attempt_number: number;
  recovery_result: string;
  time_taken_sec: number;
}

export interface CameraStatusData {
  source: string;
  is_connected: boolean;
  is_camera_connected: boolean;
  is_camera_live: boolean;
  is_synthetic: boolean;
  is_stale: boolean;
  target_fps: number;
  actual_fps: number;
  frame_count: number;
  real_frame_count: number;
  last_real_frame_timestamp: number;
  last_frame_timestamp: number;
  reconnect_count: number;
  reconnect_backoff_sec: number;
  camera_id: string;
  recovery_status: string;
  recovery_attempt_count: number;
  consecutive_failures: number;
  last_diagnostic_timestamp: string | null;
  last_successful_frame_timestamp: string | null;
  current_failure_reason: string | null;
}

export interface RunDiagnosticsResult {
  success: boolean;
  camera_id: string;
  diagnostic: CameraDiagnosticReport;
  error: string | null;
}

export interface GetDiagnosticsResult {
  success: boolean;
  camera_id: string;
  latest_diagnostic: CameraDiagnosticReport | null;
  history: CameraDiagnosticHistoryEntry[];
  error: string | null;
}

export interface GetCameraStatusResult {
  success: boolean;
  status: CameraStatusData | null;
  error: string | null;
}

/**
 * Trigger safe manual reconnection and verify new real frames arrive.
 * Protected: Physical Security or Super Admin only.
 */
export const refreshCameraStream = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        force: z.boolean().default(true),
      })
      .parse(input || {}),
  )
  .handler(async ({ data, context }) => {
    await requireSecurityOrAdmin(context.supabase, context.userId);
    const { gatewayUrl, deviceKey } = getGatewayConfig();

    try {
      const resp = await fetch(`${gatewayUrl}/camera/reconnect?force=${data.force ? "true" : "false"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(deviceKey ? { "x-device-key": deviceKey } : {}),
        },
      });

      if (!resp.ok) {
        let detail = "";
        try {
          const errJson = await resp.json();
          detail = errJson.detail || errJson.message || JSON.stringify(errJson);
        } catch {
          detail = await resp.text().catch(() => "");
        }
        return {
          success: false,
          status: "FAILED",
          camera_connected: false,
          is_synthetic: false,
          is_stale: true,
          real_frame_count: 0,
          message: `Gateway HTTP ${resp.status}: ${detail || "Recovery request failed"}`,
          new_frames_received: 0,
          time_taken_sec: 0,
          failure_reason: `Gateway returned HTTP ${resp.status}`,
          recovery_status: "RECOVERY_FAILED",
        };
      }

      const json = await resp.json();
      return {
        success: Boolean(json.success && json.status === "reconnected"),
        status: json.status,
        camera_connected: Boolean(json.camera_connected),
        is_synthetic: Boolean(json.is_synthetic),
        is_stale: Boolean(json.is_stale),
        real_frame_count: Number(json.real_frame_count || 0),
        message: String(json.message || ""),
        new_frames_received: Number(json.new_frames_received || 0),
        time_taken_sec: Number(json.time_taken_sec || 0),
        failure_reason: (json.failure_reason as string | null) ?? null,
        recovery_status: (json.recovery_status as string | null) ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to communicate with Vision Gateway";
      return {
        success: false,
        status: "GATEWAY_OFFLINE",
        camera_connected: false,
        is_synthetic: false,
        is_stale: true,
        real_frame_count: 0,
        message: `Gateway unreachable: ${message}`,
        new_frames_received: 0,
        time_taken_sec: 0,
        failure_reason: "Vision Gateway service is offline or unreachable on port 8001",
        recovery_status: "GATEWAY_OFFLINE",
      };
    }
  });

/**
 * Execute on-demand diagnostic evaluation across all camera health checks.
 * Protected: Physical Security or Super Admin only.
 */
export const runCameraDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireSecurityOrAdmin(context.supabase, context.userId);
    const { gatewayUrl, deviceKey } = getGatewayConfig();

    try {
      const resp = await fetch(`${gatewayUrl}/camera/diagnostics/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(deviceKey ? { "x-device-key": deviceKey } : {}),
        },
      });

      if (!resp.ok) {
        throw new Error(`Diagnostics failed with HTTP ${resp.status}`);
      }

      const json = await resp.json();
      return {
        success: true,
        camera_id: String(json.camera_id || "ESP32-CAM-01-NORTH"),
        diagnostic: json.diagnostic as CameraDiagnosticReport,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to run diagnostics";
      return {
        success: false,
        camera_id: "ESP32-CAM-01-NORTH",
        error: message,
        diagnostic: {
          timestamp: new Date().toISOString(),
          overall_status: "GATEWAY_OFFLINE",
          is_camera_live: false,
          is_stale: true,
          is_synthetic: false,
          real_frame_count: 0,
          last_successful_frame_timestamp: null,
          recovery_attempt_count: 0,
          consecutive_failures: 1,
          recovery_status: "GATEWAY_OFFLINE",
          current_failure_reason: "Vision Gateway is offline or unreachable on port 8001",
          recovery_backoff_sec: 0,
          checks: {
            gateway_health: {
              status: "FAIL",
              detail: `Connection to ${gatewayUrl} refused: ${message}`,
            },
          },
        },
      };
    }
  });

/**
 * Retrieve comprehensive diagnostics report and bounded history.
 * Protected: Physical Security or Super Admin only.
 */
export const getCameraDiagnostics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<GetDiagnosticsResult> => {
    await requireSecurityOrAdmin(context.supabase, context.userId);
    const { gatewayUrl } = getGatewayConfig();

    try {
      const resp = await fetch(`${gatewayUrl}/camera/diagnostics`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (!resp.ok) {
        throw new Error(`Failed to fetch diagnostics (HTTP ${resp.status})`);
      }

      const json = await resp.json();
      return {
        success: true,
        camera_id: String(json.camera_id || "ESP32-CAM-01-NORTH"),
        latest_diagnostic: json.latest_diagnostic as CameraDiagnosticReport,
        history: (json.history || []) as CameraDiagnosticHistoryEntry[],
        error: null,
      };
    } catch (err) {
      return {
        success: false,
        camera_id: "ESP32-CAM-01-NORTH",
        latest_diagnostic: null,
        history: [],
        error: err instanceof Error ? err.message : "Gateway offline",
      };
    }
  });

/**
 * Fetch detailed camera status from gateway.
 * Protected: Physical Security or Super Admin only.
 */
export const getCameraStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<GetCameraStatusResult> => {
    await requireSecurityOrAdmin(context.supabase, context.userId);
    const { gatewayUrl } = getGatewayConfig();

    try {
      const resp = await fetch(`${gatewayUrl}/camera/status`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (!resp.ok) {
        throw new Error(`Failed to fetch camera status (HTTP ${resp.status})`);
      }

      const json = await resp.json();
      return {
        success: true,
        status: json as CameraStatusData,
        error: null,
      };
    } catch (err) {
      return {
        success: false,
        status: null,
        error: err instanceof Error ? err.message : "Gateway offline",
      };
    }
  });

/**
 * Safely trigger authenticated physical camera reboot.
 * Protected: Physical Security or Super Admin only.
 */
export const rebootCameraStream = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireSecurityOrAdmin(context.supabase, context.userId);
    const { gatewayUrl, deviceKey } = getGatewayConfig();

    try {
      const resp = await fetch(`${gatewayUrl}/camera/reboot`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(deviceKey ? { "x-device-key": deviceKey } : {}),
        },
      });

      if (!resp.ok) {
        let detail = "";
        try {
          const errJson = await resp.json();
          detail = errJson.detail || errJson.message || "";
        } catch {
          detail = await resp.text().catch(() => "");
        }
        return {
          success: false,
          status: "FAILED",
          message: `Gateway HTTP ${resp.status}: ${detail || "Reboot request failed"}`,
          requires_physical_power_cycle: false,
        };
      }

      const json = await resp.json();
      return {
        success: Boolean(json.success),
        status: String(json.status || "UNKNOWN"),
        message: String(json.message || ""),
        requires_physical_power_cycle: Boolean(json.requires_physical_power_cycle),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to communicate with Vision Gateway";
      return {
        success: false,
        status: "GATEWAY_OFFLINE",
        message: `Gateway unreachable: ${message}`,
        requires_physical_power_cycle: false,
      };
    }
  });
