'use strict';
/*
 * 第 3 周：求助事件的持久化测试
 *
 * 存在理由：help.history 原先只存服务端内存（HELP_KEEP=20），服务重启即清空；
 * 板端也不落盘（main.c 不写文件，s_help/s_help_id 都在 RAM）。两端同时无痕迹，
 * 导致「昨天那次求助是否发生过、有没有被回应」无法证明 —— 第 3 周闭环缺少
 * 持久化证据。本测试验证落盘与启动回读。
 *
 * 覆盖：
 *   ① 求助事件写入 data/help.ndjson（一行一事件，NDJSON）
 *   ② 服务重启后 history 能从磁盘恢复（启动回读）
 *   ③ 磁盘记录含足够证据字段（时间、事件名、help_id、设备）
 *   ④ 求助事件不混入 records.ndjson（语义隔离：事件 vs 采样）
 *   ⑤ 落盘失败不影响求助闭环本身（存储是旁路，不是主链路）
 *
 * 自带服务，使用独立端口 8094，独立 DATA_DIR。
 * 用法：node test/help-persist-test.js
 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 8092;   // 避开已被占用的 8093-8099（见 run-all.js 的端口注释）
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, '.test-data-helppersist');
const HELP_FILE = path.join(DATA_DIR, 'help.ndjson');
const RECORDS_FILE = path.join(DATA_DIR, 'records.ndjson');

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
const jget = async (p) => JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' })).body);
const jpost = async (p, o) => {
  const s = JSON.stringify(o);
  return JSON.parse((await req({
    host: '127.0.0.1', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) },
  }, s)).body);
};

const HELP = (extra) => Object.assign({
  type: 'help', event: 'request', help_id: 'help-persist-0001',
  device: 'S3EYE-GROUP01', mac: 'AABBCCDDEEFF', seq: 100, ts: 1758421800000,
}, extra);

/* 启动一个隔离的 server 实例 */
function startServer() {
  return spawn('node', ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1',
      CONFIG_PATH: path.join(__dirname, '.test-config.json'),
      DATA_DIR,
      NL_CONFIG_PATH: __dirname + '/.test-nl-local-absent.json', NL_ENDPOINT: '', NL_API_KEY: '',
    }),
    stdio: 'ignore',
  });
}

/* 读取 help.ndjson 的每一行（跳过空行） */
function readHelpFile() {
  if (!fs.existsSync(HELP_FILE)) return [];
  return fs.readFileSync(HELP_FILE, 'utf8')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let srv = startServer();
  await sleep(1300);

  try {
    await jpost('/api/config', { autoDetect: false, autoReconnect: false });
    await req({ host: '127.0.0.1', port: PORT, path: '/api/disconnect', method: 'POST' }, '{}');
    await sleep(400);

    console.log('— ① 求助事件写入 data/help.ndjson —');
    ok(!fs.existsSync(HELP_FILE), '初始时 help.ndjson 不存在（不预建空文件）');

    await jpost('/api/data', HELP({}));
    await sleep(300);

    let lines = readHelpFile();
    ok(fs.existsSync(HELP_FILE), 'help.ndjson 已被创建');
    ok(lines.length >= 1, `落盘至少 1 条事件（实际 ${lines.length}）`);

    const first = lines.find((x) => x.ev === 'received');
    ok(!!first, '含 ev=received 的落盘记录');

    console.log('— ③ 落盘记录含足够证据字段 —');
    ok(first && typeof first.at === 'number' && first.at > 0, '记录含时间戳 at');
    ok(first && first.help_id === 'help-persist-0001', '记录含 help_id');
    ok(first && first.device_id === 'S3EYE-GROUP01', '记录含 device_id（可追溯是哪个设备）');

    console.log('— 完整闭环的每个节点都落盘 —');
    await jpost('/api/help', { action: 'ack' });
    await sleep(200);
    await jpost('/api/data', {
      type: 'ack', device: 'S3EYE-GROUP01',
      request_id: 'help-persist-0001', seq: 101, status: 'ack_shown',
    });
    await sleep(200);
    await jpost('/api/data', HELP({ event: 'cancel', seq: 102 }));
    await sleep(300);

    lines = readHelpFile();
    const evs = lines.map((x) => x.ev);
    ok(evs.includes('received'), '闭环节点 received 已落盘');
    ok(evs.includes('ack_sent') || evs.includes('ack_failed'), '闭环节点 ack 尝试已落盘');
    ok(evs.includes('ack_delivered'), '闭环节点 ack_delivered 已落盘');
    ok(evs.includes('cancelled'), '闭环节点 cancelled 已落盘');

    console.log('— ④ 求助事件不混入 records.ndjson —');
    const recs = fs.existsSync(RECORDS_FILE)
      ? fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(Boolean).length : 0;
    const recHasHelp = fs.existsSync(RECORDS_FILE)
      && fs.readFileSync(RECORDS_FILE, 'utf8').includes('help-persist-0001');
    ok(!recHasHelp, 'records.ndjson 不含求助事件（事件与采样语义隔离）');
    console.log(`    （records.ndjson 现有 ${recs} 条采样记录，与求助事件分开存放）`);

    const countBefore = readHelpFile().length;

    console.log('— ② 服务重启后 history 从磁盘恢复 —');
    srv.kill('SIGKILL');
    await sleep(500);

    srv = startServer();
    await sleep(1300);
    await jpost('/api/config', { autoDetect: false, autoReconnect: false });
    await sleep(300);

    const after = await jget('/api/help');
    const h = after.help.history || [];
    ok(h.length > 0, `重启后 history 非空（恢复 ${h.length} 条）`);
    ok(h.some((x) => x.ev === 'received'), '重启后仍能看到 received 事件');
    ok(h.some((x) => x.help_id === 'help-persist-0001'), '重启后仍能追溯 help_id');

    const countAfter = readHelpFile().length;
    ok(countAfter >= countBefore, `重启不回写、不丢盘上记录（${countBefore} -> ${countAfter}）`);

    console.log('— ⑤ 落盘失败不影响求助闭环（存储是旁路）—');
    // 把 help.ndjson 变成一个目录，制造写入失败
    const tmpFile = HELP_FILE + '.bak';
    if (fs.existsSync(HELP_FILE)) fs.renameSync(HELP_FILE, tmpFile);
    fs.mkdirSync(HELP_FILE, { recursive: true });

    const r = await jpost('/api/data', HELP({ help_id: 'help-persist-0002', seq: 200 }));
    await sleep(300);
    const st = await jget('/api/help');
    ok(st.help.status === 'received' || st.help.help_id === 'help-persist-0002',
      '落盘失败时，求助事件仍被正常接收处理（闭环不因存储故障中断）');

    // 还原
    fs.rmdirSync(HELP_FILE);
    if (fs.existsSync(tmpFile)) fs.renameSync(tmpFile, HELP_FILE);

    console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  } catch (e) {
    console.error('测试异常：', e);
    fail++;
  } finally {
    try { await jpost('/api/config', { autoDetect: false, autoReconnect: false }); } catch (_) { /* 忽略 */ }
    srv.kill('SIGKILL');
    await sleep(200);
  }
  process.exit(fail ? 1 : 0);
})();
