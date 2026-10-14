'use strict';
/*
 * 第 4 周：自然语言助手测试（当堂验证全部用例）
 *
 * 覆盖：
 *   ① “查看上次数据” → 返回旧记录且保留旧时间，不触发任何新采集
 *   ② “重新采集一次” → 等待对应新结果（回执 + 新观测，同一 request_id）
 *   ③ 含糊输入 → 要求澄清，不擅自执行
 *   ④ 越界（点名白名单外设备 / 删除数据）→ 拒绝
 *   ⑤ 位置问题 → 如实说明不提供位置，绝不生成坐标
 *   ⑥ 设备无响应 → 如实报“未能确认采集完成”，绝不说“采集成功”
 *   ⑦ LLM 未配置时规则兜底解析全部可用（备用路径）
 *
 * 自带服务，使用独立端口 8098 与临时数据目录，不影响正在运行的主服务。
 * 用法：node test/nl-test.js
 */
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 8098;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.platform === 'win32' ? 'D:/tmp/nl-test-data' : '/tmp/nl-test-data';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const get = (p) => req({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' });
const post = (p, obj) => {
  const s = JSON.stringify(obj);
  return req({
    host: '127.0.0.1', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) },
  }, s);
};
const jget = async (p) => JSON.parse((await get(p)).body);
const jpost = async (p, o) => JSON.parse((await post(p, o)).body);

/* 注入一条真实传感帧（device=S3EYE-GROUP01） */
const FRAME = (seq, extra) => Object.assign({
  device: 'S3EYE-GROUP01', mac: 'AABBCCDDEEFF', seq,
  acc_x_g: -0.28, acc_y_g: -0.49, acc_z_g: -0.77, temp_c: 51.8,
}, extra || {});

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CONFIG_PATH: path.join(ROOT, 'test', '.test-nl-config.json'),
      DATA_DIR,
      NL_ENDPOINT: '', NL_API_KEY: '',   // 显式确保走规则兜底（备用路径）
      // 隔离真实 config.local.json：否则本机若已配置 LLM，会读到真实密钥而使本用例误判
      NL_CONFIG_PATH: path.join(ROOT, 'test', '.test-nl-local-absent.json'),
    }),
    stdio: 'ignore',
  });
  await sleep(1300);
  try {
    console.log('— 0 能力说明 —');
    let j = await jget('/api/nl');
    ok(j.ok === true, 'GET /api/nl 可用');
    ok(j.llm_configured === false && j.engine === 'rule', 'LLM 未配置 → 声明使用规则兜底（备用路径）');
    ok(j.allowed_device === 'S3EYE-GROUP01', '设备白名单 = S3EYE-GROUP01');
    ok(j.tools && j.tools.query_last && j.tools.collect_once, '只暴露 query_last / collect_once 两个工具');

    console.log('— ① 查看上次数据：无记录时如实回答 —');
    let r = await jpost('/api/nl', { text: '查看上次数据' });
    ok(r.intent === 'query_last' && r.tool === 'query_last', '意图映射：查看上次数据 → query_last');
    ok(r.evidence && r.evidence.found === false, '无记录时 evidence.found=false');
    ok(!/采集成功/.test(r.reply), '回复不含“采集成功”字样');

    console.log('— ① 查看上次数据：有记录时保留旧时间，且不触发新采集 —');
    await jpost('/api/data', FRAME(100, { ts: 1790570000000 }));
    await sleep(200);
    r = await jpost('/api/nl', { text: '上次数据是多少' });
    ok(r.intent === 'query_last', '意图映射：上次数据是多少 → query_last');
    ok(r.evidence && r.evidence.found === true && typeof r.evidence.recv_ts === 'number', '返回旧记录的接收时间');
    ok(/历史|旧/.test(r.reply), '回复明确声明这是历史/旧记录');
    const oldTs = r.evidence.recv_ts;
    let lst = await jget('/api/collect');
    const before = (lst.requests || []).length;
    r = await jpost('/api/nl', { text: '再帮我看看上次数据' });
    lst = await jget('/api/collect');
    ok((lst.requests || []).length === before, '连续查询不产生任何采集请求');
    ok(r.evidence.recv_ts === oldTs, '同一旧数据两次查询，时间不变（保留旧时间）');

    console.log('— ② 重新采集：等待对应新结果，证据链完整 —');
    r = await jpost('/api/nl', { text: '重新采集一次' });
    ok(r.intent === 'collect_once' && r.tool === 'collect_once', '意图映射：重新采集一次 → collect_once');
    ok(r.evidence && r.evidence.status === 'completed', '等到新结果：status=completed');
    ok(typeof r.evidence.request_id === 'string' && r.evidence.request_id.length > 0, '携带 request_id（回环证据）');
    ok(/采集成功/.test(r.reply), '有完成证据才说“采集成功”');
    ok(r.evidence.simulated === true, '模拟模式如实标注 simulated');
    // 再注入新帧后查询：上次数据时间应更新（与采集结果对应）
    await jpost('/api/data', FRAME(200, { ts: 1790571000000 }));
    await sleep(200);
    r = await jpost('/api/nl', { text: '查看上次数据' });
    ok(r.evidence.recv_ts > oldTs, '新采集后“查看上次数据”返回的是更新的记录');

    console.log('— ③ 含糊输入：要求澄清，不擅自执行 —');
    r = await jpost('/api/nl', { text: '数据' });
    ok(r.intent === 'ambiguous' && r.error === 'ambiguous', '只说“数据” → ambiguous');
    ok(/查看上次数据/.test(r.reply) && /重新采集/.test(r.reply), '澄清回复列出两个可选任务');
    ok(!r.tool, '含糊时不执行任何工具');

    console.log('— ④ 越界请求：一律拒绝 —');
    r = await jpost('/api/nl', { text: '查看S3EYE-GROUP99的数据' });
    ok(r.intent === 'out_of_scope' && r.error === 'device_out_of_scope', '点名白名单外设备 → 拒绝');
    ok(/S3EYE-GROUP99/.test(r.reply) && /不在允许范围/.test(r.reply), '拒绝回复点明设备与范围');
    r = await jpost('/api/nl', { text: '删除所有记录' });
    ok(r.intent === 'out_of_scope', '删除数据 → 拒绝');

    console.log('— ⑤ 位置问题：说明不提供，绝不生成坐标 —');
    r = await jpost('/api/nl', { text: '设备在哪里' });
    ok(r.intent === 'location_query' && r.error === 'no_location_data', '位置问题 → location_query');
    ok(/不包含位置/.test(r.reply) && /不会生成|不会.*坐标|推测坐标/.test(r.reply), '如实说明不提供位置');
    ok(!/\d{2,3}\.\d{4,}/.test(r.reply), '回复中不出现任何疑似经纬度数字');
    r = await jpost('/api/nl', { text: '给我坐标' });
    ok(r.intent === 'location_query', '直接要坐标 → location_query');

    console.log('— ⑥ 设备无响应：不说“采集成功” —');
    await jpost('/api/config', { mockDevice: false });
    r = await jpost('/api/nl', { text: '重新采集一次' });
    ok(r.intent === 'collect_once', '意图仍是 collect_once');
    ok(r.evidence && r.evidence.status !== 'completed', '无设备完成证据：status != completed（实际=' + (r.evidence && r.evidence.status) + '）');
    ok(!/采集成功/.test(r.reply), '回复绝不含“采集成功”');
    ok(/未能确认采集完成/.test(r.reply), '如实回复“未能确认采集完成”');

    console.log('— ⑦ 中文表述变体（规则兜底健壮性） —');
    await jpost('/api/config', { mockDevice: true });
    r = await jpost('/api/nl', { text: '再采一帧' });
    ok(r.intent === 'collect_once', '“再采一帧” → collect_once');
    r = await jpost('/api/nl', { text: '最近的数据怎么样' });
    ok(r.intent === 'query_last', '“最近的数据” → query_last');
    r = await jpost('/api/nl', { text: '今天天气怎么样' });
    ok(r.intent === 'other' && r.error === 'unknown_intent', '无关请求 → 引导到两个能力');
  } finally {
    srv.kill();
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
