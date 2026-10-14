'use strict';
/* LLM 自定义配置管理专项测试（隔离实例 8098 + 独立 NL_CONFIG_PATH，不碰真实密钥文件）
 * 覆盖：查看（脱敏）/保存（校验+落盘）/测试连接（成功+失败分类）/删除/推理接入/密钥不泄漏 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 8095;
const ROOT = path.join(__dirname, '..');
const TEST_DATA = path.join(__dirname, '.test-data-nlcfg');
const NL_CFG_PATH = path.join(__dirname, '.test-nl-local.json');
const FULL_KEY = 'sk-test-full-secret-key-0123456789';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { host: '127.0.0.1', port: PORT, path: p, method };
    if (data) {
      opts.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    }
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d || '{}'); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: d });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* mock OpenAI 兼容 LLM 服务：记录请求，返回固定意图 JSON */
let llmHits = 0;
const llmMock = http.createServer((req2, res2) => {
  let b = '';
  req2.on('data', (c) => (b += c));
  req2.on('end', () => {
    llmHits++;
    const auth = req2.headers.authorization || '';
    if (!auth.includes('Bearer ')) { res2.writeHead(401); res2.end('{"error":"no auth"}'); return; }
    res2.writeHead(200, { 'Content-Type': 'application/json' });
    res2.end(JSON.stringify({ choices: [{ message: { content: '{"intent":"query_last","device":null,"reason":"mock"}' } }] }));
  });
});

(async () => {
  try { fs.mkdirSync(TEST_DATA, { recursive: true }); } catch (_) {}
  for (const f of [NL_CFG_PATH]) { try { fs.unlinkSync(f); } catch (_) {} }
  await new Promise((r) => llmMock.listen(0, '127.0.0.1', r));
  const llmPort = llmMock.address().port;

  const srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1',
      CONFIG_PATH: path.join(__dirname, '.test-config.json'),
      DATA_DIR: TEST_DATA,
      NL_CONFIG_PATH: NL_CFG_PATH,          // 隔离：不碰真实 config.local.json
      NL_ENDPOINT: '', NL_API_KEY: '', NL_MODEL: '', NL_TIMEOUT_MS: '',   // 清掉宿主可能的 env 覆盖
    }),
    stdio: 'ignore',
  });
  await sleep(1300);

  try {
    // ---- 1. 初始：未配置 ----
    const g0 = await req('GET', '/api/nl/config');
    ok(g0.status === 200 && g0.body.configured === false && g0.body.source === 'none', '初始未配置（source=none）');
    ok(!JSON.stringify(g0.body).includes(FULL_KEY), '未配置响应不含密钥');

    // ---- 2. 保存校验：各非法输入给明确错误 ----
    ok((await req('PUT', '/api/nl/config', { endpoint: '', apiKey: 'x', model: 'm' })).status === 400, '空地址 → 400');
    ok((await req('PUT', '/api/nl/config', { endpoint: 'not-a-url', apiKey: 'x', model: 'm' })).status === 400, '非法 URL → 400');
    ok((await req('PUT', '/api/nl/config', { endpoint: 'ftp://x.com', apiKey: 'x', model: 'm' })).status === 400, '非 http(s) 协议 → 400');
    ok((await req('PUT', '/api/nl/config', { endpoint: 'https://x.com', apiKey: '', model: 'm' })).status === 400, '空 Key → 400');
    ok((await req('PUT', '/api/nl/config', { endpoint: 'https://x.com', apiKey: 'a b', model: 'm' })).status === 400, 'Key 含空白 → 400');
    ok((await req('PUT', '/api/nl/config', { endpoint: 'https://x.com', apiKey: 'x', model: '' })).status === 400, '空模型 → 400');
    ok((await req('PUT', '/api/nl/config', { endpoint: 'https://x.com', apiKey: 'x', model: 'm', timeoutMs: 100 })).status === 400, '超时越界 → 400');

    // ---- 3. 保存合法配置 ----
    const s1 = await req('PUT', '/api/nl/config', { endpoint: `http://127.0.0.1:${llmPort}`, apiKey: FULL_KEY, model: 'mock-llm', timeoutMs: 5000 });
    ok(s1.status === 200 && s1.body.configured === true && s1.body.source === 'file', '保存成功（source=file）');
    ok(s1.body.apiKey_masked && s1.body.apiKey_masked.includes('****') && !s1.body.apiKey_masked.includes(FULL_KEY), '响应只含脱敏 Key');
    ok(!s1.raw.includes(FULL_KEY), '保存响应原文不含完整 Key');
    const onDisk = JSON.parse(fs.readFileSync(NL_CFG_PATH, 'utf8'));
    ok(onDisk.nlApiKey === FULL_KEY && onDisk.nlEndpoint === `http://127.0.0.1:${llmPort}` && onDisk.nlModel === 'mock-llm', '密钥已落盘到隔离配置文件');
    ok(onDisk.nlTimeoutMs === 5000, '超时已落盘');

    // ---- 4. 查看：脱敏，不泄漏 ----
    const g1 = await req('GET', '/api/nl/config');
    ok(g1.body.configured === true && g1.body.model === 'mock-llm', '查看返回已配置+模型名');
    ok(g1.body.apiKey_masked && !g1.raw.includes(FULL_KEY), '查看响应不含完整 Key');

    // ---- 5. 测试连接：成功 ----
    const t1 = await req('POST', '/api/nl/config/test', {});
    ok(t1.status === 200 && t1.body.ok === true && typeof t1.body.latencyMs === 'number', `测试连接成功（${t1.body.latencyMs}ms）`);
    ok(!t1.raw.includes(FULL_KEY), '测试成功响应不含 Key');

    // ---- 6. 测试连接：失败分类（不存在的端口 → 明确错误；并带表单参数测试） ----
    const t2 = await req('POST', '/api/nl/config/test', { endpoint: 'http://127.0.0.1:1', apiKey: 'x', model: 'm', timeoutMs: 3000 });
    ok(t2.status === 200 && t2.body.ok === false && /拒绝|失败|超时|解析/.test(t2.body.error || ''), '不可达地址 → ok=false 且错误明确');
    ok((await req('POST', '/api/nl/config/test', { endpoint: 'bad', apiKey: 'x', model: 'm' })).status === 400, '测试带非法参数 → 400');

    // ---- 7. 推理接入：保存后 NL 走自定义模型（engine=llm 且 reason 来自 mock） ----
    llmHits = 0;
    const nl1 = await req('POST', '/api/nl', { text: '看看上次的数据' });
    ok(nl1.status === 200 && nl1.body.engine === 'llm', 'NL 引擎 = llm（自定义模型生效）');
    ok(nl1.body.parser_note === 'mock', '意图确实来自 mock 云端模型');
    ok(llmHits === 1, '自定义模型端点被请求 1 次');
    ok(nl1.body.tool === 'query_last', '意图路由正确');

    // ---- 8. 修改配置（换模型名）→ 立即生效 ----
    await req('PUT', '/api/nl/config', { endpoint: `http://127.0.0.1:${llmPort}`, apiKey: FULL_KEY, model: 'mock-v2', timeoutMs: 5000 });
    const g2 = await req('GET', '/api/nl/config');
    ok(g2.body.model === 'mock-v2', '修改模型名已生效');

    // ---- 9. 删除 ----
    const d1 = await req('DELETE', '/api/nl/config');
    ok(d1.status === 200 && d1.body.configured === false && d1.body.source === 'none', '删除后未配置');
    ok(!fs.existsSync(NL_CFG_PATH) || !JSON.parse(fs.readFileSync(NL_CFG_PATH, 'utf8')).nlApiKey, '盘上密钥已清');
    const nl2 = await req('POST', '/api/nl', { text: '看看上次的数据' });
    ok(nl2.status === 200 && nl2.body.engine === 'rule', '删除后 NL 降级规则兜底');

    // ---- 10. 测试连接未配置 → 明确提示 ----
    const t3 = await req('POST', '/api/nl/config/test', {});
    ok(t3.status === 400 && t3.body.error === 'not_configured', '未配置时测试连接 → 400 not_configured');
  } catch (e) {
    fail++; console.error('  ✗ 异常：', e.message);
  } finally {
    srv.kill();
    llmMock.close();
    try { fs.unlinkSync(NL_CFG_PATH); } catch (_) {}
  }
  console.log(`\nLLM 配置管理验证：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
