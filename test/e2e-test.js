/**
 * 端到端链路自检（不属于平台运行时的一部分）
 *
 * 默认**自建隔离实例**：端口在 8090-8099 内自动挑一个空闲的（首选 8099），
 * 独立 DATA_DIR = test/.test-data-e2e，跑完即杀进程 —— 所以单独执行
 * `node test/e2e-test.js` 不会碰到 8080 上的生产实例，也不会污染真实采集数据。
 *
 * 连生产实例必须显式指定（真实板子在线时「无设备」断言必然失败——那是正常行为，
 * 因为生产实例本来就该有数据）：
 *   E2E_PORT=8080 node test/e2e-test.js
 *   node test/e2e-test.js --production
 *
 * 端口约定：
 *   · E2E_PORT 未设置        → 自建隔离实例（8090-8099 内挑空闲端口）
 *   · E2E_PORT=8090..8099   → 在该端口自建隔离实例（编排器 run-all.js 用 8099）
 *   · E2E_PORT=8080         → 连生产实例，不启动任何子进程
 *   · 其他端口               → 直接报错退出（自建实例只允许 8090-8099）
 *
 * 想先确认「这次到底打谁」，用 --dry-run：只打印解析结果，不连服务、不写数据。
 *   node test/e2e-test.js --dry-run
 *   E2E_PORT=8080 node test/e2e-test.js --dry-run
 *
 * 验证：
 *   1) 页面在无设备时拿到的状态为空（无任何模拟数据）
 *   2) 外部设备真实上报后，WebSocket 能收到 sample
 *   3) 停止上报后进入"停采保留"(stale)：保留末次数据与旧时间，不广播 cleared
 *      （对应作业要求：停采后保留旧时间、提示未更新；与"拔线即清空"区分）
 *   4) 手动断开（/api/disconnect）才广播 cleared，前端据此清空显示
 */
const WebSocket = require('ws');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEST_CONFIG = path.join(__dirname, '.test-config.json');
/* 隔离数据目录：只给 e2e 用，别跟 help/ws/storage/verify 共用 .test-data，
 * 否则几个测试并行或残留时会互相看到对方的合成帧（被 .gitignore 的 test/.test-data* 覆盖）。 */
const DATA_DIR = path.join(__dirname, '.test-data-e2e');

const PRODUCTION_PORT = 8080;
const PORT_RANGE = [8090, 8099];   // 自建实例只允许落在这一段（与生产 8080 隔开）
const DEFAULT_ISOLATED_PORT = 8099; // 首选端口，与 run-all.js 注入值一致，便于对日志

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* 解析「这次到底打谁」。
 * 关键原则：连生产必须显式（E2E_PORT=8080 或 --production），默认一律隔离。 */
function resolveTarget() {
  const rawPort = process.env.E2E_PORT;
  const wantProduction = process.argv.includes('--production');

  if (rawPort !== undefined && rawPort !== '' && !Number.isFinite(Number(rawPort))) {
    console.error(`E2E_PORT 不是合法端口：${JSON.stringify(rawPort)}`);
    process.exit(2);
  }
  const port = rawPort === undefined || rawPort === '' ? null : Number(rawPort);

  if (wantProduction) {
    if (port !== null && port !== PRODUCTION_PORT) {
      console.error(`--production 与 E2E_PORT=${port} 冲突：一个要连生产，一个要自建实例。`);
      process.exit(2);
    }
    return { port: PRODUCTION_PORT, isolated: false, why: '--production 显式指定生产实例' };
  }
  if (port === null) {
    return { port: null, isolated: true, why: '默认隔离（未设置 E2E_PORT）' };
  }
  if (port === PRODUCTION_PORT) {
    return { port: PRODUCTION_PORT, isolated: false, why: 'E2E_PORT=8080 显式指定生产实例' };
  }
  if (port < PORT_RANGE[0] || port > PORT_RANGE[1]) {
    console.error(
      `E2E_PORT=${port} 不在自建实例允许的端口段 ${PORT_RANGE[0]}-${PORT_RANGE[1]} 内。\n` +
      `自建实例必须用 8090-8099（避免撞上 8080 生产实例）；要连生产请显式 E2E_PORT=8080。`
    );
    process.exit(2);
  }
  return { port, isolated: true, why: `E2E_PORT=${port}` };
}

/* 端口是否可绑（能 listen 就说明空闲）。 */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/* 优先用 preferred，被占用则从 8099 往下找，全占则抛错。 */
async function pickPort(preferred) {
  const order = [];
  if (preferred) order.push(preferred);
  for (let p = PORT_RANGE[1]; p >= PORT_RANGE[0]; p--) if (!order.includes(p)) order.push(p);
  for (const p of order) {
    if (await portFree(p)) return p;
  }
  throw new Error(`端口段 ${PORT_RANGE[0]}-${PORT_RANGE[1]} 全被占用，无法自建隔离实例`);
}

async function waitReady(base, timeoutMs = 15000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(base + '/api/state');
      if (r.ok) return await r.json();
    } catch (e) { lastErr = e; }
    await sleep(250);
  }
  throw new Error(`隔离实例 ${timeoutMs}ms 内未就绪${lastErr ? `（最后错误：${lastErr.message}）` : ''}`);
}

async function post(base, payload) {
  const r = await fetch(base + '/api/data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

(async () => {
  const target = resolveTarget();
  const DRY_RUN = process.argv.includes('--dry-run');
  const PORT = target.isolated ? await pickPort(target.port || DEFAULT_ISOLATED_PORT) : PRODUCTION_PORT;
  // 统一用 127.0.0.1：隔离实例监听 127.0.0.1，生产监听 0.0.0.0，两边都通；
  // 写 localhost 在 Windows 上可能先解析到 ::1，隔离实例会连不上。
  const BASE = `http://127.0.0.1:${PORT}`;
  const ISOLATED = target.isolated;

  /* --dry-run：只报告「会打谁」，不启动实例、不连服务、不写任何数据。
   * 存在的理由：缺口一的本质是「不知道自己连的是不是生产」。给一个零副作用的
   * 自检入口，比让人读代码推断 ISOLATED 布尔值可靠得多。 */
  if (DRY_RUN) {
    console.log('ESP32 监控平台 —— 链路自检（--dry-run，不做任何实际操作）');
    console.log(`  模式：${ISOLATED ? '隔离（自建实例）' : '★ 生产实例'}`);
    console.log(`  目标：${ISOLATED ? `http://127.0.0.1:${PORT}（将自建）` : BASE}`);
    console.log(`  依据：${target.why}`);
    if (ISOLATED) {
      console.log(`  DATA_DIR：${path.relative(ROOT, DATA_DIR)}（隔离，跑完不保留）`);
    } else {
      console.log('  注意：生产模式下「无设备时 connected=false」等断言在真实板子在线时必然失败，');
      console.log('        且本测试会向 /api/data 注入合成帧 —— 那是真实实例，请不要在用户使用期间跑。');
    }
    process.exit(0);
  }

  let srv = null;
  const killSrv = () => {
    if (!srv || srv.killed) return;
    try { srv.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
  };
  // 异常退出 / Ctrl+C 也要收掉子进程，避免残留实例占着端口
  process.on('exit', killSrv);
  process.on('SIGINT', () => { killSrv(); process.exit(130); });

  try {
    if (ISOLATED) {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });  // 每次从干净数据目录起，结果可复现
      srv = spawn('node', ['server.js'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          PORT: String(PORT),
          HOST: '127.0.0.1',
          CONFIG_PATH: TEST_CONFIG,
          DATA_DIR,                                   // ★ 隔离数据目录，绝不写真实 data/
          NL_CONFIG_PATH: path.join(__dirname, '.test-nl-local-absent.json'),
          NL_ENDPOINT: '',
          NL_API_KEY: '',
        }),
        stdio: 'ignore',
      });
      await waitReady(BASE);
    }
    console.log(`ESP32 监控平台 —— 链路自检 (${ISOLATED ? '隔离模式 PORT=' + PORT : '生产模式 PORT=' + PORT})\n`);
    if (!ISOLATED) {
      console.log('  ⚠ 生产模式：直接对 8080 上的真实实例断言。');
      console.log('    真实板子在线时「无设备时 connected=false」等断言必然失败，这是预期行为；');
      console.log('    想跑全绿请去掉 E2E_PORT=8080 / --production，默认会自建隔离实例。\n');
    }

    // 1) 初始状态必须为空
    const st0 = await (await fetch(BASE + '/api/state')).json();
    check('无设备时 connected=false', st0.connected === false);
    check('无设备时 fields 为空', Object.keys(st0.fields).length === 0, JSON.stringify(st0.fields));

    // 2) 建立 WebSocket
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const samples = [];
    let cleared = false;
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'sample') samples.push(m);
      if (m.type === 'cleared') cleared = true;
    });
    await sleep(300);

    // 3) 模拟外部设备真实上报 5 次
    for (let i = 0; i < 5; i++) {
      await post(BASE, { temp_c: 30 + i * 0.5, adc0: 1800 + i, adc0_v: 1.45 + i * 0.01, uptime: i });
      await sleep(200);
    }
    await sleep(300);
    check('收到真实上报的 sample', samples.length >= 4, `收到 ${samples.length} 条`);
    check('sample 字段解析正确', samples.length > 0 && samples[0].fields.temp_c === 30,
      samples.length ? JSON.stringify(samples[samples.length - 1].fields) : '');

    const st1 = await (await fetch(BASE + '/api/state')).json();
    check('状态变为 connected=true', st1.connected === true, `transport=${st1.transport}`);
    check('最新字段已保存', st1.fields && st1.fields.adc0 !== undefined, JSON.stringify(st1.fields));

    // 4) 停止上报 => 进入"停采保留"(stale)：保留末次数据与旧时间，不广播 cleared
    //    （作业要求：停采后保留旧时间、提示未更新；只有物理拔线 / 手动断开才清空）
    console.log('\n  停止上报，等待进入"停采保留"状态（约 7s）…');
    await sleep(7000);
    check('停采后未广播 cleared（应保留旧值）', cleared === false);
    const st2 = await (await fetch(BASE + '/api/state')).json();
    check('停采后保留末次字段', st2.fields && st2.fields.adc0 !== undefined, JSON.stringify(st2.fields));
    check('停采后 live=false（标记未更新）', st2.live === false);
    check('停采后仍 connected（保留状态）', st2.connected === true);

    // 4b) 手动断开（物理拔线/释放串口的等价动作）=> 广播 cleared 并清空
    await fetch(BASE + '/api/disconnect', { method: 'POST' });
    await sleep(400);
    check('断开后收到 cleared 广播', cleared === true);
    const st2b = await (await fetch(BASE + '/api/state')).json();
    check('断开后 fields 已清空', Object.keys(st2b.fields).length === 0, JSON.stringify(st2b.fields));
    check('断开后 connected=false', st2b.connected === false);

    // 5) 非法数据不应被当作传感器数据
    await post(BASE, { hello: 'world', flag: true });
    await sleep(300);
    const st3 = await (await fetch(BASE + '/api/state')).json();
    check('无数值字段的报文不被当作数据', st3.connected === false && Object.keys(st3.fields).length === 0);

    ws.close();
    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  } catch (e) {
    console.error('测试异常:', e);
    fail++;
  } finally {
    killSrv();
    await sleep(200);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
