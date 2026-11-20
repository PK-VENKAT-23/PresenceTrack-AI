import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import { Esp32CanvasOverlay } from "@/components/presence/security/Esp32CanvasOverlay";
import { Esp32StreamGrid } from "@/components/presence/security/Esp32StreamGrid";
import { Route as TelemetryRoute } from "@/routes/api/public/esp32/telemetry";
import { Route as BoundaryTransitRoute } from "@/routes/api/public/esp32/boundary-transit";
import { Route as EnrolledTemplatesRoute } from "@/routes/api/public/esp32/enrolled-templates";

vi.mock("@/integrations/supabase/client.server", () => ({
  hasSupabaseAdminConfigured: () => true,
  supabaseAdmin: {
    auth: {
      getUser: vi.fn((token: string) => {
        if (token === "valid-security-token" || token === "valid-admin-token") {
          return Promise.resolve({
            data: { user: { id: "sec-user-uuid-1", email: "sec@presencetrack.local" } },
            error: null,
          });
        }
        if (token === "valid-employee-token") {
          return Promise.resolve({
            data: { user: { id: "emp-user-uuid-1", email: "emp@presencetrack.local" } },
            error: null,
          });
        }
        return Promise.resolve({
          data: { user: null },
          error: { message: "Invalid session token" },
        });
      }),
    },
    rpc: vi.fn((fnName: string, args: { _user_id: string; _roles: string[] }) => {
      if (fnName === "has_any_role") {
        const isSecurityOrAdmin = args._user_id === "sec-user-uuid-1";
        return Promise.resolve({ data: isSecurityOrAdmin, error: null });
      }
      return Promise.resolve({ data: false, error: null });
    }),
    from: vi.fn((table: string) => {
      const qb: any = {
        eq: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        not: vi.fn().mockImplementation(() =>
          Promise.resolve({
            data: [
              {
                id: "a0000000-0000-0000-0000-000000000001",
                name: "Priya Sharma",
                badge_id: "EMP-101",
                enrolled_embedding: {
                  encrypted: true,
                  payload: "mock-encrypted-template-payload",
                  iv: "mock-iv-base64",
                },
                consent_revoked: false,
                is_active: true,
              },
            ],
            error: null,
          }),
        ),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: "a0000000-0000-0000-0000-000000000001",
            name: "Priya Sharma",
            consent_revoked: false,
            is_active: true,
          },
          error: null,
        }),
      };
      return {
        insert: vi.fn().mockResolvedValue({ data: { id: "test-id" }, error: null }),
        select: vi.fn().mockReturnValue(qb),
      };
    }),
  },
}));

type RouteHandler = (args: { request: Request }) => Promise<Response>;

function getServerHandler(
  route: any,
  method: string,
): RouteHandler {
  return route.options?.server?.handlers?.[method] as RouteHandler;
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    setLineDash: vi.fn(),
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

describe("Phase 5: Vision Gateway & Security Telemetry Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["ESP32_DEVICE_KEY"] = "test-device-secret-key-32";
  });

  describe("Esp32CanvasOverlay Rendering", () => {
    it("renders standby message when camera is offline", () => {
      render(
        <Esp32CanvasOverlay
          isLive={false}
          faceDetected={false}
          faceBoundingBox={null}
          scScore={0}
          statusMessage="No edge camera nodes online"
        />,
      );
      // Canvas is rendered in container
      expect(screen.queryByText("Identity Verified")).toBeNull();
    });

    it("displays live detection badge and cosine score when face is detected", () => {
      render(
        <Esp32CanvasOverlay
          isLive={true}
          faceDetected={true}
          faceBoundingBox={{ x: 100, y: 80, w: 90, h: 90 }}
          scScore={0.9421}
        />,
      );
      expect(screen.getByText("Identity Verified")).toBeDefined();
      expect(screen.getByText("Sc 0.9421")).toBeDefined();
    });

    it("displays awaiting transit indicator when live but no face is detected", () => {
      render(
        <Esp32CanvasOverlay
          isLive={true}
          faceDetected={false}
          faceBoundingBox={null}
          scScore={0}
        />,
      );
      expect(screen.getByText("Awaiting boundary transit")).toBeDefined();
      expect(screen.queryByText("Identity Verified")).toBeNull();
    });

    it("routes direct ESP32 streamUrl to gateway video relay URL", () => {
      render(
        <Esp32CanvasOverlay
          isLive={true}
          streamUrl="http://192.168.1.18:81/stream"
          faceDetected={false}
          faceBoundingBox={null}
          scScore={0}
        />,
      );
      const img = screen.getByAltText("ESP32-CAM live stream") as HTMLImageElement;
      expect(img).toBeDefined();
      expect(img.src).toBe("http://localhost:8001/video_feed");
      expect(screen.getByText("CONNECTING…")).toBeDefined();
    });

    it("renders gateway video relay URL directly when provided", () => {
      render(
        <Esp32CanvasOverlay
          isLive={true}
          streamUrl="http://localhost:8001/video_feed"
          faceDetected={false}
          faceBoundingBox={null}
          scScore={0}
        />,
      );
      const img = screen.getByAltText("ESP32-CAM live stream") as HTMLImageElement;
      expect(img).toBeDefined();
      expect(img.src).toBe("http://localhost:8001/video_feed");
      expect(screen.getByText("CONNECTING…")).toBeDefined();
    });

    it("detects decoded video frames and switches status to LIVE STREAM", () => {
      render(
        <Esp32CanvasOverlay
          isLive={true}
          streamUrl="http://localhost:8001/video_feed"
          faceDetected={false}
          faceBoundingBox={null}
          scScore={0}
        />,
      );
      const img = screen.getByAltText("ESP32-CAM live stream") as HTMLImageElement;
      // Simulate frame arrival by setting natural dimensions
      Object.defineProperty(img, "naturalWidth", { value: 320, configurable: true });
      Object.defineProperty(img, "naturalHeight", { value: 240, configurable: true });
      act(() => {
        fireEvent.load(img);
      });
      expect(screen.getByText("LIVE STREAM")).toBeDefined();
    });

    it("displays STREAM ERROR when gateway relay connection fails and supports reconnect", () => {
      render(
        <Esp32CanvasOverlay
          isLive={true}
          streamUrl="http://localhost:8001/video_feed"
          faceDetected={false}
          faceBoundingBox={null}
          scScore={0}
        />,
      );
      const img = screen.getByAltText("ESP32-CAM live stream");
      act(() => {
        fireEvent.error(img);
      });
      expect(screen.getByText("STREAM ERROR")).toBeDefined();
      const reconnectBtn = screen.getByText("↻ Reconnect Stream");
      expect(reconnectBtn).toBeDefined();
      act(() => {
        fireEvent.click(reconnectBtn);
      });
      expect(screen.getByText("CONNECTING…")).toBeDefined();
    });

    it("displays STREAM STALE badge when isStale is true and hides video stream opacity", () => {
      const { rerender } = render(
        <Esp32CanvasOverlay
          isLive={true}
          isStale={true}
          streamUrl="http://localhost:8001/video_feed"
          faceDetected={false}
          faceBoundingBox={null}
          scScore={0}
        />,
      );
      expect(screen.getByText("STREAM STALE")).toBeDefined();

      // Recovers when isStale returns to false
      rerender(
        <Esp32CanvasOverlay
          isLive={true}
          isStale={false}
          streamUrl="http://localhost:8001/video_feed"
          faceDetected={false}
          faceBoundingBox={null}
          scScore={0}
        />,
      );
      const img = screen.getByAltText("ESP32-CAM live stream");
      act(() => {
        fireEvent.load(img);
      });
      expect(screen.getByText("LIVE STREAM")).toBeDefined();
    });

    it("Esp32StreamGrid distinguishes LIVE vs STREAM STALE vs CAMERA OFFLINE vs NODE OFFLINE", () => {
      const now = new Date().toISOString();
      const nodes: any[] = [
        {
          id: "ESP32-CAM-01-NORTH",
          boundary_name: "North Entrance",
          is_online: true,
          last_ping: now,
          fps: 15,
        },
        {
          id: "ESP32-CAM-02-SOUTH",
          boundary_name: "South Exit",
          is_online: true,
          last_ping: now,
          fps: 15,
        },
        {
          id: "ESP32-CAM-03-EAST",
          boundary_name: "East Corridor",
          is_online: false,
          last_ping: null,
          fps: 15,
        },
        {
          id: "ESP32-CAM-04-WEST",
          boundary_name: "West Terrace",
          is_online: false,
          last_ping: null,
          fps: 15,
        },
      ];

      // 1. When isLive=true, isStale=false: North is LIVE, reserved nodes are NODE OFFLINE
      const { rerender } = render(
        <Esp32StreamGrid nodes={nodes} isLive={true} isStale={false} />,
      );
      expect(screen.getByText("LIVE")).toBeDefined();
      expect(screen.getAllByText("NODE OFFLINE").length).toBe(3);

      // 2. When isStale=true: North transitions to STREAM STALE
      rerender(<Esp32StreamGrid nodes={nodes} isLive={true} isStale={true} />);
      expect(screen.getByText("STREAM STALE")).toBeDefined();

      // 3. When isLive=false: North transitions to CAMERA OFFLINE
      rerender(<Esp32StreamGrid nodes={nodes} isLive={false} isStale={false} />);
      expect(screen.getByText("CAMERA OFFLINE")).toBeDefined();

      // 4. When North node has no recent heartbeat: North transitions to NODE OFFLINE
      const nodesWithoutPing = [
        { ...nodes[0], last_ping: new Date(Date.now() - 120000).toISOString() },
        ...nodes.slice(1),
      ];
      rerender(<Esp32StreamGrid nodes={nodesWithoutPing} isLive={true} isStale={false} />);
      expect(screen.getAllByText("NODE OFFLINE").length).toBe(4);
    });
  });

  describe("Telemetry API Route (/api/public/esp32/telemetry)", () => {
    it("GET rejects unauthorized requests without session credentials (401)", async () => {
      const getHandler = getServerHandler(TelemetryRoute, "GET");
      expect(getHandler).toBeDefined();

      const request = new Request("http://localhost:3000/api/public/esp32/telemetry");
      const response = await getHandler!({ request });
      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Session required");
    });

    it("GET strictly rejects requests relying solely on x-device-key (403)", async () => {
      const getHandler = getServerHandler(TelemetryRoute, "GET");
      expect(getHandler).toBeDefined();

      const request = new Request("http://localhost:3000/api/public/esp32/telemetry", {
        headers: { "x-device-key": "test-device-secret-key-32" },
      });
      const response = await getHandler!({ request });
      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Device key cannot authorize telemetry retrieval");
    });

    it("GET rejects non-security role (e.g. employee) (403)", async () => {
      const getHandler = getServerHandler(TelemetryRoute, "GET");
      expect(getHandler).toBeDefined();

      const request = new Request("http://localhost:3000/api/public/esp32/telemetry", {
        headers: { authorization: "Bearer valid-employee-token" },
      });
      const response = await getHandler!({ request });
      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Security or Super Admin role required");
    });

    it("GET returns current telemetry state when authorized with Security role (200)", async () => {
      const getHandler = getServerHandler(TelemetryRoute, "GET");
      expect(getHandler).toBeDefined();

      const request = new Request("http://localhost:3000/api/public/esp32/telemetry", {
        headers: { authorization: "Bearer valid-security-token" },
      });
      const response = await getHandler!({ request });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.telemetry).toBeDefined();
      expect(json.telemetry.camera_id).toBe("ESP32-CAM-01-NORTH");
    });

    it("POST rejects requests without x-device-key", async () => {
      const postHandler = getServerHandler(TelemetryRoute, "POST");
      const request = new Request("http://localhost:3000/api/public/esp32/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          camera_id: "ESP32-CAM-01-NORTH",
          is_live: true,
          face_detected: true,
        }),
      });

      const response = await postHandler!({ request });
      expect(response.status).toBe(401);
    });

    it("POST rejects out-of-bounds bounding box coordinates", async () => {
      const postHandler = getServerHandler(TelemetryRoute, "POST");
      const request = new Request("http://localhost:3000/api/public/esp32/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-key": "test-device-secret-key-32",
        },
        body: JSON.stringify({
          camera_id: "ESP32-CAM-01-NORTH",
          is_live: true,
          face_detected: true,
          face_bounding_box: { x: 3950, y: 3950, w: 200, h: 200 }, // Extends beyond 4000
        }),
      });

      const response = await postHandler!({ request });
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("out-of-bounds");
    });

    it("POST rejects expired or skewed timestamps (replay protection: window is ±30s)", async () => {
      const postHandler = getServerHandler(TelemetryRoute, "POST");
      // Timestamp skewed by 45 seconds (> 30s)
      const oldTimestamp = new Date(Date.now() - 45000).toISOString();
      const request = new Request("http://localhost:3000/api/public/esp32/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-key": "test-device-secret-key-32",
        },
        body: JSON.stringify({
          camera_id: "ESP32-CAM-01-NORTH",
          is_live: true,
          face_detected: true,
          timestamp: oldTimestamp,
        }),
      });

      const response = await postHandler!({ request });
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("replay protection");
    });

    it("POST debounces and suppresses duplicate event_nonces", async () => {
      const postHandler = getServerHandler(TelemetryRoute, "POST");
      const validTimestamp = new Date().toISOString();
      const duplicateNonce = "unique-test-nonce-9999";

      const firstReq = new Request("http://localhost:3000/api/public/esp32/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-key": "test-device-secret-key-32",
        },
        body: JSON.stringify({
          camera_id: "ESP32-CAM-01-NORTH",
          is_live: true,
          face_detected: false,
          timestamp: validTimestamp,
          event_nonce: duplicateNonce,
        }),
      });
      const firstRes = await postHandler!({ request: firstReq });
      expect(firstRes.status).toBe(200);

      // Replay identical nonce
      const secondReq = new Request("http://localhost:3000/api/public/esp32/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-key": "test-device-secret-key-32",
        },
        body: JSON.stringify({
          camera_id: "ESP32-CAM-01-NORTH",
          is_live: true,
          face_detected: false,
          timestamp: validTimestamp,
          event_nonce: duplicateNonce,
        }),
      });
      const secondRes = await postHandler!({ request: secondReq });
      expect(secondRes.status).toBe(200);
      const secondJson = await secondRes.json();
      expect(secondJson.debounced).toBe(true);
      expect(secondJson.message).toContain("suppressed");
    });

    it("POST accepts and records telemetry when valid device key is provided", async () => {
      const postHandler = getServerHandler(TelemetryRoute, "POST");
      const validTimestamp = new Date().toISOString();
      const request = new Request("http://localhost:3000/api/public/esp32/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-key": "test-device-secret-key-32",
        },
        body: JSON.stringify({
          camera_id: "ESP32-CAM-01-NORTH",
          is_live: true,
          face_detected: true,
          face_bounding_box: { x: 120, y: 75, w: 85, h: 85 },
          sc_score: 0.9312,
          matched_name: "Rahul Roy",
          person_count: 1,
          active_tracks: 1,
          last_event: "ZONE_ENTER",
          timestamp: validTimestamp,
          event_nonce: "nonce-123456",
        }),
      });

      const response = await postHandler!({ request });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);

      // Verify authorized Security GET returns the updated telemetry
      const getHandler = getServerHandler(TelemetryRoute, "GET");
      const getReq = new Request("http://localhost:3000/api/public/esp32/telemetry", {
        headers: { authorization: "Bearer valid-security-token" },
      });
      const getRes = await getHandler!({ request: getReq });
      const getJson = await getRes.json();
      expect(getJson.telemetry.face_detected).toBe(true);
      expect(getJson.telemetry.sc_score).toBe(0.9312);
      expect(getJson.telemetry.matched_name).toBe("Rahul Roy");
      expect(getJson.telemetry.face_bounding_box).toEqual({ x: 120, y: 75, w: 85, h: 85 });
    });

    it("Task 4 Discrepancy: POST telemetry strips identity for score in [0.363, 0.70) (0.55)", async () => {
      const postHandler = getServerHandler(TelemetryRoute, "POST");
      const getHandler = getServerHandler(TelemetryRoute, "GET");

      const response = await postHandler!({
        request: new Request("http://localhost:3000/api/public/esp32/telemetry", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-device-key": "test-device-secret-key-32",
          },
          body: JSON.stringify({
            camera_id: "ESP32-CAM-01-NORTH",
            is_live: true,
            face_detected: true,
            face_bounding_box: { x: 50, y: 50, w: 100, h: 100 },
            sc_score: 0.55,
            matched_person_id: "a0000000-0000-0000-0000-000000000001",
            matched_name: "Priya Sharma",
            timestamp: new Date().toISOString(),
          }),
        }),
      });
      expect(response.status).toBe(200);

      // Verify sanitized state via Security GET: identity is stripped and category is UNCERTAIN
      const getRes = await getHandler!({
        request: new Request("http://localhost:3000/api/public/esp32/telemetry", {
          headers: { authorization: "Bearer valid-security-token" },
        }),
      });
      const data = await getRes.json();
      expect(data.telemetry.sc_score).toBe(0.55);
      expect(data.telemetry.confidence_category).toBe("UNCERTAIN");
      expect(data.telemetry.matched_person_id).toBeNull();
      expect(data.telemetry.matched_name).toBeNull();
    });

    it("Task 4 Discrepancy: POST telemetry verifies canonical identity when score >= 0.70", async () => {
      const postHandler = getServerHandler(TelemetryRoute, "POST");
      const getHandler = getServerHandler(TelemetryRoute, "GET");

      const response = await postHandler!({
        request: new Request("http://localhost:3000/api/public/esp32/telemetry", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-device-key": "test-device-secret-key-32",
          },
          body: JSON.stringify({
            camera_id: "ESP32-CAM-01-NORTH",
            is_live: true,
            face_detected: true,
            face_bounding_box: { x: 50, y: 50, w: 100, h: 100 },
            sc_score: 0.76,
            matched_person_id: "a0000000-0000-0000-0000-000000000001",
            matched_name: "Spoofed Name Attempt",
            timestamp: new Date().toISOString(),
          }),
        }),
      });
      expect(response.status).toBe(200);

      const getRes = await getHandler!({
        request: new Request("http://localhost:3000/api/public/esp32/telemetry", {
          headers: { authorization: "Bearer valid-security-token" },
        }),
      });
      const data = await getRes.json();
      expect(data.telemetry.sc_score).toBe(0.76);
      expect(data.telemetry.confidence_category).toBe("MATCHED");
      expect(data.telemetry.matched_person_id).toBe("a0000000-0000-0000-0000-000000000001");
      // Must use canonical name from DB ("Priya Sharma"), not spoofed name
      expect(data.telemetry.matched_name).toBe("Priya Sharma");
    });
  });

  describe("Boundary Transit Gate & Low Confidence Alerting", () => {
    it("POST boundary-transit rejects unauthorized device calls (missing x-device-key)", async () => {
      const postHandler = getServerHandler(BoundaryTransitRoute, "POST");
      const request = new Request("http://localhost:3000/api/public/esp32/boundary-transit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          camera_id: "ESP32-CAM-01-NORTH",
          user_id: "a0000000-0000-0000-0000-000000000001",
          zone_from: "CORRIDOR_TRANSIT",
          zone_to: "WORKSPACE_FLOOR",
          direction: "ZONE_ENTER",
          cosine_score: 0.95,
          dram_scrub_ms: 1.2,
        }),
      });

      const response = await postHandler!({ request });
      expect(response.status).toBe(401);
    });

    it("POST boundary-transit flags score < 0.70 as unknown detection (422 status)", async () => {
      const postHandler = getServerHandler(BoundaryTransitRoute, "POST");
      const request = new Request("http://localhost:3000/api/public/esp32/boundary-transit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-key": "test-device-secret-key-32",
        },
        body: JSON.stringify({
          camera_id: "ESP32-CAM-01-NORTH",
          user_id: "00000000-0000-0000-0000-000000000000",
          zone_from: "CORRIDOR_TRANSIT",
          zone_to: "WORKSPACE_FLOOR",
          direction: "ZONE_ENTER",
          cosine_score: 0.45,
          dram_scrub_ms: 1.0,
        }),
      });

      const response = await postHandler({ request });
      expect(response.status).toBe(422);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.unknown_alert_logged).toBe(true);
      expect(json.error).toContain("0.7000");
    });

    it("Task 4 Discrepancy: POST boundary-transit rejects genuine SFace score 0.58 even for valid employee because 0.58 < 0.70 (422 status)", async () => {
      const postHandler = getServerHandler(BoundaryTransitRoute, "POST");
      const request = new Request("http://localhost:3000/api/public/esp32/boundary-transit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-key": "test-device-secret-key-32",
        },
        body: JSON.stringify({
          camera_id: "ESP32-CAM-01-NORTH",
          user_id: "a0000000-0000-0000-0000-000000000001",
          zone_from: "CORRIDOR_TRANSIT",
          zone_to: "WORKSPACE_FLOOR",
          direction: "ZONE_ENTER",
          cosine_score: 0.58,
          dram_scrub_ms: 1.0,
        }),
      });

      const response = await postHandler!({ request });
      expect(response.status).toBe(422);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.unknown_alert_logged).toBe(true);
      expect(json.error).toContain("0.7000");
    });
  });

  describe("Enrolled Templates Distribution (/api/public/esp32/enrolled-templates)", () => {
    it("GET rejects requests without x-device-key (401)", async () => {
      const getHandler = getServerHandler(EnrolledTemplatesRoute, "GET");
      const request = new Request("http://localhost:3000/api/public/esp32/enrolled-templates");
      const response = await getHandler({ request });
      expect(response.status).toBe(401);
    });

    it("GET rejects requests with invalid x-device-key (401)", async () => {
      const getHandler = getServerHandler(EnrolledTemplatesRoute, "GET");
      const request = new Request("http://localhost:3000/api/public/esp32/enrolled-templates", {
        headers: { "x-device-key": "invalid-device-key" },
      });
      const response = await getHandler({ request });
      expect(response.status).toBe(401);
    });

    it("GET returns encrypted template envelopes and excludes raw biometric vectors (200)", async () => {
      const getHandler = getServerHandler(EnrolledTemplatesRoute, "GET");
      const request = new Request("http://localhost:3000/api/public/esp32/enrolled-templates", {
        headers: { "x-device-key": "test-device-secret-key-32" },
      });
      const response = await getHandler({ request });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.count).toBe(1);
      expect(Array.isArray(data.templates)).toBe(true);
      expect(data.templates[0].employee_id).toBe("a0000000-0000-0000-0000-000000000001");
      expect(data.templates[0].name).toBe("Priya Sharma");
      expect(data.templates[0].badge_id).toBe("EMP-101");
      // Template must be an encrypted envelope, never raw plaintext array
      expect(data.templates[0].encrypted_envelope).toEqual({
        encrypted: true,
        payload: "mock-encrypted-template-payload",
        iv: "mock-iv-base64",
      });
      expect(data.templates[0]).not.toHaveProperty("raw_embedding");
      expect(data.templates[0]).not.toHaveProperty("embedding");
    });
  });
});
