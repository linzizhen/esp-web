#!/usr/bin/env node
/**
 * 第 6 周：语音任务的澄清与停止（回归测试）
 *
 * 为什么要有这个测试：本周的三件事全是「时序错位」类缺陷，人工点一遍看不出来 ——
 *   ① 澄清之后用户只回一句「第一个」，系统必须接上前文；接不上就是又反问一遍，
 *      而页面看起来「有回复」，很容易被当成通过。
 *   ② 用户点了停止，之前发出去的请求仍会回来。它一旦写进状态、触发播报，
 *      就是「取消了还在动」——课程当堂验证的第一条正是这个。
 *   ③ 两个任务连着来，旧任务的结果晚到，不能覆盖新任务的结论。
 *
 * 锁死的语义（对应课程四句判据）：
 *   · 取消后同一 request_id 的迟到结果一律丢弃，并落事件 late_result_dropped；
 *   · 新任务的 request_id 与旧的不同，旧结果不写 reply、不改阶段；
 *   · 澄清上下文按 session 隔离、30 秒过期、用一次即清；
 *   · 时序（到站 → 首次反馈 → 任务完成）落盘且可查，延迟注入只认显式配置。
 *
 * 隔离：自建 server 实例（独立 PORT + DATA_DIR），不碰 8080 与真实 data/。
 */
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, `.test-data-cancel-${process.pid}`);
const CONFIG_FIXTURE = path.join(__dirname, '.test-config.json');
const CLARIFY_TTL_MS = 1200;          // 只在本测试的实例里生效，便于验证过期
const LATENCY_MS = 400;               // 延迟注入的量化基准

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

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function pickPort(start = 8110) {
  for (let p = start; p < start + 20; p++) if (await portFree(p)) return p;
  throw new Error(`端口 ${start}–${start + 19} 全被占用`);
}

function startServer(port, opts = {}) {
  const { dataDir = DATA_DIR, latencyMs = 0 } = opts;
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
    NL_ENDPOINT: '', NL_API_KEY: '',          // 只走规则引擎，排除模型随机性
    ASR_ENABLED: '0',                          // 本周不测转写
    VOICE_CLARIFY_TTL_MS: String(CLARIFY_TTL_MS),
    VOICE_LATENCY_MS: latencyMs ? String(latencyMs) : '',
  });
  return spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
}

async function waitReady(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await httpReq(port, 'GET', '/api/state');
      if (r.status === 200) return true;
    } catch (_) { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

function readEvents() {
  const f = path.join(DATA_DIR, 'voice', 'events.ndjson');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

const jget = (port, p) => httpReq(port, 'GET', p);
const jpost = (port, p, o) => httpReq(port, 'POST', p, o);

(async () => {
  /* ---------- ⓪ 静态契约：这一周的入口必须真的存在 ---------- */
  console.log('\n— ⓪ 静态契约（源码/页面） —');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  ok(/'cancelled'/.test(serverSrc.slice(serverSrc.indexOf('const VOICE_STAGES'), serverSrc.indexOf('const VOICE_STAGE_SET'))),
    'VOICE_STAGES 含 cancelled');
  ok(/const CLARIFY = new Map\(\)/.test(serverSrc), '服务端有澄清上下文表 CLARIFY');
  ok(/const CANCELLED_RIDS = new Map\(\)/.test(serverSrc), '服务端有已取消 request_id 登记表');
  ok(/late_result_dropped/.test(serverSrc), '取消后的迟到结果有专门事件名');
  ok(/VOICE_LATENCY_MS/.test(serverSrc), '延迟注入由配置驱动');
  ok(/api\/voice\/timings/.test(serverSrc), '时序查询接口存在');
  ok(/function voiceCancel/.test(appSrc), '前端有 voiceCancel()');
  ok(/VOICE_STOP_WORDS|STOP_WORDS/.test(appSrc), '前端有停止口令词表');
  ok(/voiceNewRequestId|newVoiceRequestId/.test(appSrc), '前端能生成链路 request_id');
  ok(/id="btnVoiceStop"/.test(htmlSrc), '页面有文字「停止」按钮');
  ok(Number((/app\.js\?v=(\d+)/.exec(htmlSrc) || [])[1]) >= 46, 'app.js 版本号已推进');

  /* ---------- 启动隔离实例 ---------- */
  const port = await pickPort();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  let srv = startServer(port);
  ok(await waitReady(port), `隔离实例已就绪（端口 ${port}）`, `DATA_DIR=${path.basename(DATA_DIR)}`);

  /* ---------- ① 澄清上下文 ---------- */
  console.log('\n— ① 澄清上下文：第二句只回「第一个」也能接上 —');
  const amb1 = await jpost(port, '/api/nl', { text: '数据', session_id: 'sess-A' });
  ok(amb1.status === 200 && amb1.json.intent === 'ambiguous', '模糊指令判 ambiguous');
  ok(Array.isArray(amb1.json.clarify && amb1.json.clarify.options)
    && amb1.json.clarify.options.length === 2, '回复里给出两个候选任务', JSON.stringify((amb1.json.clarify || {}).options));
  ok(((amb1.json.clarify || {}).ttl_ms > 0), '候选带有效期（有限多轮，不会一直追问）', String((amb1.json.clarify || {}).ttl_ms));

  const pick1 = await jpost(port, '/api/nl', { text: '第一个', session_id: 'sess-A' });
  ok(pick1.json.intent === 'query_last', '同一 session 说「第一个」→ 按上文落到查上次数据', pick1.json.intent);
  ok(pick1.json.clarify_used === true, '回复里标注「是按上一句澄清执行的」');

  const pickAgain = await jpost(port, '/api/nl', { text: '第一个', session_id: 'sess-A' });
  ok(pickAgain.json.intent === 'ambiguous', '上下文用一次即清（不无限追问）', pickAgain.json.intent);

  await jpost(port, '/api/nl', { text: '数据', session_id: 'sess-B' });
  const otherSess = await jpost(port, '/api/nl', { text: '第一个', session_id: 'sess-C' });
  ok(otherSess.json.intent === 'ambiguous', '上下文按 session 隔离，别的标签页接不上');

  await jpost(port, '/api/nl', { text: '数据', session_id: 'sess-D' });
  await sleep(CLARIFY_TTL_MS + 300);
  const expired = await jpost(port, '/api/nl', { text: '第一个', session_id: 'sess-D' });
  ok(expired.json.intent === 'ambiguous', `澄清上下文超 ${CLARIFY_TTL_MS}ms 即失效`);

  /* ---------- ② 取消 + 迟到结果隔离 ---------- */
  console.log('\n— ② 取消：同 request_id 的迟到结果必须丢弃 —');
  const ridOld = 'vr-20260101-000001-0001';
  const ridNew = 'vr-20260101-000002-0002';
  const cancelRes = await jpost(port, '/api/voice/state', {
    stage: 'cancelled', request_id: ridOld, reason: '用户点了停止', audio_id: null,
  });
  ok(cancelRes.status === 200 && cancelRes.json.ok === true, '取消阶段可写入');
  const stAfterCancel = await jget(port, '/api/voice/state');
  ok(stAfterCancel.json.stage === 'cancelled', '状态读回 stage=cancelled', stAfterCancel.json.stage);
  ok(stAfterCancel.json.request_id === ridOld, '取消记录带 request_id（可关联日志）', stAfterCancel.json.request_id);
  ok((stAfterCancel.json.stages || []).length === 9 && stAfterCancel.json.stages.includes('cancelled'),
    '阶段枚举 8 → 9（cancelled 是合法阶段）', String((stAfterCancel.json.stages || []).length));

  const late = await jpost(port, '/api/nl', { text: '查看上次数据', request_id: ridOld, session_id: 'sess-E' });
  ok(late.json.cancelled === true, '已取消 request_id 的请求被判为迟到结果', JSON.stringify({ ok: late.json.ok, cancelled: late.json.cancelled }));
  ok(!late.json.reply || late.json.cancelled === true, '迟到结果不带可播报的回复');
  const evLate = readEvents().filter((e) => e.ev === 'late_result_dropped');
  ok(evLate.length >= 1, '迟到结果落事件 late_result_dropped', String(evLate.length));
  ok(evLate.some((e) => e.request_id === ridOld), '该事件带原 request_id，能追到是哪一次被丢弃');

  const fresh = await jpost(port, '/api/nl', { text: '查看上次数据', request_id: ridNew, session_id: 'sess-E' });
  ok(fresh.json.ok === true && fresh.json.intent === 'query_last' && !fresh.json.cancelled,
    '没被取消的 request_id 照常执行');

  /* ---------- ③ 新任务不被旧结果覆盖 ---------- */
  console.log('\n— ③ 新任务不被旧结果覆盖 —');
  const st1 = await jpost(port, '/api/voice/state', {
    stage: 'recorded', audio_id: 'voice-20260101-000001-001-0001', request_id: ridNew,
    timings: { to_first_feedback_ms: 120, to_task_done_ms: 2400 },
  });
  ok(st1.status === 200, '新链路状态带 request_id 与 timings 写入成功');
  const sv = await jget(port, '/api/voice/state');
  ok(sv.json.request_id === ridNew, '状态只认新任务的 request_id', String(sv.json.request_id));
  const lateOldAudio = await jpost(port, '/api/voice/state', {
    stage: 'spoken', audio_id: 'voice-20260101-000001-001-0001', request_id: ridOld,
  });
  ok(lateOldAudio.status === 200 && lateOldAudio.json.ignored === true,
    '旧 request_id 的状态推进被拒绝（不覆盖新任务）', JSON.stringify(lateOldAudio.json));

  /* ③b 取消是终点：同一条链路取消之后不许再往前走。
   * 2026-11-18 线上实测抓到的缺陷 —— cancel 后同 rid 推 task_done 被接受，
   * 状态从 cancelled 变回 task_done，迟到的播报就跟着来了。 */
  console.log('\n— ③b 取消之后同一条链路不许再推进 —');
  const ridCancel = 'vr-20260101-000004-0004';
  await jpost(port, '/api/voice/state', { stage: 'task_running', request_id: ridCancel, audio_id: null });
  await jpost(port, '/api/voice/state', { stage: 'cancelled', request_id: ridCancel, reason: '点了停止' });
  const afterCancel = await jpost(port, '/api/voice/state', {
    stage: 'task_done', request_id: ridCancel, intent: 'query_last', reply: '迟到的回复',
  });
  ok(afterCancel.status === 200 && afterCancel.json.ignored === true
    && afterCancel.json.reason === 'cancelled_request_id',
    '已取消的 request_id 推 task_done 被拒（取消是终点）', JSON.stringify(afterCancel.json.reason));
  const stillCancelled = await jget(port, '/api/voice/state');
  ok(stillCancelled.json.stage === 'cancelled', '状态仍是 cancelled，没被迟到阶段改写', stillCancelled.json.stage);
  ok(!stillCancelled.json.reply, '迟到阶段的 reply 没有写进状态（不会触发播报）', String(stillCancelled.json.reply));

  /* ③c 上一条链路已经终结时，新链路必须能直接接管。
   * 原判据「rid 不同就拒」把已终结的链路也当成在跑 —— 新 rid 推 task_running
   * 被当 stale 丢掉，页面卡在 cancelled 不动，用户会以为「点了停止就录不进去了」。 */
  console.log('\n— ③c 上一条已终结时，新链路能直接接管 —');
  const ridNext = 'vr-20260101-000005-0005';
  const takeOver = await jpost(port, '/api/voice/state', {
    stage: 'task_running', request_id: ridNext, audio_id: 'voice-20260101-000002-002-0002',
  });
  ok(takeOver.status === 200 && !takeOver.json.ignored,
    '上一条是 cancelled 时，新 request_id 推 task_running 被接受（不要求先补 recorded）',
    JSON.stringify({ ignored: takeOver.json.ignored, reason: takeOver.json.reason }));
  const nowRunning = await jget(port, '/api/voice/state');
  ok(nowRunning.json.stage === 'task_running' && nowRunning.json.request_id === ridNext,
    '状态切到新链路', nowRunning.json.stage + ' / ' + nowRunning.json.request_id);
  const backOld = await jpost(port, '/api/voice/state', { stage: 'spoken', request_id: ridCancel });
  ok(backOld.status === 200 && backOld.json.ignored === true,
    '旧链路仍推不进来（它已取消）', JSON.stringify(backOld.json.reason));

  /* ---------- ④ 时序落盘与查询 ---------- */
  console.log('\n— ④ 时序：到站 → 首次反馈 → 任务完成 —');
  const tim = await jget(port, '/api/voice/timings?limit=5');
  ok(tim.status === 200 && tim.json.ok === true, '时序接口可用');
  ok(Array.isArray(tim.json.recent) && tim.json.recent.length >= 1, '能查到带 timings 的记录');
  const rec = (tim.json.recent || [])[0] || {};
  ok(rec.timings && rec.timings.to_first_feedback_ms === 120 && rec.timings.to_task_done_ms === 2400,
    '时序字段原样保存（毫秒）', JSON.stringify(rec.timings));
  ok(tim.json.p50 && typeof tim.json.p50.to_task_done_ms === 'number', '给出中位数（课堂演示单元增量用）');
  const badTim = await jpost(port, '/api/voice/state', {
    stage: 'recorded', audio_id: 'voice-20260101-000003-003-0003', request_id: 'vr-20260101-000003-0003',
    timings: { to_first_feedback_ms: -5, to_task_done_ms: 'abc' },
  });
  ok(badTim.status === 200, '非法时序值不炸服务（写入时夹紧/丢弃）');
  const tim2 = await jget(port, '/api/voice/timings?limit=5');
  const rec2 = (tim2.json.recent || [])[0] || {};
  ok(!rec2.timings || (rec2.timings.to_first_feedback_ms >= 0), '负数时序不会原样存下来', JSON.stringify(rec2.timings));

  /* ---------- ⑤ 延迟注入（默认关闭） ---------- */
  console.log('\n— ⑤ 延迟注入默认关闭 —');
  const t0 = Date.now();
  await jpost(port, '/api/nl', { text: '查看上次数据' });
  const fastMs = Date.now() - t0;
  ok(fastMs < LATENCY_MS, '未配置注入时请求是快的', `${fastMs}ms`);
  const diag = await jget(port, '/api/diag');
  ok(diag.json.voice && diag.json.voice.latency_ms === 0, '诊断接口暴露当前注入值（0=未注入）',
    JSON.stringify((diag.json.voice || {}).latency_ms));

  srv.kill();
  await sleep(400);

  const port2 = await pickPort(8130);
  const ds2 = DATA_DIR + '-lat';
  let srv2 = startServer(port2, { dataDir: ds2, latencyMs: LATENCY_MS });
  const ready2 = await waitReady(port2);
  ok(ready2, `注入实例已就绪（端口 ${port2}）`);
  if (ready2) {
    const t1 = Date.now();
    await jpost(port2, '/api/nl', { text: '查看上次数据' });
    const slowMs = Date.now() - t1;
    ok(slowMs >= LATENCY_MS - 30, `注入 ${LATENCY_MS}ms 后请求确实变慢（用于复现迟到结果）`, `${slowMs}ms`);
    const d2 = await jget(port2, '/api/diag');
    ok(d2.json.voice && d2.json.voice.latency_ms === LATENCY_MS, '诊断接口如实报告注入值', JSON.stringify((d2.json.voice || {}).latency_ms));
  } else {
    skip('延迟注入实测', '实例没起来');
  }
  srv2.kill();
  await sleep(300);

  // 清理（这两个目录由本测试独占，测试结束即删）
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(ds2, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n结果: ${pass} 通过, ${fail} 失败` + (skipped ? `, ${skipped} 跳过` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();