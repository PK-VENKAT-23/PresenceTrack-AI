import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Esp32CameraControlCard } from "@/components/presence/security/Esp32CameraControlCard";
import { Esp32StreamGrid } from "@/components/presence/security/Esp32StreamGrid";
import { Esp32CanvasOverlay } from "@/components/presence/security/Esp32CanvasOverlay";
import { CameraDiagnosticsModal } from "@/components/presence/security/CameraDiagnosticsModal";
import type { Esp32Node } from "@/lib/ambient";
import type { LiveTelemetry } from "@/lib/queries";

// Mock TanStack React Start
vi.mock("@tanstack/react-start", () => {
  const mockMiddleware: any = {
    client: () => mockMiddleware,
    server: () => mockMiddleware,
  };
  const mockFnBuilder: any = {
    middleware: () => mockFnBuilder,
    validator: () => mockFnBuilder,
    handler: (fn: any) => fn,
  };
  return {
    useServerFn: (fn: any) => fn,
    createMiddleware: () => mockMiddleware,
    createCsrfMiddleware: () => mockMiddleware,
    createServerFn: () => mockFnBuilder,
  };
});

// Mock camera functions
const mockRefreshStream = vi.fn();
const mockRebootStream = vi.fn();
const mockRunDiagnostics = vi.fn();
const mockGetDiagnostics = vi.fn();
const mockGetStatus = vi.fn();

vi.mock("@/lib/camera.functions", () => ({
  refreshCameraStream: (...args: any[]) => mockRefreshStream(...args),
  rebootCameraStream: (...args: any[]) => mockRebootStream(...args),
  runCameraDiagnostics: (...args: any[]) => mockRunDiagnostics(...args),
  getCameraDiagnostics: (...args: any[]) => mockGetDiagnostics(...args),
  getCameraStatus: (...args: any[]) => mockGetStatus(...args),
}));

const mockNodes: Esp32Node[] = [
  {
    id: "ESP32-CAM-01-NORTH",
    boundary_name: "North Entrance Camera",
    stream_url: "http://192.168.1.18:81/stream",
    zone_a: "CORRIDOR_TRANSIT",
    zone_b: "WORKSPACE_FLOOR",
    is_online: true,
    fps: 15,
    last_ping: new Date().toISOString(),
    firmware_version: "gateway-v1.1.0",
    boundary_coordinates: { x1: 20, y1: 150, x2: 380, y2: 150 },
  },
  {
    id: "ESP32-CAM-02-SOUTH",
    boundary_name: "South Exit Turnstile",
    stream_url: "http://192.168.1.19:81/stream",
    zone_a: "CORRIDOR_TRANSIT",
    zone_b: "WORKSPACE_FLOOR",
    is_online: false,
    fps: 15,
    last_ping: null,
    firmware_version: null,
    boundary_coordinates: { x1: 20, y1: 150, x2: 380, y2: 150 },
  },
];

const mockHealthyTelemetry: LiveTelemetry = {
  camera_id: "ESP32-CAM-01-NORTH",
  is_live: true,
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
  real_frame_count: 1420,
  recovery_status: "LIVE",
  consecutive_failures: 0,
  current_failure_reason: null,
  last_successful_frame_timestamp: new Date().toISOString(),
  last_diagnostic_timestamp: new Date().toISOString(),
  recovery_attempt_count: 0,
};

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("Camera Health Monitor, Diagnostics & Automatic Recovery Frontend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("UI Status Transitions in Esp32CameraControlCard", () => {
    it("renders LIVE badge and monitoring state when camera is healthy", () => {
      renderWithClient(
        <Esp32CameraControlCard
          nodes={mockNodes}
          activeNode={mockNodes[0]}
          isNodeAttested={true}
          isCameraLive={true}
          live={1}
          telemetry={mockHealthyTelemetry}
        />,
      );

      expect(screen.getAllByText("LIVE").length).toBeGreaterThan(0);
      expect(screen.getByText("Refresh Camera")).toBeInTheDocument();
      expect(screen.getByText("Run Diagnostics")).toBeInTheDocument();
      expect(screen.getByText(/MONITORING/)).toBeInTheDocument();
    });

    it("renders STREAM STALE badge and failure reason when real frames stop arriving", () => {
      const staleTelemetry: LiveTelemetry = {
        ...mockHealthyTelemetry,
        is_live: true,
        is_stale: true,
        recovery_status: "STREAM_STALE",
        current_failure_reason: "Stream STALE: no new real frames for 4.2s (threshold 3.0s)",
      };

      renderWithClient(
        <Esp32CameraControlCard
          nodes={mockNodes}
          activeNode={mockNodes[0]}
          isNodeAttested={true}
          isCameraLive={true}
          live={1}
          telemetry={staleTelemetry}
        />,
      );

      expect(screen.getAllByText("STREAM STALE").length).toBeGreaterThan(0);
      expect(screen.getByText(/Stream STALE: no new real frames for 4.2s/)).toBeInTheDocument();
    });

    it("renders CAMERA OFFLINE when node heartbeat or connection is lost", () => {
      const offlineTelemetry: LiveTelemetry = {
        ...mockHealthyTelemetry,
        is_live: false,
        recovery_status: "CAMERA_OFFLINE",
        current_failure_reason: "ESP32 network connection failed: Connection refused on port 81",
      };

      renderWithClient(
        <Esp32CameraControlCard
          nodes={mockNodes}
          activeNode={mockNodes[0]}
          isNodeAttested={false}
          isCameraLive={false}
          live={0}
          telemetry={offlineTelemetry}
        />,
      );

      expect(screen.getAllByText("CAMERA OFFLINE").length).toBeGreaterThan(0);
      expect(screen.getByText(/Connection refused on port 81/)).toBeInTheDocument();
    });

    it("renders RECONNECTING badge when recovery or manual refresh is in progress", () => {
      const recoveringTelemetry: LiveTelemetry = {
        ...mockHealthyTelemetry,
        recovery_status: "RECONNECTING",
      };

      renderWithClient(
        <Esp32CameraControlCard
          nodes={mockNodes}
          activeNode={mockNodes[0]}
          isNodeAttested={true}
          isCameraLive={false}
          live={1}
          telemetry={recoveringTelemetry}
        />,
      );

      expect(screen.getByText("RECONNECTING")).toBeInTheDocument();
    });

    it("renders RECOVERY FAILED state when consecutive recovery failures reach threshold", () => {
      const failedTelemetry: LiveTelemetry = {
        ...mockHealthyTelemetry,
        recovery_status: "RECOVERY_FAILED",
        consecutive_failures: 5,
        current_failure_reason:
          "Automatic recovery halted after 5 failed attempts: Camera stream could not advance real frames. Manual intervention or Refresh Camera required.",
      };

      renderWithClient(
        <Esp32CameraControlCard
          nodes={mockNodes}
          activeNode={mockNodes[0]}
          isNodeAttested={true}
          isCameraLive={false}
          live={0}
          telemetry={failedTelemetry}
        />,
      );

      expect(screen.getByText("RECOVERY FAILED")).toBeInTheDocument();
      expect(screen.getByText(/HALTED \(FAILED\)/)).toBeInTheDocument();
      expect(screen.getByText(/Automatic recovery halted after 5 failed attempts/)).toBeInTheDocument();
    });

    it("renders GATEWAY OFFLINE when vision gateway is down", () => {
      const gatewayDownTelemetry: LiveTelemetry = {
        ...mockHealthyTelemetry,
        is_live: false,
        recovery_status: "GATEWAY_OFFLINE",
        current_failure_reason: "Vision Gateway service is offline or unreachable on port 8001",
      };

      renderWithClient(
        <Esp32CameraControlCard
          nodes={mockNodes}
          activeNode={mockNodes[0]}
          isNodeAttested={false}
          isCameraLive={false}
          live={0}
          telemetry={gatewayDownTelemetry}
        />,
      );

      expect(screen.getByText("GATEWAY OFFLINE")).toBeInTheDocument();
    });
  });

  describe("Manual Refresh Action", () => {
    it("triggers refreshCameraStream server function without full page reload", async () => {
      mockRefreshStream.mockResolvedValueOnce({
        success: true,
        status: "reconnected",
        message: "Manual refresh succeeded: 12 fresh frames verified in 0.42s",
        camera_connected: true,
        real_frame_count: 1432,
        new_frames_received: 12,
        time_taken_sec: 0.42,
        failure_reason: null,
      });

      const onRefresh = vi.fn();
      renderWithClient(
        <Esp32CameraControlCard
          nodes={mockNodes}
          activeNode={mockNodes[0]}
          isNodeAttested={true}
          isCameraLive={true}
          live={1}
          telemetry={mockHealthyTelemetry}
          onRefreshTelemetry={onRefresh}
        />,
      );

      const refreshBtn = screen.getByRole("button", { name: /Refresh Camera/i });
      fireEvent.click(refreshBtn);

      await waitFor(() => {
        expect(mockRefreshStream).toHaveBeenCalledWith({ data: { force: true } });
        expect(onRefresh).toHaveBeenCalled();
      });
    });

    it("shows error and never reports success when manual refresh returns 0 fresh frames", async () => {
      mockRefreshStream.mockResolvedValueOnce({
        success: false,
        status: "STREAM_STALE",
        message: "Manual refresh completed but 0 fresh real frames received (2.50s)",
        camera_connected: false,
        real_frame_count: 1420,
        new_frames_received: 0,
        time_taken_sec: 2.5,
        failure_reason: "Manual refresh completed but 0 fresh real frames received",
      });

      const onRefresh = vi.fn();
      renderWithClient(
        <Esp32CameraControlCard
          nodes={mockNodes}
          activeNode={mockNodes[0]}
          isNodeAttested={true}
          isCameraLive={false}
          live={0}
          telemetry={{ ...mockHealthyTelemetry, is_live: false, real_frame_count: 1420 }}
          onRefreshTelemetry={onRefresh}
        />,
      );

      const refreshBtn = screen.getByRole("button", { name: /Refresh Camera/i });
      fireEvent.click(refreshBtn);

      await waitFor(() => {
        expect(mockRefreshStream).toHaveBeenCalledWith({ data: { force: true } });
        expect(screen.queryByText(/Camera Stream Reconnected/i)).not.toBeInTheDocument();
      });
    });

    it("handles network route error properly when network is unreachable", async () => {
      mockRefreshStream.mockResolvedValueOnce({
        success: false,
        status: "CAMERA_OFFLINE",
        detailed_state: "NETWORK_UNAVAILABLE",
        message: "Network route unreachable to 10.204.175.1:81 (No route to host, errno 65) - verify Mac Wi-Fi / hotspot",
        camera_connected: false,
        real_frame_count: 0,
        new_frames_received: 0,
        time_taken_sec: 0.1,
        failure_reason: "Network route unreachable (errno 65)",
      });

      const onRefresh = vi.fn();
      renderWithClient(
        <Esp32CameraControlCard
          nodes={mockNodes}
          activeNode={mockNodes[0]}
          isNodeAttested={true}
          isCameraLive={false}
          live={0}
          telemetry={{ ...mockHealthyTelemetry, is_live: false, real_frame_count: 0 }}
          onRefreshTelemetry={onRefresh}
        />,
      );

      const refreshBtn = screen.getByRole("button", { name: /Refresh Camera/i });
      fireEvent.click(refreshBtn);

      await waitFor(() => {
        expect(mockRefreshStream).toHaveBeenCalledWith({ data: { force: true } });
        expect(screen.queryByText(/Camera Stream Reconnected/i)).not.toBeInTheDocument();
      });
    });

    it("triggers rebootCameraStream server function when Reboot Camera button is clicked", async () => {
      mockRebootStream.mockResolvedValueOnce({
        success: true,
        status: "rebooting",
        message: "ESP32 reboot command issued successfully. Stream recovery in progress...",
      });

      const staleTelemetry = {
        ...mockHealthyTelemetry,
        is_live: false,
        recovery_status: "STREAM_STALE",
        current_failure_reason: "Stream stalled",
      };

      const onRefresh = vi.fn();
      renderWithClient(
        <Esp32CameraControlCard
          nodes={mockNodes}
          activeNode={mockNodes[0]}
          isNodeAttested={true}
          isCameraLive={false}
          live={0}
          telemetry={staleTelemetry}
          onRefreshTelemetry={onRefresh}
        />,
      );

      const rebootBtn = screen.getByRole("button", { name: /Reboot Camera/i });
      fireEvent.click(rebootBtn);

      await waitFor(() => {
        expect(mockRebootStream).toHaveBeenCalled();
        expect(onRefresh).toHaveBeenCalled();
      });
    });
  });

  describe("Esp32StreamGrid Quadrant Statuses", () => {
    it("displays RECOVERY FAILED on node slot when recovery threshold is exceeded", () => {
      renderWithClient(
        <Esp32StreamGrid
          nodes={mockNodes}
          isLive={false}
          isStale={false}
          recoveryStatus="RECOVERY_FAILED"
        />,
      );

      expect(screen.getAllByText("RECOVERY FAILED").length).toBeGreaterThan(0);
      expect(screen.getByText(/ESP32-CAM-02-SOUTH/)).toBeInTheDocument();
    });

    it("displays STREAM STALE on node slot when stream is frozen", () => {
      renderWithClient(
        <Esp32StreamGrid
          nodes={mockNodes}
          isLive={true}
          isStale={true}
          recoveryStatus="STREAM_STALE"
        />,
      );

      expect(screen.getAllByText("STREAM STALE").length).toBeGreaterThan(0);
    });
  });

  describe("CameraDiagnosticsModal", () => {
    it("renders 9 structured checks and bounded history table", async () => {
      mockGetDiagnostics.mockResolvedValue({
        success: true,
        camera_id: "ESP32-CAM-01-NORTH",
        latest_diagnostic: {
          timestamp: new Date().toISOString(),
          overall_status: "HEALTHY",
          is_camera_live: true,
          is_stale: false,
          is_synthetic: false,
          real_frame_count: 1450,
          last_successful_frame_timestamp: new Date().toISOString(),
          recovery_attempt_count: 1,
          consecutive_failures: 0,
          recovery_status: "LIVE",
          current_failure_reason: null,
          recovery_backoff_sec: 0,
          checks: {
            network_reachability: { status: "PASS", detail: "ESP32 reachable on 192.168.1.18:81" },
            stream_connection: { status: "PASS", detail: "Socket connected" },
            mjpeg_decoding: { status: "PASS", detail: "Valid JPEG decoded" },
            frame_advancement: { status: "PASS", detail: "15 frames in window" },
            frame_freshness: { status: "PASS", detail: "Last frame 0.08s ago" },
            camera_reader: { status: "PASS", detail: "Threads active" },
            gateway_health: { status: "PASS", detail: "Gateway online 15 FPS" },
            node_heartbeat: { status: "PASS", detail: "Heartbeat valid" },
            video_relay: { status: "PASS", detail: "Buffer populated" },
          },
        },
        history: [
          {
            timestamp: new Date().toISOString(),
            failure_category: "STREAM_STALL",
            error_details: "Frozen frames",
            recovery_action: "RECONNECT_STREAM",
            attempt_number: 1,
            recovery_result: "SUCCESS",
            time_taken_sec: 0.35,
          },
        ],
        error: null,
      });

      const onClose = vi.fn();
      renderWithClient(<CameraDiagnosticsModal onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText(/Camera Health & Stream Diagnostics/i)).toBeInTheDocument();
        expect(screen.getByText(/ESP32 reachable on 192.168.1.18:81/i)).toBeInTheDocument();
        expect(screen.getByText(/Socket connected/i)).toBeInTheDocument();
        expect(screen.getByText(/Valid JPEG decoded/i)).toBeInTheDocument();
        expect(screen.getByText(/15 frames in window/i)).toBeInTheDocument();
        expect(screen.getByText(/Last frame 0.08s ago/i)).toBeInTheDocument();
        expect(screen.getByText(/Threads active/i)).toBeInTheDocument();
        expect(screen.getByText(/Gateway online 15 FPS/i)).toBeInTheDocument();
        expect(screen.getByText(/Heartbeat valid/i)).toBeInTheDocument();
        expect(screen.getByText(/Buffer populated/i)).toBeInTheDocument();
        expect(screen.getByText("STREAM_STALL")).toBeInTheDocument();
      });
    });
  });
});
