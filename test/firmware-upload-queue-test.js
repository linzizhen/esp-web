/* 固件「上传移出采样循环」行为契约（静态检查，不需要开发板）
 *
 * 存在理由（2026-11-16 实测）：帧间隔 ≈ 100ms + k×RTT。
 * 原实现里 send_frame() 在采样主循环内同步调用 http_upload()，每次都要
 * esp_http_client_init → TCP 建连 → 请求 → 等响应 → cleanup；链路 RTT 一高，
 * 采样节拍就被拖垮。现场实测：RTT 高时掉到 0.7 fps（设计值 10），
 * 「采样率」与「网络往返时间」被硬绑在一起。
 *
 * 方案 B：采样循环只负责组帧 + 串口输出 + 把帧塞进队列，真正发 HTTP 交给
 * 独立的 upload_task。采样率因此与 RTT 解耦；网络慢时表现为「队列满丢帧」
 * （用 upload_drop 如实记账），而不是「采样变慢」。
 *
 * 本测试锁住这些约定，防止有人把 http_upload 又塞回采样循环：
 *   ① 队列与任务确实被创建，且任务在采样循环之前建好；
 *   ② send_frame 内不出现 http_upload，只做 xQueueSend；
 *   ③ 退避与成功/失败计数全部搬到 upload_task；
 *   ④ 队列满时计入 upload_drop 并在帧里上报；
 *   ⑤ 串口保底通道与「WiFi 未连接」记账语义不变。
 *
 * 用法：node test/firmware-upload-queue-test.js
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

const sendFrame = fnBody(SRC, 'static void send_frame(');
const uploadTask = fnBody(SRC, 'static void upload_task(');
const buildFrame = fnBody(SRC, 'static int build_frame(');
const appMain = fnBody(SRC, 'void app_main(');

console.log('=== 固件「上传移出采样循环」契约 ===\n');

/* ---------- ① 队列与任务 ---------- */
console.log('① 独立的上传队列与任务');
check('定义了队列长度常量 UPLOAD_QUEUE_LEN', /#define\s+UPLOAD_QUEUE_LEN\s+\d+/.test(SRC),
  (SRC.match(/#define\s+UPLOAD_QUEUE_LEN\s+\d+/) || [''])[0]);
check('定义了单帧上限常量 UPLOAD_FRAME_MAX', /#define\s+UPLOAD_FRAME_MAX\s+\d+/.test(SRC),
  (SRC.match(/#define\s+UPLOAD_FRAME_MAX\s+\d+/) || [''])[0]);
check('单帧上限不小于原栈上缓冲 768 字节',
  (() => {
    const m = SRC.match(/#define\s+UPLOAD_FRAME_MAX\s+(\d+)/);
    return !!m && Number(m[1]) >= 768;
  })());
check('声明了队列句柄 s_upload_q', /static\s+QueueHandle_t\s+s_upload_q/.test(SRC));
check('upload_task 存在且会收队列', /xQueueReceive\(\s*s_upload_q/.test(uploadTask));
check('upload_task 里调用 http_upload', /http_upload\(/.test(uploadTask));
check('app_main 里创建队列', /xQueueCreate\(\s*UPLOAD_QUEUE_LEN\s*,\s*UPLOAD_FRAME_MAX\s*\)/.test(appMain));
check('app_main 里创建 upload_task（栈 ≥ 4096）',
  /xTaskCreate\(\s*upload_task\s*,\s*"upload"\s*,\s*(\d+)/.test(appMain) &&
  Number((appMain.match(/xTaskCreate\(\s*upload_task\s*,\s*"upload"\s*,\s*(\d+)/) || [0, 0])[1]) >= 4096);
check('队列创建失败时有明确日志（不是静默）',
  /if\s*\(\s*!\s*s_upload_q\s*\)\s*ESP_LOGW/.test(appMain));

/* ---------- ② 采样循环不再发 HTTP ---------- */
console.log('\n② 采样循环只入队，不再同步发 HTTP');
check('send_frame 内不出现 http_upload', sendFrame.length > 0 && !/http_upload\(/.test(sendFrame),
  sendFrame.length ? '' : '未找到 send_frame 函数体');
check('send_frame 把帧塞进队列', /xQueueSend\(\s*s_upload_q/.test(sendFrame));
check('入队使用非阻塞等待（0 超时，绝不拖慢采样）',
  /xQueueSend\(\s*s_upload_q\s*,[^;]*,\s*0\s*\)/.test(sendFrame));
check('队列满/未建队列时计入 upload_drop', /s_drop\s*\+\+/.test(sendFrame));
check('采样循环仍在 app_main 的 while(1) 内调用 send_frame',
  /while\s*\(\s*1\s*\)[\s\S]{0,400}send_frame\(/.test(appMain));

/* ---------- ③ 退避与计数搬到上传任务 ---------- */
console.log('\n③ 退避与成功/失败计数跟着搬进 upload_task');
check('退避判定 s_next_try_us 在 upload_task 内', /s_next_try_us/.test(uploadTask));
check('send_frame 内不再有退避判定', sendFrame.length > 0 && !/s_next_try_us/.test(sendFrame));
check('成功计数 s_ok++ 在 upload_task 内', /s_ok\s*\+\+/.test(uploadTask));
check('失败计数 s_fail++ 在 upload_task 内', /s_fail\s*\+\+/.test(uploadTask));

/* ---------- ④ 丢帧如实上报 ---------- */
console.log('\n④ 丢帧如实上报，不装作没发生');
check('帧里上报 upload_drop 字段', /upload_drop\\?"\s*:\s*%lu/.test(buildFrame));
check('build_frame 传入了 s_drop', /\(unsigned long\)\s*s_drop/.test(buildFrame));
check('四个计数都声明为 volatile（跨任务读写）',
  /static\s+volatile\s+uint32_t\s+s_ok\s*=\s*0\s*,\s*s_fail\s*=\s*0/.test(SRC) &&
  /volatile\s+uint32_t\s+s_skip/.test(SRC) && /volatile\s+uint32_t\s+s_drop/.test(SRC));

/* ---------- ⑤ 保底通道语义不变 ---------- */
console.log('\n⑤ 串口保底通道与「WiFi 未连接」语义不变');
check('send_frame 仍然把每帧打印到 USB 串口', /printf\(\s*"%s\\n"\s*,\s*body\s*\)/.test(sendFrame));
check('WiFi 未连接时仍然 s_skip++ 并限频提示',
  /wifi_wait\(0\)/.test(sendFrame) && /s_skip\s*\+\+/.test(sendFrame) && /WIFI_OFF_LOG_MS/.test(sendFrame));
check('WiFi 未连接时不入队（不入队就不会被当作待传帧）',
  (() => {
    const i = sendFrame.indexOf('wifi_wait(0)');
    const j = sendFrame.indexOf('xQueueSend');
    return i >= 0 && j > i;
  })());

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
