'use strict';
/** 第 5 周：语音链路【真机】端到端验证（Hardware-In-The-Loop）
 *
 * 与 test/voice-test.js 的分工（两者互补，不可互相替代）：
 *   · voice-test.js —— 隔离实例 + 合成 WAV，验证服务端接口契约与失败分支。
 *     它证不了「板子真的能录到声音」。
 *   · 本文件 —— 打真实板子：通过 POST /api/voice/record 让固件走
 *     BOOT 键同一条 voice_record_toggle() 路径，录音 → 上传 → 落盘，
 *     再对收到的 WAV 做电平分析，证明是真实拾音而不是静音。
 *
 * 前置条件（缺一即 skip，绝不假通过）：
 *   1. 开发板已烧录含 voice_record 命令的固件并连在串口上
 *   2. 服务端已在 8080 运行且 transport=serial（真实串口，非 mock）
 *   3. 板端与电脑在物理世界中：录音时需有人在麦克风附近发声，
 *      否则 silent_hint 为 true，本测试会如实报告「录到静音」而不是失败
 *
 * 用法：node test/voice-hil.js
 *       node test/voice-hil.js --speak   （提示你在 6 秒内对着板子说话）
 */
const http = require('node:http');

const BASE = process.env.VOICE_HIL_BASE || 'http://127.0.0.1:8080';
const SPEAK = process.argv.includes('--speak');

let pass = 0, fail = 0, skip = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};
const skipped = (m, why) => { skip++; console.log('  ⊘', m + '  -> ' + why); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* 非 JSON 保持 null */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/* 把 WAV 的 data 段解码成 16bit 采样，算峰值 / RMS，与服务端算法独立实现，
 * 避免「服务端自己算自己报」的自证循环。 */
function analyzeWav(buf) {
  if (buf.length < 44) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  // 找 data 块（fmt 块可能不是 16 字节，必须按块遍历而不是硬编码偏移）
  let off = 12, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = Math.min(sz, buf.length - dataOff); break; }
    off += 8 + sz + (sz % 2);
  }
  if (dataOff < 0) return null;
  const n = Math.floor(dataLen / 2);
  if (!n) return null;
  let peak = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(dataOff + i * 2);
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / n);
  const toDb = (x) => (x <= 0 ? -Infinity : 20 * Math.log10(x / 32768));
  return {
    sampleRate, channels, bits, samples: n,
    durationMs: Math.round((n / channels) / sampleRate * 1000),
    peak, rms, peakDb: toDb(peak), rmsDb: toDb(rms),
  };
}

(async () => {
  console.log('='.repeat(64));
  console.log('  第 5 周 语音链路 · 真机端到端验证（HIL）');
  console.log('  目标：' + BASE);
  console.log('='.repeat(64));

  /* ---------- ⓪ 前置检查：缺条件就 skip，绝不假通过 ---------- */
  console.log('\n— ⓪ 前置条件 —');
  let st;
  try {
    st = await req('GET', '/api/state');
  } catch (e) {
    console.error(`\n无法连接 ${BASE}：${e.message}`);
    console.error('请先启动服务端：node server.js');
    process.exit(1);
  }
  ok(st.status === 200, '服务端可达', `HTTP ${st.status}`);
  const connected = !!(st.json && st.json.connected);
  const transport = st.json && st.json.transport;
  ok(connected, '板端已连接', `transport=${transport}`);
  if (!connected) {
    skipped('后续真机断言', '板端未连接，无法验证真实录音');
    summary();
    return;
  }
  if (transport !== 'serial') {
    skipped('后续真机断言', `transport=${transport}（本测试要求真实串口，mock 不算）`);
    summary();
    return;
  }

  const vs0 = await req('GET', '/api/voice/state');
  ok(vs0.status === 200, '语音状态接口可达');
  ok(vs0.json && vs0.json.audio_source === 'board_mic_i2s',
    '音频来源标注为板载 I2S 麦克风', vs0.json && vs0.json.audio_source);
  ok(vs0.json && vs0.json.asr_runs_on === 'browser_web_speech',
    '识别运行位置标注为浏览器', vs0.json && vs0.json.asr_runs_on);

  /* ---------- ① 真实录音：开始 → 发声 → 结束 ---------- */
  console.log('\n— ① 真机录音（板端 MEMS 麦克风 → WAV → 上传）—');
  const before = await req('GET', '/api/voice');
  const beforeTotal = (before.json && before.json.audio_total) || 0;
  const beforeId = (vs0.json && vs0.json.audio_id) || null;

  const startR = await req('POST', '/api/voice/record', { action: 'start' });
  ok(startR.json && startR.json.ok, '开始录音命令已下发',
    startR.json ? `channel=${startR.json.channel}` : `HTTP ${startR.status}`);
  if (!startR.json || !startR.json.ok) {
    skipped('录音断言', '命令通道不可用：' + (startR.json && startR.json.note));
    summary();
    return;
  }

  const REC_SEC = 6;
  if (SPEAK) {
    console.log(`\n  ▶ 请现在对着开发板麦克风说话（${REC_SEC} 秒）…\n`);
  } else {
    console.log(`  · 静默录制 ${REC_SEC} 秒（加 --speak 参数会提示你发声）`);
  }
  await sleep(REC_SEC * 1000);

  const stopR = await req('POST', '/api/voice/record', { action: 'stop' });
  ok(stopR.json && stopR.json.ok, '结束录音命令已下发');

  // 板端要压缩 + 建立 HTTP 连接 + 上传，给足 12 秒
  let after = null;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    after = await req('GET', '/api/voice');
    const aid = after.json && after.json.latest && after.json.latest.audio_id;
    if (aid && aid !== beforeId) break;
  }
  const latest = after && after.json && after.json.latest;
  ok(!!latest, '服务端收到新录音');
  if (!latest) { summary(); return; }

  ok(latest.audio_id !== beforeId, 'audio_id 是本次新录音（不是上一段旧值）',
    `${beforeId || '(无)'} → ${latest.audio_id}`);
  ok(latest.bytes > 44, 'WAV 有实际数据', `${latest.bytes} 字节`);
  ok(latest.riff === 'RIFF' && latest.wave === 'WAVE', 'WAV 头合法');
  ok(latest.sample_rate === 16000, '采样率 16000 Hz（固件约定）', String(latest.sample_rate));
  ok(latest.channels === 1, '单声道', String(latest.channels));
  ok(latest.bits === 16, '16 bit', String(latest.bits));
  // 6 秒录音允许 ±2 秒误差（板端结束检测 + 传输耗时）
  ok(latest.duration_ms >= (REC_SEC - 2) * 1000 && latest.duration_ms <= (REC_SEC + 3) * 1000,
    `时长接近 ${REC_SEC} 秒`, `${latest.duration_ms} ms`);
  ok(latest.device_id === 'S3EYE-GROUP01', '录音归属正确设备', latest.device_id);

  /* ---------- ② 独立复核音频电平（不信服务端自报） ---------- */
  console.log('\n— ② 音频电平独立复核（重新下载 WAV 自行解码）—');
  const wav = await new Promise((resolve) => {
    const u = new URL(latest.audio_url, BASE);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'], buf: Buffer.concat(cs) }));
    }).on('error', () => resolve({ status: 0, buf: Buffer.alloc(0) }));
  });
  ok(wav.status === 200, 'GET 回放成功', `HTTP ${wav.status}`);
  ok(/audio\/wav/.test(wav.ct || ''), 'Content-Type 是 audio/wav', wav.ct);

  const a = analyzeWav(wav.buf);
  ok(!!a, '本地解码 WAV 成功');
  if (a) {
    console.log(`    本地解码：${a.samples} 采样 / ${a.durationMs} ms / ` +
                `峰值 ${a.peakDb === -Infinity ? '-∞' : a.peakDb.toFixed(1)} dBFS / ` +
                `RMS ${a.rmsDb === -Infinity ? '-∞' : a.rmsDb.toFixed(1)} dBFS`);
    ok(a.durationMs > 0, '本地算出的时长 > 0', `${a.durationMs} ms`);
    // 静音是合法结果（无人说话），但必须如实区分
    const silent = a.rmsDb < -60;
    if (silent) {
      skipped('真实拾音确认', '录到静音（无人发声属正常）——请加 --speak 参数并对着板子说话复验');
    } else {
      ok(true, '录到真实声音（非静音）', `RMS ${a.rmsDb.toFixed(1)} dBFS`);
    }
    // 与服务端自报值比对：差异过大说明有一方算法有问题
    if (latest.rms_dbfs != null) {
      const diff = Math.abs(latest.rms_dbfs - a.rmsDb);
      ok(diff < 2.0, '服务端 RMS 与本地独立计算一致（<2 dB）',
        `服务端 ${latest.rms_dbfs.toFixed(1)} vs 本地 ${a.rmsDb.toFixed(1)}`);
    }
  }

  /* ---------- ③ 链路阶段推进 ---------- */
  console.log('\n— ③ 链路阶段推进 —');
  const vs1 = await req('GET', '/api/voice/state');
  ok(vs1.json && vs1.json.audio_id === latest.audio_id, '状态里的 audio_id 与新录音一致');
  ok(vs1.json && vs1.json.stage === 'recorded', '阶段推进到 recorded（已收到板端 WAV）',
    vs1.json && vs1.json.stage);
  ok(vs1.json && vs1.json.has_audio === true, 'has_audio=true');
  ok(vs1.json && typeof vs1.json.stage_text === 'string' && vs1.json.stage_text.length > 0,
    'stage_text 有中文说明', vs1.json && vs1.json.stage_text);

  /* ---------- ④ 失败分支：非法 stage 必须被拒绝 ---------- */
  console.log('\n— ④ 失败分支（真机实例上验证，不是隔离实例）—');
  const badStage = await req('POST', '/api/voice/state', { stage: 'not_a_stage' });
  ok(badStage.status === 400, '非法 stage → 400', `HTTP ${badStage.status}`);
  ok(badStage.json && badStage.json.error === 'invalid_stage', '错误码 invalid_stage');

  const noStage = await req('POST', '/api/voice/state', {});
  ok(noStage.status === 400, '缺 stage → 400');

  const badId = await req('POST', '/api/voice/state', { stage: 'transcribed', audio_id: '../../etc/passwd' });
  ok(badId.status === 400, '非法 audio_id（路径穿越）→ 400', `HTTP ${badId.status}`);

  const asrFail = await req('POST', '/api/voice/state', { stage: 'asr_failed' });
  ok(asrFail.json && asrFail.json.voice && asrFail.json.voice.reason,
    'asr_failed 未给 reason 时服务端补中文原因', asrFail.json && asrFail.json.voice.reason);

  const notFound = await req('GET', '/api/voice/audio/voice-19700101-000000-000-dead');
  ok(notFound.status === 404, '不存在的 audio_id → 404', `HTTP ${notFound.status}`);

  /* ---------- ⑤ 录音期间的失败可见性：通道关闭时不谎报 ---------- */
  console.log('\n— ⑤ 通道不可用时不得谎报已下发 —');
  const recAgain = await req('POST', '/api/voice/record', { action: 'toggle' });
  ok(recAgain.json && typeof recAgain.json.ok === 'boolean',
    '返回明确的 ok 布尔值（不模糊）', recAgain.json ? `ok=${recAgain.json.ok}` : '');
  if (recAgain.json && !recAgain.json.ok) {
    ok(!!recAgain.json.note, '未送达时给出中文原因', recAgain.json.note);
  } else {
    ok(recAgain.json.channel === 'serial' || recAgain.json.channel === 'wifi',
      '送达时说明走的是哪条通道', recAgain.json.channel);
    // 收尾：把这次 toggle 触发的录音停掉，避免板端一直录
    await sleep(500);
    await req('POST', '/api/voice/record', { action: 'stop' });
  }

  summary();

  function summary() {
    console.log('\n' + '='.repeat(64));
    if (fail === 0) {
      console.log(`  真机验证通过：${pass} 项断言${skip ? `，${skip} 项跳过` : ''}`);
    } else {
      console.log(`  ✗ ${fail} 项失败 / ${pass} 项通过${skip ? ` / ${skip} 项跳过` : ''}`);
    }
    console.log('='.repeat(64));
    process.exit(fail === 0 ? 0 : 1);
  }
})().catch((e) => {
  console.error('\n测试异常终止：', e && e.stack || e);
  process.exit(1);
});
