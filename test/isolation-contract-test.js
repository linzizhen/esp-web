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

/* 编排器端口隔离契约（2026-10-28 新增）。
 *
 * 存在理由：run-all.js 里曾写成 `env.E2E_PORT = env.E2E_PORT || '8099'`（尊重外部显式值），
 * 而 e2e-test.js 把 E2E_PORT=8080 定义为「连生产实例」。两者叠加的后果是：
 * 在设过 E2E_PORT=8080 的 shell / CI 里跑 `node test/run-all.js`，e2e 会打到**生产 8080**。
 * 实测复现：e2e 7 通过 / 7 失败，并向生产 /api/data 注入了合成帧
 * {"hello":"world","flag":true}，生产 raw 流被污染并触发一次「断开 → cleared」。
 *
 * 这类缺陷和上面 DATA_DIR 那个同性质：没有运行时异常、单看测试结果还以为是环境问题，
 * 只能靠静态契约拦住。断言两条：
 *   a) 编排器给 e2e 注入的 E2E_PORT 必须是**字面量常量**，不得透传外部值（|| / ??）；
 *   b) 想打生产只能绕过编排器，所以编排器代码里不应出现 8080。 */
const runAllSrc = fs.readFileSync(path.join(TEST_DIR, 'run-all.js'), 'utf8');
// 去掉块注释与行注释后再检查，避免把说明文字里的反面示例当成代码
const runAllCode = runAllSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const e2ePortAssign = /env\.E2E_PORT\s*=\s*([^;\n]+)/.exec(runAllCode);
check('编排器给 e2e 注入 E2E_PORT（端口可预期）', !!e2ePortAssign,
  e2ePortAssign ? `env.E2E_PORT = ${e2ePortAssign[1].trim()}` : '未找到注入语句，e2e 端口将不可预期');

const e2ePortExpr = e2ePortAssign ? e2ePortAssign[1].trim() : '';
const isLiteral = /^['"`]8\d{3}['"`]$/.test(e2ePortExpr);
const passesThrough = /\|\||\?\?/.test(e2ePortExpr);
check('编排器的 E2E_PORT 是字面量、不透传外部值', isLiteral && !passesThrough,
  isLiteral && !passesThrough
    ? `字面量 ${e2ePortExpr}（外部 E2E_PORT 一律被覆盖，整套跑恒隔离）`
    : `表达式为 ${e2ePortExpr} —— 透传外部值会让 E2E_PORT=8080 的环境把 e2e 打到生产。` +
      `必须改成 env.E2E_PORT = '8099'; 想打生产请绕过编排器直接跑 e2e-test.js`);

check('编排器代码里不出现生产端口 8080', !/8080/.test(runAllCode),
  /8080/.test(runAllCode)
    ? 'run-all.js 代码里出现 8080 —— 编排器职责是整套隔离，不得有打生产的路径'
    : '无 8080 引用（打生产必须绕过编排器）');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
