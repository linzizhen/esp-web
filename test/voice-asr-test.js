'use strict';
/** 第 5 周补强：服务端语音转写（POST /api/voice/transcribe）契约测试
 *
 * 存在理由（2026-10-30 实测）：
 *   本机 12 个录音端点全部 NOTPRESENT/UNPLUGGED（零麦克风），也没有扬声器。
 *   原设计的第②步依赖浏览器 Web Speech API，而它**只能听麦克风**、没有接口能
 *   直接喂 WAV，因此原方案是「扬声器外放录音 → 麦克风听回来 → 识别」——本质是
 *   放给自己听。两端都没有声卡硬件时，这条路物理上不可能走通。
 *
 *   补强方案：把 WAV 直接交给服务端转写（智谱 GLM-ASR），不再绕声音一圈。
 *   浏览器有用的机器仍走 Web Speech（满足课程原文要求），无麦克风时自动降级。
 *
 * 本测试的隔离纪律（test/isolation-contract-test.js 会强制检查）：
 *   · 端口从 8090-8099 里挑空闲的；独立 DATA_DIR（被 .gitignore 的 test/.test-data* 覆盖）
 *   · 转写目标一律指向**本进程起的假 ASR 服务**（ASR_ENDPOINT=http://127.0.0.1:<port>）
 *     —— 绝不连真实智谱、绝不上传任何真实录音（用户明确要求先不上传）
 *   · autoDetect=false：不打开真实板子串口
 *
 * 用法：node test/voice-asr-test.js
 */
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, `.test-data-asr-${process.pid}`);
const DATA_DIR_B = path.join(__dirname, `.test-data-asr-b-${process.pid}`);
const DATA_DIR_C = path.join(__dirname, `.test-data-asr-c-${process.pid}`);
const CONFIG_FIXTURE = path.join(__dirname, '.test-config.json');
const STUB_KEY = 'test-key-asr-1234';
const STUB_MODEL = 'glm-asr-2512';

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- HTTP 小工具 ---------- */
function httpReq(port, method, p, body, timeoutMs = 25000) {
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

/* 上传原始二进制（WAV）—— /api/voice/audio 收的是裸 body，不是 multipart */
function postBinary(port, p, buf, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'audio/wav', 'Content-Length': buf.length }, headers),
      timeout: 20000,
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
async function pickPort(used = []) {
  for (let p = 8090; p <= 8099; p++) {
    if (used.includes(p)) continue;
    if (await portFree(p)) return p;
  }
  throw new Error('8090-8099 全被占用');
}

/* ---------- 最小的合法 WAV（16kHz / 单声道 / 16bit，带正弦波不是静音） ---------- */
function makeWav(durationMs, { rate = 16000, amp = 8000, freq = 440 } = {}) {
  const samples = Math.max(1, Math.round((rate * durationMs) / 1000));
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // 单声道
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);     // byteRate
  buf.writeUInt16LE(2, 32);            // blockAlign
  buf.writeUInt16LE(16, 34);           // bits
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate));
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

/* ---------- 假 ASR 服务（记录请求，按 mode 回不同结果） ---------- */
const stub = { mode: 'ok', hits: [], server: null, port: 0 };
function startStub() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        stub.hits.push({
          path: req.url,
          auth: req.headers.authorization || '',
          contentType: req.headers['content-type'] || '',
          bodyBuf: Buffer.concat(chunks),
        });
        const send = (code, obj) => {
          const b = Buffer.from(JSON.stringify(obj), 'utf8');
          res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
          res.end(b);
        };
        if (stub.mode === 'hang') return;                     // 永不响应 → 触发超时
        if (stub.mode === 'unauthorized') return send(401, { error: { code: '1000', message: '身份验证失败' } });
        if (stub.mode === 'server_error') return send(500, { error: { message: '内部错误' } });
        if (stub.mode === 'bad_json') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html>not json</html>');
        }
        if (stub.mode === 'empty') return send(200, { id: 'x', model: STUB_MODEL, text: '   ' });
        return send(200, { id: 'asr-stub-1', model: STUB_MODEL, text: '今天室内温度是多少' });
      });
    });
    s.listen(0, '127.0.0.1', () => { stub.server = s; stub.port = s.address().port; resolve(); });
  });
}

/* ---------- 启动 / 停止隔离实例 ---------- */
function startServer(port, opts = {}) {
  const { asr = true, asrEnabled = true, asrTimeoutMs = 700, asrMaxBytes = null, dataDir = DATA_DIR } = opts;
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
    DATA_DIR: dataDir,                          // ★ 隔离数据目录，绝不写真实 data/
    NL_CONFIG_PATH: path.join(__dirname, '.test-nl-local-absent.json'),
    NL_ENDPOINT: '', NL_API_KEY: '',
    ASR_ENDPOINT: '', ASR_API_KEY: '',          // 先清空，下面按用例决定注入
    ASR_ENABLED: '',                            // 默认关闭：必须显式开启才会外发
    ASR_TIMEOUT_MS: String(asrTimeoutMs),
  });
  if (asrEnabled) env.ASR_ENABLED = '1';
  if (asr) {
    env.ASR_ENDPOINT = `http://127.0.0.1:${stub.port}/api/paas/v4`;
    env.ASR_API_KEY = STUB_KEY;
  }
  if (asrMaxBytes != null) env.ASR_MAX_BYTES = String(asrMaxBytes);
  return spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
}
async function waitReady(port, timeoutMs = 15000) {
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

/* 传一段 WAV 进隔离实例，返回 audio_id。duration_ms 用请求头自报，
 * 方便造「超时长」用例而不必真生成 31 秒音频。 */
async function uploadWav(port, wav, durationMs) {
  const h = durationMs != null ? { duration_ms: String(durationMs) } : {};
  const r = await postBinary(port, '/api/voice/audio', wav, h);
  return { status: r.status, id: r.json && r.json.audio_id, json: r.json };
}

(async () => {
  const procs = [];
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(DATA_DIR_B, { recursive: true, force: true });
    fs.rmSync(DATA_DIR_C, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(DATA_DIR_B, { recursive: true });
    fs.mkdirSync(DATA_DIR_C, { recursive: true });

    /* ============ ① 静态契约：URL 归一化与限额常量 ============ */
    console.log('\n① 静态契约（URL 拼接 / 限额 / 默认模型）');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    const fnMatch = /function asrTranscriptionsUrl\s*\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(serverSrc);
    ok(!!fnMatch, 'server.js 存在 asrTranscriptionsUrl() 用于拼转写地址');
    if (fnMatch) {
      const asrUrl = new Function(`${fnMatch[0]}; return asrTranscriptionsUrl;`)();
      ok(asrUrl('https://open.bigmodel.cn/api/paas/v4')
        === 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
        '带版本段的 Base URL 只补 /audio/transcriptions（不出现 /v4/v1）',
        asrUrl('https://open.bigmodel.cn/api/paas/v4'));
      ok(asrUrl('https://api.example.com') === 'https://api.example.com/v1/audio/transcriptions',
        '纯域名补 /v1/audio/transcriptions', asrUrl('https://api.example.com'));
      ok(asrUrl('https://x.com/v1/audio/transcriptions') === 'https://x.com/v1/audio/transcriptions',
        '已是完整端点时原样使用');
      ok(asrUrl('https://x.com/v1/') === 'https://x.com/v1/audio/transcriptions',
        '末尾多余斜杠被剥掉再加路径', asrUrl('https://x.com/v1/'));
    } else {
      ok(false, '找不到 asrTranscriptionsUrl()，后续 URL 用例无法验证');
      ok(false, '（跳过）纯域名补版本段');
      ok(false, '（跳过）完整端点原样使用');
      ok(false, '（跳过）末尾斜杠处理');
    }

    ok(/ASR_MAX_BYTES/.test(serverSrc), '存在 ASR_MAX_BYTES 上限常量（智谱限制 25MB）');
    ok(/ASR_MAX_MS/.test(serverSrc), '存在 ASR_MAX_MS 上限常量（智谱限制 30 秒）');
    ok(/glm-asr-2512/.test(serverSrc), '默认模型为 glm-asr-2512（该接口文档里唯一枚举）');

    /* ============ 启动假 ASR + 主隔离实例 ============ */
    await startStub();
    const PORT = await pickPort([]);
    const srv = startServer(PORT, { asr: true, asrTimeoutMs: 700 });
    procs.push(srv);
    const ready = await waitReady(PORT);
    ok(ready, `隔离实例已就绪（端口 ${PORT}，DATA_DIR=${path.relative(ROOT, DATA_DIR)}）`);
    if (!ready) throw new Error('隔离实例未起来，后续断言无意义');

    /* ============ ② 入参校验 ============ */
    console.log('\n② 入参校验（缺参 / 格式 / 不存在）');
    let r = await httpReq(PORT, 'POST', '/api/voice/transcribe', {});
    ok(r.status === 400 && r.json && r.json.error === 'missing_audio_id',
      '缺 audio_id → 400 missing_audio_id', `${r.status} ${r.json && r.json.error}`);

    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: '../../etc/passwd' });
    ok(r.status === 400 && r.json && r.json.error === 'invalid_audio_id',
      '路径穿越式 audio_id → 400 invalid_audio_id', `${r.status} ${r.json && r.json.error}`);

    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: 'voice-20990101-000000-000-dead' });
    ok(r.status === 404 && r.json && r.json.error === 'audio_not_found',
      '不存在的录音 → 404 audio_not_found', `${r.status} ${r.json && r.json.error}`);
    ok(stub.hits.length === 0, '以上校验用例一次都没有真调 ASR（校验在调用之前）',
      `stub 命中 ${stub.hits.length} 次`);

    /* ============ ③ 成功路径 ============ */
    console.log('\n③ 成功路径：真调转写接口，返回文本并推进阶段');
    const wav1s = makeWav(1000);                     // 1 秒音频，避免测试太慢
    const up = await uploadWav(PORT, wav1s, 1000);
    ok(up.status === 200 && !!up.id, '先把 WAV 传进隔离实例（走真实落盘路径）', String(up.id));

    stub.mode = 'ok';
    stub.hits.length = 0;
    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: up.id });
    ok(r.status === 200 && r.json && r.json.ok === true, '转写成功 → 200 ok=true', `${r.status}`);
    ok(r.json && r.json.text === '今天室内温度是多少', '返回的 text 与假服务给的一致', r.json && r.json.text);
    ok(r.json && r.json.model === STUB_MODEL, '返回体带上实际使用的模型名', r.json && r.json.model);

    const hit = stub.hits[0] || {};
    ok(hit.path === '/api/paas/v4/audio/transcriptions', '请求打到正确的转写路径', hit.path);
    ok(hit.auth === `Bearer ${STUB_KEY}`, '带上 Authorization: Bearer <key>', hit.auth ? 'Bearer ***' : '(空)');
    ok(/multipart\/form-data/i.test(hit.contentType), '用 multipart/form-data 上传（智谱要求）', hit.contentType);
    const bodyText = hit.bodyBuf ? hit.bodyBuf.toString('latin1') : '';
    ok(bodyText.includes('name="model"') && bodyText.includes(STUB_MODEL), '表单里带 model=glm-asr-2512');
    ok(bodyText.includes('name="file"') && bodyText.includes('filename='), '表单里带 file 文件字段');
    ok(bodyText.includes('RIFF'), '上传的确实是 WAV 字节（不是被字符串化后的乱码）');

    let st = await httpReq(PORT, 'GET', '/api/voice/state');
    ok(st.json && st.json.stage === 'transcribed', '阶段推进到 transcribed', st.json && st.json.stage);
    ok(st.json && st.json.transcript === '今天室内温度是多少', 'transcript 写进内存状态', st.json && st.json.transcript);
    const evFile = path.join(DATA_DIR, 'voice', 'events.ndjson');
    const evText = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8') : '';
    ok(/transcribed/.test(evText), 'transcribed 事件已落盘 events.ndjson');

    /* ============ ④ 上游失败分类 ============ */
    console.log('\n④ 上游失败必须分类，且不谎报成功');
    stub.mode = 'unauthorized';
    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: up.id });
    ok(r.status === 502 && r.json && r.json.error === 'asr_failed',
      '上游 401 → 502 asr_failed（不报成功）', `${r.status} ${r.json && r.json.error}`);
    ok(r.json && String(r.json.reason || '').includes('401'),
      'reason 里带出上游状态码，便于排查', r.json && r.json.reason);
    st = await httpReq(PORT, 'GET', '/api/voice/state');
    ok(st.json && st.json.stage === 'asr_failed', '失败时阶段落回 asr_failed，不留在 transcribed', st.json && st.json.stage);

    stub.mode = 'server_error';
    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: up.id });
    ok(r.status === 502 && r.json && r.json.error === 'asr_failed', '上游 500 → 502 asr_failed', `${r.status}`);

    stub.mode = 'empty';
    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: up.id });
    ok(r.status === 502 && r.json && r.json.error === 'asr_empty_text',
      '上游返回空白文本 → 502 asr_empty_text（不当成功）', `${r.status} ${r.json && r.json.error}`);

    stub.mode = 'bad_json';
    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: up.id });
    ok(r.status === 502 && r.json && r.json.error === 'asr_failed',
      '上游返回非 JSON → 502 asr_failed（不抛未捕获异常）', `${r.status}`);

    stub.mode = 'hang';
    const tHang = Date.now();
    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: up.id });
    const took = Date.now() - tHang;
    ok(r.status === 504 && r.json && r.json.error === 'asr_timeout',
      '上游不响应 → 504 asr_timeout', `${r.status} ${r.json && r.json.error} ${took}ms`);
    ok(took < 5000, `超时按 ASR_TIMEOUT_MS=700 生效，没有挂死（实测 ${took}ms）`);
    stub.mode = 'ok';

    /* ============ ⑤ 时长限额 ============ */
    console.log('\n⑤ 时长限额（智谱限制 30 秒）');
    const upLong = await uploadWav(PORT, wav1s, 40000);   // 自报 40 秒
    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: upLong.id });
    ok(r.status === 400 && r.json && r.json.error === 'asr_audio_too_long',
      '时长 40 秒 > 30 秒上限 → 400 asr_audio_too_long', `${r.status} ${r.json && r.json.error}`);
    ok(String((r.json && r.json.message) || '').includes('30'),
      '提示里说清上限是 30 秒', r.json && r.json.message);

    /* ============ ⑥ 密钥不外泄 ============ */
    console.log('\n⑥ 密钥不外泄');
    const probe = await httpReq(PORT, 'GET', '/api/voice');
    ok(!probe.text.includes(STUB_KEY), '/api/voice 响应里没有完整密钥');
    ok(!st.text.includes(STUB_KEY), '/api/voice/state 响应里没有完整密钥');
    r = await httpReq(PORT, 'POST', '/api/voice/transcribe', { audio_id: up.id });
    ok(!r.text.includes(STUB_KEY), '转写响应里没有完整密钥');

    /* ============ ⑦ 限额与未配置（第二个实例：1KB 上限、不配 ASR） ============ */
    console.log('\n⑦ 体积限额与「未配置」必须如实报（第二个隔离实例）');
    const PORT2 = await pickPort([PORT]);
    const srvB = startServer(PORT2, { asr: false, asrMaxBytes: 1000, dataDir: DATA_DIR_B });
    procs.push(srvB);
    const readyB = await waitReady(PORT2);
    ok(readyB, `第二个隔离实例已就绪（端口 ${PORT2}，ASR_MAX_BYTES=1000，未配 ASR）`);
    if (readyB) {
      const upBig = await uploadWav(PORT2, makeWav(1000));   // 约 32KB > 1KB 上限
      r = await httpReq(PORT2, 'POST', '/api/voice/transcribe', { audio_id: upBig.id });
      ok(r.status === 413 && r.json && r.json.error === 'asr_audio_too_large',
        '超过 25MB 类上限 → 413 asr_audio_too_large（测试用 1KB 模拟）', `${r.status} ${r.json && r.json.error}`);

      const upSmall = await uploadWav(PORT2, makeWav(20));    // ~684 字节 < 1KB
      r = await httpReq(PORT2, 'POST', '/api/voice/transcribe', { audio_id: upSmall.id });
      ok(r.status === 503 && r.json && r.json.error === 'asr_not_configured',
        '没配 endpoint/key → 503 asr_not_configured（绝不假装成功）', `${r.status} ${r.json && r.json.error}`);
      ok(String((r.json && r.json.message) || '').includes('智谱')
        || String((r.json && r.json.message) || '').includes('ASR'),
        '提示里说清要去配什么', r.json && r.json.message);
    }

    /* ============ ⑦b 默认关闭：没显式开启就一条请求都不许发 ============ */
    /* 这条是隐私边界，不是功能分支。用户的原话是「先别上传，等我自己确认账号与费用」——
     * 所以「默认关闭」必须是可测的行为：禁用时不仅不能成功，连假 ASR 服务都不许收到请求。 */
    console.log('\n⑦b 默认关闭时绝不外发（隐私边界）');
    const PORT3 = await pickPort([PORT, PORT2]);
    const srvC = startServer(PORT3, { asr: true, asrEnabled: false, dataDir: DATA_DIR_C });
    procs.push(srvC);
    const readyC = await waitReady(PORT3);
    ok(readyC, `第三个隔离实例已就绪（端口 ${PORT3}，有 endpoint/key 但未开启 asrEnabled）`);
    if (readyC) {
      const hitsBefore = stub.hits.length;
      const upC = await uploadWav(PORT3, makeWav(800));
      r = await httpReq(PORT3, 'POST', '/api/voice/transcribe', { audio_id: upC.id });
      ok(r.status === 503 && r.json && r.json.error === 'asr_disabled',
        '未开启 asrEnabled → 503 asr_disabled（不假装成功）', `${r.status} ${r.json && r.json.error}`);
      ok(stub.hits.length === hitsBefore,
        '未开启时假 ASR 服务一次请求都没收到（录音没有离开本机）',
        `命中 ${stub.hits.length - hitsBefore} 次`);
      const stC = await httpReq(PORT3, 'GET', '/api/voice/state');
      ok(stC.json && stC.json.asr && stC.json.asr.enabled === false,
        '/api/voice/state 如实报告「转写未启用」，前端据此不必白试',
        stC.json && stC.json.asr && JSON.stringify({ enabled: stC.json.asr.enabled }));
    }

    /* ============ ⑧ 静态契约：前端降级路径存在 ============ */
    console.log('\n⑧ 前端静态契约（无麦克风时走服务端转写）');
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    ok(/voice-transcribe/.test(appSrc) || /api\/voice\/transcribe/.test(appSrc),
      'public/app.js 里有调用 /api/voice/transcribe 的地方');
    ok(/voiceProbeMic/.test(appSrc), '仍保留麦克风自检（有麦克风的机器优先走 Web Speech）');
    ok(/Web Speech/.test(appSrc) && /服务端转写|GLM-ASR|glm-asr/.test(appSrc),
      '两条路径在代码里都有可辨识名字（日志/界面能说清走了哪条）');
  } catch (e) {
    fail++;
    console.error('  ✗ 异常：', e.message);
  } finally {
    for (const p of procs.reverse()) { try { p.kill(); } catch (_) {} }
    try { if (stub.server) stub.server.close(); } catch (_) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(DATA_DIR_B, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(DATA_DIR_C, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
    process.exit(fail ? 1 : 0);
  }
})();