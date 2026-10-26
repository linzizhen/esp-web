'use strict';
/** 第 5 周：录音数据布局契约（静态检查，无需硬件）
 *
 * 回归的是 2026-10-26 真机暴露的缺陷：
 *   I2S 配成 I2S_SLOT_MODE_MONO 时，RX 侧仍按 2 slot 一帧送数据，
 *   每帧 2 个 int16，只有活动 slot 是真实采样，另一个被 auto_clear 填 0。
 *   当时固件把这批交错数据直接当单声道写进 WAV，导致：
 *     · 3 秒录音 → 6144 ms（时长翻倍、播放慢一半）
 *     · 6 秒录音 → 顶到 10000 ms 上限
 *     · 10 秒上限实际只能录 5 秒（缓冲按单声道算）
 *
 * 这些断言不替代 test/voice-hil.js（真机必须实测），但能在改固件时
 * 立刻发现"有人又把交错数据当单声道用了"——CI 里没有板子，只能靠它兜底。
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'firmware', 's3eye_imu_idf', 'main', 'voice_record.c');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};
const has = (re) => re.test(src);
const grab = (re) => { const m = src.match(re); return m ? m[1] : null; };

console.log('\n' + '='.repeat(64));
console.log('  第 5 周 录音数据布局契约（静态）');
console.log('  目标：' + path.relative(path.join(__dirname, '..'), SRC));
console.log('='.repeat(64));

console.log('\n— ① 必须声明 I2S 为 2 slot 交错 —');
const slots = grab(/#define\s+VOICE_I2S_SLOTS\s+(\d+)/);
ok(slots === '2', 'VOICE_I2S_SLOTS == 2', slots === null ? '未定义' : slots);

const rawPerMs = grab(/#define\s+VOICE_RAW_BYTES_PER_MS\s+\(([^)]*)\)/);
ok(!!rawPerMs, '定义了 VOICE_RAW_BYTES_PER_MS');
ok(has(/VOICE_BYTES_PER_MS\s*\*\s*VOICE_I2S_SLOTS/), '原始字节率 = 单声道字节率 × slot 数');

console.log('\n— ② 缓冲必须按 2 倍开，否则 10 秒上限只能录 5 秒 —');
ok(has(/#define\s+VOICE_MAX_RAW_BYTES\s+\(VOICE_MAX_RECORD_MS\s*\*\s*VOICE_RAW_BYTES_PER_MS\)/),
  'VOICE_MAX_RAW_BYTES = 上限毫秒 × 原始字节率');
ok(has(/#define\s+VOICE_MAX_PCM_BYTES\s+\(VOICE_MAX_RECORD_MS\s*\*\s*VOICE_BYTES_PER_MS\)/),
  'VOICE_MAX_PCM_BYTES 仍是去交错后的单声道字节数');
ok(has(/heap_caps_malloc\s*\(\s*VOICE_MAX_RAW_BYTES/), '按 VOICE_MAX_RAW_BYTES 分配原始缓冲');
ok(has(/static\s+uint8_t\s+\*s_raw/), '存在独立的 s_raw 缓冲（不能与 s_pcm 共用）');

console.log('\n— ③ 采集循环必须读进 s_raw，且按整帧读 —');
ok(has(/i2s_channel_read\s*\(\s*s_rx\s*,\s*s_raw\s*\+/), 'i2s_channel_read 写入 s_raw');
ok(has(/room\s*=\s*VOICE_MAX_RAW_BYTES\s*-\s*raw_total/), '循环按 raw_total 判余量');
ok(has(/want\s*-=\s*want\s*%\s*\(2\s*\*\s*VOICE_I2S_SLOTS\)/),
  '按整帧对齐（防止一帧被劈成两半导致去交错错位）');
ok(!has(/i2s_channel_read\s*\(\s*s_rx\s*,\s*s_pcm/),
  '★ 绝不能把交错数据直接读进 s_pcm（这正是当初的缺陷）');

console.log('\n— ④ 必须去交错后才算时长 / 写 WAV 头 —');
ok(has(/static\s+size_t\s+voice_deinterleave\s*\(/), '存在 voice_deinterleave()');
ok(has(/voice_deinterleave\s*\(\s*\(const\s+int16_t\s*\*\)\s*s_raw\s*,\s*raw_total\s*,\s*\(int16_t\s*\*\)\s*s_pcm\s*\)/),
  '采集结束后调用去交错，输出到 s_pcm');
const deIdx = src.indexOf('voice_deinterleave((const int16_t *)s_raw');
const minIdx = src.indexOf('total < VOICE_MIN_PCM_BYTES');
ok(deIdx > 0 && minIdx > deIdx, '过短判定用的是去交错后的 total（不是 raw_total）');
const peakIdx = src.indexOf('const int16_t *pcm = (const int16_t *)s_pcm;');
ok(peakIdx > deIdx, '峰值计算基于去交错后的 s_pcm');

console.log('\n— ⑤ 活动 slot 自动适配（左右声道接反时不能静音） —');
ok(has(/lead_even/) && has(/lead_odd/), '去交错前先探测哪一路有信号');
ok(has(/slot\s*=\s*\(lead_even\s*>=\s*lead_odd\)\s*\?\s*0\s*:\s*1/), '按探测结果选 slot');

console.log('\n— ⑥ WAV 头必须与去交错后的数据一致 —');
const hdr = grab(/static\s+void\s+wav_build_header\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
ok(!!hdr, '找到 wav_build_header');
if (hdr) {
  ok(/put_u16\s*\(\s*h\s*\+\s*22\s*,\s*VOICE_CHANNELS\s*\)/.test(hdr),
    '通道数字段写 VOICE_CHANNELS（=1）');
  ok(/put_u32\s*\(\s*h\s*\+\s*24\s*,\s*VOICE_SAMPLE_RATE\s*\)/.test(hdr),
    '采样率字段写 VOICE_SAMPLE_RATE（=16000）');
  ok(/put_u32\s*\(\s*h\s*\+\s*40\s*,\s*pcm_bytes\s*\)/.test(hdr),
    'data 长度用传入的 pcm_bytes');
}
// 上传时传入的必须是去交错后的长度
ok(has(/voice_upload\s*\(\s*pcm\s*,\s*peak\s*,\s*elapsed_ms\s*\)/), 'voice_upload 收到去交错后的 pcm 字节数');
const uploadBody = grab(/static\s+bool\s+voice_upload\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*esp_http_client_config_t/);
ok(!!uploadBody && /wav_build_header\s*\(\s*s_wav\s*,\s*\(uint32_t\)\s*pcm_bytes\s*\)/.test(uploadBody),
  'wav_build_header 用 pcm_bytes 写头');

console.log('\n— ⑦ 文档必须记下这个坑（否则下次还会踩） —');
ok(has(/数据布局/) && has(/时长翻倍/), '文件头有「数据布局」段落说明该缺陷');
ok(has(/auto_clear\s*=\s*true/) || has(/auto_clear/), '说明了空 slot 被 auto_clear 填 0');

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`  结果：${pass} 项通过，0 项失败`);
} else {
  console.log(`  ✗ ${fail} 项失败 / ${pass} 项通过`);
}
console.log('='.repeat(64));
console.log('\n  注：静态契约只能防"改回去"，真机行为请跑 node test/voice-hil.js');
process.exit(fail === 0 ? 0 : 1);
