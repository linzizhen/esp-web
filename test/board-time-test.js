/* 板端时间三列契约（2026-11-27 真机实测暴露的字段映射缺陷）
 *
 * 现象：固件帧里明明有 `"ts":1795745719831,"iso":"2026-11-27T02:15:19Z"`，
 * 落盘记录却是 `board_ts=1795745719831`（对）、`board_iso=null`（错）、
 * 并且 `iso` 被当成传感器字段塞进了 `fields.iso`。
 *
 * 根因：`server.js` 的 `META_KEYS` 只收了 `device/mac/src/ver/fw/id/imu_*`，
 * 没收 `iso`。于是 JSON 解析时 `meta.iso` 永远是 undefined
 *   → `state.boardIso = meta.iso || null` 恒为 null
 *   → 记录里 `board_iso` 恒为 null
 *   → 而 `iso` 留在 numbers 里，最后混进 `fields`，被页面当成一个传感器卡片。
 *
 * 后果：第 1 周「核对单位与时间」与第 7 周「带采集时间的输入样例」都只剩
 * 服务端接收时刻，板端时刻读不出来（虽然 board_ts 有，但要人自己换算）。
 *
 * 本测试锁住：
 *   ① `iso` 必须被当作元数据（在 META_KEYS 里）；
 *   ② 落盘记录的 `board_iso` 非空且等于帧里的 iso；
 *   ③ `fields` 里不许出现 `iso`（元数据不该画成传感器卡片）；
 *   ④ `skew_ms` 与 board_ts/recv_ts 自洽。
 *
 * 用法：node test/board-time-test.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'test', `.test-data-boardtime-${process.pid}`);
const PORT = 8160 + (process.pid % 20);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* ─────────── ⓪ 静态契约 ─────────── */
console.log('=== ⓪ 静态契约（META_KEYS 必须收 iso）===\n');
const SRV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const metaLine = (SRV.match(/const META_KEYS = new Set\(\[[\s\S]*?\]\);/) || [''])[0];
check('META_KEYS 定义存在', metaLine.length > 0);
check("META_KEYS 含 'iso'（否则 board_iso 永远为 null）",
  /['"]iso['"]/.test(metaLine),
  metaLine ? metaLine.replace(/\s+/g, ' ').slice(0, 130) : '');
check('board_iso 由 meta.iso 赋值',
  /state\.boardIso\s*=\s*meta\.iso/.test(SRV),
  (SRV.match(/state\.boardIso\s*=[^;]*;/) || [''])[0].trim());
check('落盘记录的 board_iso 取 state.boardIso',
  /board_iso:\s*state\.boardIso/.test(SRV));

/* ─────────── 起隔离实例 ─────────── */
const cfgPath = path.join(DATA_DIR, 'config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify({
  httpPort: PORT, host: '127.0.0.1', portPath: '', autoDetect: false,
  expectedDeviceId: '', storageMaxMb: 32, mockDevice: true,
}, null, 2), 'utf8');

const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  CONFIG_PATH: cfgPath,
  NL_CONFIG_PATH: path.join(DATA_DIR, 'nl-absent.json'),
  NL_ENDPOINT: '',
  ASR_ENABLED: '0',
  E2E_PORT: String(PORT),
};

const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d.toString(); });
child.stderr.on('data', (d) => { log += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method, timeout: 10000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (s) => {
      let b = '';
      s.on('data', (c) => { b += c; });
      s.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (_) { /* 非 JSON 响应 */ }
        resolve({ status: s.statusCode, json, text: b });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

async function waitReady(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { await req('GET', '/api/state'); return true; } catch (_) { await sleep(200); }
  }
  return false;
}

(async () => {
  const ready = await waitReady();
  if (!ready) {
    console.error('隔离实例未就绪\n' + log.slice(-1200));
    child.kill();
    process.exit(1);
  }

  console.log('\n=== ① 注入一帧带 ts + iso 的数据 ===\n');
  const boardTs = Date.now() - 3000;
  const boardIso = new Date(boardTs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const frame = {
    device: 'TEST-BOARDTIME', mac: 'AABBCCDDEEFF', seq: 4321,
    ts: boardTs, iso: boardIso,
    acc_x_g: 0.1, acc_y_g: -0.2, acc_z_g: 0.98, temp_c: 31.5,
  };
  const post = await req('POST', '/api/data', frame);
  check('注入帧被接受（HTTP 200）', post.status === 200, 'status=' + post.status);
  await sleep(400);

  console.log('\n=== ② 记录里的板端时间三列 ===\n');
  const recs = await req('GET', '/api/records?limit=1');
  const row = (recs.json && recs.json.rows && recs.json.rows[0]) || null;
  check('取到一条记录', !!row);
  if (row) {
    check('board_ts 非空且等于帧里的 ts',
      row.board_ts === boardTs, 'board_ts=' + JSON.stringify(row.board_ts) + ' 期望=' + boardTs);
    check('★ board_iso 非空且等于帧里的 iso',
      row.board_iso === boardIso,
      'board_iso=' + JSON.stringify(row.board_iso) + ' 期望=' + boardIso);
    check('★ fields 里不许出现 iso（元数据不该画成传感器卡片）',
      !row.fields || row.fields.iso === undefined,
      row.fields && row.fields.iso !== undefined ? 'fields.iso=' + JSON.stringify(row.fields.iso) : '');
    check('fields 里仍保留真实传感器值',
      row.fields && row.fields.acc_x_g === 0.1 && row.fields.temp_c === 31.5,
      row.fields ? 'acc_x_g=' + row.fields.acc_x_g + ' temp_c=' + row.fields.temp_c : '');
    check('skew_ms = board_ts - recv_ts',
      typeof row.skew_ms === 'number' && row.skew_ms === row.board_ts - row.recv_ts,
      'skew=' + row.skew_ms + ' 计算=' + (row.board_ts - row.recv_ts));
  }

  console.log('\n=== ③ /api/state 也带 board_iso ===\n');
  const st = await req('GET', '/api/state');
  const s = st.json || {};
  check('/api/state 的 board_iso 非空',
    s.boardIso === boardIso, 'boardIso=' + JSON.stringify(s.boardIso));

  console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
  child.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }
  process.exit(fail === 0 ? 0 : 1);
})();
