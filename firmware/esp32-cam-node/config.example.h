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
// Set to your Android Mobile Hotspot name (SSID) and WPA2 Password.
// IMPORTANT:
// - Android Hotspot band MUST be configured to "2.4 GHz Band" (ESP32 does not support 5 GHz).
// - Security should be WPA2-Personal (or WPA2/WPA3 Personal).
// - Do not commit real credentials. Keep them in "config.h" only.
#define WIFI_SSID         "YOUR_HOTSPOT_SSID"
#define WIFI_PASSWORD     "YOUR_HOTSPOT_PASSWORD"

// ── 2. Backend & Node Identity ───────────────────────────────────────────────
// Backend URL (no trailing slash)
// When connected to an Android Hotspot:
// - If your Mac connects to the same Android hotspot, it will get an IP on the hotspot subnet (e.g. 192.168.43.X).
// - Set BACKEND_HOST to "http://<MAC_HOTSPOT_IP>:8080" for local testing, or your cloud URL.
#define BACKEND_HOST      "http://192.168.43.100:8080"

// Must match the ESP32_DEVICE_KEY secret configured in your backend environment
#define DEVICE_KEY        "YOUR_ESP32_DEVICE_KEY"

// Unique camera node identifier across facility
#define NODE_ID           "ESP32-CAM-01-NORTH"
#define BOUNDARY_NAME     "Corridor -> Workspace Floor"
#define ZONE_A            "CORRIDOR_TRANSIT"
#define ZONE_B            "WORKSPACE_FLOOR"

// ── 3. Operational Parameters ────────────────────────────────────────────────
#define FIRMWARE_VERSION  "v1.3.0"
#define HEARTBEAT_INTERVAL_MS 15000  // 15 seconds ping interval
#define HTTP_TIMEOUT_MS       5000   // 5 seconds request timeout
#define HTTP_MAX_RETRIES      3      // Retry count with exponential backoff
#define TARGET_FPS            15.0f

// ── 4. Image, Sensor & Coverage Settings (GC2145 & OV2640) ───────────────────
// Pixel Format & Architecture:
// - Uses PIXFORMAT_RGB565 in external PSRAM for maximum sensor compatibility.
// - Supports both GalaxyCore GC2145 (PID 0x2145) and OmniVision OV2640.
// - Eliminates "JPEG format is not supported on this sensor" (0x106) driver errors on non-JPEG sensors like GC2145.
// - Hardware frames are converted to high-quality JPEG in volatile memory via frame2jpg() for port 81 MJPEG streaming.
//
// Supported Resolutions:
//   FRAMESIZE_QVGA  (320x240) - Standard baseline default (lowest bandwidth, highest frame stability)
//   FRAMESIZE_VGA   (640x480) - Recommended for corridor facial recognition coverage
#define CAMERA_DEFAULT_FRAMESIZE     FRAMESIZE_QVGA

// Indoor Lighting Optimization Defaults
#define CAMERA_DEFAULT_BRIGHTNESS    1       // -2 to 2 (1 slightly brightens indoor scene)
#define CAMERA_DEFAULT_CONTRAST      1       // -2 to 2 (1 enhances facial feature definition)
#define CAMERA_DEFAULT_SATURATION    0       // -2 to 2 (0 = natural color saturation)
#define CAMERA_DEFAULT_AEC           1       // 1 = Auto Exposure Control enabled
#define CAMERA_DEFAULT_AEC2          0       // 0 = Standard hardware AEC (avoids DSP exposure pulsing/waving)
#define CAMERA_DEFAULT_AE_LEVEL      0       // -2 to 2 (0 = balanced target exposure)
#define CAMERA_DEFAULT_AGC           1       // 1 = Auto Gain Control enabled
#define CAMERA_DEFAULT_GAINCEILING   2       // 0 to 6 (2 = GAINCEILING_8X, controls sensor noise)
#define CAMERA_DEFAULT_AWB           1       // 1 = Auto White Balance enabled
#define CAMERA_DEFAULT_WB_MODE       0       // 0 = Auto, 1 = Sunny, 2 = Cloudy, 3 = Office, 4 = Home
#define CAMERA_DEFAULT_LENC          0       // 0 = Lens Shading Correction disabled (avoids corner ripple/wavy distortion)
#define CAMERA_DEFAULT_BPC           0       // 0 = Black Pixel Correction standard
#define CAMERA_DEFAULT_WPC           1       // 1 = White Pixel Correction
#define CAMERA_DEFAULT_RAW_GMA       0       // 0 = Standard linear gamma (avoids tone curve distortion)
#define CAMERA_DEFAULT_HMIRROR       0       // 0 = Normal, 1 = Horizontal Mirror
#define CAMERA_DEFAULT_VFLIP         0       // 0 = Normal, 1 = Vertical Flip

#endif // PRESENCETRACK_CONFIG_H
