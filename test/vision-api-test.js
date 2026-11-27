#!/usr/bin/env node
/**
 * 第 8 周：视觉推理接口（集成测试，隔离实例，不碰 8080 / 真实 data/）
 *
 * 锁死的语义：
 *   · 云端默认关闭：visionEnabled=false 时 /api/vision/infer 返回 cloud_disabled，
 *     绝不把画面发往任何模型（模型可用性的「调用次数=0」由 vision-infer-test 断言）；
 *   · 无 shot_id → 400；不存在的 shot → 404；未 captured 的 shot → 409；
 *   · 推理结果带 score_calibrated=false，绑定输入的 shot_id（三对应）；
 *   · 纠正只写 human_*，不存在记录 → 404、缺 human_label → 400；
 *   · 推理记录落盘在 DATA_DIR/vision/records.ndjson。
 */
'use strict';
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, `.test-data-vision-${process.pid}`);
const CONFIG_FIXTURE = path.join(__dirname, '.test-config.json');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};
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
        let json = null; try { json = JSON.parse(text || '{}'); } catch (_) {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
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
async function pickPort(start = 8140) {
  for (let p = start; p < start + 20; p++) if (await portFree(p)) return p;
  throw new Error('端口全被占用');
}

function startServer(port) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cfgPath = path.join(DATA_DIR, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FIXTURE, 'utf8'));
  cfg.mockDevice = true; cfg.autoDetect = false; cfg.autoReconnect = false;
  cfg.httpPort = port; cfg.snapshotKeep = 5; cfg.visionEnabled = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  const env = Object.assign({}, process.env, {
    PORT: String(port), HOST: '127.0.0.1',
    CONFIG_PATH: cfgPath, DATA_DIR,
    NL_CONFIG_PATH: path.join(__dirname, '.test-nl-local-absent.json'),
    NL_ENDPOINT: '', NL_API_KEY: '',
    ASR_ENABLED: '0',
    VISION_ENABLED: '0',           // ★ 云端关闭：本测试验证隐私闸门
    SNAPSHOT_WINDOW_MS: '3000',
  });
  return spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
}

async function waitReady(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await httpReq(port, 'GET', '/api/state'); if (r.status === 200) return true; } catch (_) {}
    await sleep(200);
  }
  return false;
}

function goodJpeg(n = 5000) {
  const b = crypto.randomBytes(n);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[3] = 0xE0;
  b[n - 2] = 0xFF; b[n - 1] = 0xD9;
  return b;
}
let injectSeq = 5000;
async function injectFrame(port, buf) {
  injectSeq++;
  return httpReq(port, 'POST', '/api/data', {
    type: 'frame', device: 'S3EYE-GROUP01', seq: injectSeq, size: '320x240',
    len: buf.length, jpeg: buf.toString('base64'), shot: 1,
  });
}

(async () => {
  console.log('\n— ⓪ 静态契约 —');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  ok(/require\('\.\/lib\/vision-infer\.js'\)/.test(serverSrc), 'server.js 引入 lib/vision-infer.js');
  ok(/api\/vision\/infer/.test(serverSrc), '有 /api/vision/infer 路由');
  ok(/api\/vision\/correct/.test(serverSrc), '有 /api/vision/correct 路由');
  ok(/api\/vision\/config/.test(serverSrc), '有 /api/vision/config 路由');
  ok(/id="btnVisionInfer"/.test(htmlSrc), '页面有「对这张图做识别」按钮');
  ok(/id="visScore"/.test(htmlSrc), '页面有模型分数展示位');

  const port = await pickPort();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const srv = startServer(port);
  const ready = await waitReady(port);
  ok(ready, `隔离实例已就绪（端口 ${port}）`);
  if (!ready) { srv.kill(); process.exit(1); }
  const cleanup = () => { try { srv.kill(); } catch (_) {} };
  process.on('exit', cleanup);

  try {
    console.log('\n— ① 配置：云端默认关闭 —');
    const cfg = await httpReq(port, 'GET', '/api/vision/config');
    ok(cfg.status === 200 && cfg.json && cfg.json.enabled === false, 'visionEnabled=false（默认关闭）', String(cfg.json && cfg.json.enabled));
    ok(cfg.json && cfg.json.model === 'glm-4v-flash', '模型名 glm-4v-flash', cfg.json && cfg.json.model);

    const rec0 = await httpReq(port, 'GET', '/api/vision/records');
    ok(rec0.status === 200 && Array.isArray(rec0.json.records) && rec0.json.records.length === 0, '初始无推理记录');

    console.log('\n— ② 接口校验：缺 id / 不存在的 shot —');
    const noId = await httpReq(port, 'POST', '/api/vision/infer', {});
    ok(noId.status === 400 && noId.json.error === 'shot_id_required', '缺 shot_id → 400', String(noId.status));
    const nf = await httpReq(port, 'POST', '/api/vision/infer', { shot_id: 'shot-20260101-000000-000-0000' });
    ok(nf.status === 404 && nf.json.error === 'shot_not_found', '不存在的 shot → 404', String(nf.status));

    console.log('\n— ③ 采集一张真实记录，再对它推理（cloud_disabled） —');
    const b = await httpReq(port, 'POST', '/api/cam', { action: 'shot', trigger: 'ui' });
    ok(b.status === 200, '抓拍命令被接受');
    await injectFrame(port, goodJpeg());
    await sleep(400);
    const c = await httpReq(port, 'GET', '/api/cam');
    const shot = (c.json && c.json.shot) || {};
    ok(shot.state === 'captured', '采集进入 captured', shot.state);
    const shotId = shot.shot_id;

    const inf = await httpReq(port, 'POST', '/api/vision/infer', { shot_id: shotId, trigger: 'ui' });
    ok(inf.status === 200 && inf.json.ok === true, '推理接口返回 200', String(inf.status));
    const rec = (inf.json && inf.json.record) || {};
    ok(rec.outcome === 'cloud_disabled', '★ 云端关闭时 outcome=cloud_disabled（不上传）', rec.outcome);
    ok(rec.score_calibrated === false, 'score_calibrated=false');
    ok(rec.shot_id === shotId, '★ 结果绑定输入 shot_id（三对应）');
    ok(typeof rec.inference_id === 'string' && rec.inference_id.startsWith('vis-'), 'inference_id 有格式');
    ok(rec.model_version === 'local_metrics_only', '未启用时不谎称用了模型', rec.model_version);

    const one = await httpReq(port, 'GET', '/api/vision/record?inference_id=' + encodeURIComponent(rec.inference_id));
    ok(one.status === 200 && one.json.record.inference_id === rec.inference_id, '按 inference_id 可回查');

    console.log('\n— ④ 人工纠正：只写 human_*，不覆盖 model_* —');
    const cor = await httpReq(port, 'POST', '/api/vision/correct', { inference_id: rec.inference_id, human_label: '这是一张测试画面的纠正' });
    ok(cor.status === 200 && cor.json.ok === true, '纠正成功');
    ok(cor.json.record.human_label && cor.json.record.human_label.label === '这是一张测试画面的纠正', '写入 human_label');
    ok(cor.json.record.model_label === rec.model_label, 'model_label 未被覆盖（保留对照）');
    const cnf = await httpReq(port, 'POST', '/api/vision/correct', { inference_id: 'vis-不存在', human_label: 'x' });
    ok(cnf.status === 404, '纠正不存在的记录 → 404', String(cnf.status));
    const cbad = await httpReq(port, 'POST', '/api/vision/correct', { inference_id: rec.inference_id, human_label: '' });
    ok(cbad.status === 400, '缺 human_label → 400', String(cbad.status));

    console.log('\n— ⑤ 记录列表与落盘 —');
    const list = await httpReq(port, 'GET', '/api/vision/records');
    ok(list.status === 200 && list.json.records.length >= 1, '记录列表可读', String(list.json.records.length));
    const nfile = path.join(DATA_DIR, 'vision', 'records.ndjson');
    ok(fs.existsSync(nfile) && fs.statSync(nfile).size > 0, '推理记录落盘 DATA_DIR/vision/records.ndjson');
  } finally {
    cleanup();
    await sleep(100);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
  process.exit(fail ? 1 : 0);
})();
