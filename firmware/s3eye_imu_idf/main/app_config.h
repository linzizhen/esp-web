/* =====================================================================
 * 本组配置 —— 唯一需要修改的地方
 *
 *  1) WiFi：改成能上网、且与本组电脑在同一局域网的 WiFi
 *  2) 服务器：运行 server.js 的电脑 IP（默认已填本机有线网 IP）
 *  3) 设备标识：各组必须不同，需与服务端 config.json 的 expectedDeviceId 一致
 *
 *  注意：本组电脑只有有线网（无 WiFi 网卡）。若暂时没有可用 WiFi，
 *        固件仍会把同样格式的 JSON 打印到 USB 串口，网页可先通过 USB 看到数据；
 *        WiFi 连上后会自动改为"独立网络上传"。
 * ===================================================================== */
#pragma once

#define APP_WIFI_SSID   "YOUR_WIFI_SSID"      /* ← 改成你的 WiFi 名称 */
#define APP_WIFI_PASS   "YOUR_WIFI_PASSWORD"  /* ← 改成你的 WiFi 密码 */

#define APP_SERVER_HOST "10.1.41.112"         /* ← 运行 server.js 的电脑 IP */
#define APP_SERVER_PORT 8080                  /* ← 与服务端端口一致 */

#define APP_DEVICE_ID   "S3EYE-GROUP01"       /* ← 本组独立标识 */

/* 上报间隔（毫秒）：10Hz = 100ms，建议 50~200ms。
 * USB-CDC 115200bps 下每条 JSON ≈300 字节，20Hz 以内安全。 */
#define REPORT_INTERVAL_MS 100

/* WiFi 下行命令轮询间隔（毫秒）。
 * 板端是纯 HTTP 客户端，服务端连不上它，所以由板端定期来取命令
 * （GET /api/cmd）。串口在线时服务端只写串口，这里取到的永远是空，
 * 因此两条下行通道互不干扰。400ms 兼顾响应速度与请求频率。 */
#define CMD_POLL_INTERVAL_MS 400
