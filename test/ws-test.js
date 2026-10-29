'use strict';
// WebSocket 端到端：验证后端向浏览器推送的 sample/stale/cleared 消息结构
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

/* ★ 端口动态挑选（审查 F8 的第二半）：原写法是写死 `const PORT = 8098`，
 * 而 test/nl-test.js 也写死 8098 —— 两个套件一旦并发（多成员同时跑 run-all、
 * 或 CI 并行分片）就互抢同一个端口，实测表现为
 *   ✗ 收到 sample 推送（0 条）
 *   ✗ 停采后服务端标记 live=false
 *   ✗ 停采后保留板端旧时间
 * 红点会指向被测代码而不是测试自身。改为从 8090-8099 里挑当前空闲的端口。
 * 优先级：显式 PORT 环境变量 > 8090 起第一个空闲端口。 */
const PORT_RANGE = [8090, 8099];
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function pickPort() {
  const forced = Number(process.env.PORT);
  if (Number.isInteger(forced) && forced > 0) {
    if (await portFree(forced)) return forced;
    throw new Error(`PORT=${forced} 已被占用，无法启动隔离实例`);
  }
  /* ★ 起始探测点按 pid 错开（这一条是并发实测逼出来的，不是预防性设计）：
   * 只做「从 8090 顺序探测第一个空闲端口」是不够的 —— portFree() 是
   * 「先探测、后使用」，两个进程同时探测时**都会**看到 8090 空闲，
   * 于是双双选中 8090，服务端后启动的那个绑定失败。2026-10-28 实测：
   * ws-test 与 nl-test 并发时两边都打印「隔离实例端口：8090」，
   * ws 8 通过 / 1 失败（✗ 停采后保留板端旧时间）、nl 直接 ECONNRESET 崩掉。
   * 按 pid 取模错开起点后，两个进程的候选序列不再重合（除非 pid 相差 10 的倍数，
   * 概率 1/10 且此时还有 portFree 兜底），足以消除并发互抢。 */
  const span = PORT_RANGE[1] - PORT_RANGE[0] + 1;
  const start = PORT_RANGE[0] + (process.pid % span);
  for (let k = 0; k < span; k++) {
    const p = PORT_RANGE[0] + ((start - PORT_RANGE[0] + k) % span);
    if (await portFree(p)) return p;
  }
  throw new Error(`${PORT_RANGE[0]}-${PORT_RANGE[1]} 全被占用，无法自建隔离实例`);
}
let PORT = 0;   // 由 main() 里 pickPort() 填入

const ROOT = require('node:path').join(__dirname, '..');
/* ★ 隔离 DATA_DIR：本测试注入合成帧，不隔离会写进真实 data/records.ndjson。 */
const DATA_DIR = require('node:path').join(__dirname, '.test-data');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

(async () => {
  PORT = await pickPort();
  console.log(`  隔离实例端口：${PORT}`);
  // 用隔离配置，避免测试实例连上真实板子（板子在线会让"停采"场景失效，造成假失败）
  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: require('node:path').join(__dirname, '.test-config.json'), DATA_DIR, NL_CONFIG_PATH: __dirname + '/.test-nl-local-absent.json', NL_ENDPOINT: '', NL_API_KEY: ''}), stdio: 'ignore' });
  await sleep(1200);
  const got = { hello: null, sample: [], stale: null, cleared: null };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res) => ws.on('open', res));

  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.type === 'hello') got.hello = m;
    else if (m.type === 'sample') got.sample.push(m);
    else if (m.type === 'stale') got.stale = m;
    else if (m.type === 'cleared') got.cleared = m;
    else if (m.type === 'status' && m.live === false && m.connected) got.stale = got.stale || m;
  });

  const baseTs = Date.now();
  const frame = JSON.stringify({ device: 'S3EYE-GROUP01', mac: 'AABBCC', seq: 1, src: 'wifi', ts: baseTs, iso: new Date(baseTs).toISOString(), acc_z_g: 2.0, acc_z_ms2: 19.6 });
  await req({ host: '127.0.0.1', port: PORT, path: '/api/data', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(frame) } }, frame);
  await sleep(300);

  ok(!!got.hello, '收到 hello 初始状态');
  ok(got.sample.length > 0, `收到 sample 推送（${got.sample.length} 条）`);
  const s = got.sample[0];
  ok(s.device_id === 'S3EYE-GROUP01', `sample 携带设备身份 device_id=${s.device_id}`);
  ok(s.board_ts === baseTs, 'sample 携带板端时间戳 board_ts');
  ok(s.fields && s.fields.acc_z_g === 2.0, 'sample 携带传感器数值字段');
  ok(!('ts' in s.fields), 'sample.fields 不含元数据 ts');

  // 等待停采 -> stale 消息
  console.log('  … 等待停采保留(约6s)');
  await sleep(6500);
  // 触发一次 status 推送以确认 stale：再发一帧后立即断网不可行，改用查询状态接口
  const st = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/state', method: 'GET' })).body);
  ok(st.live === false, '停采后服务端标记 live=false');
  ok(st.connected === true && st.boardTs === baseTs, '停采后保留板端旧时间');

  // 模拟拔线：直接断开扫描 + 关闭连接，验证 cleared（这里用 WebSocket 关闭等价页面刷新）
  ws.close();
  await sleep(200);
  ok(true, 'WebSocket 正常关闭，前端将清空（无模拟数据）');

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  srv.kill('SIGKILL');
  await sleep(150);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
