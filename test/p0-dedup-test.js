'use strict';
/* P0 修复专项验证：采集并发防护 / 幂等复用
 * 隔离实例 8097 + 独立 DATA_DIR + mockDevice，不碰主服务与真机 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 8097;
const ROOT = path.join(__dirname, '..');
const TEST_DATA = path.join(__dirname, '.test-data-p0');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  try { fs.mkdirSync(TEST_DATA, { recursive: true }); } catch (_) {}
  // 专用配置：mockDevice 让服务端自答回执与观测（模拟模式明确标注）
  const cfg = Object.assign({}, require('./.test-config.json'), { httpPort: PORT, host: '127.0.0.1', mockDevice: true, collectTimeoutMs: 4000 });
  const cfgPath = path.join(__dirname, '.test-p0-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: cfgPath, DATA_DIR: TEST_DATA }), stdio: 'ignore' });
  await sleep(1200);

  try {
    // ---- 场景 1：并发 3 次 POST /api/collect，应只产生 1 个请求 ----
    const before = (await req('GET', '/api/collect')).body.requests.length;
    const [r1, r2, r3] = await Promise.all([req('POST', '/api/collect'), req('POST', '/api/collect'), req('POST', '/api/collect')]);
    if (!r1.body.ok) console.log('  [debug] r1 =', JSON.stringify(r1).slice(0, 300));
    ok(r1.body.ok && r2.body.ok && r3.body.ok, '3 次并发 POST 均 ok=true');
    ok(r1.body.request.request_id === r2.body.request.request_id && r1.body.request.request_id === r3.body.request.request_id,
      `3 次返回同一 request_id（${r1.body.request.request_id}）`);
    ok(r2.body.deduped === true && r3.body.deduped === true, '第 2/3 次响应带 deduped=true');
    ok(!r1.body.deduped, '第 1 次是真正新建（无 deduped）');
    const during = (await req('GET', '/api/collect')).body;
    ok(during.requests.length === before + 1, `请求总数只 +1（${before} → ${during.requests.length}）`);

    // ---- 场景 2：进行中再发，仍复用同一请求（状态非终态不下发新命令）----
    const r4 = await req('POST', '/api/collect');
    ok(r4.body.request.request_id === r1.body.request.request_id && r4.body.deduped === true, '进行中再 POST 仍复用同一请求');

    // ---- 场景 3：等首次采集 completed 后再发 → 允许新建（幂等不锁死）----
    await sleep(2500);   // mock 模式 ~1.2s 完成
    const after1 = (await req('GET', '/api/collect')).body.requests[0];
    ok(after1.status === 'completed', `首次请求已 completed（status=${after1.status}）`);
    const r5 = await req('POST', '/api/collect');
    ok(r5.body.ok && r5.body.request.request_id !== r1.body.request.request_id && !r5.body.deduped, 'completed 后允许发起新一轮采集（新 request_id）');

    // ---- 场景 4：NL 路径幂等 —— 并发两次「重新采集一次」，第二次复用在途请求 ----
    // （nl1 会阻塞到 completed 才返回，串行发第二次时已无在途请求，故必须并发；
    //   且须先等场景 3 的 r5 完成，否则 NL 会复用 r5 而非新建）
    await sleep(2500);
    const before4 = (await req('GET', '/api/collect')).body.requests.length;
    const [nl1, nl2] = await Promise.all([
      req('POST', '/api/nl', { text: '重新采集一次' }),
      req('POST', '/api/nl', { text: '重新采集一次' }),
    ]);
    ok(nl1.body.tool === 'collect_once' && nl1.body.evidence && nl1.body.evidence.status === 'completed', `NL 第 1 次采集成功（${nl1.body.evidence && nl1.body.evidence.status}）`);
    ok(nl2.body.evidence && nl2.body.evidence.deduped === true, 'NL 第 2 次复用在途请求（evidence.deduped=true）');
    ok(nl1.body.evidence.request_id === nl2.body.evidence.request_id, 'NL 两次调用共享同一 request_id');
    const after4 = (await req('GET', '/api/collect')).body;
    ok(after4.requests.length === before4 + 1, `NL 并发也只新增 1 个请求（${before4} → ${after4.requests.length}）`);

    // ---- 场景 5：GET 列表与单查不受影响的结构完整性 ----
    const list = (await req('GET', '/api/collect')).body;
    ok(Array.isArray(list.requests) && list.requests.length >= 2, `请求列表正常（${list.requests.length} 条）`);
    const one = await req('GET', `/api/collect/${encodeURIComponent(r1.body.request.request_id)}`);
    ok(one.status === 200 && one.body.request.request_id === r1.body.request.request_id, '单查旧请求 200');
  } catch (e) {
    fail++; console.error('  ✗ 异常：', e.message);
  } finally {
    srv.kill();
    try { fs.unlinkSync(cfgPath); } catch (_) {}
  }
  console.log(`\nP0 幂等验证：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
