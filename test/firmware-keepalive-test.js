/* 固件「WiFi 上传复用长连接」行为契约（静态检查，不需要开发板）
 *
 * 存在理由（2026-11-16 实测）：方案 B 把上传移出采样循环后，采样率回到 9.73 fps，
 * 但 WiFi 上行吞吐仍然很低（60 秒 upload_ok +6、upload_fail +10、upload_drop +568）。
 * 原因是 http_post() 每次都 esp_http_client_init → TCP 建连 → 请求 → cleanup，
 * 一次 POST 要付 2~3 个 RTT；RTT 200ms 时一条连接就要 0.5 秒以上。
 *
 * 方案 A：给「帧上传」这一条高频路径配一个常驻客户端（keep-alive），把 TCP 握手
 * 摊到多次请求上。三个必须守住的约定：
 *   ① 热路径（http_post_keepalive）里不许再出现 init/cleanup；
 *   ② 任何失败都立刻销毁长连接、下次重建，绝不带着坏连接硬撑；
 *   ③ 常驻客户端只归 upload_task 使用 —— 一次性 http_post() 保持原样，
 *      避免两个任务共享同一个句柄（esp_http_client 不是线程安全的）。
 *
 * 用法：node test/firmware-keepalive-test.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAIN_C = path.join(ROOT, 'firmware', 's3eye_imu_idf', 'main', 'main.c');
const SRC = fs.readFileSync(MAIN_C, 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* 按花括号配平抽函数体（与 firmware-wifi-skip-test.js 同一套办法） */
function fnBody(src, name) {
  const at = src.indexOf(name);
  if (at < 0) return '';
  const paren = src.indexOf(')', at);
  const start = src.indexOf('{', paren >= 0 ? paren : at);
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

const kaGet = fnBody(SRC, 'static esp_http_client_handle_t http_ka_get(');
const kaReset = fnBody(SRC, 'static void http_ka_reset(');
const kaPost = fnBody(SRC, 'static bool http_post_keepalive(');
const oneShot = fnBody(SRC, 'static bool http_post(');
const upload = fnBody(SRC, 'static bool http_upload(');
const uploadTask = fnBody(SRC, 'static void upload_task(');
const sendFrame = fnBody(SRC, 'static void send_frame(');
const ackTask = fnBody(SRC, 'static void ack_task(');

console.log('=== 固件「上传复用长连接」契约 ===\n');

/* ---------- ① 常驻客户端 ---------- */
console.log('① 常驻客户端与它的生命周期');
check('声明了常驻句柄 s_http_ka',
  /static\s+esp_http_client_handle_t\s+s_http_ka/.test(SRC));
check('定义了复用上限常量 HTTP_KA_MAX_REUSE',
  /#define\s+HTTP_KA_MAX_REUSE\s+\d+/.test(SRC),
  (SRC.match(/#define\s+HTTP_KA_MAX_REUSE\s+\d+/) || [''])[0]);
check('http_ka_get() 惰性创建（内含 esp_http_client_init）',
  /esp_http_client_init\(/.test(kaGet));
check('创建时开启 keep_alive_enable',
  /\.keep_alive_enable\s*=\s*true/.test(kaGet) || /keep_alive_enable\s*=\s*true/.test(kaGet));
check('创建时设置 Content-Type',
  /esp_http_client_set_header\(\s*s_http_ka\s*,\s*"Content-Type"/.test(kaGet) ||
  /"Content-Type"/.test(kaGet));
check('http_ka_reset() 会关闭并销毁句柄',
  /esp_http_client_close\(/.test(kaReset) && /esp_http_client_cleanup\(/.test(kaReset));
check('http_ka_reset() 把句柄置空（下次重建，不留在坏状态）',
  /s_http_ka\s*=\s*NULL/.test(kaReset));

/* ---------- ② 热路径不再建连 ---------- */
console.log('\n② 上传热路径不再每次建连');
check('http_post_keepalive() 用常驻句柄发送',
  /esp_http_client_perform\(\s*s_http_ka\s*\)/.test(kaPost));
check('http_post_keepalive() 内不出现 esp_http_client_init',
  !/esp_http_client_init\(/.test(kaPost));
check('http_post_keepalive() 内不出现 esp_http_client_cleanup',
  !/esp_http_client_cleanup\(/.test(kaPost));
check('失败时立刻销毁长连接（调用 http_ka_reset）',
  /http_ka_reset\(\)/.test(kaPost));
check('失败后重建并重试一次（不是直接算失败）',
  /for\s*\(\s*int\s+attempt\s*=\s*0\s*;\s*attempt\s*<\s*2/.test(kaPost));
check('成功后累计复用次数',
  /s_http_ka_sent\s*\+\+/.test(kaPost));
check('复用次数到上限后主动重建（避免连接长期僵死）',
  /s_http_ka_sent\s*>=\s*HTTP_KA_MAX_REUSE/.test(kaPost));

/* ---------- ③ 接线：只改上传路径 ---------- */
console.log('\n③ 只有帧上传走长连接，一次性请求保持原样');
check('http_upload() 改走长连接版本',
  /http_post_keepalive\(/.test(upload));
check('upload_task 仍然调用 http_upload()',
  /http_upload\(/.test(uploadTask));
check('一次性 http_post() 仍然存在且自带 init/cleanup（ack/求助路径不受影响）',
  /esp_http_client_init\(/.test(oneShot) && /esp_http_client_cleanup\(/.test(oneShot));
check('ack_task 仍然用一次性 http_post("/api/data"',
  /http_post\(\s*"\/api\/data"/.test(ackTask));
check('采样循环内仍不出现 http_upload（方案 B 的底线不破）',
  !/http_upload\(/.test(sendFrame));
check('注释说明了「常驻句柄只归 upload_task 用」的原因',
  /esp_http_client[^\n]*不是线程安全|不是线程安全|只归\s*upload_task/.test(SRC));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
