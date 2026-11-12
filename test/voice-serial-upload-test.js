'use strict';
/**
 * 语音「走 USB 串口回传」的回归测试（第 5 周补充）
 *
 * 背景：录音在板端（I2S MEMS 麦克风）采集，完成后原来只能靠 WiFi 把 WAV
 * POST 到 /api/voice/audio。板端 WiFi 连不上时，WAV 一个字节都传不回来，
 * 页面只能看到「上传失败 / 未上传」。本测试锁住新增的串口回传通道：
 *
 *   板端 → {"type":"voice_begin", bytes, duration_ms, ...}
 *        → {"type":"voice_chunk", seq, data:"<base64>"} × N
 *        → {"type":"voice_end", chunks}
 *   服务端 → 拼回二进制 → 复用原有落盘 + 电平分析 + 事件链路
 *
 * 分两部分：
 *   ① 组装器 voice-serial-rx.js 的行为测试（真跑，可二进制往返）
 *   ② 服务端与固件的静态契约（防止有人把通道改回「只走 WiFi」）
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS ' + label + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.error('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}

/* ------------------------------------------------------------------ */
/* ① 组装器行为测试                                                    */
/* ------------------------------------------------------------------ */
console.log('\n① 串口语音组装器 voice-serial-rx.js');

const { createVoiceRx } = require(path.join(ROOT, 'voice-serial-rx.js'));

function makePayload(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + 11) & 0xff;   // 含 0x00 / 0xFF，验二进制不被破坏
  return b;
}

{
  const rx = createVoiceRx({ maxBytes: 1024 * 1024, timeoutMs: 30000, maxChunks: 2048 });
  const payload = makePayload(5000);
  const begin = rx.handle({ type: 'voice_begin', bytes: payload.length, duration_ms: 312 });
  ok(begin && begin.status === 'begin', 'begin 被接受', JSON.stringify(begin));

  const CHUNK = 1536;
  for (let off = 0, seq = 0; off < payload.length; off += CHUNK, seq++) {
    const slice = payload.subarray(off, Math.min(off + CHUNK, payload.length));
    const r = rx.handle({ type: 'voice_chunk', seq, data: slice.toString('base64') });
    assert.strictEqual(r.status, 'chunk', 'chunk 应被接受');
  }
  const end = rx.handle({ type: 'voice_end', chunks: Math.ceil(payload.length / CHUNK) });
  ok(end && end.status === 'done', 'end 返回 done');
  ok(!!end && Buffer.compare(end.data, payload) === 0, '拼回的二进制与原字节完全一致',
    end ? end.data.length + ' 字节' : '无结果');
  ok(!!end && end.data.length === 5000, '长度正确', end ? String(end.data.length) : '-');
}

{
  const rx = createVoiceRx({ maxBytes: 1000, timeoutMs: 30000, maxChunks: 2048 });
  const r = rx.handle({ type: 'voice_begin', bytes: 5000 });
  ok(r.status === 'error' && r.error === 'too_large', '声明字节数超限被拒绝', JSON.stringify(r));
}

{
  const rx = createVoiceRx({ maxBytes: 1024 * 1024, timeoutMs: 30000, maxChunks: 2048 });
  const r = rx.handle({ type: 'voice_chunk', seq: 0, data: 'AAAA' });
  ok(r.status === 'error' && r.error === 'no_begin', '没有 begin 的 chunk 被拒绝', JSON.stringify(r));
  const r2 = rx.handle({ type: 'voice_end' });
  ok(r2.status === 'error' && r2.error === 'no_begin', '没有 begin 的 end 被拒绝', JSON.stringify(r2));
}

{
  const rx = createVoiceRx({ maxBytes: 1024 * 1024, timeoutMs: 1000, maxChunks: 2048 });
  rx.handle({ type: 'voice_begin', bytes: 100 }, 1000);
  const r = rx.handle({ type: 'voice_chunk', seq: 0, data: Buffer.from('abc').toString('base64') }, 2500);
  ok(r.status === 'error' && r.error === 'timeout', '中途超时后作废（不把半截当录音）', JSON.stringify(r));
}

{
  const rx = createVoiceRx({ maxBytes: 1024 * 1024, timeoutMs: 30000, maxChunks: 3 });
  rx.handle({ type: 'voice_begin', bytes: 4000 });
  let sawTooMany = null;
  for (let i = 0; i < 5; i++) {
    const r = rx.handle({ type: 'voice_chunk', seq: i, data: Buffer.from('xxxx').toString('base64') });
    if (r.status === 'error' && r.error === 'too_many_chunks') sawTooMany = r;
  }
  ok(!!sawTooMany, '分块数超限被拒绝', JSON.stringify(sawTooMany));
}

{
  const rx = createVoiceRx({ maxBytes: 1024 * 1024, timeoutMs: 30000, maxChunks: 2048 });
  const a = makePayload(10);
  rx.handle({ type: 'voice_begin', bytes: a.length });
  rx.handle({ type: 'voice_chunk', seq: 0, data: a.toString('base64') });
  const first = rx.handle({ type: 'voice_end' });
  ok(first.status === 'done' && first.data.length === 10, '一次完整会话正常结束');
  const stray = rx.handle({ type: 'voice_chunk', seq: 0, data: a.toString('base64') });
  ok(stray.status === 'error' && stray.error === 'no_begin', '结束后状态已复位，不带残留缓冲');
}

/* ------------------------------------------------------------------ */
/* ② 服务端 / 固件静态契约                                              */
/* ------------------------------------------------------------------ */
console.log('\n② 服务端与固件契约');

const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const fw = fs.readFileSync(path.join(ROOT, 'firmware', 's3eye_imu_idf', 'main', 'voice_record.c'), 'utf8');

ok(/require\(['"]\.\/voice-serial-rx\.js['"]\)/.test(serverSrc), 'server.js 引入 voice-serial-rx.js');
ok(/voice_begin/.test(serverSrc) && /voice_chunk/.test(serverSrc) && /voice_end/.test(serverSrc),
  'server.js 处理三种串口语音帧');
ok(/function ingestVoiceWav\(/.test(serverSrc), '存在共享的 ingestVoiceWav()（HTTP 与串口共用落盘链路）');
ok(/(\/api\/voice\/audio'[\s\S]{0,4000}?ingestVoiceWav\()/.test(serverSrc), 'HTTP 上传入口复用 ingestVoiceWav()');
ok(/transport:\s*'serial'/.test(serverSrc) || /transport\s*[:=]\s*'serial'/.test(serverSrc),
  '串口来的录音标注 transport=serial（不冒充 WiFi）');

ok(/static bool voice_upload_serial\(/.test(fw), '固件存在 voice_upload_serial()');
ok(/static (?:size_t|void|int) b64_encode\(/.test(fw), '固件自带 base64 编码器');
ok(/"\{\\"type\\":\\"voice_begin\\""/.test(fw) || /voice_begin/.test(fw), '固件发送 voice_begin');
ok(/voice_chunk/.test(fw) && /voice_end/.test(fw), '固件发送 voice_chunk / voice_end');
ok(/VOICE_SERIAL_CHUNK/.test(fw), '分块大小有具名常量');
ok(/if \(!wifi_wait\(0\)\)[\s\S]{0,200}?voice_upload_serial\(/.test(fw),
  'WiFi 未连接时走串口而不是直接失败');
ok(/printf\(/.test(fw), '串口通道用 printf 输出到 USB 串口');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
