'use strict';
/*
 * 空帧守卫测试（t6）
 *
 * 背景：data/records.ndjson 里曾出现 158 条 fields:{} 的空记录，违反项目红线
 * 「一帧真实观测 = 一条记录」。根因是 key=value 解析路径不剔除元数据数值键
 * （ts / seq / uptime_ms / boot_ms）：这类行能通过「numbers 非空」守卫，
 * 删掉元数据后 disp 变成 {}，旧代码仍然落盘。
 *
 * 断言目标：
 *   ① 只含元数据的帧 → 不落盘、不产生 fields、不改 state
 *   ② 含 device+seq 但无传感值的帧 → 不落盘
 *   ③ 正常传感帧 → 照常落盘且值正确
 *   ④ 请求 id 帧：不产生「空采样记录」，但采集链路不被误报成功
 *      （既有语义：JSON 帧无传感值即不是观测，采集侧应如实超时）
 *
 * 自带服务，使用独立端口 8091 与隔离 DATA_DIR，不影响正在运行的主服务。
 * 用法：node test/handleline-guard-test.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.GUARD_PORT || 8091);
const ROOT = path.join(__dirname, '..');
/* ★ 隔离 DATA_DIR：本测试会注入合成帧，不隔离会写进真实 data/records.ndjson。 */
const DATA_DIR = path.join(__dirname, '.test-data-guard');

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  → ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  → ' + extra : '')); }
};
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
/* 原始文本帧（用于 key=value / 非 JSON 行） */
const postRaw = (p, text) => req({
  host: '127.0.0.1', port: PORT, path: p, method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(text) },
}, text);

const jget = async (p) => JSON.parse((await get(p)).body);
const jpost = async (p, o) => JSON.parse((await post(p, o)).body);

const countRecords = async () => {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'records.ndjson'), 'utf8');
    return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (_) { return []; }
};

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1',
      CONFIG_PATH: path.join(ROOT, 'test', '.test-config.json'),
      DATA_DIR,
      NL_CONFIG_PATH: path.join(__dirname, '.test-nl-local-absent.json'),
      NL_ENDPOINT: '', NL_API_KEY: '',
    }),
    stdio: 'ignore',
  });
  await sleep(1400);
  const start = Date.now();

  try {
    // 关掉串口自动连接：否则「串口优先」会让 /api/data 注入被忽略
    await jpost('/api/config', { autoDetect: false, autoReconnect: false, parseMode: 'auto' });
    await post('/api/disconnect', {});
    await sleep(400);

    /* ---------------- ① 只含元数据数值键 ---------------- */
    console.log('— ① 只含元数据键的帧：不得落盘 —');

    let before = (await countRecords()).length;
    await jpost('/api/data', { seq: 1, ts: 123 });
    await sleep(350);
    let recs = await countRecords();
    ok(recs.length === before, 'JSON {"seq":1,"ts":123} 不产生记录', `记录 ${before} → ${recs.length}`);
    let st = await jget('/api/state');
    ok(Object.keys(st.fields).length === 0, 'state.fields 保持为空（未产生假字段）', JSON.stringify(st.fields));
    ok(st.connected === false, '未把设备误标为已连接', String(st.connected));

    console.log('— ①b key=value 路径（历史脏记录的真实来源）—');
    before = (await countRecords()).length;
    await postRaw('/api/data', 'seq=12 ts=1700000001000');
    await sleep(350);
    recs = await countRecords();
    ok(recs.length === before, 'key=value "seq=12 ts=..." 不产生记录', `记录 ${before} → ${recs.length}`);
    st = await jget('/api/state');
    ok(Object.keys(st.fields).length === 0, 'state.fields 仍为空', JSON.stringify(st.fields));

    before = (await countRecords()).length;
    await postRaw('/api/data', 'uptime_ms=12345');
    await sleep(350);
    recs = await countRecords();
    ok(recs.length === before, 'key=value "uptime_ms=..." 不产生记录', `记录 ${before} → ${recs.length}`);

    /* ---------------- ② device + seq 但无传感值 ---------------- */
    console.log('— ② 含设备身份但无传感值的帧：不得落盘 —');
    before = (await countRecords()).length;
    await jpost('/api/data', { device: 'S3EYE-GROUP01', seq: 5 });
    await sleep(350);
    recs = await countRecords();
    ok(recs.length === before, 'JSON {"device":"X","seq":5} 不产生记录', `记录 ${before} → ${recs.length}`);
    const emptyRecs = recs.filter((r) => !r.fields || Object.keys(r.fields).length === 0);
    ok(emptyRecs.length === 0, '库中不存在 fields:{} 的空记录', `共 ${recs.length} 条`);

    /* ---------------- ③ 正常传感帧：照常落盘 ---------------- */
    console.log('— ③ 正常传感帧：必须照常落盘（不得误伤）—');
    before = (await countRecords()).length;
    await jpost('/api/data', {
      device: 'S3EYE-GROUP01', mac: 'AABBCCDDEEFF', seq: 10,
      ts: Date.now(), acc_z_g: 2.0, temp_c: 31.2,
    });
    await sleep(400);
    recs = await countRecords();
    ok(recs.length === before + 1, '正常帧落盘恰好 +1 条', `记录 ${before} → ${recs.length}`);
    const normal = recs[recs.length - 1];
    ok(normal.device_id === 'S3EYE-GROUP01', '正常帧记录含 device_id', String(normal.device_id));
    ok(normal.fields.acc_z_g === 2.0 && normal.fields.temp_c === 31.2, '正常帧传感值正确落盘', JSON.stringify(normal.fields));
    ok(!('seq' in normal.fields) && !('ts' in normal.fields), '元数据未混入 fields', JSON.stringify(Object.keys(normal.fields)));

    console.log('— ③b key=value 元数据 + 一个传感值：应照常落盘 —');
    before = (await countRecords()).length;
    await postRaw('/api/data', 'seq=13 ts=1700000002000 temp_c=26.5');
    await sleep(350);
    recs = await countRecords();
    ok(recs.length === before + 1, '含传感值的键值行落盘 +1', `记录 ${before} → ${recs.length}`);
    const kv = recs[recs.length - 1];
    ok(kv.fields.temp_c === 26.5, '键值行传感值正确', JSON.stringify(kv.fields));
    ok(!('seq' in kv.fields) && !('ts' in kv.fields), '键值行元数据未混入 fields', JSON.stringify(Object.keys(kv.fields)));

    /* ---------------- ④ request_id 采集帧不被误伤 ---------------- */
    console.log('— ④ request_id：不产生空采样记录，采集链路如实处理 —');
    const cr = await jpost('/api/collect', {});
    const rid = cr.request && cr.request.request_id;
    ok(!!rid, '发起采集请求成功', String(rid));

    // ④a 带 request_id 且带传感值 → 正常落盘 + 采集完成
    before = (await countRecords()).length;
    await jpost('/api/data', {
      device: 'S3EYE-GROUP01', seq: 20, request_id: rid, ts: Date.now(), acc_z_g: -1.0, temp_c: 30.0,
    });
    await sleep(500);
    recs = await countRecords();
    ok(recs.length === before + 1, '带 request_id 的正常观测照常落盘 +1', `记录 ${before} → ${recs.length}`);
    let one = await jget('/api/collect/' + encodeURIComponent(rid));
    ok(one.request.status === 'completed', '采集请求标记 completed（观测证据真实）', one.request.status);

    // ④b 只带 request_id、没有任何传感值 → 不是观测：不落盘，且不得被当成采集完成
    const cr2 = await jpost('/api/collect', {});
    const rid2 = cr2.request && cr2.request.request_id;
    ok(!!rid2, '发起第二个采集请求', String(rid2));
    before = (await countRecords()).length;
    await jpost('/api/data', { device: 'S3EYE-GROUP01', seq: 21, request_id: rid2 });
    await sleep(400);
    recs = await countRecords();
    ok(recs.length === before, '无传感值的 request_id 帧不产生记录', `记录 ${before} → ${recs.length}`);
    one = await jget('/api/collect/' + encodeURIComponent(rid2));
    ok(one.request.status !== 'completed', '无观测证据 → 采集不得标 completed（如实不成功）', one.request.status);

    /* ---------------- ⑤ 全局不变量 ---------------- */
    console.log('— ⑤ 全程不变量：库中无空记录 —');
    recs = await countRecords();
    const empties = recs.filter((r) => !r.fields || Object.keys(r.fields).length === 0);
    ok(empties.length === 0, 'records.ndjson 中空记录数为 0', `总 ${recs.length} 条`);
    ok(recs.length === 3, '总记录数 = 正常帧数（3 条）', String(recs.length));

  } catch (e) {
    console.error('测试异常：', e && e.stack ? e.stack.split('\n')[0] : e);
    fail++;
  } finally {
    srv.kill('SIGKILL');
    await sleep(200);
  }

  const dur = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}   （${dur}s）`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
