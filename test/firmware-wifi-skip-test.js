/* 固件「WiFi 未连接」行为契约（静态检查，不需要开发板）
 *
 * 存在理由：2026-11-12 实测日志里 invalid 行 13449 / valid 12804 —— 几乎每帧
 * 都有一条 `wifi:Haven't to connect to a suitable AP now!`，因为断线事件处理里
 * 立刻 esp_wifi_connect() 死循环重试，一次失败约 100ms，等于 10Hz 刷屏。
 * 另一半问题是 upload_fail 恒为 0：发送函数在 wifi_wait(0) 为假时直接 return，
 * 既不记账也不吭声，页面上就完全看不出「WAV 从来没传上去」。
 *
 * 本测试锁住三条约定：
 *   ① WiFi 未连接时每帧不再打日志，改为按 WIFI_OFF_LOG_MS 限频；
 *   ② 未连接时用独立计数 s_skip 记账，并通过 upload_skip 字段上报；
 *   ③ 断线重连带指数退避（esp_timer 延时重连），避免事件处理里死循环。
 *
 * 用法：node test/firmware-wifi-skip-test.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'firmware', 's3eye_imu_idf', 'main', 'main.c'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* 按花括号配平抽函数体（能跨过字符串里的括号：粗略但足够，代码里没有 '{' 字面量） */
function fnBody(src, name) {
  const at = src.indexOf(name);
  if (at < 0) return '';
  const start = src.indexOf('{', src.indexOf(')', at) >= 0 ? src.indexOf(')', at) : at);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const sendFrame = fnBody(SRC, 'static void send_frame(');
const buildFrame = fnBody(SRC, 'static int build_frame(');
const discHandler = fnBody(SRC, 'static void wifi_event_handler(');

console.log('=== 固件「WiFi 未连接」行为契约 ===\n');

/* ---------- ① 未连接分支：限频日志 ---------- */
check('定义了 WIFI_OFF_LOG_MS 限频常量', /#define\s+WIFI_OFF_LOG_MS\s+\d+/.test(SRC),
  (SRC.match(/#define\s+WIFI_OFF_LOG_MS\s+\d+/) || [''])[0]);
check('有 s_wifi_off_log_us 记录上次打日志的时刻', /static\s+int64_t\s+s_wifi_off_log_us/.test(SRC));
check('send_frame 在 wifi_wait(0) 为假时进入分支（不再直接 return）',
  /if\s*\(\s*!\s*wifi_wait\(0\)\s*\)\s*\{/.test(sendFrame));
check('该分支内按 WIFI_OFF_LOG_MS 限频', /WIFI_OFF_LOG_MS/.test(sendFrame));

/* ---------- ② 未连接也有账可查 ---------- */
check('有 s_skip 计数', /static\s+uint32_t\s+s_skip/.test(SRC));
check('未连接分支里 s_skip++', /s_skip\s*\+\+/.test(sendFrame));
check('帧里上报 upload_skip 字段', /upload_skip\\?"\s*:\s*%lu/.test(buildFrame));
check('build_frame 传入了 s_skip', /\(unsigned long\)\s*s_skip/.test(buildFrame));

/* ---------- ③ 断线重连带退避 ---------- */
check('定义重连最小间隔 WIFI_RECONNECT_MIN_MS',
  /#define\s+WIFI_RECONNECT_MIN_MS\s+\d+/.test(SRC));
check('定义重连最大间隔 WIFI_RECONNECT_MAX_MS',
  /#define\s+WIFI_RECONNECT_MAX_MS\s+\d+/.test(SRC));
check('有重连定时器回调 wifi_reconnect_cb 且调用 esp_wifi_connect',
  /static\s+void\s+wifi_reconnect_cb\([^)]*\)\s*\{[^}]*esp_wifi_connect\(\)/.test(SRC));
check('断线处理里用 esp_timer_start_once 延时重连',
  /esp_timer_start_once\(\s*s_reconnect_timer/.test(discHandler));
/* 只看「断线」那一段：STA_START 里保留立即连接是对的，不能一起判错 */
const discBranch = (() => {
  const i = SRC.indexOf('WIFI_EVENT_STA_DISCONNECTED');
  if (i < 0) return '';
  const j = SRC.indexOf('IP_EVENT_STA_GOT_IP', i);
  return SRC.slice(i, j > i ? j : i + 2000);
})();
check('断线处理里不再直接调用 esp_wifi_connect()（避免死循环刷屏）',
  discBranch.length > 0 && !/esp_wifi_connect\(\)/.test(discBranch));
check('断线日志按 WIFI_DISC_LOG_MS 限频', /WIFI_DISC_LOG_MS/.test(SRC) && /s_last_disc_log_us/.test(SRC));
check('压掉 wifi 驱动内部重试噪音（esp_log_level_set("wifi", ESP_LOG_ERROR)）',
  /esp_log_level_set\(\s*"wifi"\s*,\s*ESP_LOG_ERROR\s*\)/.test(SRC));
check('拿到 IP 后把重连间隔复位', /GOT_IP[\s\S]{0,400}s_reconnect_delay_ms\s*=\s*0/.test(SRC));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
