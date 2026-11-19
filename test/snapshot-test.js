#!/usr/bin/env node
/**
 * 第 7 周：按需获取一张环境图像（集成测试）
 *
 * 为什么必须有这个测试：本周两条当堂验证都是「状态被错误地当成成功」，
 * 而且 2026-11-19 在真实实例上实测确认缺陷存在：
 *   ① 抓拍失败（framesize:99）后 GET /api/cam/snapshot.jpg 仍返回 200 + 旧图，
 *      页面据此显示「已抓拍」—— 上次的成功图像被标成了本次成功；
 *   ② 失败后旧图与绿色标签一起留着 —— 采集失败没有保持明确状态。
 * 这类缺陷人工点一遍很难发现（画面看起来「有图」就是成功），必须写成断言。
 *
 * 锁死的语义：
 *   · 每次采集有独立 shot_id，状态只能沿 requested → capturing → captured 前进；
 *   · 序号未递增的帧、超时帧不认，且绝不把上次的图当成本次结果；
 *   · 失败（failed）与画面不可用（blocked）是终止态，带人可读原因，且不落图；
 *   · /api/cam/snapshot.jpg 必须带 shot_id：缺失 400、不匹配 404、非 captured 409；
 *   · 保留最近 N 张，超出记 pruned；
 *   · 三种触发来源（ui / voice / help）都能用。
 *
 * 隔离：自建 server 实例（独立 PORT + DATA_DIR），不碰 8080 与真实 data/。
 * 摄像头帧用「模拟设备」注入：本测试不要求板子在线（板子不在也能跑）。
 */
'use strict';
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, `.test-data-snapshot-${process.pid}`);
const CONFIG_FIXTURE = path.join(__dirname, '.test-config.json');
const KEEP = 5;

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
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try { json = JSON.parse(text || '{}'); } catch (_) { /* 可能是 JPEG */ }
        resolve({ status: res.statusCode, text, json, buf: raw, headers: res.headers });
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
async function pickPort(start = 8120) {
  for (let p = start; p < start + 20; p++) if (await portFree(p)) return p;
  throw new Error(`端口 ${start}–${start + 19} 全被占用`);
}

function startServer(port, opts = {}) {
  const { dataDir = DATA_DIR } = opts;
  fs.mkdirSync(dataDir, { recursive: true });
  const cfgPath = path.join(dataDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FIXTURE, 'utf8'));
  cfg.mockDevice = true;          // 不依赖真实板子
  cfg.autoDetect = false;
  cfg.autoReconnect = false;
  cfg.httpPort = port;
  cfg.snapshotKeep = KEEP;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  const env = Object.assign({}, process.env, {
    PORT: String(port), HOST: '127.0.0.1',
    CONFIG_PATH: cfgPath,
    DATA_DIR: dataDir,
    NL_CONFIG_PATH: path.join(__dirname, '.test-nl-local-absent.json'),
    NL_ENDPOINT: '', NL_API_KEY: '',
    ASR_ENABLED: '0',
    /* 用 1.2 秒的时间窗（生产默认 15 秒）：测试里要能在几秒内验证
     * 「卡住的采集会被 sweep 判失败」，而不是干等 15 秒。 */
    SNAPSHOT_WINDOW_MS: '1200',
    HELP_SNAPSHOT_MIN_MS: '0',
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

/* 造一帧「像样」的 JPEG：随机字节（熵接近真实照片的 7.4），带 JPEG 魔数。
 * 用 crypto.randomBytes 而不是 LCG —— 实测 LCG 低 8 位的熵只有 1.34，
 * 会被判成「画面无细节」，测的就不是产品行为了。 */
function goodJpeg(n = 5000) {
  const b = crypto.randomBytes(n);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[3] = 0xE0;
  b[n - 2] = 0xFF; b[n - 1] = 0xD9;
  return b;
}
function flatJpeg(n = 5000) {
  const b = Buffer.alloc(n, 0x00);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[3] = 0xE0;
  b[n - 2] = 0xFF; b[n - 1] = 0xD9;
  return b;
}

/* 通过 /api/data 注入一帧（模拟设备上报），等价于板端 cam_send_frame_locked 的输出。
 * seq 必须单调递增：这既符合板端行为，也是「旧帧不得冒充」判据的前提。 */
let injectSeq = 1000;
async function injectFrame(port, buf, opts = {}) {
  injectSeq++;
  const obj = {
    type: 'frame',
    device: 'S3EYE-GROUP01',
    seq: opts.seq != null ? opts.seq : injectSeq,
    size: '320x240',
    len: buf.length,
    jpeg: buf.toString('base64'),
  };
  if (opts.shot) obj.shot = 1;
  return httpReq(port, 'POST', '/api/data', obj);
}

const jget = (port, p) => httpReq(port, 'GET', p);
/** 安全取采集记录：接口还没实现时返回空对象，让断言如实报 ✗ 而不是抛 TypeError */
const shotOf = (r) => (r && r.json && r.json.shot) || {};
const jpost = (port, p, o) => httpReq(port, 'POST', p, o);

(async () => {
  /* ---------- ⓪ 静态契约：本周的入口必须真的存在 ---------- */
  console.log('\n— ⓪ 静态契约（源码 / 页面） —');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  ok(/require\('\.\/lib\/snapshot-store\.js'\)/.test(serverSrc), 'server.js 引入 lib/snapshot-store.js');
  ok(/createSnapshotStore/.test(serverSrc), '服务端创建采集记录仓库');
  ok(/snapshotKeep/.test(serverSrc), '保留张数可配置（默认 5）');
  ok(/api\/cam\/shots/.test(serverSrc), '有采集记录查询接口 /api/cam/shots');
  ok(/'snapshot'/.test(serverSrc), '自然语言侧有 snapshot 意图（语音口令触发）');
  ok(/trigger/.test(serverSrc), '采集记录带触发来源');
  ok(/id="camShotState"/.test(htmlSrc), '页面有采集状态展示位');
  ok(/id="camShotList"/.test(htmlSrc), '页面有采集记录列表');
  ok(/function renderCamShot/.test(appSrc), '前端有 renderCamShot()');
  ok(/shot_id=/.test(appSrc), '前端取图时带 shot_id（不再无条件取旧图）');
  ok(Number((/app\.js\?v=(\d+)/.exec(htmlSrc) || [])[1]) >= 49, 'app.js 版本号已推进到 49');

  /* ---------- 启动隔离实例 ---------- */
  const port = await pickPort();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const srv = startServer(port);
  const ready = await waitReady(port);
  ok(ready, `隔离实例已就绪（端口 ${port}）`, `DATA_DIR=${path.basename(DATA_DIR)}`);
  if (!ready) { console.error('实例起不来，后续跳过'); srv.kill(); process.exit(1); }

  const cleanup = () => { try { srv.kill(); } catch (_) {} };
  process.on('exit', cleanup);

  try {
    /* ---------- ① 正常一次采集：四态推进 + 落盘 + 记录 ---------- */
    console.log('\n— ① 正常采集：requested → capturing → captured —');
    const b1 = await jpost(port, '/api/cam', { action: 'shot', trigger: 'ui' });
    b1.json = b1.json || {};
    ok(b1.status === 200 && b1.json.ok === true, '抓拍命令被接受');
    ok(/^shot-/.test(shotOf(b1).shot_id || ''), '响应里带回本次 shot_id',
      (shotOf(b1) || {}).shot_id);
    const shot1 = (shotOf(b1) || {}).shot_id || null;
    ok((shotOf(b1) || {}).state === 'requested' || (shotOf(b1) || {}).state === 'capturing',
      '响应里的状态是「已请求」或「采集中」，不是「成功」', (shotOf(b1) || {}).state);

    // 注入一帧（带 shot:1，模拟板端抓拍帧）
    await injectFrame(port, goodJpeg(), { shot: true });
    await sleep(300);

    const c1 = await jget(port, '/api/cam');
    c1.json = c1.json || {};
    c1.json.shot = shotOf(c1) || {};
    ok(shotOf(c1).shot_id === shot1, 'GET /api/cam 回传的是同一条采集记录');
    ok(shotOf(c1).state === 'captured', '★ 收到帧后状态变成 captured', shotOf(c1).state);
    ok(shotOf(c1).captured_at > 0, '记录里有采集时间 captured_at');
    ok(shotOf(c1).requested_at > 0 && shotOf(c1).requested_at <= shotOf(c1).captured_at,
      '请求时刻不晚于采集时刻');
    ok(shotOf(c1).board_seq > 0, '记录里有板端帧序号（同一帧的证据）', String(shotOf(c1).board_seq));
    ok(shotOf(c1).bytes > 0, '记录里有字节数', String(shotOf(c1).bytes));

    // 取图：必须带 shot_id
    const img = shot1 ? await jget(port, `/api/cam/snapshot.jpg?shot_id=${shot1}`) : { status: 0, buf: Buffer.alloc(0) };
    img.json = img.json || {};
    ok(img.status === 200, '带正确 shot_id 能取到图', String(img.status));
    ok(img.buf.length > 0 && img.buf[0] === 0xFF && img.buf[1] === 0xD8, '取回的是 JPEG');

    /* ---------- ② ★ 旧图不得冒充本次（当堂验证第 1 条） ---------- */
    console.log('\n— ② ★ 上次图像不得被标为本次采集成功 —');
    const noId = await jget(port, '/api/cam/snapshot.jpg');
    noId.json = noId.json || {};
    ok(noId.status === 400, '不带 shot_id 取图被拒（不再无条件返回旧图）', String(noId.status));
    ok(/shot_id/.test(noId.text || ''), '拒绝原因说明缺 shot_id', (noId.json || {}).error);

    const fake = await jget(port, '/api/cam/snapshot.jpg?shot_id=shot-20260101-000000-000-0000');
    fake.json = fake.json || {};
    ok(fake.status === 404, '不存在的 shot_id 返回 404（不会把旧图当它）', String(fake.status));

    // 发起第二次采集，但注入「序号没变」的帧 —— 这就是上次那张
    const b2 = await jpost(port, '/api/cam', { action: 'shot', trigger: 'ui' });
    b2.json = b2.json || {};
    const shot2 = (shotOf(b2) || {}).shot_id || null;
    ok(shot2 !== shot1, '第二次采集是新 shot_id', shot2);

    const seqUsed = (shotOf(c1) || {}).board_seq;
    await injectFrame(port, goodJpeg(), { shot: true, seq: seqUsed });   // 旧序号
    await sleep(300);

    const c2 = await jget(port, '/api/cam');
    c2.json = c2.json || {};
    c2.json.shot = shotOf(c2) || {};
    ok(shotOf(c2).shot_id === shot2, '当前采集记录是第二次那条');
    ok(shotOf(c2).shot_id === shot2 && shotOf(c2).state !== 'captured',
      '★ 序号未递增的帧没有把第二次标成成功', shotOf(c2).state);
    ok(/旧|序号|stale/i.test(shotOf(c2).reason || ''), '失败原因说清是旧帧', shotOf(c2).reason);

    const img2 = shot2 ? await jget(port, `/api/cam/snapshot.jpg?shot_id=${shot2}`) : { status: 0 };
    img2.json = img2.json || {};
    ok(img2.status !== 200, '★ 本次取不到图（不会把上次那张冒充本次结果）', String(img2.status));

    // 旧的那张仍可按自己的 shot_id 取到 —— 历史不该被抹掉
    const img1again = shot1 ? await jget(port, `/api/cam/snapshot.jpg?shot_id=${shot1}`) : { status: 0 };
    img1again.json = img1again.json || {};
    ok(img1again.status === 200, '旧记录仍可按自己的 shot_id 取到（历史保留）', String(img1again.status));

    /* ---------- ③ ★ 采集失败保持明确状态（当堂验证第 2 条） ---------- */
    console.log('\n— ③ ★ 采集失败保持明确状态 —');
    /* ② 里被旧帧拒掉的那次采集还挂在 capturing（它自己还在等本命令的新帧）。
     * 等过一个时间窗，让它被 sweep 如实判失败，顺便验证「在途不会永久卡住」。 */
    await sleep(1400);
    const c3 = await jget(port, '/api/cam');
    c3.json = c3.json || {};
    c3.json.shot = shotOf(c3) || {};
    const failedState = shotOf(c3).state;
    ok(!!shotOf(c3).shot_id && (failedState === 'failed' || failedState === 'capturing'),
      '失败或等待中，绝不冒充成功', failedState);

    // 明确制造一次失败：板端回执 no_camera（模拟设备路径）
    const b4 = await jpost(port, '/api/cam', { action: 'shot', trigger: 'ui' });
    b4.json = b4.json || {};
    const shot4 = (shotOf(b4) || {}).shot_id || null;
    // 超时路径：不发帧，等服务器自己的窗口判定
    await sleep(300);
    const c4 = await jget(port, '/api/cam');
    c4.json = c4.json || {};
    c4.json.shot = shotOf(c4) || {};
    ok(shotOf(c4).shot_id === shot4 && (shotOf(c4).state === 'capturing' || shotOf(c4).state === 'requested'),
      '没收到帧时状态停在「采集中」，不跳成功', shotOf(c4).state);

    /* ---------- ④ 画面不可用 → blocked ---------- */
    console.log('\n— ④ 画面不可用（镜头遮挡）→ blocked —');
    /* ③ 的 b4 是「故意不发帧」的那次，它还挂在 capturing（单飞），
     * 先等过一个时间窗让它被 sweep 判失败，否则这里必然 409。 */
    await sleep(1400);
    const b5 = await jpost(port, '/api/cam', { action: 'shot', trigger: 'ui' });
    b5.json = b5.json || {};
    const shot5 = (shotOf(b5) || {}).shot_id || null;
    if (!shot5) console.error('  [debug] ④ 抓拍未被受理 status=' + b5.status + ' err=' + JSON.stringify(b5.json.error || b5.json.message || null));
    await injectFrame(port, flatJpeg(), { shot: true });
    await sleep(300);
    const c5 = await jget(port, '/api/cam');
    c5.json = c5.json || {};
    c5.json.shot = shotOf(c5) || {};
    ok(shotOf(c5).shot_id === shot5 && shotOf(c5).state === 'blocked', '★ 纯色帧 → blocked（与 failed 区分）', shotOf(c5).state);
    ok(/纯色|遮挡|无细节|全黑/.test(shotOf(c5).reason || ''), 'blocked 带具体原因', shotOf(c5).reason);
    const img5 = shot5 ? await jget(port, `/api/cam/snapshot.jpg?shot_id=${shot5}`) : { status: 0 };
    img5.json = img5.json || {};
    ok(img5.status !== 200, 'blocked 的采集取不到图（不把废图当结果）', String(img5.status));

    /* ---------- ⑤ 三种触发来源 ---------- */
    console.log('\n— ⑤ 触发来源：ui / voice / help —');
    const bu = await jpost(port, '/api/cam', { action: 'shot', trigger: 'ui' });
    bu.json = bu.json || {};
    ok((shotOf(bu) || {}).trigger === 'ui', 'ui 触发被记录', (shotOf(bu) || {}).trigger);
    await injectFrame(port, goodJpeg(), { shot: true });
    await sleep(250);

    /* 语音口令：nlRunSnapshot 会一直等帧，所以帧必须【并发】注入 ——
     * 先 await 拿到响应再注入，等于让服务端干等到窗口超时（实测必然 failed）。 */
    const nlPromise = jpost(port, '/api/nl', { text: '看一眼现在什么样' });
    await sleep(250);
    await injectFrame(port, goodJpeg(), { shot: true });
    const vc = await nlPromise;
    vc.json = vc.json || {};
    ok(vc.status === 200, '语音口令「看一眼」被受理', String(vc.status));
    ok(vc.json.intent === 'snapshot', '★ 口令落到 snapshot 意图', vc.json.intent);
    ok(/^shot-/.test(shotOf(vc).shot_id || vc.json.shot_id || ''),
      '口令执行后返回本次 shot_id', shotOf(vc).shot_id || vc.json.shot_id);
    await sleep(250);

    const list0 = await jget(port, '/api/cam/shots');
    list0.json = list0.json || {};
    list0.json = list0.json || {};
    ok(list0.status === 200 && Array.isArray(list0.json.shots), '/api/cam/shots 返回列表');
    ok((list0.json.shots || []).some((r) => r.trigger === 'voice'), '列表里能看到 voice 触发的记录');

    /* ---------- ⑥ 保留最近 N 张 ---------- */
    console.log(`\n— ⑥ 保留：磁盘只留最近 ${KEEP} 张 —`);
    for (let i = 0; i < KEEP + 2; i++) {
      const b = await jpost(port, '/api/cam', { action: 'shot', trigger: 'ui' });
    b.json = b.json || {};
      if (!b.json.ok) { await sleep(400); continue; }
      await injectFrame(port, goodJpeg(), { shot: true });
      await sleep(250);
    }
    const snapDir = path.join(DATA_DIR, 'snapshots');
    const files = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter((n) => n.endsWith('.jpg')) : [];
    ok(files.length <= KEEP, `磁盘上的 JPEG 不超过 ${KEEP} 张`, String(files.length));
    ok(files.length > 0, '至少留了一张（不是全删了）', String(files.length));

    const eventsFile = path.join(snapDir, 'events.ndjson');
    ok(fs.existsSync(eventsFile), '采集事件流水已落盘');
    const evs = fs.existsSync(eventsFile)
      ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean)
      : [];
    ok(evs.length > 0, '事件流水非空', evs.length + ' 行');
    ok(evs.some((e) => e.ev === 'pruned'), '有 pruned 记录（淘汰是留痕的）');
    ok(evs.some((e) => e.ev === 'captured'), '有 captured 记录');
    ok(evs.every((e) => e.shot_id), '每条事件都带 shot_id（能串起来）');

    /* ---------- ⑦ 并发：单飞 ---------- */
    console.log('\n— ⑦ 并发采集被拒（单飞） —');
    const p1 = jpost(port, '/api/cam', { action: 'shot', trigger: 'ui' });
    const p2 = jpost(port, '/api/cam', { action: 'shot', trigger: 'ui' });
    const [r1, r2] = await Promise.all([p1, p2]);
    const codes = [r1.status, r2.status].sort();
    ok(codes.includes(409), '并发时第二次被拒（409 shot_in_progress）', codes.join('/'));
    ok([r1, r2].some((r) => r.json && r.json.error === 'shot_in_progress'),
      '拒绝原因是 shot_in_progress');
    await injectFrame(port, goodJpeg(), { shot: true });
    await sleep(250);

    /* ---------- ⑧ 不要求先开直播流 ---------- */
    console.log('\n— ⑧ 按需采集不依赖直播流 —');
    const st = await jget(port, '/api/cam');
    st.json = st.json || {};
    st.json = st.json || {};
    ok(st.json.streaming === false || st.json.streaming === undefined,
      '模拟设备下没有直播流，但采集仍能成功', String(st.json.streaming));
    ok(st.json.shots === undefined || Array.isArray(st.json.shots),
      'GET /api/cam 可带回历史列表（可选）');
  } finally {
    cleanup();
    await sleep(300);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n结果：${pass} 项通过，${fail} 项失败${skipped ? '，' + skipped + ' 项跳过' : ''}`);
  process.exit(fail ? 1 : 0);
})();
