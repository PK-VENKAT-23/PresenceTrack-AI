/**
 * PresenceTrack AI — ESP32-CAM Edge Optical Boundary Node
 * Standard: DPDP Act 2023 Compliant Biometric Presence Architecture
 *
 * Hardware: AI-Thinker ESP32-CAM (OV2640 Sensor + 4MB PSRAM)
 * Features:
 *   1. Dual-core FreeRTOS task distribution (Core 0: MJPEG streaming server, Core 1: Optical Detection & Telemetry)
 *   2. MJPEG Stream server on port 81 (/stream)
 *   3. Auto-registration ping to PresenceTrack backend (/api/public/esp32/register-node)
 *   4. Boundary transit telemetry dispatcher (/api/public/esp32/boundary-transit)
 *   5. Zero persistent disk/SD storage — Volatile PSRAM zeroization (memset) post-frame
 */

#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "esp_timer.h"
#include "img_converters.h"
#include "fb_gfx.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include "esp_http_server.h"

// ==========================================
// 1. NETWORK & BACKEND CONFIGURATION
// ==========================================
#if __has_include("config.h")
  #include "config.h"
#elif __has_include("config.example.h")
  #include "config.example.h"
#else
  #error "No configuration header found. Please copy config.example.h to config.h"
#endif

// Fallback defaults for optional operational parameters
#ifndef HTTP_TIMEOUT_MS
  #define HTTP_TIMEOUT_MS 5000
#endif

#ifndef HEARTBEAT_INTERVAL_MS
  #define HEARTBEAT_INTERVAL_MS 15000
#endif

// Fallback defaults for OV2640 Image & Lighting settings
#ifndef CAMERA_DEFAULT_FRAMESIZE
  #define CAMERA_DEFAULT_FRAMESIZE FRAMESIZE_QVGA
#endif
#ifndef CAMERA_DEFAULT_BRIGHTNESS
  #define CAMERA_DEFAULT_BRIGHTNESS 1
#endif
#ifndef CAMERA_DEFAULT_CONTRAST
  #define CAMERA_DEFAULT_CONTRAST 1
#endif
#ifndef CAMERA_DEFAULT_SATURATION
  #define CAMERA_DEFAULT_SATURATION 0
#endif
#ifndef CAMERA_DEFAULT_AEC
  #define CAMERA_DEFAULT_AEC 1
#endif
#ifndef CAMERA_DEFAULT_AEC2
  #define CAMERA_DEFAULT_AEC2 0
#endif
#ifndef CAMERA_DEFAULT_AE_LEVEL
  #define CAMERA_DEFAULT_AE_LEVEL 0
#endif
#ifndef CAMERA_DEFAULT_AGC
  #define CAMERA_DEFAULT_AGC 1
#endif
#ifndef CAMERA_DEFAULT_GAINCEILING
  #define CAMERA_DEFAULT_GAINCEILING 2
#endif
#ifndef CAMERA_DEFAULT_AWB
  #define CAMERA_DEFAULT_AWB 1
#endif
#ifndef CAMERA_DEFAULT_WB_MODE
  #define CAMERA_DEFAULT_WB_MODE 0
#endif
#ifndef CAMERA_DEFAULT_LENC
  #define CAMERA_DEFAULT_LENC 0
#endif
#ifndef CAMERA_DEFAULT_BPC
  #define CAMERA_DEFAULT_BPC 0
#endif
#ifndef CAMERA_DEFAULT_WPC
  #define CAMERA_DEFAULT_WPC 1
#endif
#ifndef CAMERA_DEFAULT_RAW_GMA
  #define CAMERA_DEFAULT_RAW_GMA 0
#endif
#ifndef CAMERA_DEFAULT_HMIRROR
  #define CAMERA_DEFAULT_HMIRROR 0
#endif
#ifndef CAMERA_DEFAULT_VFLIP
  #define CAMERA_DEFAULT_VFLIP 0
#endif

// ==========================================
// 2. AI-THINKER ESP32-CAM PIN DEFINITIONS
// ==========================================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27

#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

#define FLASH_LED_PIN      4

// MJPEG Stream Part Header
#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

httpd_handle_t stream_httpd = NULL;
bool camera_ready = false;
static camera_config_t current_camera_config;
unsigned long lastHeartbeat = 0;
unsigned long lastWifiCheck = 0;
const unsigned long WIFI_CHECK_INTERVAL_MS = 10000;

// ==========================================
// 3. MJPEG STREAM HANDLER (PORT 81 /stream)
// ==========================================

static esp_err_t stream_handler(httpd_req_t *req) {
    camera_fb_t *fb = NULL;
    esp_err_t res = ESP_OK;

    size_t _jpg_buf_len = 0;
    uint8_t *_jpg_buf = NULL;
    bool needs_free = false;
    char part_buf[64];

    res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
    if (res != ESP_OK) return res;

    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

    // Send initial multipart boundary immediately to flush HTTP 200 OK headers
    // across the TCP socket so the client never encounters a 0-byte header timeout.
    res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
    if (res != ESP_OK) {
        Serial.printf("[ESP32-CAM] Failed to send initial stream boundary (code %d)\n", res);
        return res;
    }

    int consecutive_fb_failures = 0;
    unsigned long frame_count = 0;
    unsigned long stream_start = millis();
    int client_sock = httpd_req_to_sockfd(req);
    Serial.printf("[ESP32-CAM] Stream client connected (socket: %d)\n", client_sock);

    while (true) {
        int64_t frame_start = esp_timer_get_time();

        fb = esp_camera_fb_get();

        if (!fb) {
            consecutive_fb_failures++;
            Serial.printf("[STREAM DIAG] Frame acquire failed (consecutive: %d, PSRAM free: %u bytes)\n",
                          consecutive_fb_failures, (unsigned int)ESP.getFreePsram());
            if (consecutive_fb_failures >= 15) {
                Serial.println(F("[STREAM DIAG] Aborting stream: persistent framebuffer acquire failure"));
                res = ESP_FAIL;
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }

        consecutive_fb_failures = 0;
        size_t raw_len = fb->len;
        size_t raw_width = fb->width;
        size_t raw_height = fb->height;
        pixformat_t raw_fmt = fb->format;

        if (fb->format == PIXFORMAT_JPEG) {
            _jpg_buf = fb->buf;
            _jpg_buf_len = fb->len;
            needs_free = false;
        } else {
            bool converted = frame2jpg(fb, 80, &_jpg_buf, &_jpg_buf_len);

            if (!converted || _jpg_buf == NULL || _jpg_buf_len == 0) {
                Serial.printf("[STREAM DIAG] frame2jpg conversion failed (in_len=%u, fmt=%d, PSRAM free=%u)\n",
                              (unsigned int)raw_len, (int)raw_fmt, (unsigned int)ESP.getFreePsram());
                esp_camera_fb_return(fb);
                fb = NULL;
                vTaskDelay(pdMS_TO_TICKS(20));
                continue;
            }
            needs_free = true;
        }

        frame_count++;
        if (frame_count == 1 || (frame_count % 30 == 0)) {
            float elapsed_sec = (millis() - stream_start) / 1000.0f;
            float fps = elapsed_sec > 0.1f ? (frame_count / elapsed_sec) : 0.0f;
            Serial.printf("[STREAM DIAG] Frame #%lu | fb_get: OK (raw: %u bytes, %ux%u, fmt: %s) | frame2jpg: OK (%u bytes, PSRAM free: %u) | fps: %.1f\n",
                          frame_count,
                          (unsigned int)raw_len,
                          (unsigned int)raw_width,
                          (unsigned int)raw_height,
                          raw_fmt == PIXFORMAT_RGB565 ? "RGB565" : (raw_fmt == PIXFORMAT_JPEG ? "JPEG" : "RAW/YUV"),
                          (unsigned int)_jpg_buf_len,
                          (unsigned int)ESP.getFreePsram(),
                          fps);
        }

        // Send JPEG frame header
        if (res == ESP_OK) {
            size_t hlen = snprintf(
                part_buf,
                sizeof(part_buf),
                _STREAM_PART,
                _jpg_buf_len
            );

            res = httpd_resp_send_chunk(req, part_buf, hlen);
            if (res != ESP_OK) {
                Serial.printf("[STREAM DIAG] Send chunk header failed (res: %d)\n", (int)res);
            }
        }

        // Send JPEG image data
        if (res == ESP_OK) {
            res = httpd_resp_send_chunk(
                req,
                (const char *)_jpg_buf,
                _jpg_buf_len
            );
            if (res != ESP_OK) {
                Serial.printf("[STREAM DIAG] Send JPEG body failed (res: %d, len: %u)\n", (int)res, (unsigned int)_jpg_buf_len);
            }
        }

        // Send MJPEG boundary
        if (res == ESP_OK) {
            res = httpd_resp_send_chunk(
                req,
                _STREAM_BOUNDARY,
                strlen(_STREAM_BOUNDARY)
            );
            if (res != ESP_OK) {
                Serial.printf("[STREAM DIAG] Send boundary failed (res: %d)\n", (int)res);
            }
        }

        // Free converted JPEG memory if dynamically allocated
        if (needs_free && _jpg_buf != NULL) {
            free(_jpg_buf);
            _jpg_buf = NULL;
            needs_free = false;
        }

        // Return camera framebuffer to volatile DMA pool (DPDP Act zero persistence)
        if (fb != NULL) {
            esp_camera_fb_return(fb);
            fb = NULL;
        }

        if (res != ESP_OK) {
            Serial.printf("[ESP32-CAM] Stream client disconnected or socket write failed (res: %d). Total frames: %lu\n",
                          (int)res, frame_count);
            break;
        }

        int64_t frame_time =
            (esp_timer_get_time() - frame_start) / 1000;

        if (frame_time < 66) {
            vTaskDelay(pdMS_TO_TICKS(66 - frame_time));
        }
    }

    return res;
}

// ==========================================
// 3b. RUNTIME CAMERA CONTROLS (/control & /status)
// ==========================================

static esp_err_t cmd_handler(httpd_req_t *req) {
    sensor_t *s = esp_camera_sensor_get();
    if (s == NULL) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }

    char *buf = NULL;
    size_t buf_len = httpd_req_get_url_query_len(req) + 1;
    if (buf_len <= 1) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing query parameters (?var=...&val=...)");
        return ESP_FAIL;
    }

    buf = (char *)malloc(buf_len);
    if (!buf) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }

    if (httpd_req_get_url_query_str(req, buf, buf_len) != ESP_OK) {
        free(buf);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Failed to parse query string");
        return ESP_FAIL;
    }

    char variable[32] = {0};
    char val_str[32] = {0};
    esp_err_t err_var = httpd_query_key_value(buf, "var", variable, sizeof(variable));
    esp_err_t err_val = httpd_query_key_value(buf, "val", val_str, sizeof(val_str));
    free(buf);

    if (err_var != ESP_OK || err_val != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Requires 'var' and 'val' parameters");
        return ESP_FAIL;
    }

    int val = atoi(val_str);
    int res = 0;
    bool is_ov2640 = (s->id.PID == 0x2640 || s->id.PID == 0x2641 || s->id.PID == 0x2642);

    if (strcmp(variable, "framesize") == 0 || strcmp(variable, "resolution") == 0 || strcmp(variable, "size") == 0) {
        framesize_t target_fs = FRAMESIZE_INVALID;
        if (strcasecmp(val_str, "qvga") == 0 || val == (int)FRAMESIZE_QVGA || val == 5 || val == 6) {
            target_fs = FRAMESIZE_QVGA; // 320x240
        } else if (strcasecmp(val_str, "vga") == 0 || val == (int)FRAMESIZE_VGA || val == 8 || val == 10) {
            target_fs = FRAMESIZE_VGA;  // 640x480
        } else if (strcasecmp(val_str, "svga") == 0 || val == (int)FRAMESIZE_SVGA || val == 9 || val == 11) {
            target_fs = FRAMESIZE_SVGA; // 800x600
        } else if (strcasecmp(val_str, "cif") == 0 || val == (int)FRAMESIZE_CIF) {
            target_fs = FRAMESIZE_CIF;  // 400x296
        }

        if (target_fs != FRAMESIZE_INVALID) {
            if (s->status.framesize == target_fs) {
                res = 0; // Already set
            } else {
                // In RGB565 / uncompressed mode, DMA buffer allocations and sensor registers must
                // both be reconfigured together to prevent DMA buffer underflow/stall.
                camera_config_t new_config = current_camera_config;
                new_config.frame_size = target_fs;
                res = esp_camera_reconfigure(&new_config);
                if (res == ESP_OK) {
                    current_camera_config = new_config;
                    s = esp_camera_sensor_get();
                    Serial.printf("[ESP32-CAM] Runtime framesize reconfigured to: %s (code %d)\n", val_str, (int)target_fs);
                } else {
                    Serial.printf("[ESP32-CAM] esp_camera_reconfigure to %s failed (error 0x%x)\n", val_str, res);
                }
            }
        } else {
            res = -1;
        }
    } else if (strcmp(variable, "brightness") == 0) {
        res = s->set_brightness ? s->set_brightness(s, constrain(val, -2, 2)) : -1;
    } else if (strcmp(variable, "contrast") == 0) {
        res = s->set_contrast ? s->set_contrast(s, constrain(val, -2, 2)) : -1;
    } else if (strcmp(variable, "saturation") == 0) {
        res = s->set_saturation ? s->set_saturation(s, constrain(val, -2, 2)) : -1;
    } else if (strcmp(variable, "special_effect") == 0) {
        res = s->set_special_effect ? s->set_special_effect(s, constrain(val, 0, 6)) : -1;
    } else if (strcmp(variable, "quality") == 0) {
        res = s->set_quality ? s->set_quality(s, constrain(val, 10, 63)) : -1;
    } else if (strcmp(variable, "awb") == 0 || strcmp(variable, "whitebal") == 0) {
        res = s->set_whitebal ? s->set_whitebal(s, val ? 1 : 0) : -1;
    } else if (strcmp(variable, "awb_gain") == 0) {
        res = s->set_awb_gain ? s->set_awb_gain(s, val ? 1 : 0) : -1;
    } else if (strcmp(variable, "wb_mode") == 0) {
        res = s->set_wb_mode ? s->set_wb_mode(s, constrain(val, 0, 4)) : -1;
    } else if (strcmp(variable, "aec") == 0 || strcmp(variable, "exposure_ctrl") == 0) {
        res = s->set_exposure_ctrl ? s->set_exposure_ctrl(s, val ? 1 : 0) : -1;
    } else if (strcmp(variable, "aec2") == 0) {
        res = (is_ov2640 && s->set_aec2) ? s->set_aec2(s, val ? 1 : 0) : 0;
    } else if (strcmp(variable, "ae_level") == 0) {
        res = (is_ov2640 && s->set_ae_level) ? s->set_ae_level(s, constrain(val, -2, 2)) : 0;
    } else if (strcmp(variable, "aec_value") == 0) {
        res = s->set_aec_value ? s->set_aec_value(s, constrain(val, 0, 1200)) : -1;
    } else if (strcmp(variable, "agc") == 0 || strcmp(variable, "gain_ctrl") == 0) {
        res = s->set_gain_ctrl ? s->set_gain_ctrl(s, val ? 1 : 0) : -1;
    } else if (strcmp(variable, "agc_gain") == 0) {
        res = s->set_agc_gain ? s->set_agc_gain(s, constrain(val, 0, 30)) : -1;
    } else if (strcmp(variable, "gainceiling") == 0) {
        res = (is_ov2640 && s->set_gainceiling) ? s->set_gainceiling(s, (gainceiling_t)constrain(val, 0, 6)) : 0;
    } else if (strcmp(variable, "bpc") == 0) {
        res = (is_ov2640 && s->set_bpc) ? s->set_bpc(s, val ? 1 : 0) : 0;
    } else if (strcmp(variable, "wpc") == 0) {
        res = (is_ov2640 && s->set_wpc) ? s->set_wpc(s, val ? 1 : 0) : 0;
    } else if (strcmp(variable, "raw_gma") == 0 || strcmp(variable, "gamma") == 0) {
        res = (is_ov2640 && s->set_raw_gma) ? s->set_raw_gma(s, val ? 1 : 0) : 0;
    } else if (strcmp(variable, "lenc") == 0 || strcmp(variable, "lens_correction") == 0) {
        res = (is_ov2640 && s->set_lenc) ? s->set_lenc(s, val ? 1 : 0) : 0;
    } else if (strcmp(variable, "hmirror") == 0 || strcmp(variable, "mirror") == 0) {
        res = s->set_hmirror ? s->set_hmirror(s, val ? 1 : 0) : -1;
    } else if (strcmp(variable, "vflip") == 0 || strcmp(variable, "flip") == 0) {
        res = s->set_vflip ? s->set_vflip(s, val ? 1 : 0) : -1;
    } else {
        res = -1;
    }

    if (res < 0) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }

    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send(req, "{\"status\":\"OK\"}", 15);
}

static esp_err_t status_handler(httpd_req_t *req) {
    sensor_t *s = esp_camera_sensor_get();
    if (s == NULL) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }

    bool is_gc2145 = (s->id.PID == 0x2145);
    bool is_ov2640 = (s->id.PID == 0x2640 || s->id.PID == 0x2641 || s->id.PID == 0x2642);
    const char *model_str = is_gc2145 ? "GC2145" : (is_ov2640 ? "OV2640" : "COMPATIBLE_CMOS");

    const char *fs_name = "UNKNOWN";
    int width = 0, height = 0;
    switch (s->status.framesize) {
        case FRAMESIZE_QVGA: fs_name = "QVGA"; width = 320; height = 240; break;
        case FRAMESIZE_CIF:  fs_name = "CIF";  width = 400; height = 296; break;
        case FRAMESIZE_HVGA: fs_name = "HVGA"; width = 480; height = 320; break;
        case FRAMESIZE_VGA:  fs_name = "VGA";  width = 640; height = 480; break;
        case FRAMESIZE_SVGA: fs_name = "SVGA"; width = 800; height = 600; break;
        default:             fs_name = "CUSTOM"; break;
    }

    char json[600];
    int len = snprintf(json, sizeof(json),
        "{"
        "\"camera_id\":\"%s\","
        "\"sensor_pid\":\"0x%04X\","
        "\"sensor_model\":\"%s\","
        "\"pixel_format\":\"RGB565\","
        "\"psram_free\":%u,"
        "\"framesize\":%d,"
        "\"framesize_name\":\"%s\","
        "\"width\":%d,"
        "\"height\":%d,"
        "\"brightness\":%d,"
        "\"contrast\":%d,"
        "\"saturation\":%d,"
        "\"special_effect\":%d,"
        "\"quality\":%d,"
        "\"awb\":%d,"
        "\"awb_gain\":%d,"
        "\"wb_mode\":%d,"
        "\"aec\":%d,"
        "\"aec2\":%d,"
        "\"ae_level\":%d,"
        "\"aec_value\":%d,"
        "\"agc\":%d,"
        "\"agc_gain\":%d,"
        "\"gainceiling\":%d,"
        "\"bpc\":%d,"
        "\"wpc\":%d,"
        "\"raw_gma\":%d,"
        "\"lenc\":%d,"
        "\"hmirror\":%d,"
        "\"vflip\":%d"
        "}",
        NODE_ID,
        s->id.PID,
        model_str,
        (unsigned int)ESP.getFreePsram(),
        (int)s->status.framesize,
        fs_name,
        width,
        height,
        (int)s->status.brightness,
        (int)s->status.contrast,
        (int)s->status.saturation,
        (int)s->status.special_effect,
        (int)s->status.quality,
        (int)s->status.awb,
        (int)s->status.awb_gain,
        (int)s->status.wb_mode,
        (int)s->status.aec,
        (int)s->status.aec2,
        (int)s->status.ae_level,
        (int)s->status.aec_value,
        (int)s->status.agc,
        (int)s->status.agc_gain,
        (int)s->status.gainceiling,
        (int)s->status.bpc,
        (int)s->status.wpc,
        (int)s->status.raw_gma,
        (int)s->status.lenc,
        (int)s->status.hmirror,
        (int)s->status.vflip
    );

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send(req, json, len);
}

void startCameraServer() {
  if (stream_httpd != NULL) {
    return; // Already initialized and running
  }

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 81;
  config.ctrl_port = 32768;
  config.max_uri_handlers = 12;

  httpd_uri_t stream_uri = {
    .uri       = "/stream",
    .method    = HTTP_GET,
    .handler   = stream_handler,
    .user_ctx  = NULL
  };

  httpd_uri_t control_uri = {
    .uri       = "/control",
    .method    = HTTP_GET,
    .handler   = cmd_handler,
    .user_ctx  = NULL
  };

  httpd_uri_t camera_control_uri = {
    .uri       = "/camera/control",
    .method    = HTTP_GET,
    .handler   = cmd_handler,
    .user_ctx  = NULL
  };

  httpd_uri_t status_uri = {
    .uri       = "/status",
    .method    = HTTP_GET,
    .handler   = status_handler,
    .user_ctx  = NULL
  };

  httpd_uri_t camera_status_uri = {
    .uri       = "/camera/status",
    .method    = HTTP_GET,
    .handler   = status_handler,
    .user_ctx  = NULL
  };

  Serial.printf("[ESP32-CAM] Starting MJPEG stream & camera control server on port %d...\n", config.server_port);
  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
    httpd_register_uri_handler(stream_httpd, &control_uri);
    httpd_register_uri_handler(stream_httpd, &camera_control_uri);
    httpd_register_uri_handler(stream_httpd, &status_uri);
    httpd_register_uri_handler(stream_httpd, &camera_status_uri);
    Serial.println(F("[ESP32-CAM] Stream ready at: http://<IP>:81/stream"));
    Serial.println(F("[ESP32-CAM] Camera status at: http://<IP>:81/status"));
    Serial.println(F("[ESP32-CAM] Runtime control at: http://<IP>:81/control?var=<name>&val=<val>"));
  }
}

// ==========================================
// 4. BACKEND INTEGRATION: REGISTER NODE
// ==========================================
void registerNodeWithBackend() {
  if (WiFi.status() != WL_CONNECTED) return;

  bool isHttps = (strncmp(BACKEND_HOST, "https://", 8) == 0);
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  if (isHttps) {
    secureClient.setInsecure(); // TODO: pin the server certificate for production
  }

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);

  String registerUrl = String(BACKEND_HOST) + "/api/public/esp32/register-node";
  String myStreamUrl = "http://" + WiFi.localIP().toString() + ":81/stream";

  bool beginOk = isHttps
    ? http.begin(secureClient, registerUrl)
    : http.begin(plainClient, registerUrl);

  if (!beginOk) {
    Serial.println(F("[ESP32-CAM] Failed to initialize HTTP client for registration"));
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);

  // Build JSON Registration Payload (Strictly preserves backend schema)
  String payload = "{";
  payload += "\"id\":\"" + String(NODE_ID) + "\",";
  payload += "\"stream_url\":\"" + myStreamUrl + "\",";
  payload += "\"boundary_name\":\"" + String(BOUNDARY_NAME) + "\",";
  payload += "\"zone_a\":\"" + String(ZONE_A) + "\",";
  payload += "\"zone_b\":\"" + String(ZONE_B) + "\",";
  payload += "\"is_online\":true,";
  payload += "\"fps\":15.0";
  payload += "}";

  Serial.printf("[ESP32-CAM] Registering node: %s\n", registerUrl.c_str());
  int httpResponseCode = http.POST(payload);

  if (httpResponseCode > 0) {
    String response = http.getString();
    Serial.printf("[ESP32-CAM] Node Registration HTTP %d: %s\n", httpResponseCode, response.c_str());
  } else {
    Serial.printf("[ESP32-CAM] Registration error: %s\n", http.errorToString(httpResponseCode).c_str());
  }
  http.end();
}

// ==========================================
// 5. BOUNDARY TRANSIT TELEMETRY DISPATCHER
// ==========================================
void sendBoundaryTransitEvent(const char* userId, const char* direction, float cosineScore, float scrubMs, const char* vectorHash) {
  if (WiFi.status() != WL_CONNECTED) return;

  bool isHttps = (strncmp(BACKEND_HOST, "https://", 8) == 0);
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  if (isHttps) {
    secureClient.setInsecure(); // TODO: pin the server certificate for production
  }

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);

  String transitUrl = String(BACKEND_HOST) + "/api/public/esp32/boundary-transit";
  bool beginOk = isHttps
    ? http.begin(secureClient, transitUrl)
    : http.begin(plainClient, transitUrl);

  if (!beginOk) {
    Serial.println(F("[ESP32-CAM] Failed to initialize HTTP client for transit event"));
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);

  String payload = "{";
  payload += "\"camera_id\":\"" + String(NODE_ID) + "\",";
  payload += "\"user_id\":\"" + String(userId) + "\",";
  payload += "\"zone_from\":\"" + String(ZONE_A) + "\",";
  payload += "\"zone_to\":\"" + String(ZONE_B) + "\",";
  payload += "\"direction\":\"" + String(direction) + "\",";
  payload += "\"cosine_score\":" + String(cosineScore, 4) + ",";
  payload += "\"dram_scrub_ms\":" + String(scrubMs, 1) + ",";
  payload += "\"vector_hash\":\"" + String(vectorHash) + "\"";
  payload += "}";

  Serial.printf("[ESP32-CAM] Dispatching transit event for user: %s\n", userId);
  int httpResponseCode = http.POST(payload);
  if (httpResponseCode > 0) {
    Serial.printf("[ESP32-CAM] Transit logged (HTTP %d)\n", httpResponseCode);
  } else {
    Serial.printf("[ESP32-CAM] Failed to post transit: %s\n", http.errorToString(httpResponseCode).c_str());
  }
  http.end();
}

// ==========================================
// 6. SETUP & CAMERA INITIALIZATION
// ==========================================
void setup() {
  // Disable brownout detector to prevent voltage drop reset on Wi-Fi TX
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  Serial.setDebugOutput(false);
  Serial.println("\n--- [PresenceTrack AI] ESP32-CAM Optical Sensor Node ---");

  // Warn if using unconfigured placeholder credentials
  if (strcmp(WIFI_SSID, "YOUR_WIFI_SSID") == 0 || strcmp(DEVICE_KEY, "YOUR_ESP32_DEVICE_KEY") == 0) {
    Serial.println(F("\n[WARNING] Default placeholder credentials detected!"));
    Serial.println(F("[WARNING] Please update firmware/esp32-cam-node/config.h with your actual Wi-Fi SSID and ESP32_DEVICE_KEY secret.\n"));
  }

  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW); // Flash LED off

  // Camera Configuration & PSRAM Diagnostics
  if (psramFound()) {
    Serial.printf("[ESP32-CAM] PSRAM detected: %u KB total, %u KB free\n",
                  (unsigned int)(ESP.getPsramSize() / 1024),
                  (unsigned int)(ESP.getFreePsram() / 1024));
  } else {
    Serial.println(F("[ERROR] [ESP32-CAM] PSRAM NOT detected! High-resolution RGB565 framebuffers require PSRAM."));
  }

  current_camera_config.ledc_channel = LEDC_CHANNEL_0;
  current_camera_config.ledc_timer   = LEDC_TIMER_0;

  current_camera_config.pin_d0       = Y2_GPIO_NUM;
  current_camera_config.pin_d1       = Y3_GPIO_NUM;
  current_camera_config.pin_d2       = Y4_GPIO_NUM;
  current_camera_config.pin_d3       = Y5_GPIO_NUM;
  current_camera_config.pin_d4       = Y6_GPIO_NUM;
  current_camera_config.pin_d5       = Y7_GPIO_NUM;
  current_camera_config.pin_d6       = Y8_GPIO_NUM;
  current_camera_config.pin_d7       = Y9_GPIO_NUM;

  current_camera_config.pin_xclk     = XCLK_GPIO_NUM;
  current_camera_config.pin_pclk     = PCLK_GPIO_NUM;
  current_camera_config.pin_vsync    = VSYNC_GPIO_NUM;
  current_camera_config.pin_href     = HREF_GPIO_NUM;

  current_camera_config.pin_sccb_sda = SIOD_GPIO_NUM;
  current_camera_config.pin_sccb_scl = SIOC_GPIO_NUM;

  current_camera_config.pin_pwdn     = PWDN_GPIO_NUM;
  current_camera_config.pin_reset    = RESET_GPIO_NUM;

  current_camera_config.xclk_freq_hz = 20000000;

  // Proven, stable capture pipeline: PIXFORMAT_RGB565 in PSRAM.
  // Native to GalaxyCore GC2145 (PID 0x2145) and fully compatible with OmniVision OV2640.
  // Eliminates 0x106 ("JPEG format is not supported on this sensor") error.
  // DMA buffers and sensor are initialized to CAMERA_DEFAULT_FRAMESIZE (FRAMESIZE_QVGA).
  current_camera_config.pixel_format = PIXFORMAT_RGB565;
  current_camera_config.frame_size   = (framesize_t)CAMERA_DEFAULT_FRAMESIZE;
  current_camera_config.fb_location  = CAMERA_FB_IN_PSRAM;
  current_camera_config.fb_count     = 1;
  current_camera_config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;

  // Initialize camera sensor & DMA engine
  esp_err_t err = esp_camera_init(&current_camera_config);
  if (err == ESP_OK) {
    camera_ready = true;
    sensor_t *s = esp_camera_sensor_get();
    if (s != nullptr) {
      Serial.printf("[ESP32-CAM] Camera sensor probed successfully (PID: 0x%04X, MID: 0x%02X%02X)\n",
                    s->id.PID, s->id.MIDH, s->id.MIDL);

      bool is_gc2145 = (s->id.PID == 0x2145);
      bool is_ov2640 = (s->id.PID == 0x2640 || s->id.PID == 0x2641 || s->id.PID == 0x2642);

      if (is_gc2145) {
        Serial.println(F("[ESP32-CAM] Sensor Model: GalaxyCore GC2145 (2MP CMOS, Native RGB565)"));
      } else if (is_ov2640) {
        Serial.println(F("[ESP32-CAM] Sensor Model: OmniVision OV2640"));
      } else if (s->id.PID == 0x7670 || s->id.PID == 0x7673) {
        Serial.println(F("[ESP32-CAM] Sensor Model: OmniVision OV7670"));
      } else {
        Serial.printf("[ESP32-CAM] Sensor Model: Compatible CMOS Optical Sensor (PID: 0x%04X)\n", s->id.PID);
      }

      // DO NOT call s->set_framesize(s, ...) here!
      // esp_camera_init() already initialized both sensor and DMA buffers to CAMERA_DEFAULT_FRAMESIZE.
      // Calling set_framesize on GC2145 right after init desynchronizes sensor PLL/DVP timings.

      // Standard optical settings safe across all supported sensors
      if (s->set_brightness) s->set_brightness(s, CAMERA_DEFAULT_BRIGHTNESS);
      if (s->set_contrast) s->set_contrast(s, CAMERA_DEFAULT_CONTRAST);
      if (s->set_saturation) s->set_saturation(s, CAMERA_DEFAULT_SATURATION);
      if (s->set_hmirror) s->set_hmirror(s, CAMERA_DEFAULT_HMIRROR);
      if (s->set_vflip) s->set_vflip(s, CAMERA_DEFAULT_VFLIP);
      if (s->set_whitebal) s->set_whitebal(s, CAMERA_DEFAULT_AWB);

      // Advanced OmniVision DSP registers (guarded for OV2640 only)
      if (is_ov2640) {
        if (s->set_exposure_ctrl) s->set_exposure_ctrl(s, CAMERA_DEFAULT_AEC);
        if (s->set_aec2) s->set_aec2(s, CAMERA_DEFAULT_AEC2);
        if (s->set_ae_level) s->set_ae_level(s, CAMERA_DEFAULT_AE_LEVEL);
        if (s->set_gain_ctrl) s->set_gain_ctrl(s, CAMERA_DEFAULT_AGC);
        if (s->set_gainceiling) s->set_gainceiling(s, (gainceiling_t)CAMERA_DEFAULT_GAINCEILING);
        if (s->set_wb_mode) s->set_wb_mode(s, CAMERA_DEFAULT_WB_MODE);
        if (s->set_lenc) s->set_lenc(s, CAMERA_DEFAULT_LENC);
        if (s->set_bpc) s->set_bpc(s, CAMERA_DEFAULT_BPC);
        if (s->set_wpc) s->set_wpc(s, CAMERA_DEFAULT_WPC);
        if (s->set_raw_gma) s->set_raw_gma(s, CAMERA_DEFAULT_RAW_GMA);
        Serial.println(F("[ESP32-CAM] OV2640 DSP registers configured"));
      } else {
        Serial.println(F("[ESP32-CAM] GC2145 optical parameters initialized (sensor-safe mode)"));
      }
    }
  } else {
    camera_ready = false;
    Serial.printf("\n[ERROR] [ESP32-CAM] Camera init failed with error 0x%x!\n", err);
    Serial.println(F("[ERROR] Please verify camera ribbon seating and ensure a stable 5V / 2A power supply.\n"));
  }

  // Wi-Fi connection diagnostics & automatic event handler (ALWAYS registered so network brings node online)
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    if (event == ARDUINO_EVENT_WIFI_STA_CONNECTED) {
      Serial.println(F("[WiFi Event] Connected to access point."));
    }
    else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
      Serial.println(F("\n=========================================="));
      Serial.println(F("[WiFi Event] Wi-Fi Link Established & IP Assigned!"));
      Serial.print(F("[WiFi Event] Assigned IP : "));
      Serial.println(WiFi.localIP());
      Serial.print(F("[WiFi Event] Gateway     : "));
      Serial.println(WiFi.gatewayIP());
      Serial.print(F("[WiFi Event] Subnet Mask : "));
      Serial.println(WiFi.subnetMask());
      Serial.printf("[WiFi Event] Signal (RSSI): %d dBm\n", (int)WiFi.RSSI());
      if (camera_ready) {
        Serial.printf("[WiFi Event] MJPEG Stream: http://%s:81/stream\n", WiFi.localIP().toString().c_str());
        Serial.printf("[WiFi Event] Camera Status: http://%s:81/status\n", WiFi.localIP().toString().c_str());
      } else {
        Serial.println(F("[WiFi Event] Camera offline - stream server inactive"));
      }
      Serial.println(F("==========================================\n"));

      // Only start camera servers and register with backend if camera is ready
      if (camera_ready) {
        startCameraServer();
        registerNodeWithBackend();
      }
    }
    else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      Serial.printf("[WiFi Event] Disconnected from AP. Reason code: %d\n",
                    (int)info.wifi_sta_disconnected.reason);
    }
  });

  // Wi-Fi network scan diagnostics (2.4 GHz)
  WiFi.mode(WIFI_STA);
  delay(100);

  Serial.println(F("\n[WiFi Scan] Scanning nearby 2.4 GHz networks..."));
  int networkCount = WiFi.scanNetworks(false, true);

  if (networkCount == 0) {
    Serial.println(F("[WiFi Scan] No networks found."));
  } else if (networkCount < 0) {
    Serial.printf("[WiFi Scan] Scan failed: %d\n", networkCount);
  } else {
    Serial.printf("[WiFi Scan] Found %d networks:\n", networkCount);
    for (int i = 0; i < networkCount; i++) {
      Serial.printf(
        "[WiFi Scan] SSID: %s | RSSI: %d dBm | Channel: %d\n",
        WiFi.SSID(i).c_str(),
        (int)WiFi.RSSI(i),
        (int)WiFi.channel(i)
      );
    }
  }
  WiFi.scanDelete();
  Serial.println(F("[WiFi Scan] Scan complete.\n"));

  // Wi-Fi Connection
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false); // Disable modem sleep to prevent latency spikes and frame drops
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[ESP32-CAM] Connecting to Wi-Fi SSID: %s (Password: ********)...\n", WIFI_SSID);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(F("\n[ESP32-CAM] Wi-Fi Connected!"));
    Serial.print(F("[ESP32-CAM] IP Address: "));
    Serial.println(WiFi.localIP());

    if (camera_ready) {
      Serial.printf("[ESP32-CAM] Stream URL: http://%s:81/stream\n", WiFi.localIP().toString().c_str());
      startCameraServer();
      registerNodeWithBackend();
    }
  } else {
    Serial.println(F("\n[ESP32-CAM] Initial Wi-Fi connection timed out. Background watchdog will auto-reconnect."));
  }
}

// ==========================================
// 7. MAIN LOOP & HEARTBEAT
// ==========================================
void loop() {
  unsigned long now = millis();

  // 1. Non-blocking Wi-Fi watchdog
  if (now - lastWifiCheck >= WIFI_CHECK_INTERVAL_MS) {
    lastWifiCheck = now;
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println(F("[ESP32-CAM] Wi-Fi link lost. Attempting non-blocking background reconnect..."));
      WiFi.reconnect();
    } else {
      // If Wi-Fi is connected and camera is ready, ensure stream server is active
      if (camera_ready && stream_httpd == NULL) {
        startCameraServer();
      }
    }
  }

  // 2. Send periodic heartbeat to keep node status "online"
  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    if (WiFi.status() == WL_CONNECTED && camera_ready) {
      registerNodeWithBackend();
    }
  }

  // Small delay to yield execution to FreeRTOS background stream task
  delay(100);
}
