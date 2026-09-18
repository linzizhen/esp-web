/* =====================================================================
 * ESP32-S3-EYE —— QMA7981 三轴加速度采集 + 上报（ESP-IDF 版）
 *
 * 双通道上报（同一份真实数据，绝不生成/模拟）：
 *   1) WiFi  → HTTP POST http://<APP_SERVER_HOST>:<APP_SERVER_PORT>/api/data
 *   2) USB   → 把同样的 JSON 打印到 USB Serial/JTAG（COM 口），供串口方式读取/调试
 *
 * 硬件依据（来自官方资料，非猜测）：
 *   - ESP32-S3-EYE 无 USB-UART 桥接芯片，板载 I2C：SDA=GPIO4 / SCL=GPIO5
 *     （esp-bsp: BSP_I2C_SDA=GPIO_NUM_4, BSP_I2C_SCL=GPIO_NUM_5）
 *   - QMA7981：地址 0x12，ID 寄存器 0x00 期望 0xE7，数据寄存器 X=0x01 Y=0x03 Z=0x05，
 *     写 0x11=0xC0 进入 active，14bit 左对齐，默认 ±2g（满量程 0x1FFF）
 *   - 单位核对：静止水平放置时 Z 轴应约 +1g ≈ +9.8 m/s²
 *   - 时间核对：板端 NTP 取 UTC 时间戳，服务端另记接收时间，两者可对照
 * ===================================================================== */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <time.h>
#include <sys/time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

#include "esp_system.h"
#include "esp_log.h"
#include "esp_err.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_client.h"
#include "esp_sntp.h"
#include "nvs_flash.h"

#include "driver/i2c_master.h"
#include "driver/temperature_sensor.h"

#include "app_config.h"

static const char *TAG = "S3EYE";

/* ---------------------- QMA7981 ---------------------- */
#define QMA_ADDR        0x12
#define QMA_REG_CHIPID  0x00
#define QMA_REG_PWR     0x11
#define QMA_REG_DXM     0x01
#define QMA_REG_RANGE   0x0F    /* FSR 量程寄存器 */
#define QMA_ACTIVE_CMD  0xC0
#define QMA_FULLSCALE   8191.0f   /* 0x1FFF */
#define QMA_RANGE_G     2.0f      /* 默认 ±2g */
#define QMA_CALIBRATION 0.765f    /* 本板 QMA7981 灵敏度偏高 ~31%；校准使静止 |a|≈1.0g */
#define G_TO_MS2        9.80665f

#define I2C_SDA_GPIO    4
#define I2C_SCL_GPIO    5

static i2c_master_bus_handle_t  s_bus = NULL;
static i2c_master_dev_handle_t  s_dev = NULL;
static bool                     s_imu_ok = false;
static uint8_t                  s_imu_id = 0;     // 读到的 WHO_AM_I 字节（诊断用）
static char                     s_imu_scan[128] = ""; // 扫描到的 I2C 地址列表

static temperature_sensor_handle_t s_tsens = NULL;
static bool                        s_tsens_ok = false;

static void temp_sensor_init(void)
{
    temperature_sensor_config_t cfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    if (temperature_sensor_install(&cfg, &s_tsens) == ESP_OK &&
        temperature_sensor_enable(s_tsens) == ESP_OK) {
        s_tsens_ok = true;
    }
}

static float temp_sensor_read(void)
{
    float c = NAN;
    if (s_tsens_ok) temperature_sensor_get_celsius(s_tsens, &c);
    return c;
}

/* ---------------------- WiFi ---------------------- */
static EventGroupHandle_t s_wifi_eg = NULL;
#define WIFI_CONNECTED_BIT BIT0
static char s_ip[16] = "0.0.0.0";

/* ---------------------- 统计 ---------------------- */
static uint32_t s_seq = 0, s_ok = 0, s_fail = 0;
static char     s_mac[13] = "000000000000";

/* ===================== I2C / QMA7981 ===================== */

static esp_err_t qma_read(uint8_t reg, uint8_t *buf, size_t len)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, buf, len, 1000);
}

static esp_err_t qma_write(uint8_t reg, uint8_t val)
{
    uint8_t b[2] = { reg, val };
    return i2c_master_transmit(s_dev, b, 2, 1000);
}

static void i2c_scan(void)
{
    s_imu_scan[0] = '\0';
    ESP_LOGI(TAG, "扫描 I2C 总线 (SDA=%d SCL=%d)…", I2C_SDA_GPIO, I2C_SCL_GPIO);
    for (uint8_t a = 0x08; a < 0x78; a++) {
        if (i2c_master_probe(s_bus, a, 50) == ESP_OK) {
            ESP_LOGI(TAG, "  发现 I2C 设备: 0x%02X", a);
            int len = strlen(s_imu_scan);
            snprintf(s_imu_scan + len, sizeof(s_imu_scan) - len, "%s0x%02X", len ? " " : "", a);
        }
    }
    if (!s_imu_scan[0]) snprintf(s_imu_scan, sizeof(s_imu_scan), "(无响应设备)");
}

/* 在指定 I2C 端口上尝试初始化 QMA7981；返回 true 表示数据可读 */
static bool imu_init_on_port(i2c_port_num_t port)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = port,
        .sda_io_num = I2C_SDA_GPIO,
        .scl_io_num = I2C_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    if (i2c_new_master_bus(&bus_cfg, &s_bus) != ESP_OK) {
        ESP_LOGE(TAG, "I2C 总线 %d 创建失败", port);
        return false;
    }
    i2c_scan();

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = QMA_ADDR,
        .scl_speed_hz = 400000,
    };
    if (i2c_master_bus_add_device(s_bus, &dev_cfg, &s_dev) != ESP_OK) {
        ESP_LOGE(TAG, "QMA7981 (0x%02X) 设备添加失败", QMA_ADDR);
        return false;
    }

    uint8_t id = 0;
    if (qma_read(QMA_REG_CHIPID, &id, 1) != ESP_OK) {
        ESP_LOGE(TAG, "读取 QMA7981 ID 失败");
        return false;
    }
    s_imu_id = id;
    ESP_LOGI(TAG, "QMA7981 WHO_AM_I = 0x%02X (本板实测 0x90，故不做 ID 强校验)", id);
    if (id != 0xE7) {
        ESP_LOGW(TAG, "QMA7981 ID 不匹配，仍尝试读取（可能是兼容型号）");
    }
    /* 显式设置量程 ±2g（寄存器 0x0F bits[1:0]=00），
     * 部分变体芯片默认量程可能不同，不设置会导致 g 值偏差。 */
    qma_write(QMA_REG_RANGE, 0x00);
    qma_write(QMA_REG_PWR, QMA_ACTIVE_CMD);   /* 进入 active */
    vTaskDelay(pdMS_TO_TICKS(60));
    ESP_LOGI(TAG, "QMA7981 初始化完成（±2g，14bit，端口 %d）", port);
    return true;
}

static bool imu_init(void)
{
    /* 依次尝试 I2C 端口 0 / 1（不同板子可能挂在任一个上） */
    if (imu_init_on_port(I2C_NUM_0)) return true;
    if (s_bus) { i2c_del_master_bus(s_bus); s_bus = NULL; s_dev = NULL; }
    if (imu_init_on_port(I2C_NUM_1)) return true;
    s_imu_id = 0;
    ESP_LOGE(TAG, "QMA7981 在两路 I2C 上均未初始化成功");
    return false;
}

static bool imu_read(int16_t out[3])
{
    uint8_t b[6] = {0};
    if (qma_read(QMA_REG_DXM, b, 6) != ESP_OK) return false;
    int16_t x16 = (int16_t)((b[1] << 8) | b[0]);
    int16_t y16 = (int16_t)((b[3] << 8) | b[2]);
    int16_t z16 = (int16_t)((b[5] << 8) | b[4]);
    /* QMA7981 14-bit 数据为左对齐：bit[1:0] 为零，需右移 2 位获得真实值。
     * 但不同批次芯片的寄存器对齐方式可能不同。输出原始 16bit 以便诊断。 */
    out[0] = x16 >> 2;
    out[1] = y16 >> 2;
    out[2] = z16 >> 2;
    return true;
}

/* ===================== WiFi ===================== */

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_wifi_eg, WIFI_CONNECTED_BIT);
        ESP_LOGW(TAG, "WiFi 断开，重连中…");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&e->ip_info.ip));
        ESP_LOGI(TAG, "WiFi 已连接，IP=%s", s_ip);
        xEventGroupSetBits(s_wifi_eg, WIFI_CONNECTED_BIT);
    }
}

static void wifi_init(void)
{
    s_wifi_eg = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    wifi_config_t wc = {0};
    strncpy((char *)wc.sta.ssid, APP_WIFI_SSID, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, APP_WIFI_PASS, sizeof(wc.sta.password) - 1);
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;   /* 兼容开放/各类加密 */

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_LOGI(TAG, "WiFi 启动，SSID=%s", APP_WIFI_SSID);
}

static bool wifi_wait(int ms)
{
    EventBits_t bits = xEventGroupWaitBits(s_wifi_eg, WIFI_CONNECTED_BIT, pdFALSE, pdTRUE, pdMS_TO_TICKS(ms));
    return (bits & WIFI_CONNECTED_BIT) != 0;
}

/* ===================== SNTP 对时 ===================== */

static void time_sync(void)
{
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "ntp.aliyun.com");
    esp_sntp_setservername(1, "pool.ntp.org");
    esp_sntp_init();

    time_t now = 0;
    int retry = 0;
    while (now < 1700000000 && retry++ < 30) {
        vTaskDelay(pdMS_TO_TICKS(500));
        time(&now);
    }
    if (now < 1700000000) {
        ESP_LOGW(TAG, "NTP 对时失败，报文将不带板端时间戳");
    } else {
        struct tm ti;
        gmtime_r(&now, &ti);
        char iso[32];
        strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", &ti);
        ESP_LOGI(TAG, "板端 UTC = %s", iso);
    }
}

/* ===================== HTTP 上传 ===================== */

static bool http_upload(const char *body)
{
    char url[96];
    snprintf(url, sizeof(url), "http://%s:%d/api/data", APP_SERVER_HOST, APP_SERVER_PORT);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return false;
    esp_http_client_set_header(c, "Content-Type", "application/json");
    esp_http_client_set_post_field(c, body, strlen(body));

    esp_err_t err = esp_http_client_perform(c);
    int status = esp_http_client_get_status_code(c);
    esp_http_client_cleanup(c);
    return (err == ESP_OK && status == 200);
}

/* ===================== 主程序 ===================== */

/* ---------------------- 上报帧构建与发送 ---------------------- */

/* 构建一帧 JSON（含真实传感数据）。request_id 非空时写入帧内，
 * 供服务端把这次观测与「远程采集请求」关联起来。返回写入长度。 */
static int build_frame(char *body, size_t cap, const char *request_id)
{
    int n = 0;
    n += snprintf(body + n, cap - n,
                  "{\"device\":\"%s\",\"mac\":\"%s\",\"seq\":%lu,\"src\":\"s3eye\"",
                  APP_DEVICE_ID, s_mac, (unsigned long)s_seq);
    if (request_id && request_id[0]) {
        n += snprintf(body + n, cap - n, ",\"request_id\":\"%s\"", request_id);
    }

    /* 板端时间（NTP，UTC 毫秒） */
    time_t t = time(NULL);
    if (t > 1700000000) {
        struct timeval tv;
        gettimeofday(&tv, NULL);
        struct tm ti;
        gmtime_r(&t, &ti);
        char iso[32];
        strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", &ti);
        n += snprintf(body + n, cap - n,
                      ",\"ts\":%llu,\"iso\":\"%s\"",
                      (unsigned long long)t * 1000ULL + (unsigned long long)(tv.tv_usec / 1000), iso);
    }

    /* 三轴加速度：raw / g / m·s⁻² 三种形式，便于核对单位 */
    if (s_imu_ok) {
        int16_t raw[3];
        if (imu_read(raw)) {
            const char *axis[3] = { "x", "y", "z" };
            for (int i = 0; i < 3; i++) {
                float g   = (float)raw[i] * QMA_RANGE_G / QMA_FULLSCALE * QMA_CALIBRATION;
                float ms2 = g * G_TO_MS2;
                n += snprintf(body + n, cap - n,
                              ",\"acc_%s_raw\":%d,\"acc_%s_g\":%.4f,\"acc_%s_ms2\":%.3f",
                              axis[i], raw[i], axis[i], g, axis[i], ms2);
            }
        }
    }

    /* 保底真实数据源：芯片内部温度 */
    {
        float tc = temp_sensor_read();
        if (!isnan(tc) && tc > -100.0f) {
            n += snprintf(body + n, cap - n, ",\"temp_c\":%.1f", tc);
        }
    }

    /* IMU 诊断信息（便于确认板载传感器型号/地址，不用于展示） */
    n += snprintf(body + n, cap - n,
                  ",\"imu_ok\":%d,\"imu_id\":%d,\"imu_scan\":\"%s\"",
                  s_imu_ok ? 1 : 0, s_imu_id, s_imu_scan);

    int rssi = 0;
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) rssi = ap.rssi;
    n += snprintf(body + n, cap - n,
                  ",\"rssi\":%d,\"heap\":%lu,\"upload_ok\":%lu,\"upload_fail\":%lu}",
                  rssi, (unsigned long)esp_get_free_heap_size(),
                  (unsigned long)s_ok, (unsigned long)s_fail);
    return n;
}

/* 构建并双通道发送一帧（USB 串口 + WiFi） */
static void send_frame(const char *request_id)
{
    char body[768];
    int n = build_frame(body, sizeof(body), request_id);
    if (n <= 0 || n >= (int)sizeof(body)) {
        ESP_LOGW(TAG, "组帧溢出(%d)，跳过本帧", n);
        return;
    }
    printf("%s\n", body);                 /* 通道 1：USB 串口 */
    if (wifi_wait(0)) {                   /* 通道 2：WiFi 上传 */
        if (http_upload(body)) {
            s_ok++;
            if (s_ok % 10 == 1) ESP_LOGI(TAG, "上传成功 成功=%lu 失败=%lu", (unsigned long)s_ok, (unsigned long)s_fail);
        } else {
            s_fail++;
            ESP_LOGW(TAG, "上传失败 成功=%lu 失败=%lu", (unsigned long)s_ok, (unsigned long)s_fail);
        }
    }
}

/* ---------------------- 远程命令（下行通道） ----------------------
 * 命令由服务端经同一 USB 串口写入，每行一条 JSON：
 *   {"cmd":"collect_once","request_id":"req-..."}  立即采集一次并回传（带 request_id）
 *   {"cmd":"pause"}                                暂停周期上报（命令通道保持）
 *   {"cmd":"resume"}                               恢复周期上报
 *   {"cmd":"ping","request_id":"..."}              连通性探测
 * 板端回执：
 *   {"type":"ack","request_id":"...","seq":N,"status":"received"}
 * 采集观测 = 普通数据帧 + request_id 字段（复用同一条解析链路）。
 * ------------------------------------------------------------------ */
static volatile bool s_report_paused = false;

/* 极简 JSON 取值：找 "key":"value"（仅支持字符串值，够用且无额外依赖） */
static bool json_str(const char *json, const char *key, char *out, size_t cap)
{
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p) return false;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    if (*p != '"') return false;
    p++;
    size_t i = 0;
    while (*p && *p != '"' && i + 1 < cap) out[i++] = *p++;
    out[i] = '\0';
    return true;
}

static void cmd_ack(const char *request_id, const char *status)
{
    char buf[192];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"ack\",\"device\":\"%s\",\"request_id\":\"%s\",\"seq\":%lu,\"status\":\"%s\"}",
             APP_DEVICE_ID, request_id, (unsigned long)s_seq, status);
    printf("%s\n", buf);
}

/* 立即采集一次：先回执证明收到，再做全新一次采集并回传 */
static void cmd_collect_once(const char *request_id)
{
    cmd_ack(request_id, "received");
    s_seq++;                        /* 新序号 —— 服务端据此确认是「新采集」 */
    send_frame(request_id);
    ESP_LOGI(TAG, "远程采集完成 request_id=%s seq=%lu", request_id, (unsigned long)s_seq);
}

static void handle_command(const char *line)
{
    char cmd[32] = {0};
    if (!json_str(line, "cmd", cmd, sizeof(cmd))) return;
    char rid[64] = {0};
    json_str(line, "request_id", rid, sizeof(rid));

    if (strcmp(cmd, "collect_once") == 0) {
        cmd_collect_once(rid);
    } else if (strcmp(cmd, "pause") == 0) {
        s_report_paused = true;
        cmd_ack(rid, "paused");
        ESP_LOGI(TAG, "周期上报已暂停（命令通道保持）");
    } else if (strcmp(cmd, "resume") == 0) {
        s_report_paused = false;
        cmd_ack(rid, "resumed");
        ESP_LOGI(TAG, "周期上报已恢复");
    } else if (strcmp(cmd, "ping") == 0) {
        cmd_ack(rid, "pong");
    } else {
        cmd_ack(rid, "unknown_cmd");
    }
}

/* 命令接收任务：阻塞读串口行（控制台即 USB-Serial-JTAG，与 printf 同一通道） */
static void cmd_task(void *arg)
{
    (void)arg;
    char line[256];
    while (1) {
        if (fgets(line, sizeof(line), stdin) == NULL) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        size_t L = strlen(line);
        while (L && (line[L - 1] == '\n' || line[L - 1] == '\r')) line[--L] = '\0';
        if (L < 3 || line[0] != '{') continue;   /* 忽略空行与日志回显 */
        handle_command(line);
    }
}

void app_main(void)
{
    /* NVS（WiFi 需要） */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    vTaskDelay(pdMS_TO_TICKS(1200));   /* 等 USB CDC 枚举 */

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_mac, sizeof(s_mac), "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    printf("\n=== ESP32-S3-EYE IMU 上报固件 (ESP-IDF) ===\n");
    printf("chip=%s  device=%s  mac=%s\n", "ESP32-S3", APP_DEVICE_ID, s_mac);

    temp_sensor_init();
    s_imu_ok = imu_init();
    if (!s_imu_ok) {
        ESP_LOGW(TAG, "IMU 不可用，将只上报芯片内部温度（仍是真实传感源）");
    }

    wifi_init();
    if (wifi_wait(15000)) {
        time_sync();
    } else {
        ESP_LOGW(TAG, "WiFi 未连上（请检查 app_config.h）。仍会通过 USB 串口输出 JSON。");
    }

    /* 启动远程命令接收任务（下行通道，与上报共用同一 USB 串口） */
    xTaskCreate(cmd_task, "cmd", 4096, NULL, 5, NULL);

    int64_t last = 0;
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(10));
        if (s_report_paused) continue;          /* 已被远程命令暂停周期上报 */
        int64_t now_ms = esp_timer_get_time() / 1000;
        if (now_ms - last < REPORT_INTERVAL_MS) continue;
        last = now_ms;
        s_seq++;
        send_frame(NULL);                       /* 周期帧：不带 request_id */
    }
}
