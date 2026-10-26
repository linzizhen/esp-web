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

/* 读 /api/state 的 raw 环形缓冲，找某个 request_id 的板端回执状态。
 *
 * 为什么必须看回执：POST /api/voice/record 的 ok=true 只表示「命令已写进串口」，
 * 不代表板端接受。固件 voice_record_toggle() 在 s_uploading 为真时直接 return false
 * （"正在上传上次录音，本次按键忽略"），此时服务端照样回 ok=true。
 * 实测（2026-10-26）：stop 后 200ms 内再 start，板端回 status:"busy"，
 * 服务端仍报 accepted=true —— 若不核对回执，测试会以为在录音，
 * 实际板端什么都没做，最后表现为「没等到新录音」的假失败。
 *
 * raw 里的元素是 {ts, text, ok} 对象，text 才是串口原文，且 ack 行在 text 里
 * 是转义过的 JSON，所以这里对序列化后的整行做宽松匹配。 */
async function waitAck(rid, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await req('GET', '/api/state');
    const raw = ((st.json && st.json.raw) || [])
      .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    for (const line of raw) {
      if (!line.includes(String(rid))) continue;
      const m = /status\\?":\\?"([a-z_]+)\\?"/.exec(line);
      if (m) return m[1];
    }
    await sleep(150);
  }
  return null;   // 没回执：板端可能没收到（通道问题），也可能 raw 缓冲已被冲掉
}

/* 发一次录音命令并核对板端回执；板端 busy（上一轮还在上传）时退避重试。
 * 返回 { ok, ack, attempts }。ack 为 null 表示没抓到回执（不当作失败，
 * 因为 raw 是 60 行环形缓冲，上传期间会被采样帧迅速冲掉）。 */
async function sendRecordCommand(action, { tries = 6, gapMs = 1200 } = {}) {
  let ack = null;
  for (let i = 1; i <= tries; i++) {
    const r = await req('POST', '/api/voice/record', { action });
    const rid = r.json && r.json.request_id;
    if (!r.json || !r.json.ok) return { ok: false, ack: null, attempts: i, resp: r.json };
    ack = await waitAck(rid, 2500);
    if (ack !== 'busy') return { ok: true, ack, attempts: i, resp: r.json };
    console.log(`    · 板端还在上传上一段录音（ack=busy），${gapMs}ms 后重试 ${i}/${tries}`);
    await sleep(gapMs);
  }
  return { ok: false, ack: 'busy', attempts: tries };
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
  const beforeId = (vs0.json && vs0.json.audio_id) || null;

  const startR = await sendRecordCommand('start');
  ok(startR.ok, '开始录音命令已下发并被板端接受',
    startR.ok ? `ack=${startR.ack || '(未捕获)'} 第 ${startR.attempts} 次` : '板端一直回 busy');
  if (!startR.ok) {
    skipped('录音断言', '板端持续忙（上一轮上传未结束），本次无法验证录音');
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

  /* 板端要结束采集 → 去交错 → 建 HTTP 连接 → 上传（约 100–200 KB，走 WiFi）。
   * 实测 stop→服务端可见 的延迟（2026-10-26，同一块板、同一台机器）：
   *   3177 / 3220 / 3460 / 4776 / 10369 / 12403 / 27196 ms
   * 跨度接近 9 倍 —— 这是 WiFi 上传本身不稳定（已知 P1：约 34% 上传失败率），
   * 不是录音丢失。原实现的 12 秒预算必然偶发假失败，故放宽到 45 秒；
   * 超时后不再笼统报「没收到」，而是把「从未收到」与「收到但 id 未变」分开诊断。 */
  const WAIT_MS = 45000;
  const t0 = Date.now();
  let latest = null;
  while (Date.now() - t0 < WAIT_MS) {
    await sleep(500);
    const r = await req('GET', '/api/voice');
    const L = r.json && r.json.latest;
    if (L && L.audio_id && L.audio_id !== beforeId) { latest = L; break; }
  }
  const waited = Date.now() - t0;

  if (!latest) {
    // 区分「服务端一直没收到新 WAV」与「收到了但被当成旧值」
    const r = await req('GET', '/api/voice');
    const cur = r.json && r.json.latest;
    fail++;
    console.error(`  ✗ ${WAIT_MS / 1000} 秒内没等到新录音` +
      `（当前 latest=${cur ? cur.audio_id : '(无)'}，测试前=${beforeId || '(无)'}）`);
    console.error('    可能原因：① 板端录音失败（看串口 VOICE 日志）' +
      ' ② WiFi 上传超时/失败（已知约 34% 失败率）' +
      ' ③ start 被 busy 拒绝后仍走了这条路径');
    summary();
    return;
  }
  if (waited > 15000) {
    console.log(`  · 本次上传耗时 ${waited}ms，明显慢于常态（3–5 秒）——` +
      'WiFi 链路抖动，不影响结论但值得关注');
  }
  ok(true, '服务端收到新录音', `${latest.audio_id}（stop 后 ${waited}ms）`);

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

  /* ---------- ⑤ 通道不可用时不得谎报已下发 ---------- */
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

  /* ---------- ⑥ 已知观测缺口：ok=true 不等于板端已接受 ----------
   * 实测（2026-10-26，见 sendRecordCommand 注释）：stop 后 200ms 内再 start，
   * 固件 voice_record_toggle() 因 s_uploading 直接拒绝并回 status:"busy"，
   * 但服务端 POST /api/voice/record 仍返回 ok=true / accepted=true。
   * 这是产品侧的可观测性缺口（服务端无法区分「已写进串口」与「板端已接受」），
   * 本次任务范围限定在 test/，只登记不修，也不判失败。 */
  console.log('\n— ⑥ 已知缺口登记（不判失败）—');
  skipped('ok=true 能否代表板端已接受',
    '否：固件 s_uploading 时回 ack=busy，服务端仍报 accepted=true；' +
    '建议服务端在 sendCommand 后等待 ack 再定论（超出本次 test/ 改动范围）');

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
