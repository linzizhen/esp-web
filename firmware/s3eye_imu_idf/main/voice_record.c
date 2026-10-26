/* =====================================================================
 * 第 5 周：按键说话 —— 板载 MEMS 麦克风 I2S 录音 → 标准 WAV → 上传服务端
 *
 * 音频来源：ESP32-S3-EYE 板载数字 MEMS 麦克风（I2S，16bit/16kHz/单声道）。
 * 运行位置：录音在【板端】；识别（Web Speech API）与播报（speechSynthesis）
 *           在【电脑浏览器】—— 本板 BSP 明确 BSP_CAPS_AUDIO_SPEAKER = 0，
 *           没有扬声器/蜂鸣器，所以播报绝不可能在板端完成。
 *
 * 硬件依据（官方 esp-bsp，非猜测；行号对应当前 master）：
 *   bsp/esp32_s3_eye/include/bsp/esp32_s3_eye.h
 *     L82 BSP_I2S_MCLK  = GPIO_NUM_NC   本板麦克风不需要 MCLK
 *     L83 BSP_I2S_SCLK  = GPIO_NUM_41   BCLK
 *     L84 BSP_I2S_LCLK  = GPIO_NUM_42   WS / LRCK
 *     L85 BSP_I2S_DOUT  = GPIO_NUM_NC   没有扬声器 → 无数据输出
 *     L86 BSP_I2S_DSIN  = GPIO_NUM_2    麦克风数据（只读）
 *     L57 BSP_CAPS_AUDIO_SPEAKER = 0    ★ 无扬声器
 *     L58 BSP_CAPS_AUDIO_MIC     = 1    ★ 有麦克风
 *   bsp/esp32_s3_eye/src/bsp_audio.c
 *     L49 I2S_CHANNEL_DEFAULT_CONFIG(CONFIG_BSP_I2S_NUM, I2S_ROLE_MASTER)
 *     L51 i2s_new_channel(&chan_cfg, NULL, &i2s_rx_chan)     ← 只有 RX 通道
 *     L34 I2S_STD_PHILIP_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)
 *     L101 .dev_type = ESP_CODEC_DEV_TYPE_IN; .codec_if = NULL
 *          ★ codec_if = NULL → 板上没有 ES7210/ES8311 这类 I2C 受控 codec，
 *            麦克风直连 I2S，走标准 Philips 格式，不是 PDM。
 *
 * 按键依据：
 *   bsp/esp32_s3_eye/src/bsp_button.c L79-L82
 *     BSP_BUTTON_5：GPIO 直连，gpio_num = BSP_BUTTON_5_IO，active_level = 0
 *   bsp/esp32_s3_eye/include/bsp/esp32_s3_eye.h L124
 *     BSP_BUTTON_5_IO = GPIO_NUM_0   ← 板上 BOOT 功能键，按下为低
 *   ★ 不复用 ADC 分压的 4 个键：它们在第 3 周用于「求助 / 取消」，
 *     复用会打乱已有求助闭环，违反「不改已有上报/求助/摄像头逻辑」约束。
 *   ★ 注意 BOOT 键上电按住会进下载模式（芯片 strapping），所以只在上电
 *     运行后轮询；录音指示一律以 LED 为准（串口日志不在用户视野里）。
 *
 * 上传协议（与 server-voice 对齐）：
 *   POST http://<host>:<port>/api/voice/audio
 *     device: <APP_DEVICE_ID>        （服务端也接受 x-device-id / ?device=）
 *     duration_ms: <整数>            （按 PCM 字节数换算，比墙钟更准）
 *     Content-Type: audio/wav
 *     body: 44 字节 RIFF 头 + PCM（标准 WAV，不是裸 PCM）
 *   服务端校验前 4 字节 RIFF / 8-11 字节 WAVE，上限 1 MB。
 *   本模块 10 秒上限 = 320,000 字节 PCM + 44 字节头，远低于上限。
 *
 * ★ 数据布局（2026-10-26 真机实测纠正，别再踩这个坑）：
 *   I2S 配成 I2S_SLOT_MODE_MONO 时，【RX 侧仍按 2 slot 一帧送数据】——
 *   每帧 = 2 个 int16，只有活动 slot 是麦克风真实采样，另一个被
 *   chan_cfg.auto_clear = true 填成 0。实测 3 秒录音拿到 49,152 帧
 *   （16 kHz × 3.072 s），其中奇数下标采样全部为 0、偶数下标才是声音。
 *   若直接把这批交错数据当单声道写进 WAV：
 *     · WAV 头写 16 kHz/单声道，实际 32 kHz/双 slot → 时长翻倍、
 *       播放速度慢一半（3 秒录成 6144 ms、6 秒录成 10000 ms）；
 *     · 采集缓冲按单声道 320,000 字节算 → 10 秒上限实际只能录 5 秒。
 *   因此必须：① 原始缓冲按 2 倍开（640,000 字节）；② 采集后去交错，
 *   只保留活动 slot；③ WAV 头按去交错后的长度写。
 * ===================================================================== */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"

#include "esp_log.h"
#include "esp_err.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"

#include "driver/gpio.h"
#include "driver/i2s_std.h"

#include "app_config.h"
#include "voice_record.h"

static const char *TAG = "VOICE";

/* ---- 引脚（全部有 BSP 出处，见文件头）---- */
#define VOICE_I2S_BCLK_GPIO   GPIO_NUM_41
#define VOICE_I2S_WS_GPIO     GPIO_NUM_42
#define VOICE_I2S_DIN_GPIO    GPIO_NUM_2
#define VOICE_BTN_GPIO        GPIO_NUM_0

/* ---- 采集参数：ASR 通用格式 ---- */
#define VOICE_SAMPLE_RATE     16000
#define VOICE_BITS            16
#define VOICE_CHANNELS        1
#define VOICE_BYTES_PER_MS    (VOICE_SAMPLE_RATE * (VOICE_BITS / 8) * VOICE_CHANNELS / 1000)  /* = 32 */

/* ★ I2S RX 单声道仍按 2 slot 交错送数（见文件头「数据布局」），
 *   所以原始缓冲要按 2 倍开，采集后再去交错成真正的单声道 PCM。 */
#define VOICE_I2S_SLOTS       2
#define VOICE_RAW_BYTES_PER_MS (VOICE_BYTES_PER_MS * VOICE_I2S_SLOTS)   /* = 64 */

/* ---- 录音上限 10 秒 ---- */
#define VOICE_MAX_RECORD_MS   10000
#define VOICE_MAX_PCM_BYTES   (VOICE_MAX_RECORD_MS * VOICE_BYTES_PER_MS)          /* 320000 去交错后 */
#define VOICE_MAX_RAW_BYTES   (VOICE_MAX_RECORD_MS * VOICE_RAW_BYTES_PER_MS)      /* 640000 原始交错 */

#define VOICE_READ_CHUNK      4096     /* 一次读 128ms 数据，兼顾 DMA 与按键响应 */
#define VOICE_READ_TIMEOUT_MS 200      /* 单次读超时：DMA 无数据 */
#define VOICE_TIMEOUT_LIMIT   5        /* 连续 5 次超时（约 1 秒且无任何数据）= 采集超时 */
#define VOICE_MIN_PCM_BYTES   3200     /* 100ms 以下视为没录到，报失败 */

#define VOICE_HTTP_TIMEOUT_MS 15000

/* ---- LED 显示时长 ---- */
#define VOICE_LED_OK_MS       1500
#define VOICE_LED_ERR_MS      2500

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */
static i2s_chan_handle_t s_rx = NULL;
static bool              s_i2s_ok = false;

static uint8_t          *s_wav = NULL;      /* PSRAM：44 字节头 + 320000 字节 PCM */
static uint8_t          *s_pcm = NULL;
static uint8_t          *s_raw = NULL;      /* PSRAM：640000 字节 I2S 原始交错数据 */

static QueueHandle_t     s_q = NULL;

static volatile bool     s_recording = false;   /* 正在采集 */
static volatile bool     s_stop_req  = false;   /* 请求结束采集 */
static volatile bool     s_uploading = false;   /* 正在上传（此时忽略按键） */
static volatile bool     s_btn_down  = false;

static volatile voice_led_t s_led = VOICE_LED_NONE;
static volatile int64_t     s_led_until_us = 0;

typedef enum { VC_START = 1 } vc_msg_t;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */
static void led_set(voice_led_t v, int keep_ms)
{
    s_led = v;
    s_led_until_us = keep_ms > 0 ? esp_timer_get_time() + (int64_t)keep_ms * 1000 : 0;
}

voice_led_t voice_record_led(void)
{
    voice_led_t v = s_led;
    if ((v == VOICE_LED_OK || v == VOICE_LED_ERROR) &&
        s_led_until_us > 0 && esp_timer_get_time() > s_led_until_us) {
        s_led = VOICE_LED_NONE;
        s_led_until_us = 0;
        return VOICE_LED_NONE;
    }
    return v;
}

bool voice_record_is_recording(void) { return s_recording; }

static void put_u16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v & 0xFF); p[1] = (uint8_t)(v >> 8); }
static void put_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xFF); p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF); p[3] = (uint8_t)((v >> 24) & 0xFF);
}

/* 标准 44 字节 WAV 头（RIFF/WAVE/fmt 16/PCM/data） */
static void wav_build_header(uint8_t *h, uint32_t pcm_bytes)
{
    const uint16_t block_align = (uint16_t)(VOICE_CHANNELS * (VOICE_BITS / 8));
    const uint32_t byte_rate   = (uint32_t)VOICE_SAMPLE_RATE * block_align;

    memcpy(h + 0, "RIFF", 4);
    put_u32(h + 4, 36u + pcm_bytes);          /* RIFF chunk size = 文件长度 - 8 */
    memcpy(h + 8, "WAVE", 4);
    memcpy(h + 12, "fmt ", 4);
    put_u32(h + 16, 16);                      /* PCM 的 fmt 块固定 16 字节 */
    put_u16(h + 20, 1);                       /* AudioFormat = 1 (PCM) */
    put_u16(h + 22, VOICE_CHANNELS);
    put_u32(h + 24, VOICE_SAMPLE_RATE);
    put_u32(h + 28, byte_rate);
    put_u16(h + 32, block_align);
    put_u16(h + 34, VOICE_BITS);
    memcpy(h + 36, "data", 4);
    put_u32(h + 40, pcm_bytes);
}

/* 从响应里抠出 "audio_id":"xxx"（找不到就留空，不影响链路） */
static void json_pick(const char *json, const char *key, char *out, size_t cap)
{
    out[0] = '\0';
    if (!json || !key) return;
    char pat[32];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p) return;
    p = strchr(p + strlen(pat), ':');
    if (!p) return;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '"') return;
    p++;
    size_t i = 0;
    while (*p && *p != '"' && i + 1 < cap) out[i++] = *p++;
    out[i] = '\0';
}

/* ------------------------------------------------------------------ */
/* I2S 初始化（懒加载：第一次录音前才建通道）                           */
/* ------------------------------------------------------------------ */
static bool voice_i2s_init(void)
{
    if (s_i2s_ok) return true;

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true;
    esp_err_t err = i2s_new_channel(&chan_cfg, NULL, &s_rx);
    if (err != ESP_OK || s_rx == NULL) {
        ESP_LOGE(TAG, "I2S 未初始化：i2s_new_channel 失败（%s）", esp_err_to_name(err));
        s_rx = NULL;
        return false;
    }

    /* 与 esp-bsp bsp_audio.c L34 完全一致：Philips 格式 + 16bit + 单声道 */
    i2s_std_config_t std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(VOICE_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIP_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,           /* BSP_I2S_MCLK = NC */
            .bclk = VOICE_I2S_BCLK_GPIO,       /* BSP_I2S_SCLK = GPIO41 */
            .ws   = VOICE_I2S_WS_GPIO,         /* BSP_I2S_LCLK = GPIO42 */
            .dout = I2S_GPIO_UNUSED,           /* BSP_I2S_DOUT = NC（无扬声器）*/
            .din  = VOICE_I2S_DIN_GPIO,        /* BSP_I2S_DSIN = GPIO2 */
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    err = i2s_channel_init_std_mode(s_rx, &std_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "I2S 未初始化：i2s_channel_init_std_mode 失败（%s）", esp_err_to_name(err));
        i2s_del_channel(s_rx);
        s_rx = NULL;
        return false;
    }
    err = i2s_channel_enable(s_rx);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "I2S 未初始化：i2s_channel_enable 失败（%s）", esp_err_to_name(err));
        i2s_del_channel(s_rx);
        s_rx = NULL;
        return false;
    }

    s_i2s_ok = true;
    ESP_LOGI(TAG, "I2S 就绪：主机模式 %dHz/%dbit/%dch，BCLK=GPIO%d WS=GPIO%d DIN=GPIO%d（"
                  "依据 esp-bsp esp32_s3_eye.h L83/L84/L86）",
             VOICE_SAMPLE_RATE, VOICE_BITS, VOICE_CHANNELS,
             (int)VOICE_I2S_BCLK_GPIO, (int)VOICE_I2S_WS_GPIO, (int)VOICE_I2S_DIN_GPIO);
    return true;
}

/* ------------------------------------------------------------------ */
/* 去交错：I2S 单声道 RX 仍按 2 slot 一帧送数（见文件头「数据布局」），  */
/* 只保留活动 slot 的采样，原地搬回 dst。返回去交错后的字节数。          */
/* ------------------------------------------------------------------ */
static size_t voice_deinterleave(const int16_t *src, size_t raw_bytes, int16_t *dst)
{
    const size_t frames = raw_bytes / (2 * VOICE_I2S_SLOTS);   /* 每帧 2 个 int16 */
    /* 活动 slot：I2S_STD_SLOT_LEFT → 帧内第 0 个。这里用实测结论（偶数下标有声音），
     * 同时做一次自检：若偶数下标全 0 而奇数下标有值，说明活动 slot 在右，改用奇数。 */
    size_t lead_even = 0, lead_odd = 0;
    const size_t probe = frames < 2048 ? frames : 2048;
    for (size_t i = 0; i < probe; i++) {
        if (src[i * 2]     != 0) lead_even++;
        if (src[i * 2 + 1] != 0) lead_odd++;
    }
    const size_t slot = (lead_even >= lead_odd) ? 0 : 1;
    if (lead_even == 0 && lead_odd > 0) {
        ESP_LOGW(TAG, "I2S 活动 slot 在右（第 1 个），按奇数下标取数（已自动适配）");
    }

    for (size_t i = 0; i < frames; i++) dst[i] = src[i * 2 + slot];
    return frames * 2;
}

/* ------------------------------------------------------------------ */
/* 采集一段：返回实际 PCM 字节数；失败返回 0 并已写日志/设 LED        */
/* ------------------------------------------------------------------ */
static size_t voice_capture(int *out_peak, int *out_elapsed_ms)
{
    s_stop_req = false;
    s_recording = true;
    s_uploading = false;
    led_set(VOICE_LED_RECORDING, 0);

    ESP_LOGI(TAG, "● 开始录音（%dHz/%dbit/单声道，上限 %dms；再按一次 BOOT 键结束）",
             VOICE_SAMPLE_RATE, VOICE_BITS, VOICE_MAX_RECORD_MS);

    const int64_t t0 = esp_timer_get_time();
    size_t raw_total = 0;
    int timeouts = 0;
    bool failed = false;

    /* ★ 读进 s_raw（交错），循环结束后再去交错到 s_pcm。
     *   缓冲按 VOICE_MAX_RAW_BYTES 算，才能真的录满 10 秒单声道。 */
    while (!s_stop_req) {
        int64_t elapsed_ms = (esp_timer_get_time() - t0) / 1000;
        if (elapsed_ms >= VOICE_MAX_RECORD_MS) {
            ESP_LOGW(TAG, "录音达到 %dms 上限，自动结束", VOICE_MAX_RECORD_MS);
            break;
        }
        size_t room = VOICE_MAX_RAW_BYTES - raw_total;
        if (room < 2 * VOICE_I2S_SLOTS) break;
        size_t want = room < VOICE_READ_CHUNK ? room : VOICE_READ_CHUNK;
        /* 保证按整帧读，避免把一帧劈成两半导致后续去交错错位 */
        want -= want % (2 * VOICE_I2S_SLOTS);

        size_t got = 0;
        esp_err_t err = i2s_channel_read(s_rx, s_raw + raw_total, want, &got, VOICE_READ_TIMEOUT_MS);
        if (err == ESP_OK && got > 0) {
            raw_total += got;
            timeouts = 0;
        } else if (err == ESP_ERR_TIMEOUT) {
            timeouts++;
            /* 超时本身正常（等 DMA），但连续多次都拿不到任何字节 = 采集链路没数据 */
            if (timeouts >= VOICE_TIMEOUT_LIMIT && raw_total == 0) {
                ESP_LOGE(TAG, "采集超时：连续 %d 次 I2S 读超时且一个字节都没收到"
                              "（检查 BCLK=GPIO41/WS=GPIO42/DIN=GPIO2 与麦克风供电）",
                         timeouts);
                failed = true;
                break;
            }
        } else {
            ESP_LOGE(TAG, "I2S 读取失败：%s（已采集 %u 字节）",
                     esp_err_to_name(err), (unsigned)raw_total);
            failed = true;
            break;
        }
    }

    s_recording = false;
    *out_elapsed_ms = (int)((esp_timer_get_time() - t0) / 1000);

    if (failed) {
        led_set(VOICE_LED_ERROR, VOICE_LED_ERR_MS);
        return 0;
    }

    /* 去交错：2 slot 交错 → 真单声道 */
    const size_t total = voice_deinterleave((const int16_t *)s_raw, raw_total, (int16_t *)s_pcm);

    if (total < VOICE_MIN_PCM_BYTES) {
        ESP_LOGE(TAG, "录音过短：仅 %u 字节（< %d 字节 / 100ms），不当作一次有效录音",
                 (unsigned)total, VOICE_MIN_PCM_BYTES);
        led_set(VOICE_LED_ERROR, VOICE_LED_ERR_MS);
        return 0;
    }

    /* 峰值（16bit 有符号）：既能自检麦克风是否真的采到声音，也随摘要上报 */
    const int16_t *pcm = (const int16_t *)s_pcm;
    size_t samples = total / 2;
    int peak = 0;
    for (size_t i = 0; i < samples; i++) {
        int v = pcm[i];
        if (v < 0) v = -v;
        if (v > peak) peak = v;
    }
    *out_peak = peak;

    ESP_LOGI(TAG, "■ 录音结束：%u 字节 / %dms（原始 %u 字节去交错为单声道），峰值 %d（%s）",
             (unsigned)total, *out_elapsed_ms, (unsigned)raw_total, peak,
             peak < 300 ? "接近无声，请检查麦克风" : "有声");
    return total;
}

/* ------------------------------------------------------------------ */
/* 上传 WAV                                                            */
/* ------------------------------------------------------------------ */
static bool voice_upload(size_t pcm_bytes, int peak, int elapsed_ms)
{
    const uint32_t dur_ms = (uint32_t)(pcm_bytes / VOICE_BYTES_PER_MS);
    const size_t   total  = 44 + pcm_bytes;

    wav_build_header(s_wav, (uint32_t)pcm_bytes);

    char url[160];
    snprintf(url, sizeof(url), "http://%s:%d/api/voice/audio",
             APP_SERVER_HOST, APP_SERVER_PORT);

    char dur_str[16];
    snprintf(dur_str, sizeof(dur_str), "%lu", (unsigned long)dur_ms);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = VOICE_HTTP_TIMEOUT_MS,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) {
        ESP_LOGE(TAG, "上传失败：esp_http_client_init 返回 NULL");
        led_set(VOICE_LED_ERROR, VOICE_LED_ERR_MS);
        printf("{\"type\":\"voice\",\"event\":\"failed\",\"device\":\"%s\","
               "\"source\":\"onboard_mems_mic\",\"bytes\":%u,\"duration_ms\":%lu,"
               "\"sample_rate\":%d,\"bits\":%d,\"channels\":%d,\"riff\":\"RIFF\","
               "\"peak\":%d,\"http\":0,\"audio_id\":\"\",\"error\":\"http_init_failed\"}\n",
               APP_DEVICE_ID, (unsigned)total, (unsigned long)dur_ms,
               VOICE_SAMPLE_RATE, VOICE_BITS, VOICE_CHANNELS, peak);
        return false;
    }

    esp_http_client_set_header(c, "Content-Type", "audio/wav");
    esp_http_client_set_header(c, "device", APP_DEVICE_ID);
    esp_http_client_set_header(c, "duration_ms", dur_str);

    led_set(VOICE_LED_UPLOADING, 0);
    s_uploading = true;
    ESP_LOGI(TAG, "↑ 上传 WAV：%u 字节（%lums）→ %s", (unsigned)total,
             (unsigned long)dur_ms, url);

    int http_status = 0;
    const char *err_name = "";
    char resp[384] = "";
    char audio_id[64] = "";
    bool ok = false;

    esp_err_t err = esp_http_client_open(c, (int)total);
    if (err != ESP_OK) {
        err_name = "http_open_failed";
        ESP_LOGE(TAG, "上传失败：连接 %s:%d 失败（%s）——检查 WiFi 与 APP_SERVER_HOST",
                 APP_SERVER_HOST, APP_SERVER_PORT, esp_err_to_name(err));
    } else {
        size_t sent = 0;
        while (sent < total) {
            size_t chunk = total - sent;
            if (chunk > 16384) chunk = 16384;
            int n = esp_http_client_write(c, (const char *)(s_wav + sent), (int)chunk);
            if (n <= 0) {
                err = ESP_FAIL;
                err_name = "http_write_failed";
                break;
            }
            sent += (size_t)n;
        }
        if (err == ESP_OK) {
            int hdr = esp_http_client_fetch_headers(c);
            (void)hdr;
            http_status = esp_http_client_get_status_code(c);
            int n = esp_http_client_read_response(c, resp, sizeof(resp) - 1);
            if (n < 0) n = 0;
            resp[n] = '\0';
            if (http_status == 200) {
                ok = true;
            } else {
                err_name = "http_status";
                json_pick(resp, "error", audio_id, sizeof(audio_id));
                if (audio_id[0]) err_name = "http_error";
            }
            if (ok) json_pick(resp, "audio_id", audio_id, sizeof(audio_id));
        } else {
            err_name = (err_name[0] ? err_name : "http_write_failed");
            ESP_LOGE(TAG, "上传失败：写入请求体中断（已发 %u / %u 字节，%s）",
                     (unsigned)sent, (unsigned)total, esp_err_to_name(err));
        }
        esp_http_client_close(c);
    }
    esp_http_client_cleanup(c);
    s_uploading = false;

    if (ok) {
        ESP_LOGI(TAG, "✔ 上传成功：http=%d audio_id=%s bytes=%u duration_ms=%lu",
                 http_status, audio_id[0] ? audio_id : "(未回传)",
                 (unsigned)total, (unsigned long)dur_ms);
        led_set(VOICE_LED_OK, VOICE_LED_OK_MS);
    } else {
        ESP_LOGE(TAG, "✘ 上传失败：http=%d error=%s%s%s（本次录音 %u 字节未入库）",
                 http_status, err_name,
                 resp[0] ? "，服务端返回：" : "", resp[0] ? resp : "",
                 (unsigned)total);
        led_set(VOICE_LED_ERROR, VOICE_LED_ERR_MS);
    }

    /* 一行 JSON 摘要 → USB 串口（服务端 handleLine 的 type:'voice' 分支专门接它，
     * 不会污染 state.fields 传感器字段） */
    printf("{\"type\":\"voice\",\"event\":\"%s\",\"device\":\"%s\","
           "\"source\":\"onboard_mems_mic\",\"bytes\":%u,\"duration_ms\":%lu,"
           "\"sample_rate\":%d,\"bits\":%d,\"channels\":%d,\"riff\":\"RIFF\","
           "\"peak\":%d,\"http\":%d,\"audio_id\":\"%s\",\"error\":\"%s\","
           "\"elapsed_ms\":%d}\n",
           ok ? "uploaded" : "failed", APP_DEVICE_ID, (unsigned)total,
           (unsigned long)dur_ms, VOICE_SAMPLE_RATE, VOICE_BITS, VOICE_CHANNELS,
           peak, http_status, audio_id, ok ? "" : (err_name[0] ? err_name : "unknown"),
           elapsed_ms);

    return ok;
}

/* ------------------------------------------------------------------ */
/* 录音任务：串行处理「开始录音 → 采集 → 上传」                        */
/* ------------------------------------------------------------------ */
static void voice_task(void *arg)
{
    (void)arg;
    vc_msg_t m;
    uint32_t ok_cnt = 0, fail_cnt = 0;

    while (1) {
        if (xQueueReceive(s_q, &m, portMAX_DELAY) != pdTRUE) continue;
        if (m != VC_START) continue;

        if (s_uploading) {
            ESP_LOGW(TAG, "上一次上传还没结束，忽略这次按键");
            continue;
        }
        if (!voice_i2s_init()) {                 /* 失败分支①：I2S 未初始化 */
            led_set(VOICE_LED_ERROR, VOICE_LED_ERR_MS);
            continue;
        }

        int peak = 0, elapsed_ms = 0;
        size_t pcm = voice_capture(&peak, &elapsed_ms);
        if (pcm == 0) {                          /* 失败分支②：采集超时 / 过短 */
            fail_cnt++;
            ESP_LOGW(TAG, "累计：成功 %lu 次，失败 %lu 次",
                     (unsigned long)ok_cnt, (unsigned long)fail_cnt);
            continue;
        }
        if (voice_upload(pcm, peak, elapsed_ms)) {   /* 失败分支③：上传失败 */
            ok_cnt++;
        } else {
            fail_cnt++;
        }
        ESP_LOGI(TAG, "累计：成功 %lu 次，失败 %lu 次",
                 (unsigned long)ok_cnt, (unsigned long)fail_cnt);
    }
}

/* ------------------------------------------------------------------ */
/* 按键任务：BOOT 键（GPIO0，按下=低）轮询 + 去抖 + 边沿触发           */
/* ------------------------------------------------------------------ */
static void voice_btn_task(void *arg)
{
    (void)arg;
    bool stable = false;    /* 去抖后的状态：true = 按下 */
    bool cand   = false;
    int  same   = 0;

    while (1) {
        int level = gpio_get_level(VOICE_BTN_GPIO);
        bool pressed = (level == 0);

        if (pressed == cand) {
            if (same < 4) same++;
        } else {
            cand = pressed;
            same = 1;
        }

        if (same >= 3 && cand != stable) {
            stable = cand;
            s_btn_down = stable;
            if (stable) {
                ESP_LOGI(TAG, "BOOT 键按下（GPIO%d）", (int)VOICE_BTN_GPIO);
                voice_record_toggle();
            } else {
                ESP_LOGI(TAG, "BOOT 键松开");
            }
        }
        vTaskDelay(pdMS_TO_TICKS(25));
    }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */
bool voice_record_toggle(void)
{
    if (s_uploading) {
        ESP_LOGW(TAG, "正在上传上次录音，本次按键忽略");
        return false;
    }
    if (s_recording) {
        s_stop_req = true;
        ESP_LOGI(TAG, "按键：结束录音并上传");
        return true;
    }
    if (!s_q) {
        ESP_LOGE(TAG, "语音模块未初始化（s_q 为空）");
        return false;
    }
    vc_msg_t m = VC_START;
    if (xQueueSend(s_q, &m, 0) != pdTRUE) {
        ESP_LOGW(TAG, "语音任务忙，本次按键忽略");
        return false;
    }
    ESP_LOGI(TAG, "按键：开始录音");
    return true;
}

void voice_record_init(void)
{
    /* 录音缓冲：44 字节头 + 320,000 字节【去交错后】PCM。
     * ★ 额外再留一倍给 I2S 原始交错数据（640,000 字节）：采集时先落在
     *   s_raw，再原地去交错搬回 s_pcm 起址，因此两者不能共用同一块。
     *   内部 RAM 放不下（会顶掉 WiFi/摄像头），一律优先放板载 8MB PSRAM。 */
    const size_t wav_cap = 44 + VOICE_MAX_PCM_BYTES;
    s_wav = heap_caps_malloc(wav_cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_wav) s_wav = malloc(wav_cap);
    if (!s_wav) {
        ESP_LOGE(TAG, "语音模块不可用：分配 %u 字节 WAV 缓冲失败（PSRAM 与内部 RAM 均不足）"
                      "——按键录音功能关闭，其它功能不受影响",
                 (unsigned)wav_cap);
        return;
    }
    s_pcm = s_wav + 44;

    s_raw = heap_caps_malloc(VOICE_MAX_RAW_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_raw) s_raw = malloc(VOICE_MAX_RAW_BYTES);
    if (!s_raw) {
        ESP_LOGE(TAG, "语音模块不可用：分配 %u 字节 I2S 原始缓冲失败"
                      "（PSRAM 与内部 RAM 均不足）——按键录音功能关闭",
                 (unsigned)VOICE_MAX_RAW_BYTES);
        free(s_wav);
        s_wav = NULL;
        s_pcm = NULL;
        return;
    }

    s_q = xQueueCreate(4, sizeof(vc_msg_t));
    if (!s_q) {
        ESP_LOGE(TAG, "语音模块不可用：命令队列创建失败");
        free(s_raw);
        s_raw = NULL;
        free(s_wav);
        s_wav = NULL;
        s_pcm = NULL;
        return;
    }

    /* BOOT 键：GPIO0，板上已有外部上拉，这里再开内部上拉作为兜底 */
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << VOICE_BTN_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&io);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "BOOT 键 GPIO%d 配置失败（%s）：录音仍可用远程命令触发",
                 (int)VOICE_BTN_GPIO, esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "BOOT 键就绪：GPIO%d 低电平有效（依据 esp-bsp bsp_button.c L79-L82，"
                      "BSP_BUTTON_5_IO=GPIO0），按一下开始、再按一下结束",
                 (int)VOICE_BTN_GPIO);
    }

    /* 语音任务栈 8192：上传走 esp_http_client，失败路径比成功路径更深（第 3 周实测结论） */
    if (xTaskCreate(voice_task, "voice", 8192, NULL, 4, NULL) != pdPASS) {
        ESP_LOGE(TAG, "语音任务创建失败，按键录音不可用");
        return;
    }
    xTaskCreate(voice_btn_task, "vbtn", 3072, NULL, 4, NULL);

    ESP_LOGI(TAG, "语音模块就绪：音频来源=板载 MEMS 麦克风（I2S），"
                  "识别与播放在电脑浏览器（本板无扬声器）");
}
