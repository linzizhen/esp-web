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
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TEST = (...p) => path.join(__dirname, ...p);

// 端口占用现状：8092 help-persist / 8093 feature / 8094 parse / 8095 verify+nl-config
//              8096 acceptance / 8097 help+p0 / 8098 ws+nl / 8099 storage+e2e
const SUITES = [
  { name: 'theme',        file: 'theme-contract-test.js', kind: 'unit' },
  { name: 'isolation',    file: 'isolation-contract-test.js', kind: 'unit' },
  { name: 'help-ui',      file: 'help-history-ui-test.js', kind: 'unit' },
  { name: 'parse',        file: 'parse-test.js',       kind: 'unit' },
  { name: 'feature',      file: 'feature-test.js',     kind: 'unit' },
  { name: 'storage',      file: 'storage-test.js',     kind: 'integration' },
  { name: 'p0-dedup',     file: 'p0-dedup-test.js',    kind: 'integration' },
  { name: 'verify',       file: 'verify-test.js',      kind: 'integration' },
  { name: 'ws',           file: 'ws-test.js',          kind: 'integration' },
  { name: 'help',         file: 'help-test.js',        kind: 'integration' },
  { name: 'help-persist', file: 'help-persist-test.js', kind: 'integration' },
  { name: 'acceptance',   file: 'acceptance-test.js',  kind: 'integration' },
  { name: 'nl',           file: 'nl-test.js',          kind: 'integration' },
  { name: 'nl-config',    file: 'nl-config-test.js',   kind: 'integration' },
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
    // e2e 强制隔离实例，避免依赖"生产服务是否在跑"这个环境前提
    if (s.name === 'e2e') env.E2E_PORT = env.E2E_PORT || '8099';

    const t0 = Date.now();
    const r = await runNode(file, env, ROOT);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 0;
    if (!ok) failed++;

    results.push({ ...s, ok, secs, out });

    // 抓结果行（各测试格式不一：有的 "结果: N 通过"，有的 "通过 N / 失败 0"）
    const m =
      out.match(/结果[:：]\s*(\d+)\s*通过[,\s]*(\d+)\s*失败/) ||
      out.match(/通过[^\d]*(\d+)\s*\/\s*失败[^\d]*(\d+)/) ||
      out.match(/(\d+)\s*通过[^\d]*(\d+)\s*失败/);
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