#!/usr/bin/env node
/* 全套测试编排器（只读运行，不修改任何源码）
 *
 * 存在的理由：原先 `npm test` 只跑 acceptance-test.js 一个文件，
 * 其余 10 个测试文件没有入口，容易让人以为"测试都跑过了"。
 *
 * 两个必须知道的坑（都已在下面代码里处理）：
 *
 * 1) 测试隔离：板子自 2026-09-28 起会 WiFi 常驻 POST 到 8080，
 *    任何直连 8080 的测试都会被真实数据污染。因此除 e2e 外，
 *    所有测试都用自己的隔离端口 + 独立 DATA_DIR，自建 server 实例。
 *
 * 2) e2e-test 默认连 8080 生产实例 —— 服务没起时会 ECONNREFUSED，
 *    那不是 bug 而是环境未就绪。这里自动用 E2E_PORT=8099 让它自建
 *    隔离实例，跑无硬件干扰的全断言版本。
 *
 * 用法：
 *   node test/run-all.js          跑全部（e2e 自动用隔离实例 8099）
 *   node test/run-all.js e2e      只跑 e2e（仍走隔离实例）
 *   node test/run-all.js --serial 只跑单元/集成，跳过 e2e（省时）
 *
 * 不在本编排器内的四个测试（需真实硬件，手动跑）：
 *   node test/voice-hil.js             真机端到端：录音 → 上传 → 电平复核
 *   node test/probe-voice-stop.js      真机探针：连续多轮 start/stop 稳定性
 *   node test/fps-baseline-test.js     真机只读：帧率基线（中位上传间隔 + 多窗口）
 *   node test/firmware-backoff-test.js 真机退避回归：要求服务端**停着**才能测
 *
 * 注：后两个从未登记进 SUITES。fps-baseline 默认打 8080 生产实例、
 * firmware-backoff 要求服务端处于停止状态，两者都与「编排器整套隔离 +
 * 服务器在跑」的前提冲突，故永久手动跑。
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TEST = (...p) => path.join(__dirname, ...p);

// 端口占用现状（2026-10-29 核对）：8090 voice / 8091 handleline-guard /
//              8092 help-persist / 8093 feature / 8094 parse / 8095 verify+nl-config /
//              8096 acceptance / 8097 help+p0 / 8099 storage+e2e
//              8098 已释放：ws 与 nl 改成在 8090-8099 内动态挑空闲端口
//              （F8 修复，原先两者都写死 8098，并发跑必然互抢）
//              command-ack 同样不固定端口：每次自建实例前探测一个当前空闲的
const SUITES = [
  { name: 'theme',        file: 'theme-contract-test.js', kind: 'unit' },
  { name: 'isolation',    file: 'isolation-contract-test.js', kind: 'unit' },
  { name: 'help-ui',      file: 'help-history-ui-test.js', kind: 'unit' },
  { name: 'cam-config',   file: 'cam-config-contract-test.js', kind: 'unit' },
  { name: 'parse',        file: 'parse-test.js',       kind: 'unit' },
  { name: 'feature',      file: 'feature-test.js',     kind: 'unit' },
  { name: 'guard',        file: 'handleline-guard-test.js', kind: 'integration' },
  { name: 'storage',      file: 'storage-test.js',     kind: 'integration' },
  { name: 'p0-dedup',     file: 'p0-dedup-test.js',    kind: 'integration' },
  { name: 'verify',       file: 'verify-test.js',      kind: 'integration' },
  { name: 'ws',           file: 'ws-test.js',          kind: 'integration' },
  { name: 'help',         file: 'help-test.js',        kind: 'integration' },
  { name: 'help-persist', file: 'help-persist-test.js', kind: 'integration' },
  { name: 'acceptance',   file: 'acceptance-test.js',  kind: 'integration' },
  { name: 'nl',           file: 'nl-test.js',          kind: 'integration' },
  { name: 'nl-config',    file: 'nl-config-test.js',   kind: 'integration' },
  { name: 'voice',        file: 'voice-test.js',       kind: 'integration' },
  { name: 'voice-layout', file: 'voice-layout-contract-test.js', kind: 'unit' },
  { name: 'command-ack',  file: 'command-ack-test.js', kind: 'integration' },
  { name: 'e2e',          file: 'e2e-test.js',         kind: 'e2e', needsServer: false },
];

const args = process.argv.slice(2);
const skipE2e = args.includes('--serial');
const only = args.filter((a) => !a.startsWith('--'));

// 注意：必须判 undefined 而不是判空数组 —— 空数组是 truthy，
// 用 `only.length ? ... : ...` 会让"无参数"走进只有空数组的分支，跑出 0 个测试。
const pick = (names) =>
  names && names.length ? SUITES.filter((s) => names.includes(s.name)) : SUITES;

const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

const results = [];
let failed = 0;

console.log('\n' + '='.repeat(64));
console.log('  imu-monitor 全套测试');
console.log('='.repeat(64));
console.log(`  工作目录：${ROOT}`);
console.log(`  Node：${process.version}`);
console.log('='.repeat(64) + '\n');

// 注意：这里必须用异步 spawn，不能用 spawnSync。
// Windows 上从 managed node 目录（.workbuddy/binaries/node/versions/…）用
// spawnSync 启动同一个可执行文件会直接 EBUSY（errno -4082），表现为
// 所有测试"0.0s 失败且无任何输出"——很容易误判成测试全挂。
// 异步 spawn 走 CreateProcess 异步路径，不会命中这个锁。
function runNode(file, env, cwd, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolve({ status: -1, stdout: out, stderr: `超时 ${timeoutMs / 1000}s 被终止` });
    }, timeoutMs);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ status: -1, stdout: '', stderr: String(e && e.message) });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ status: code, stdout: out, stderr: '' });
    });
  });
}

async function main() {
  for (const s of pick(only)) {
    const file = TEST(s.file);
    if (!fs.existsSync(file)) {
      console.log(`${RED('✗')} ${s.name.padEnd(12)} 文件缺失：${s.file}`);
      failed++; results.push({ ...s, ok: false });
      continue;
    }

    const env = Object.assign({}, process.env);
    // e2e 走隔离实例：**无条件**注入 8099。
    //
    // 这里曾经写成 `env.E2E_PORT = env.E2E_PORT || '8099'`（尊重外部显式值），
    // 而 test/e2e-test.js 把 E2E_PORT=8080 定义为「连生产实例」——
    // 两者叠加的后果是：在设过 E2E_PORT=8080 的 shell / CI 里跑本编排器，
    // e2e 会打到**生产 8080**（2026-10-28 实测复现：e2e 7 通过 / 7 失败，
    // 且向生产 /api/data 注入了合成帧 {"hello":"world","flag":true}，
    // 生产 raw 流被污染并触发一次「断开 → cleared」）。
    //
    // 编排器的职责是「整套跑都隔离」，不是「猜调用方意图」。因此改为无条件覆盖：
    // 想打生产必须绕过编排器，直接 `E2E_PORT=8080 node test/e2e-test.js`。
    // test/isolation-contract-test.js 有一条静态断言锁住这个行为。
    if (s.name === 'e2e') env.E2E_PORT = '8099';

    const t0 = Date.now();
    const r = await runNode(file, env, ROOT);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 0;
    if (!ok) failed++;

    results.push({ ...s, ok, secs, out });

    // 抓结果行（各测试格式不一：有的 "结果: N 通过"，有的 "通过 N / 失败 0"，
    // 有的 "结果：N 项通过，M 项失败" —— "项" 必须可选，否则计数会整列消失）
    const m =
      out.match(/结果[:：]\s*(\d+)\s*(?:项\s*)?通过[,\s，]*(\d+)\s*(?:项\s*)?失败/) ||
      out.match(/通过[^\d]*(\d+)\s*\/\s*失败[^\d]*(\d+)/) ||
      out.match(/(\d+)\s*(?:项\s*)?通过[^\d]*(\d+)\s*(?:项\s*)?失败/);
    const cnt = m ? `${GREEN(m[1])} 通过 / ${m[2]} 失败` : '';

    console.log(`${ok ? GREEN('✓') : RED('✗')} ${s.name.padEnd(12)} ${DIM(secs + 's')}  ${cnt}`);
    if (!ok) {
      console.log(DIM('  ' + out.split('\n').filter((l) => l.trim()).slice(-10).join('\n  ')));
    }
  } // end for

  const pass = results.filter((r) => r.ok).length;
  console.log('\n' + '='.repeat(64));
  if (failed === 0) {
    console.log(GREEN(`  全部通过：${pass}/${results.length} 个测试文件`));
  } else {
    console.log(RED(`  ${failed} 个失败，${pass}/${results.length} 个通过`));
    console.log('  失败文件：' + results.filter((r) => !r.ok).map((r) => r.name).join(', '));
  }
  if (skipE2e) console.log(DIM('  （--serial：已跳过 e2e）'));
  console.log('='.repeat(64) + '\n');

  process.exit(failed === 0 ? 0 : 1);
}

main();