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
 * 【语义变更（第 5 周收尾，2026-10-26）】POST /api/voice/record 的 ok 不再是
 * 「命令写进了串口」，而是「板端已接受」：
 *   · 服务端改为按 request_id 等板端 ack（默认 1800ms）后再回话；
 *   · 返回体把 dispatched（确实写进了通道）与 accepted（板端确认接受）分开，
 *     并用 outcome ∈ accepted | busy | error | timeout | channel_unavailable
 *     | mock | no_request_id 说明结局。
 * 本文件据此改造：命令分流按 outcome 判断（不再只看 ok），busy 才退避重试；
 * 第 ⑥ 节由「登记已知缺口」改为「正向验证修复生效」。
 *
 * 前置条件（缺一即 skip，绝不假通过）：
 *   1. 开发板已烧录含 voice_record 命令的固件并连在串口上
 *   2. 服务端已在 8080 运行且 transport=serial（真实串口，非 mock）
 *   3. 板端与电脑在物理世界中：录音时需有人在麦克风附近发声，
 *      否则 silent_hint 为 true，本测试会如实报告「录到静音」而不是失败
 *
 * 用法：node test/voice-hil.js
 *       node test/voice-hil.js --speak   （提示你在 6 秒内对着板子说话）
 *
 * 【口径已统一（2026-10-28 修复，别按旧印象理解）】第 ② 节拿服务端自报的
 * rms_dbfs 与本地全量解码比对，判据 <2 dB（未放宽）。此前服务端回读路径
 * （readVoiceAudioMeta）只读文件前 64 KB 做电平抽样，6 秒录音约 190 KB 即
 * 只看前 ~2 秒，两边天然对不上；现已改为按 wav 头里的 data 段流式分块读全量
 * PCM（内存占用恒为 64 KB 一块），与本地全量计算应当逐位接近。
 * 若这条断言又红了，失败信息里会附「前 64 KB 窗口的 RMS」：若两边的差正好
 * 等于该窗口与整段的差，说明服务端退回只读前 64 KB 的旧口径（回归了）。
 */
const http = require('node:http');

const BASE = process.env.VOICE_HIL_BASE || 'http://127.0.0.1:8080';
const SPEAK = process.argv.includes('--speak');

let pass = 0, fail = 0, skip = 0;
/* 是否真的跑到了录音验证（前置条件全过）。只用于 summary() 措辞：
 * 没跑到就不许打「通过」，否则无板时的 exit 0 会被当成绿灯读。 */
let concluded = false;
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
 * 【定位变化（第 5 周收尾）】服务端现在自己也会等板端 ack 并回报 outcome，
 * 但本函数保留为**二次独立复核**：服务端说 accepted，不代表它读到的 ack 一定
 * 属于这次命令（比如串口上来了同 request_id 的残留行，或服务端改坏了）。
 * 直接从串口原文里再确认一遍，是「不信服务端自报」的一贯做法。
 *
 * 固件行为（voice_record.c:571 voice_record_toggle）：s_uploading 为真时
 * 直接 return false（"正在上传上次录音，本次按键忽略"），main.c:1385 据此
 * 回 cmd_ack(rid, "busy") —— 命令被板端丢弃。
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

/* 发一次录音命令并核对结局；板端 busy（上一轮还在上传）时退避重试。
 *
 * 【为什么不能只看 ok】服务端把 ok 定义成「板端已接受」，板端 busy 时
 * ok=false —— 若照旧 `if (!r.json.ok) return 失败`，重试分支永远走不到，
 * 整个 HIL 在板子恰好忙的时候白跑一趟。所以按 outcome 分流：
 *
 *   accepted            → 成功；再用 waitAck() 二次独立复核板端回执
 *   busy                → 退避重试（板端明确说「在忙，这条丢了」，重发有意义）
 *   timeout             → 只重试一次（ack 可能丢在路上，板端未必没做）
 *   error               → 直接失败（板端明确拒绝/执行失败，重发只会再失败）
 *   channel_unavailable → 直接失败（命令根本没写出去，重发也不会变好）
 *   mock                → 直接失败（模拟模式不算真机证据）
 *   no_request_id       → 直接失败（没法与板端回执配对，属于服务端缺陷）
 *
 * 返回 { ok, outcome, ack, attempts, resp, retried }：
 *   ok    —— 仅 outcome==='accepted' 时为 true
 *   ack   —— 从 raw 里复核到的板端回执状态（null = 没抓到，不算失败）
 */
async function sendRecordCommand(action, { tries = 6, gapMs = 1200 } = {}) {
  let timeoutRetried = false;
  let lastOutcome = null;
  let lastResp = null;
  for (let i = 1; i <= tries; i++) {
    const r = await req('POST', '/api/voice/record', { action });
    lastResp = r.json;
    const j = r.json;
    if (!j) {
      return { ok: false, outcome: 'no_response', ack: null, attempts: i, resp: null };
    }
    lastOutcome = j.outcome || (j.ok ? 'accepted' : 'unknown');

    if (lastOutcome === 'accepted') {
      /* 二次独立复核：从串口原文确认板端真的回了这条 request_id 的 ack。
       * 抓不到 ack 不判失败（raw 是 60 行环形缓冲，采样帧会把它冲掉），
       * 但若抓到了且明确是 busy/error，说明服务端判定有误 —— 判失败。 */
      const ack = await waitAck(j.request_id, 2500);
      if (ack === 'busy' || ack === 'error') {
        return { ok: false, outcome: 'ack_mismatch', ack, attempts: i, resp: j };
      }
      return { ok: true, outcome: 'accepted', ack, attempts: i, resp: j };
    }

    if (lastOutcome === 'busy') {
      console.log(`    · 板端还在上传上一段录音（outcome=busy，dispatched=${j.dispatched}），` +
        `${gapMs}ms 后重试 ${i}/${tries}`);
      await sleep(gapMs);
      continue;
    }

    if (lastOutcome === 'timeout') {
      if (timeoutRetried) {
        return { ok: false, outcome: 'timeout', ack: null, attempts: i, resp: j, retried: true };
      }
      timeoutRetried = true;
      console.log(`    · 命令已写出但 ${j.timeout_ms || '?'}ms 内没收到板端回执` +
        `（outcome=timeout，dispatched=${j.dispatched}），重试一次以排除 ack 丢失`);
      await sleep(gapMs);
      continue;
    }

    // error / channel_unavailable / mock / no_request_id：重发无意义，立即失败
    return { ok: false, outcome: lastOutcome, ack: null, attempts: i, resp: j };
  }
  return { ok: false, outcome: lastOutcome || 'busy', ack: null, attempts: tries, resp: lastResp };
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

/* 只取 WAV 的 data 段前 maxBytes 字节算 RMS（dBFS）。
 * 用途：复现服务端「只读前 64 KB」的**旧**抽样口径，仅作回归诊断——
 * 该口径已于 2026-10-28 修掉（现在服务端流式读全量 PCM），保留此函数是为了
 * 在断言变红时一眼看出「服务端是否退回了旧口径」，不是为了改判据。 */
function prefixRmsDb(buf, maxBytes) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  let off = 12, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = Math.min(sz, buf.length - dataOff); break; }
    off += 8 + sz + (sz % 2);
  }
  if (dataOff < 0) return null;
  // 服务端按每 32 字节（16 个样本）取 1 个样本抽样
  const end = Math.min(buf.length, dataOff + dataLen, dataOff + Math.max(0, maxBytes));
  let sum = 0, n = 0;
  for (let i = dataOff; i + 1 < end; i += 32) {
    const v = buf.readInt16LE(i);
    sum += v * v;
    n++;
  }
  if (!n) return null;
  const rms = Math.sqrt(sum / n);
  return rms <= 0 ? -Infinity : 20 * Math.log10(rms / 32768);
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
  /* 前置条件不满足一律记 skip 而不是 fail（2026-10-29 修正）。
   * 原实现把「板端没连」记成 ✗ 并 exit 1，与文件头「缺条件就 skip」的承诺矛盾：
   * 没有板子时本测试给不出任何关于录音能力的结论，报红只会训练人忽略红灯
   * （同 fps-baseline-test.js「跳过 ≠ 通过」的处置原则）。 */
  if (!connected) {
    skipped('板端已连接', `connected=false（transport=${transport}）—— 本测试需要真实板子，无板时不产生结论`);
    skipped('后续真机断言', '板端未连接，无法验证真实录音');
    summary();
    return;
  }
  ok(connected, '板端已连接', `transport=${transport}`);
  if (transport !== 'serial') {
    skipped('后续真机断言', `transport=${transport}（本测试要求真实串口，mock 不算）`);
    summary();
    return;
  }
  concluded = true;   // 前置条件全过，后面才真的验录音能力

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
    startR.ok
      ? `outcome=${startR.outcome} ack=${startR.ack || '(未捕获)'} 第 ${startR.attempts} 次`
      : `outcome=${startR.outcome} 第 ${startR.attempts} 次` +
        (startR.resp && startR.resp.note ? `：${startR.resp.note}` : ''));
  if (!startR.ok) {
    /* 区分「板端一直忙」与「通道/服务端问题」——两者对使用者的含义完全不同 */
    const why = startR.outcome === 'busy'
      ? '板端持续忙（上一轮上传未结束），本次无法验证录音'
      : `命令未被板端接受（outcome=${startR.outcome}）`;
    skipped('录音断言', why);
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
  // 语义已变：ok 现在等价于 accepted（板端确认接受），比旧实现更强
  ok(stopR.json && stopR.json.ok, '结束录音命令已被板端接受',
    stopR.json ? `outcome=${stopR.json.outcome} ack=${stopR.json.ack_status || '-'}` +
      ` waited=${stopR.json.waited_ms ?? '-'}ms` : '');

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
      /* 诊断信息：历史缺陷是服务端回读路径只读文件前 64 KB 做电平抽样
       * （headLen = min(65536, size)），6 秒录音约 190 KB，即服务端只看了前
       * 约 2 秒。该缺陷已于 2026-10-28 修复（改为流式读全量 PCM），这条断言
       * 正常情况下应当绿。若又红了，把「前 64 KB 窗口」的 RMS 打出来：若两边
       * 的差正好等于该窗口与整段的差，即说明旧口径回归了。 */
      const prefixDb = prefixRmsDb(wav.buf, 65536);
      const prefixNote = (prefixDb != null && Math.abs(prefixDb - a.rmsDb) >= 1.0)
        ? `（前 64 KB ≈ 前 ${Math.round(65536 / 2 / (a.sampleRate || 16000) * 1000)} ms 的 RMS ` +
          `${prefixDb.toFixed(1)} dBFS，与整段差 ${Math.abs(prefixDb - a.rmsDb).toFixed(1)} dB；` +
          `若服务端报的值接近该窗口值，说明它退回只读前 64 KB 的旧口径）`
        : '';
      ok(diff < 2.0, '服务端 RMS 与本地独立计算一致（<2 dB）',
        `服务端 ${latest.rms_dbfs.toFixed(1)} vs 本地 ${a.rmsDb.toFixed(1)}${prefixNote}`);
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

  /* ---------- ⑤ 通道不可用时不得谎报已下发 ----------
   * 注意耗时：第 5 周收尾后本接口要等板端 ack，板端在线时通常 <100ms 返回，
   * 但通道不可用/板端不回执时会一直等到超时（默认 1800ms，可用
   * COMMAND_ACK_TIMEOUT_MS 调整）——所以本节比改造前慢，属预期。
   * 断言逻辑不变：ok=false 时必须给中文原因；ok=true 时必须说明走哪条通道。 */
  console.log('\n— ⑤ 通道不可用时不得谎报已下发 —');
  const recAgain = await req('POST', '/api/voice/record', { action: 'toggle' });
  ok(recAgain.json && typeof recAgain.json.ok === 'boolean',
    '返回明确的 ok 布尔值（不模糊）', recAgain.json ? `ok=${recAgain.json.ok}` : '');
  ok(recAgain.json && typeof recAgain.json.dispatched === 'boolean',
    'dispatched 与 accepted 分开报告（写出 ≠ 板端接受）',
    recAgain.json ? `dispatched=${recAgain.json.dispatched} accepted=${recAgain.json.accepted}` : '');
  ok(recAgain.json && typeof recAgain.json.outcome === 'string',
    '给出可判定的 outcome（不只有布尔）', recAgain.json && recAgain.json.outcome);
  if (recAgain.json && !recAgain.json.ok) {
    ok(!!recAgain.json.note, '未送达/未被接受时给出中文原因', recAgain.json.note);
  } else {
    ok(recAgain.json.channel === 'serial' || recAgain.json.channel === 'wifi',
      '送达时说明走的是哪条通道', recAgain.json.channel);
    // 收尾：把这次 toggle 触发的录音停掉，避免板端一直录
    await sleep(500);
    const stopAgain = await req('POST', '/api/voice/record', { action: 'stop' });
    ok(stopAgain.json && typeof stopAgain.json.ok === 'boolean',
      '收尾 stop 也返回明确结局', stopAgain.json ? `outcome=${stopAgain.json.outcome}` : '');
  }

  /* ---------- ⑥ 命令下发 ≠ 板端已接受：正向验证修复已生效 ----------
   * 历史：2026-10-26 实测 stop 后 200ms 内再 start，固件
   * voice_record_toggle() 因 s_uploading 直接 return false 并回 ack=busy，
   * 而服务端仍报 ok=true / accepted=true —— 本节当时是「登记缺口，不判失败」。
   *
   * 第 5 周收尾已修复（服务端改为按 request_id 等板端 ack）。本节随之改为
   * **正向验证**：用真机确认「板端忙时不再谎报成功」。若这里仍出现
   * 「outcome=busy 却 ok=true」，说明修复没生效，必须判失败，不是 skip。 */
  console.log('\n— ⑥ 命令下发 ≠ 板端已接受（正向验证修复生效）—');

  /* ⑥-a 板端空闲：必须 accepted，且 ack_status 是板端真实回执。
   * 复用 sendRecordCommand 的退避重试 —— 上一节可能留下上传任务，
   * 直接打一次很可能撞在忙窗口里，那是环境问题不是缺陷。 */
  const idle = await sendRecordCommand('start');
  ok(idle.ok, '⑥-a 板端可受理时命令被接受（等到了板端回执）',
    `outcome=${idle.outcome} 第 ${idle.attempts} 次`);
  if (idle.ok) {
    const ij = idle.resp || {};
    ok(ij.outcome === 'accepted', '⑥-a 受理时 outcome=accepted', ij.outcome);
    ok(ij.dispatched === true, '⑥-a 受理时 dispatched=true（命令确实写进通道）',
      String(ij.dispatched));
    ok(ij.accepted === true, '⑥-a 受理时 accepted=true', String(ij.accepted));
    ok(ij.ok === ij.accepted, '⑥-a ok 与 accepted 同义（旧调用方仍可用）',
      `ok=${ij.ok} accepted=${ij.accepted}`);
    ok(typeof ij.ack_status === 'string' && ij.ack_status.length > 0,
      '⑥-a ack_status 是板端真实回执（不是服务端自造）', `ack_status=${ij.ack_status}`);
    ok(typeof ij.waited_ms === 'number' && ij.waited_ms >= 0,
      '⑥-a 报告了等回执耗时', `${ij.waited_ms}ms（超时上限 ${ij.timeout_ms}ms）`);
    // 服务端说 accepted，再从串口原文独立复核一次
    const reAck = await waitAck(ij.request_id, 2000);
    ok(reAck === null || (reAck !== 'busy' && reAck !== 'error'),
      '⑥-a 串口原文里的回执与 outcome=accepted 一致',
      reAck === null ? 'raw 缓冲已冲掉，跳过比对' : `raw ack=${reAck}`);

    /* ⑥-b 板端忙：结束录音立刻触发上传，s_uploading=true 期间再下发。
     * 固件此时 voice_record_toggle() 直接 return false → 回 ack=busy。
     *
     * 【注意 toggle 语义】固件 main.c:1377 收到 cmd=voice_record 时只调
     * voice_record_toggle()，**不区分 action**（服务端也只在日志里用 action）。
     * 所以这里的 start/stop 实际是「切换」：板端在录音时发 start 会结束录音。
     * 下面的循环正是靠这一点反复制造上传窗口，改固件若引入真正的 start/stop
     * 语义，这段要跟着改。
     *
     * 【这一步不是判据】它只是「制造忙窗口」的准备动作，成败取决于板端当时
     * 处在录音态还是上传态：板端在录音 → accepted（并进入上传）；板端已在上传
     * → busy。两种结果都说明忙窗口就在眼前，所以这里只记录、不判失败
     * （改造前这里判 ok=true，真机上只要板端恰好在录音就会被误判为失败）。 */
    const stopForBusy = await req('POST', '/api/voice/record', { action: 'stop' });
    console.log('  · 制造忙窗口：stop → outcome=' +
      `${stopForBusy.json ? stopForBusy.json.outcome : '(无响应)'}` +
      `${stopForBusy.json && stopForBusy.json.accepted ? '（已进入上传）' : '（板端已在上传）'}`);

    /* 在上传窗口内反复下发。每轮：
     *   · outcome=busy  → 抓到目标场景，退出循环
     *   · ok=true       → 上传已结束、板端开始录音，立刻 stop 再造一个上传窗口
     * 最多试 15 秒 —— 上传耗时实测 3–27 秒，留足余量。 */
    let busy = null;
    const busyT0 = Date.now();
    while (Date.now() - busyT0 < 15000) {
      const b = await req('POST', '/api/voice/record', { action: 'start' });
      const bj = (b.json) || {};
      if (bj.outcome === 'busy') { busy = bj; break; }
      if (bj.ok === true) {
        // 板端已开始新录音 —— 停掉它，重新进入上传窗口
        await req('POST', '/api/voice/record', { action: 'stop' });
      }
      await sleep(150);
    }

    if (!busy) {
      skipped('⑥-b 板端忙时不得谎报成功',
        '15 秒内没抓到 busy 窗口（本机上传过快或上传失败未进入 s_uploading），无法构造该场景');
    } else {
      ok(busy.ok === false,
        '⑥-b 板端忙时 ok=false（修复生效：不再把「写进串口」当「板端已接受」）',
        `ok=${busy.ok}`);
      ok(busy.outcome === 'busy', '⑥-b 忙时 outcome=busy', busy.outcome);
      ok(busy.dispatched === true,
        '⑥-b 忙时 dispatched=true（命令确实写进了通道）', String(busy.dispatched));
      ok(busy.accepted === false,
        '⑥-b 忙时 accepted=false（板端明确丢弃了这条命令）', String(busy.accepted));
      ok(busy.dispatched !== busy.accepted,
        '⑥-b dispatched 与 accepted 在忙时分离（写出 ≠ 接受）',
        `dispatched=${busy.dispatched} accepted=${busy.accepted}`);
      ok(typeof busy.note === 'string' && busy.note.length > 0,
        '⑥-b 忙时给出中文原因（不是只给个 false）', busy.note);
      ok(typeof busy.ack_status === 'string' && /busy/i.test(busy.ack_status),
        '⑥-b ack_status 如实转述板端回执', `ack_status=${busy.ack_status}`);
    }

    // 收尾：等上传结束再确保板子没在录音，别把板子留在录音态
    await sleep(2000);
    const cleanup = await req('POST', '/api/voice/record', { action: 'stop' });
    ok(cleanup.json && typeof cleanup.json.ok === 'boolean',
      '⑥ 收尾 stop 返回明确结局', cleanup.json ? `outcome=${cleanup.json.outcome}` : '');
  }

  summary();

  function summary() {
    console.log('\n' + '='.repeat(64));
    if (fail === 0 && !concluded) {
      /* 前置条件没过（无板 / 非串口）时 pass 只有「服务端可达」那一两条，
       * 若仍打「真机验证通过」，就是拿没跑过的测试冒充绿灯。
       * 这里如实说「没有结论」，exit 0 是因为「没跑」不等于「跑失败」。 */
      console.log(`  没有结论：${skip} 项跳过 / ${pass} 项通过 —— 前置条件不满足，本测试未验证录音能力（跳过 ≠ 通过）`);
    } else if (fail === 0) {
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
