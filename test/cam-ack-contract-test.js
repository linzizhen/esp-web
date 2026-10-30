'use strict';
/* 摄像头「下发 ≠ 已接受」契约（静态检查，0.1s，不起服务、不碰硬件）
 *
 * 存在理由（2026-10-30 实测）：
 *   用户报「摄像头也不能实时显示了，无法打开」。
 *   探针 `POST /api/cam {action:'start'}` 返回 {"ok":true,"streaming":true}，
 *   而同一时刻板端回执是 {"type":"ack","status":"no_camera"} —— 也就是
 *   esp_camera_init() 在上电时就没成功，摄像头从未可用。
 *
 *   服务端当时用 sendCommand()（只把命令写进串口，不等回执），
 *   于是网页显示「正在直播」、用户对着黑屏等超时，日志里一句解释都没有。
 *   这与第 5 周语音链路修过的是同一个缺陷（下发成功 ≠ 板端接受），
 *   只是当时只修了语音那几条路由。
 *
 * 这类缺陷单看接口返回值永远是成功的，只能靠静态契约 + 回执语义断言拦住。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const MAIN_C = fs.readFileSync(
  path.join(ROOT, 'firmware', 's3eye_imu_idf', 'main', 'main.c'), 'utf8');
const CAM_C = fs.readFileSync(
  path.join(ROOT, 'firmware', 's3eye_imu_idf', 'main', 'cam_stream.c'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* 取 /api/cam 的 POST 处理器源码，避免把文件里别处的 sendCommand 误当成本路由的写法 */
function camPostBlock(src) {
  const start = src.indexOf("if (p === '/api/cam' && req.method === 'POST')");
  if (start < 0) return '';
  const end = src.indexOf("if (p === '/api/cam/", start);
  return src.slice(start, end > start ? end : start + 4000);
}
const camPost = camPostBlock(SERVER);

console.log('\n— 摄像头下发/回执契约 —\n');

/* ---- 服务端：必须等回执，不能把「写进串口」当成功 ---- */
check('找到 /api/cam 的 POST 处理器（契约本身有效）', camPost.length > 200,
  camPost ? `${camPost.length} 字符` : '未找到，断言无从校验');

check('/api/cam 用 sendCommandAndWaitAck 等板端回执',
  /sendCommandAndWaitAck\s*\(/.test(camPost),
  /sendCommandAndWaitAck\s*\(/.test(camPost) ? '' : '仍用 sendCommand：板子回 no_camera 也会报 ok=true');

check('/api/cam 为命令生成 request_id（否则等不到回执）',
  /\.request_id\s*=\s*newRequestId\s*\(\s*\)/.test(camPost),
  /newRequestId\s*\(\s*\)/.test(camPost) ? '' : '缺 request_id 时 sendCommandAndWaitAck 直接返回 no_request_id');

check('/api/cam 不再直接把 sendCommand 的返回值当 ok',
  !/const\s+ok\s*=\s*sendCommand\s*\(/.test(camPost),
  /const\s+ok\s*=\s*sendCommand\s*\(/.test(camPost) ? '仍在用 sendCommand 的返回值' : '');

check('/api/cam 识别板端拒绝（no_camera）并据此判失败',
  /no_camera/i.test(camPost) && /boardRejected/.test(camPost),
  /no_camera/i.test(camPost) ? '' : '没有把 no_camera 回执当成失败');

check('/api/cam 把回执原文透出（ack_status）',
  /ack_status\s*:/.test(camPost) && /camError\s*:/.test(camPost),
  '前端要靠这两个字段说人话');

check('/api/cam 支持 retry 动作 → cam_retry 命令',
  /'cam_retry'/.test(camPost) && /action\s*===\s*'retry'/.test(camPost),
  /cam_retry/.test(camPost) ? '' : '没有重试初始化摄像头的入口');

check('streaming 只在板端确认后才为 true',
  /state\.camStreaming\s*=\s*ok\s*;/.test(camPost),
  /state\.camStreaming\s*=\s*ok\s*;/.test(camPost) ? '' : '仍在本地假设 streaming=true');

/* ---- 服务端：ack 解析与状态记账 ---- */
check('存在 noteCamAck(status, requestId) 并接进 handleLine 的 ack 分支',
  /function\s+noteCamAck\s*\(/.test(SERVER) && /noteCamAck\s*\(\s*obj\.status/.test(SERVER),
  /noteCamAck\s*\(\s*obj\.status/.test(SERVER) ? '' : 'ack 只被 settlePendingAck 消费，摄像头状态没人记');

check('no_camera 回执会把 cam.error 写下来',
  /cam\.error\s*=\s*s/.test(SERVER),
  /cam\.error\s*=\s*s/.test(SERVER) ? '' : 'camError 永远是 null');

check('cam_init_ok 回执会清掉 cam.error',
  /cam\.error\s*=\s*null/.test(SERVER),
  /cam\.error\s*=\s*null/.test(SERVER) ? '' : '重试成功后仍会显示旧错误');

check('GET /api/cam 返回 camError 与 boardAck',
  /camError\s*:\s*cam\.error/.test(SERVER) && /boardAck\s*:\s*cam\.lastAck/.test(SERVER),
  '前端刷新时要能拿到板端态度');

/* ---- 前端：说人话 + 给重试入口 ---- */
check('前端有 camErrorText() 把 errno 翻成人话',
  /function\s+camErrorText\s*\(/.test(APP),
  /camErrorText/.test(APP) ? '' : '只能把 0x105 原样丢给用户');

check('camErrorText 覆盖 ESP_ERR_NOT_FOUND / TIMEOUT 等关键码',
  /0x106/.test(APP) && /0x108/.test(APP) && /0x102/.test(APP),
  '至少 NO_MEM / NOT_FOUND / TIMEOUT 三种要能对上');

check('前端记录 CAM.camError 与 CAM.boardAck',
  /CAM\.camError\s*=\s*d\.camError/.test(APP) && /CAM\.boardAck\s*=\s*d\.boardAck/.test(APP));

check('renderCam 在板端不可用时改说「板端无摄像头」',
  /broken/.test(APP) && /板端无摄像头/.test(APP),
  /板端无摄像头/.test(APP) ? '' : '仍会显示「等待首帧」，让用户误以为在载入');

check('板端不可用时占位文案带 errno 与排查指引',
  /摄像头没能初始化/.test(APP) && /排线/.test(APP) && /PSRAM/.test(APP),
  '文案要指向硬件，否则用户会去查网络');

check('「重试初始化摄像头」按钮存在且只在不可用时显示',
  /id="btnCamRetry"/.test(HTML) && /btnCamRetry\.classList\.toggle\('hidden'/.test(APP),
  /id="btnCamRetry"/.test(HTML) ? '' : 'index.html 里没有按钮');

check('按钮已绑定到 camControl(\'retry\')',
  /btnCamRetry\.onclick\s*=\s*\(\)\s*=>\s*camControl\('retry'\)/.test(APP));

check('camControl 处理 retry 分支（含成功文案）',
  /camControl\s*\(\s*'retry'\s*\)/.test(APP) && /重试初始化成功/.test(APP));

check('camControl 在 no_camera 时明确排除「网络问题」',
  /这不是网络问题/.test(APP),
  /这不是网络问题/.test(APP) ? '' : '用户会把摄像头故障误判成网络问题');

check('.tag-err 样式已定义（板端不可用要与「未开启」区分开）',
  /\.tag-err\s*\{/.test(CSS),
  /\.tag-err\s*\{/.test(CSS) ? '' : 'class 会被赋上但没有任何样式');

/* ---- 固件：errno 要能传出来，且能重试 ---- */
check('固件 cam_ack_unavailable() 把 errno 拼进回执',
  /cam_ack_unavailable/.test(MAIN_C) && /no_camera 0x%x/.test(MAIN_C),
  /no_camera 0x%x/.test(MAIN_C) ? '' : '仍只回一句 no_camera，服务端无法区分原因');

check('固件 cam_retry 命令会重试初始化并更新 s_cam_ok',
  /cam_retry/.test(MAIN_C) && /cam_stream_retry_init\s*\(\s*\)/.test(MAIN_C) && /s_cam_ok\s*=\s*ok/.test(MAIN_C));

check('cam_stream 有初始化重试、并暴露 init_err',
  /cam_stream_retry_init/.test(CAM_C) && /cam_stream_init_err/.test(CAM_C) && /CAM_INIT_RETRIES/.test(CAM_C));

check('固件单键求助：只由 HELP_KEY_ADC 那一颗键触发',
  /HELP_KEY_ADC/.test(MAIN_C) && /s_key_adc\[\s*idx\s*\]\s*==\s*HELP_KEY_ADC/.test(MAIN_C),
  /HELP_KEY_ADC/.test(MAIN_C) ? '' : '仍然任意键都触发求助');

check('按键判据是「最近邻归类」而不是「低于阈值」',
  /key_adc_index\s*\(/.test(MAIN_C) && !/bool\s+p\s*=\s*\(\s*v\s*<\s*th\s*\)/.test(MAIN_C),
  /bool\s+p\s*=\s*\(\s*v\s*<\s*th\s*\)/.test(MAIN_C) ? '旧的阈值判据还在（任意键都会命中）' : '');

/* ---- 版本号：改了前端就要让浏览器拿到新文件 ---- */
const verMatch = /app\.js\?v=(\d+)/.exec(HTML);
check('index.html 的 app.js 版本号 >= 35（本次改动要能加载到）',
  !!verMatch && Number(verMatch[1]) >= 35,
  verMatch ? `v=${verMatch[1]}` : '找不到版本号');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);