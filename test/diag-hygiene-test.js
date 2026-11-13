'use strict';
/**
 * 诊断口径卫生（/api/diag）回归测试
 *
 * 两个 2026-11-13 实测发现的问题，都是「统计/标签与事实不符」，会误导排查：
 *
 * ① 设备的 ESP_LOG 文本行（"I (123) S3EYE: 上传成功 …"）原来被算进 lines.invalid。
 *    正常运行 8 fps 时每 10 帧打一条摘要，于是 invalid 占到 9%，看着像数据在丢。
 *    日志既不是数据也不是「解析失败」，应单独计入 lines.logs。
 *
 * ② 双通道在线时 device.path 会被改成 WiFi(10.x.x.x)，即使 transport 仍是 serial，
 *    /api/diag 的 currentPort 于是长期显示 WiFi，与事实矛盾。
 *    现在：串口打开时不覆盖 device；串口帧到达时若被 WiFi 覆盖过则纠回串口路径。
 *
 * 用隔离实例（独立端口 + 独立 DATA_DIR），真实设备打不进来。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function pickPort(start, span) {
  return 8100 + (process.pid % (span || 20)) + (start || 0);
}
const PORT = pickPort(0, 15);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(__dirname, '.test-data-diag-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  PASS ' + label + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.error('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
};

const send = (text) => fetch(BASE + '/api/data', {
  method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text,
}).then((r) => r.json());
const diag = () => fetch(BASE + '/api/diag').then((r) => r.json());
const state = () => fetch(BASE + '/api/state').then((r) => r.json());

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CONFIG_PATH: path.join(ROOT, 'test', '.test-config.json'),
      NL_CONFIG_PATH: path.join(__dirname, '.test-nl-local-absent.json'),
      NL_ENDPOINT: '', NL_API_KEY: '',
      DATA_DIR,
    }),
    stdio: 'ignore',
  });
  await sleep(1400);

  try {
    console.log('\n① 日志行不再冒充「无效行」');
    const d0 = await diag();
    ok(typeof d0.lines.logs === 'number', '/api/diag 暴露 lines.logs 计数', 'logs=' + d0.lines.logs);

    // 真实固件的三类日志
    await send('I (12345) S3EYE: 上传成功 成功=120 失败=3');
    await send('W (12346) S3EYE: WiFi 断开（reason=201：找不到该 SSID），稍后重试连接（退避 4000 ms）');
    await send('E (12347) camera: Camera probe failed with error 0x106(ESP_ERR_NOT_SUPPORTED)');
    await sleep(400);
    const d1 = await diag();
    ok(d1.lines.logs - d0.lines.logs === 3, '三条设备日志 → logs +3', 'logs ' + d0.lines.logs + ' -> ' + d1.lines.logs);
    ok(d1.lines.invalid === d0.lines.invalid, '设备日志不再计入 invalid', 'invalid ' + d0.lines.invalid + ' -> ' + d1.lines.invalid);

    console.log('\n② 真正的坏行仍然算 invalid');
    const d2 = await diag();
    await send('%%% 这根本不是数据 %%%');
    await sleep(400);
    const d3 = await diag();
    ok(d3.lines.invalid - d2.lines.invalid === 1, '非 JSON 且非日志的坏行 → invalid +1', 'invalid ' + d2.lines.invalid + ' -> ' + d3.lines.invalid);
    ok(d3.lines.logs === d2.lines.logs, '坏行不影响 logs', 'logs=' + d3.lines.logs);

    console.log('\n③ 计数口径自洽');
    const d4 = await diag();
    ok(d4.lines.total >= d4.lines.valid + d4.lines.logs + d4.lines.invalid - 1,
      'total 覆盖 valid + logs + invalid', JSON.stringify(d4.lines));

    console.log('\n④ 设备路径不被 WiFi 标签冒充');
    const before = await state();
    ok(before.transport === 'wifi', '无串口时 WiFi 上报走 wifi 通道', String(before.transport));
    ok(!before.device || !before.device.path || String(before.device.path).startsWith('WiFi('),
      '串口未打开时 device.path 如实标成 WiFi(ip)', JSON.stringify(before.device));
    const d5 = await diag();
    ok(d5.currentPort === before.device.path, 'currentPort 与 device.path 一致', String(d5.currentPort));

    console.log('\n⑤ 源码契约（串口优先时不得被覆盖）');
    ok(/if \(!serialOpen\(\)\) state\.device = \{ path: `WiFi\(\$\{ip\}\)`, ip \};/.test(SERVER_SRC),
      'WiFi 分支只在串口未打开时改写 device');
    ok(/if \(transport === 'serial' && state\.device && \/\^WiFi\\\(\/\.test\(String\(state\.device\.path \|\| ''\)\)/.test(SERVER_SRC),
      '串口帧到达时把被覆盖的 device.path 纠回串口');
    ok(/linesLogs\+\+/.test(SERVER_SRC), 'ESP_LOG 行走 linesLogs 计数');
    ok(/logs: stats\.linesLogs/.test(SERVER_SRC), '/api/diag 输出 logs 字段');

    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  } catch (e) {
    console.error('测试异常：', e && e.stack);
    fail++;
  } finally {
    try { srv.kill(); } catch (_) { /* 忽略 */ }
    await sleep(300);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }
  process.exit(fail > 0 ? 1 : 0);
})();