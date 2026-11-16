#!/usr/bin/env node
/**
 * 云端转写失败 → 回退本机离线识别（回归测试）
 *
 * 为什么要有这个测试：2026-11-16 实测云端 GLM-ASR 返回 429「余额不足或无可用资源包，请充值」，
 * 当时服务端直接把 502 抛给页面 —— 明明本机 Vosk 能把同一段录音完整识别出来，
 * 用户看到的却是「识别失败」。云端是「更好的可选路径」，不能变成单点依赖。
 *
 * 这里锁死三条语义：
 *   ① 云端失败 + 本机有文字 → 200 成功，engine 是本机引擎（不是云端的），
 *      并且 body.fallback / state.asr_fallback_reason 必须如实写明「云端失败过」——
 *      否则额度/计费问题会被「其实识别成功了」悄悄掩盖。
 *   ② 云端成功 → 200，engine 带 cloud: 前缀，uploaded=true，不许回退。
 *   ③ 云端失败 + 本机也没听出内容 → 仍报云端失败（502 + asr_failed），
 *      但把 local_fallback 尝试结果一起带出来，页面才不会显示成「什么都没试过」。
 *
 * 隔离：自建 server 实例（独立 PORT + DATA_DIR），假 ASR 服务在本进程内起，不碰 8080，
 * 也不碰真实 data/ 目录。真实语音样本用例在没有样本文件时 skip，绝不假装通过。
 */
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, `.test-data-asrfb-${process.pid}`);
const DATA_DIR_B = path.join(__dirname, `.test-data-asrfb-b-${process.pid}`);
const CONFIG_FIXTURE = path.join(__dirname, '.test-config.json');
const STUB_KEY = 'stub-key-not-real';
const STUB_MODEL = 'glm-asr-2512';

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};
const skip = (m, why) => { skipped++; console.log('  ⊘', m + (why ? '  -> ' + why : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(port, method, p, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const s = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: s == null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text || '{}'); } catch (_) { /* 非 JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('timeout', () => r.destroy(new Error(`请求超时 ${timeoutMs}ms`)));
    r.on('error', reject);
    if (s != null) r.write(s);
    r.end();
  });
}

function postBinary(port, p, buf, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'audio/wav', 'Content-Length': buf.length }, headers),
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text || '{}'); } catch (_) { /* 非 JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('timeout', () => r.destroy(new Error('上传超时')));
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function pickPort() {
  for (let p = 8090; p <= 8099; p++) if (await portFree(p)) return p;
  throw new Error('8090-8099 全被占用');
}

/* 440 Hz 正弦：本机 Vosk 不会把它听成词句（用于验证「两边都没文字」这条语义） */
function makeToneWav(durationMs, { rate = 16000, amp = 8000, freq = 440 } = {}) {
  const samples = Math.max(1, Math.round((rate * durationMs) / 1000));
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  }
  return buf;
}

/* 假 ASR 服务：mode=quota 时回真实世界见过的 429 文案 */
const stub = { mode: 'quota', hits: [], server: null, port: 0 };
function startStub() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        stub.hits.push({ path: req.url, contentType: req.headers['content-type'] || '' });
        const send = (code, obj) => {
          const b = Buffer.from(JSON.stringify(obj), 'utf8');
          res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
          res.end(b);
        };
        if (stub.mode === 'quota') {
          return send(429, { error: { code: '1113', message: '余额不足或无可用资源包,请充值。' } });
        }
        return send(200, { id: 'asr-stub-1', model: STUB_MODEL, text: '请把空调温度调到26度' });
      });
    });
    s.listen(0, '127.0.0.1', () => { stub.server = s; stub.port = s.address().port; resolve(); });
  });
}

function startServer(port, opts = {}) {
  const { dataDir = DATA_DIR, fallbackLocal = true } = opts;
  fs.mkdirSync(dataDir, { recursive: true });
  const cfgPath = path.join(dataDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FIXTURE, 'utf8'));
  cfg.mockDevice = true;
  cfg.autoDetect = false;
  cfg.autoReconnect = false;
  cfg.httpPort = port;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  const env = Object.assign({}, process.env, {
    PORT: String(port), HOST: '127.0.0.1',
    CONFIG_PATH: cfgPath,
    DATA_DIR: dataDir,
    NL_CONFIG_PATH: path.join(__dirname, '.test-nl-local-absent.json'),
    NL_ENDPOINT: '', NL_API_KEY: '',
    ASR_ENABLED: '1',                              // 本测试专测「云端开着但失败」这条路径
    ASR_ENDPOINT: `http://127.0.0.1:${stub.port}/api/paas/v4`,
    ASR_API_KEY: STUB_KEY,
    ASR_TIMEOUT_MS: '5000',
    ASR_FALLBACK_LOCAL: fallbackLocal ? '' : '0',
  });
  return spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
}

async function waitReady(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await httpReq(port, 'GET', '/api/state', undefined, 2000);
      if (r.status === 200) return true;
    } catch (_) { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}

/* 本机引擎是启动时异步探测的（要起 python 加载模型，几秒），
 * 不等它就发转写请求会读到 local_engine=null，测出来的是「没装引擎」而不是「不回退」。
 * 这里显式等到探测完成，超时则如实失败 —— 不靠 sleep 拍脑袋。 */
async function waitLocalEngine(port, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await httpReq(port, 'GET', '/api/voice/state', undefined, 3000);
      const a = r.json && r.json.asr;
      if (a && a.local_available) return a.local_engine || true;
    } catch (_) { /* 还没起来 */ }
    await sleep(400);
  }
  return null;
}

/* 本机存在真实语音样本时才跑「回退真能出文字」这条：仓库不含录音（属用户资产） */
const REAL_WAV = path.join(ROOT, 'data', 'voice', 'voice-20261113-095432-081-59e9.wav');

(async () => {
  const procs = [];
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(DATA_DIR_B, { recursive: true, force: true });
    await startStub();

    /* ============ ① 静态契约：回退逻辑必须真的存在且有顺序 ============ */
    console.log('\n① 静态契约');
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const iAny = src.indexOf('async function transcribeAny(file)');
    const iCloud = src.indexOf('async function transcribeCloud(file)');
    const iTx = src.indexOf('async function voiceTranscribe(audioId)');
    ok(iCloud > 0 && iAny > iCloud && iTx > iAny, 'transcribeCloud → transcribeAny → voiceTranscribe 的定义顺序正确',
      `${iCloud}/${iAny}/${iTx}`);
    ok(/const r = await transcribeAny\(file\);/.test(src), 'voiceTranscribe 走统一入口 transcribeAny');
    ok(/fallback: !!r\.cloud_error/.test(src), '成功返回体里带 fallback 标志（云端失败过要可见）');
    ok(/local_fallback: \{ engine:/.test(src), '两边都没文字时也带出本机尝试结果');
    ok(/ASR_FALLBACK_LOCAL/.test(src) && /fallbackLocal/.test(src), '回退开关可通过 ASR_FALLBACK_LOCAL 关闭');
    ok(/ev: 'cloud_asr_failed'/.test(src), '云端失败写入 cloud_asr_failed 事件（不静默）');
    ok(/cloud_asr_failed/.test(appSrc), '前端认识 cloud_asr_failed，不会显示成「未知事件」');
    ok(/asr_fallback_reason/.test(src) && /asr_fallback_reason/.test(appSrc),
      '回退原因从服务端状态传到前端标签');
    ok(/transcribeAny\(file\)\.then/.test(src), '录音到站后的自动转写也走统一入口（云端失败同样回退）');
    ok(/app\.js\?v=(\d+)/.test(html) && Number((html.match(/app\.js\?v=(\d+)/) || [])[1]) >= 44,
      '前端版本号已随本次改动提升（≥44）');

    /* ============ ② 云端成功：不许回退、engine 必须带 cloud: ============ */
    console.log('\n② 云端成功时不回退');
    const PORT = await pickPort();
    stub.mode = 'ok';
    const p1 = startServer(PORT);
    procs.push(p1);
    if (!await waitReady(PORT)) throw new Error('实例未就绪');
    const engA = await waitLocalEngine(PORT);
    ok(!!engA, '本机离线引擎探测完成（否则测到的只是「没装引擎」）', String(engA));
    const up1 = await postBinary(PORT, '/api/voice/audio?duration_ms=1000', makeToneWav(1000));
    ok(up1.status === 200 && up1.json && up1.json.audio_id, '先上传一段 WAV 落到隔离实例', String(up1.status));
    let r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: up1.json.audio_id });
    ok(r.status === 200 && r.json && r.json.ok === true, '云端成功 → 200 ok=true', `${r.status}`);
    ok(/^cloud:/.test(String(r.json && r.json.engine)), 'engine 标明来自云端（cloud: 前缀）', r.json && r.json.engine);
    ok(r.json && r.json.uploaded === true, 'uploaded=true：明确告诉调用方这段录音已外发');
    ok(r.json && r.json.fallback === false && r.json.cloud_error == null, '没有失败，就不许挂回退标志');
    let st = await httpReq(PORT, 'GET', '/api/voice/state');
    ok(st.json && st.json.stage === 'transcribed', '状态推进到 transcribed', st.json && st.json.stage);
    ok(st.json && !st.json.asr_fallback_reason, '状态里的回退原因为空', String(st.json && st.json.asr_fallback_reason));

    /* ============ ③ 云端 429 + 本机无文字：报云端失败，但带上本机尝试 ============ */
    console.log('\n③ 云端 429 且本机也听不出内容');
    stub.mode = 'quota';
    const up2 = await postBinary(PORT, '/api/voice/audio?duration_ms=1000', makeToneWav(1000));
    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: up2.json.audio_id });
    ok(r.status === 502 && r.json && r.json.error === 'asr_failed', '仍报 502 asr_failed（不假装成功）', `${r.status} ${r.json && r.json.error}`);
    ok(/429/.test(String(r.json && r.json.cloud_error)), 'cloud_error 里带出上游 429 与原文', String(r.json && r.json.cloud_error).slice(0, 60));
    ok(r.json && r.json.local_fallback && /^(vosk|windows_system_speech)$/.test(String(r.json.local_fallback.engine)),
      'local_fallback.engine 说明本机确实试过', r.json && JSON.stringify(r.json.local_fallback));
    ok(/本机/.test(String(r.json && r.json.reason)), 'reason 明说本机也没听出内容', String(r.json && r.json.reason).slice(0, 80));
    st = await httpReq(PORT, 'GET', '/api/voice/state');
    ok(st.json && st.json.stage === 'asr_failed', '状态落到 asr_failed', st.json && st.json.stage);

    /* ============ ④ 云端 429 + 真实语音：回退成功，文字来自本机 ============ */
    console.log('\n④ 云端 429 但本机能识别：回退出文字');
    if (!fs.existsSync(REAL_WAV)) {
      skip('真实语音样本回退', `缺少 ${path.relative(ROOT, REAL_WAV)}（属用户资产，不入库）`);
    } else {
      const wav = fs.readFileSync(REAL_WAV);
      const up3 = await postBinary(PORT, '/api/voice/audio?duration_ms=3072', wav);
      stub.hits.length = 0;
      r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: up3.json.audio_id }, 60000);
      ok(stub.hits.length > 0, '云端确实被调用过（不是直接跳过云端）', `命中 ${stub.hits.length} 次`);
      ok(r.status === 200 && r.json && r.json.ok === true, '回退后返回 200 ok=true（不再丢这次录音）', `${r.status}`);
      ok(r.json && /^(vosk|windows_system_speech)$/.test(String(r.json.engine)),
        'engine 是本机引擎（文字来自本机，不是云端）', r.json && r.json.engine);
      ok(r.json && r.json.uploaded === true, 'uploaded=true 仍如实标注（录音确实发出去过）');
      ok(r.json && r.json.fallback === true && /429/.test(String(r.json.cloud_error)),
        'fallback=true 且 cloud_error 带 429', r.json && String(r.json.cloud_error).slice(0, 50));
      ok(r.json && String(r.json.text || '').length > 0, '确实拿到了文字', r.json && String(r.json.text).slice(0, 40));
      st = await httpReq(PORT, 'GET', '/api/voice/state');
      ok(st.json && st.json.stage === 'transcribed', '状态是 transcribed（不是 asr_failed）', st.json && st.json.stage);
      ok(st.json && /^(vosk|windows_system_speech)$/.test(String(st.json.asr_engine)),
        '状态里记下引擎名（页面才能显示「本机离线识别」）', st.json && st.json.asr_engine);
      ok(st.json && /429/.test(String(st.json.asr_fallback_reason)),
        '状态里留下「云端失败过」的证据', st.json && String(st.json.asr_fallback_reason).slice(0, 40));
    }

    /* ============ ⑤ 关掉回退开关后，行为回到「纯云端」 ============ */
    console.log('\n⑤ ASR_FALLBACK_LOCAL=0 时不回退');
    const PORT_B = await pickPort();
    const p2 = startServer(PORT_B, { dataDir: DATA_DIR_B, fallbackLocal: false });
    procs.push(p2);
    if (!await waitReady(PORT_B)) throw new Error('实例 B 未就绪');
    const up4 = await postBinary(PORT_B, '/api/voice/audio?duration_ms=1000', makeToneWav(1000));
    r = await httpReq(PORT_B, 'POST', '/api/voice/transcribe', { audio_id: up4.json.audio_id });
    ok(r.status === 502 && r.json && r.json.error === 'asr_failed', '开关关闭 → 云端失败即失败（502）', `${r.status}`);
    ok(!r.json.local_fallback || !r.json.local_fallback.engine, '开关关闭 → local_fallback 不标明本机引擎',
      r.json && JSON.stringify(r.json.local_fallback || null));

    /* ============ ⑥ 引擎归属要跨阶段存活 ============ */
    /* 真机实测过这个坑：识别出文字后链路继续推进（task_running → task_done → spoken），
     * 每次 POST /api/voice/state 都会重写状态；旧实现里 asr_engine 不在「跨阶段继承」的字段里，
     * 于是「已识别」之后页面引擎标签退回成笼统的「识别」—— 文字明明是 Vosk 出的。
     * 引擎归属是「上一次识别的事实」，不该被链路推进抹掉；只有新录音（新 audio_id）才清空。 */
    console.log('\n⑥ 引擎归属跨阶段继承、新链路清空');
    {
      const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
      const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      const idxSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      ok(/asr_engine:\s*voice\.asr_engine\s*!=\s*null/.test(srvSrc),
        'voiceApply 的非新链路 base 继承 asr_engine（源码契约）');
      ok(/for\s*\(const k of \['asr_engine',\s*'asr_fallback_reason'\]\)/.test(srvSrc),
        'POST /api/voice/state 允许前端上报引擎归属（源码契约）');
      ok(/stage:\s*'transcribed'[^}]*asr_engine:\s*tr\.engine/.test(appSrc),
        '前端服务端转写分支把引擎名一起上报');
      ok(/stage:\s*'transcribed'[^}]*asr_engine:\s*'browser_speech'/.test(appSrc),
        '前端 Web Speech 分支把 engine=browser_speech 上报');
      ok(/browser_speech'?\s*\?\s*'浏览器识别（Web Speech）'/.test(appSrc),
        '页面能把 browser_speech 显示成中文引擎名');
      ok(/app\.js\?v=(\d+)/.test(idxSrc) && Number(/app\.js\?v=(\d+)/.exec(idxSrc)[1]) >= 45,
        '前端版本号已推进（app.js?v>=45）');
    }
    if (!fs.existsSync(REAL_WAV)) {
      skip('引擎归属跨阶段继承（实跑）', `缺少 ${path.relative(ROOT, REAL_WAV)}`);
    } else {
      const wav6 = fs.readFileSync(REAL_WAV);
      const up6 = await postBinary(PORT, '/api/voice/audio?duration_ms=3072', wav6);
      const aid6 = up6.json && up6.json.audio_id;
      ok(!!aid6, '⑥ 准备了一段带 audio_id 的录音', aid6);
      let s6 = await httpReq(PORT, 'POST', '/api/voice/state',
        { stage: 'transcribed', audio_id: aid6, transcript: '喂喂喂', asr_engine: 'vosk' });
      ok(s6.status === 200 && s6.json && s6.json.voice && s6.json.voice.asr_engine === 'vosk',
        'transcribed 上报引擎名被接受', s6.json && s6.json.voice && s6.json.voice.asr_engine);
      await httpReq(PORT, 'POST', '/api/voice/state',
        { stage: 'task_done', audio_id: aid6, intent: 'other', reply: '我只能帮你…' });
      let g6 = await httpReq(PORT, 'GET', '/api/voice/state');
      ok(g6.json && g6.json.stage === 'task_done' && g6.json.asr_engine === 'vosk',
        'task_done 之后引擎名仍保留（不被抹成空）', `stage=${g6.json && g6.json.stage} engine=${g6.json && g6.json.asr_engine}`);
      await httpReq(PORT, 'POST', '/api/voice/state', { stage: 'spoken', audio_id: aid6 });
      g6 = await httpReq(PORT, 'GET', '/api/voice/state');
      ok(g6.json && g6.json.stage === 'spoken' && g6.json.asr_engine === 'vosk',
        'spoken 之后引擎名仍保留', `stage=${g6.json && g6.json.stage} engine=${g6.json && g6.json.asr_engine}`);
      ok(g6.json && g6.json.reason == null, 'spoken 阶段不再挂着失败原因（不跨阶段继承）');
      const up6b = await postBinary(PORT, '/api/voice/audio?duration_ms=1000', makeToneWav(1000));
      g6 = await httpReq(PORT, 'GET', '/api/voice/state');
      ok(g6.json && g6.json.stage === 'recorded' && g6.json.asr_engine == null,
        '新录音（新 audio_id）把引擎归属清空，不串上一段', `engine=${g6.json && g6.json.asr_engine}`);
      ok(!!(up6b.json && up6b.json.audio_id) && up6b.json.audio_id !== aid6, '新录音确实是另一个 audio_id');
    }

  } catch (e) {
    fail++;
    console.error('  ✗ 异常：', e && e.stack || e);
  } finally {
    for (const p of procs) { try { p.kill(); } catch (_) { /* 已退出 */ } }
    if (stub.server) try { stub.server.close(); } catch (_) { /* 已关闭 */ }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(DATA_DIR_B, { recursive: true, force: true });
  }
  console.log(`\n结果：${pass} 项通过，${fail} 项失败${skipped ? '，' + skipped + ' 项跳过' : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})();