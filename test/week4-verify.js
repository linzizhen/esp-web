'use strict';
/*
 * 第 4 周验收自检脚本（打真实运行中的服务，不是隔离实例）
 *
 * 与 test/nl-test.js 的区别：
 *   - nl-test.js      = 自动化测试，自带隔离实例（8090-8099 内动态挑空闲端口 + 临时数据目录 + mockDevice），
 *                       用于改代码后回归，37 项断言全硬断言。
 *   - week4-verify.js = 验收自检，打你眼前正在跑的服务（默认 8080），
 *                       逐条跑当堂验证用例并输出结论表 + 关键证据，方便当场演示/截图留证。
 *
 * 用法：
 *   node test/week4-verify.js              # 打 http://127.0.0.1:8080
 *   PORT=8090 node test/week4-verify.js    # 打别的端口
 *
 * 说明：本脚本会真的向设备下发一次采集请求（用例 ④），这是真实验证，不是模拟。
 *       设备离线时该用例不会判失败——"如实报未完成"本身就是正确行为，脚本会分开判定。
 */
const http = require('node:http');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

let pass = 0, fail = 0;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: HOST, port: PORT, path, method,
      headers: payload
        ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length }
        : {},
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const jget = async (p) => {
  const r = await req('GET', p);
  try { return JSON.parse(r.body); } catch { return {}; }
};
const jpost = async (p, o) => {
  const r = await req('POST', p, o);
  try { return JSON.parse(r.body); } catch { return { _raw: r.body }; };
};

/* 记录一条结论：ok=通过 / fail=不通过 / warn=环境导致跳过（不算失败） */
function check(name, ok, detail, level) {
  const lv = level || (ok ? 'ok' : 'fail');
  if (lv === 'ok') pass++; else if (lv === 'fail') fail++;
  results.push({ lv, name, detail });
  const mark = lv === 'ok' ? '✔' : lv === 'warn' ? '!' : '✘';
  console.log(`  ${mark} ${name}${detail ? '  → ' + detail : ''}`);
}
const head = (t) => console.log(`\n${t}`);

(async () => {
  console.log(`第 4 周验收自检  →  http://${HOST}:${PORT}`);
  console.log('='.repeat(60));

  /* ---------- 前置：服务与设备状态 ---------- */
  head('【前置】服务与设备状态');
  let st = {};
  try {
    st = await jget('/api/state');
  } catch (e) {
    console.error(`\n✘ 连不上服务 http://${HOST}:${PORT}：${e.message}`);
    console.error('  请先启动服务：node server.js（本项目后台服务需 run_in_background 方式启动）');
    process.exit(1);
  }
  const online = !!(st && st.connected && st.live);
  check('服务在线', true, `transport=${st.transport || '-'} deviceId=${st.deviceId || '-'} seq=${st.seq ?? '-'}`);
  check('设备在线状态已探明', true, online ? '在线（采集用例按"应完成"判定）' : '离线（采集用例按"应如实报未完成"判定）', 'ok');

  /* ---------- ① 能力自证 ---------- */
  head('① 能力说明（GET /api/nl）：只报是否配置，不泄密钥');
  const cap = await jget('/api/nl');
  check('接口可用', cap.ok === true, `engine=${cap.engine} llm_configured=${cap.llm_configured}`);
  check('只暴露两个工具', !!(cap.tools && cap.tools.query_last && cap.tools.collect_once),
    Object.keys(cap.tools || {}).join(', '));
  check('设备白名单正确', cap.allowed_device === 'S3EYE-GROUP01', String(cap.allowed_device));
  check('未配置 LLM 时如实声明', cap.llm_configured === false ? cap.engine === 'rule' : true,
    cap.llm_configured ? `已配置 LLM（host=${cap.llm_host}）` : 'engine=rule（备用路径）');

  /* ---------- ② 查看上次数据：保留旧时间，不触发采集 ---------- */
  head('② 查看上次数据：保留旧时间，且不触发任何采集');
  let a = await jpost('/api/nl', { text: '查看上次数据' });
  check('意图 = query_last', a.intent === 'query_last' && a.tool === 'query_last', `intent=${a.intent}`);
  check('回复声明是历史/旧记录', /历史|旧/.test(a.reply || ''), (a.reply || '').slice(0, 46) + '…');
  const found = !!(a.evidence && a.evidence.found);
  check('返回记录证据', found, found ? `recv=${a.evidence.recv_iso} seq=${a.evidence.record_seq}` : 'evidence.found=false（无历史记录）');

  const lst0 = await jget('/api/collect');
  const before = ((lst0 && lst0.requests) || []).length;
  let b = await jpost('/api/nl', { text: '上次数据是多少' });
  const lst1 = await jget('/api/collect');
  check('连续查询不产生采集请求', ((lst1 && lst1.requests) || []).length === before,
    `请求数 ${before} → ${((lst1 && lst1.requests) || []).length}`);
  if (found && b.evidence && b.evidence.recv_ts != null) {
    check('同一旧数据两次查询时间不变（保留旧时间）', b.evidence.recv_ts === a.evidence.recv_ts,
      `${a.evidence.recv_ts} == ${b.evidence.recv_ts}`);
  }

  /* ---------- ③ 重新采集：等待对应新结果 ---------- */
  head('③ 重新采集一次：等待对应新结果（真实下发，不是模拟）');
  const c = await jpost('/api/nl', { text: '重新采集一次' });
  check('意图 = collect_once', c.intent === 'collect_once' && c.tool === 'collect_once', `intent=${c.intent}`);
  const ev = c.evidence || {};
  if (online) {
    check('等到完成证据 status=completed', ev.status === 'completed', `status=${ev.status}`);
    check('携带 request_id（回执与新观测同环）', typeof ev.request_id === 'string' && ev.request_id.length > 0,
      String(ev.request_id));
    check('seq 严格递增 + 到达晚于下发',
      !!(ev.checks && ev.checks.seq_increased && ev.checks.arrived_after_dispatch),
      `seq ${ev.seq_before} → ${ev.seq_observed}`);
    check('真实设备结果不是模拟', ev.simulated === false, `simulated=${ev.simulated}`);
    check('有完成证据才说"采集成功"', /采集成功/.test(c.reply || ''), (c.reply || '').slice(0, 40) + '…');
  } else {
    check('设备离线时如实报未完成', ev.status !== 'completed', `status=${ev.status}`);
    check('回复绝不含"采集成功"', !/采集成功/.test(c.reply || ''), '无完成证据不声称成功');
    check('如实说明"未能确认采集完成"', /未能确认采集完成/.test(c.reply || ''), '诚实性红线');
  }

  /* ---------- ④ 含糊输入 ---------- */
  head('④ 含糊输入：要求澄清，不擅自执行');
  const d = await jpost('/api/nl', { text: '数据' });
  check('意图 = ambiguous', d.intent === 'ambiguous', `intent=${d.intent}`);
  check('澄清回复列出两个可选任务', /查看上次数据/.test(d.reply || '') && /重新采集/.test(d.reply || ''), '');
  check('不执行任何工具', !d.tool, `tool=${d.tool || '(无)'}`);

  /* ---------- ⑤ 越界拒绝 ---------- */
  head('⑤ 越界请求：一律拒绝');
  const e1 = await jpost('/api/nl', { text: '查看S3EYE-GROUP99的数据' });
  check('白名单外设备 → 拒绝', e1.intent === 'out_of_scope' && e1.error === 'device_out_of_scope',
    `error=${e1.error}`);
  const e2 = await jpost('/api/nl', { text: '删除所有记录' });
  check('危险/越界操作 → 拒绝', e2.intent === 'out_of_scope', `intent=${e2.intent}`);

  /* ---------- ⑥ 位置问题：绝不生成坐标 ---------- */
  head('⑥ 位置问题：如实说明不提供，绝不生成坐标');
  const f = await jpost('/api/nl', { text: '设备在哪里' });
  check('意图 = location_query', f.intent === 'location_query', `intent=${f.intent}`);
  check('回复中不出现任何疑似经纬度数字', !/\d{2,3}\.\d{4,}/.test(f.reply || ''), (f.reply || '').slice(0, 40) + '…');
  const f2 = await jpost('/api/nl', { text: '给我坐标' });
  check('直接要坐标也拒绝并说明', f2.intent === 'location_query', `intent=${f2.intent}`);

  /* ---------- ⑦ 中文表述变体 / 无关问题 ---------- */
  head('⑦ 中文表述变体与无关问题');
  const g1 = await jpost('/api/nl', { text: '再采一帧' });
  check('"再采一帧" → collect_once', g1.intent === 'collect_once', `intent=${g1.intent}`);
  const g2 = await jpost('/api/nl', { text: '最近的数据怎么样' });
  check('"最近的数据怎么样" → query_last', g2.intent === 'query_last', `intent=${g2.intent}`);
  const g3 = await jpost('/api/nl', { text: '今天天气怎么样' });
  check('无关请求 → 引导到两个能力', g3.intent === 'other', `intent=${g3.intent}`);

  /* ---------- 汇总 ---------- */
  console.log('\n' + '='.repeat(60));
  const warns = results.filter((r) => r.lv === 'warn').length;
  console.log(`结果：${pass} 通过，${fail} 失败${warns ? `，${warns} 提示` : ''}`);
  if (fail) {
    console.log('\n未通过项：');
    results.filter((r) => r.lv === 'fail').forEach((r) => console.log(`  ✘ ${r.name}  → ${r.detail}`));
  } else {
    console.log('第 4 周当堂验证用例全部通过 ✅');
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n脚本异常：', e.message);
  process.exit(1);
});
