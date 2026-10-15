'use strict';
/** 测试隔离契约（静态检查，0.1s，不起服务、不碰硬件）
 *
 * 存在理由：2026-10-15 发现 help-test / ws-test / verify-test 三个测试没有设置
 * DATA_DIR，于是它们通过 /api/data 注入的合成帧被 appendRecord() 写进了**真实**
 * data/records.ndjson —— 实测污染样本包括 device=S3EYE-GROUP02、device=WHATEVER
 * 以及 seq=1 的合成帧，与真实采集数据混在同一个文件里，且无法事后区分。
 *
 * 这类缺陷没有运行时异常：测试全绿，数据却在被污染。只能靠静态契约拦住。
 *
 * 断言：每个自建 server 实例的测试，都必须显式传入隔离的 DATA_DIR。
 */
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* 找出所有「会启动 server.js」的测试文件。
 * spawn 有多种写法，必须都覆盖：
 *   spawn(process.execPath, ['server.js'], …)      ← 用当前 node
 *   spawn('node', ['server.js'], …)                ← 用 PATH 里的 node
 *   spawn(cmd, { … }) 里 cmd 变量
 * 因此判据放宽为：文件里同时出现 spawn( 与 'server.js'。 */
const testFiles = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.js') && !f.startsWith('.'))
  .filter((f) => {
    const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    return /spawn\s*\(/.test(src) && /['"`]server\.js['"`]/.test(src);
  });

console.log(`\n— 测试隔离契约 —`);
console.log(`  自建 server 实例的测试文件：${testFiles.length} 个\n`);

check('找到了自建 server 的测试（契约本身有效）', testFiles.length >= 5,
  `${testFiles.join(', ')}`);

const missing = [];
for (const f of testFiles) {
  const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
  // 要求：spawn 的 env 里出现 DATA_DIR（直接赋值或通过变量传入均可）
  if (!/DATA_DIR/.test(src)) missing.push(f);
}

check('每个自建 server 的测试都隔离了 DATA_DIR', missing.length === 0,
  missing.length ? `未隔离：${missing.join(', ')}（会污染真实 data/）` : `${testFiles.length} 个全部隔离`);

/* 反向检查：确认隔离目标不是仓库内的真实 data/ 目录 */
const suspicious = [];
for (const f of testFiles) {
  const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
  // 隔离目录必须落在 test/ 下或系统临时目录，不能是仓库根的 data/
  const m = /DATA_DIR[^,\n]*=\s*([^\n,]+)/.exec(src);
  if (!m) continue;
  const expr = m[1];
  const looksRepoData = /['"`]\s*(\.\.\/)*data['"`]/.test(expr) && !/test/.test(expr);
  if (looksRepoData) suspicious.push(`${f}: ${expr.trim()}`);
}
check('隔离目录不指向仓库根的真实 data/', suspicious.length === 0,
  suspicious.length ? suspicious.join(' | ') : '全部指向 test/ 或系统临时目录');

/* 额外：确认 .gitignore 覆盖测试运行时目录，避免跑完测试冒出未跟踪文件 */
const gitignore = fs.readFileSync(path.join(TEST_DIR, '..', '.gitignore'), 'utf8');
check('.gitignore 覆盖 test/.test-data*', /test\/\.test-data\*/.test(gitignore),
  '漏掉会让 git add . 把测试数据带进仓库');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
