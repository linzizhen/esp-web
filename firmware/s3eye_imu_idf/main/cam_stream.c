#include "cam_stream.h"

#include <string.h>
#include "esp_camera.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "S3EYE";

/* ---------------------------------------------------------------------
 * 引脚定义 —— 取自 esp-bsp 的 bsp/esp32_s3_eye/include/bsp/esp32_s3_eye.h
 *
 * ★ PWDN / RESET 在 S3-EYE 上未连接，必须为 -1。
 *   esp32-camera 自带测试文件里写的是 PWDN=43/RESET=44，那是别的板子；
 *   在 S3-EYE 上 GPIO43/44 是 LCD 的 DC/CS，照抄会把屏幕搞坏。
 * --------------------------------------------------------------------- */
#define CAM_PIN_PWDN    (-1)
#define CAM_PIN_RESET   (-1)
#define CAM_PIN_XCLK    (15)
#define CAM_PIN_PCLK    (13)
#define CAM_PIN_VSYNC   ( 6)
#define CAM_PIN_HREF    ( 7)
/* SCCB 走 GPIO4/5，与板载 IMU 同一条总线：填 -1 表示复用已有端口 */
#define CAM_PIN_SIOD    (-1)
#define CAM_PIN_SIOC    (-1)
#define CAM_PIN_D0      (11)
#define CAM_PIN_D1      ( 9)
#define CAM_PIN_D2      ( 8)
#define CAM_PIN_D3      (10)
#define CAM_PIN_D4      (12)
#define CAM_PIN_D5      (18)
#define CAM_PIN_D6      (17)
#define CAM_PIN_D7      (16)

/* 默认参数：QVGA(320x240) + 质量 12。
 * 当前上行链路是 USB Serial/JTAG，带宽有限；QVGA 单帧 JPEG 约 8~15KB，
 * 能保证可用帧率。 */
#define CAM_DEF_FRAMESIZE  (5)     /* framesize_t: 5 = FRAMESIZE_QVGA */
#define CAM_DEF_QUALITY    (12)

static bool          s_ready     = false;
static camera_fb_t  *s_fb        = NULL;
static uint32_t      s_frames    = 0;
static uint32_t      s_fails     = 0;
static uint32_t      s_last_len  = 0;
static int           s_framesize = CAM_DEF_FRAMESIZE;
static int           s_quality   = CAM_DEF_QUALITY;

const char *cam_stream_framesize_name(int f)
{
    switch (f) {
    case 0:  return "96x96";
    case 1:  return "160x120";
    case 2:  return "128x128";
    case 3:  return "240x176";
    case 4:  return "240x240";
    case 5:  return "320x240";
    case 6:  return "400x296";
    case 7:  return "480x320";
    case 8:  return "640x480";
    case 9:  return "800x600";
    case 10: return "1024x768";
    case 11: return "1280x720";
    case 12: return "1280x1024";
    case 13: return "1600x1200";
    default: return "?";
    }
}

bool cam_stream_ready(void) { return s_ready; }
/* 返回【传感器实际生效】的分辨率，而不是我们请求的值 ——
 * 实测发现请求 QVGA(320x240) 后 OV2640 实际输出 240x240，
 * 若上报请求值就会谎报，因此以 sensor->status 为准。 */
int  cam_stream_get_framesize(void)
{
    if (s_ready) {
        sensor_t *s = esp_camera_sensor_get();
        if (s) return (int)s->status.framesize;
    }
    return s_framesize;
}
int  cam_stream_get_quality(void)   { return s_quality; }

bool cam_stream_init(int imu_i2c_port)
{
    if (s_ready) return true;

    camera_config_t c;
    memset(&c, 0, sizeof(c));
    c.pin_pwdn      = CAM_PIN_PWDN;
    c.pin_reset     = CAM_PIN_RESET;
    c.pin_xclk      = CAM_PIN_XCLK;
    c.pin_sccb_sda  = CAM_PIN_SIOD;      /* -1 → 走 SCCB_Use_Port */
    c.pin_sccb_scl  = CAM_PIN_SIOC;
    c.sccb_i2c_port = imu_i2c_port;      /* 复用 IMU 已建好的 I2C 总线 */
    c.pin_d0        = CAM_PIN_D0;
    c.pin_d1        = CAM_PIN_D1;
    c.pin_d2        = CAM_PIN_D2;
    c.pin_d3        = CAM_PIN_D3;
    c.pin_d4        = CAM_PIN_D4;
    c.pin_d5        = CAM_PIN_D5;
    c.pin_d6        = CAM_PIN_D6;
    c.pin_d7        = CAM_PIN_D7;
    c.pin_vsync     = CAM_PIN_VSYNC;
    c.pin_href      = CAM_PIN_HREF;
    c.pin_pclk      = CAM_PIN_PCLK;

    c.xclk_freq_hz = 20000000;           /* OV2640 支持到 20MHz */
    c.ledc_timer   = LEDC_TIMER_0;
    c.ledc_channel = LEDC_CHANNEL_0;

    c.pixel_format = PIXFORMAT_JPEG;     /* 直接出 JPEG，省掉软件编码 */
    c.frame_size   = (framesize_t)s_framesize;
    c.jpeg_quality = s_quality;
    c.fb_count     = 2;                  /* 双缓冲，抓帧更顺 */
    c.fb_location  = CAMERA_FB_IN_PSRAM; /* 板载 8MB Octal PSRAM */
    c.grab_mode    = CAMERA_GRAB_LATEST; /* 总取最新帧，避免越抓越旧 */

    esp_err_t err = esp_camera_init(&c);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "摄像头初始化失败: %s (0x%x)。"
                      "检查 PSRAM 是否开启、SCCB 是否与 IMU 共用总线",
                 esp_err_to_name(err), err);
        return false;
    }
    s_ready = true;
    ESP_LOGI(TAG, "摄像头初始化完成（OV2640 DVP / %s / 质量%d / 复用 I2C 端口%d / 缓冲在 PSRAM）",
             cam_stream_framesize_name(s_framesize), s_quality, imu_i2c_port);
    return true;
}

void cam_stream_deinit(void)
{
    if (!s_ready) return;
    cam_stream_release();
    esp_camera_deinit();
    s_ready = false;
    ESP_LOGI(TAG, "摄像头已关闭");
}

bool cam_stream_set_params(int framesize, int quality)
{
    if (!s_ready) return false;
    sensor_t *s = esp_camera_sensor_get();
    if (!s) return false;
    if (framesize >= 0) { s->set_framesize(s, (framesize_t)framesize); s_framesize = framesize; }
    if (quality   >= 0) { s->set_quality(s, quality);                 s_quality   = quality; }
    ESP_LOGI(TAG, "摄像头参数已更新：%s / 质量%d",
             cam_stream_framesize_name(s_framesize), s_quality);
    return true;
}

bool cam_stream_capture(uint8_t **buf, size_t *len)
{
    if (!s_ready) return false;
    cam_stream_release();                /* 上一帧没归还就先归还，防止泄漏 */
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) { s_fails++; return false; }
    s_fb = fb;
    if (buf) *buf = fb->buf;
    if (len) *len = fb->len;
    s_frames++;
    s_last_len = (uint32_t)fb->len;
    return true;
}

void cam_stream_release(void)
{
    if (s_fb) { esp_camera_fb_return(s_fb); s_fb = NULL; }
}

void cam_stream_get_stats(uint32_t *frames, uint32_t *fails, uint32_t *last_len)
{
    if (frames)   *frames   = s_frames;
    if (fails)    *fails    = s_fails;
    if (last_len) *last_len = s_last_len;
}
