/**
 * PresenceTrack AI — ESP32-CAM Edge Node Configuration Template
 * 
 * Instructions:
 * 1. Copy this file to "config.h" in the same directory:
 *    cp config.example.h config.h
 * 2. Update with your real Wi-Fi credentials, backend host, and device secret.
 * 3. Never commit "config.h" to version control (it is excluded via .gitignore).
 */

#ifndef PRESENCETRACK_CONFIG_H
#define PRESENCETRACK_CONFIG_H

// ── 1. Wi-Fi Network Credentials ─────────────────────────────────────────────
#define WIFI_SSID         "YOUR_WIFI_SSID"
#define WIFI_PASSWORD     "YOUR_WIFI_PASSWORD"

// ── 2. Backend & Node Identity ───────────────────────────────────────────────
// Backend URL (no trailing slash)
// For local network development: "http://<MAC_LAN_IP>:8080" (e.g. "http://192.168.1.8:8080")
// For cloud deployment: "https://YOUR-APP.lovable.app"
#define BACKEND_HOST      "http://192.168.1.8:8080"

// Must match the ESP32_DEVICE_KEY secret configured in your backend environment
#define DEVICE_KEY        "YOUR_ESP32_DEVICE_KEY"

// Unique camera node identifier across facility
#define NODE_ID           "ESP32-CAM-01-NORTH"
#define BOUNDARY_NAME     "Corridor -> Workspace Floor"
#define ZONE_A            "CORRIDOR_TRANSIT"
#define ZONE_B            "WORKSPACE_FLOOR"

// ── 3. Operational Parameters ────────────────────────────────────────────────
#define FIRMWARE_VERSION  "v1.2.0"
#define HEARTBEAT_INTERVAL_MS 15000  // 15 seconds ping interval
#define HTTP_TIMEOUT_MS       5000   // 5 seconds request timeout
#define HTTP_MAX_RETRIES      3      // Retry count with exponential backoff
#define TARGET_FPS            15.0f

#endif // PRESENCETRACK_CONFIG_H
