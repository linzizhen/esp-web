'use strict';
/** 前端主题变量契约测试（纯静态，不起服务、不碰硬件）
 *
 * 存在理由：app.js 通过 canvas 读 CSS 变量取色（`g('--chart-xxx', fallback)`）。
 * 一旦 style.css 少定义了某个变量，canvas 不会报错，而是静默用 fallback 硬编码
 * 颜色 —— 浅色主题下可能看不出问题，深色主题下就会出现"等待带仍是浅黄底"这类
 * 错色。这类缺陷没有任何运行时异常，只能靠静态契约断言拦住。
 *
 * 覆盖三套主题：浅色（:root）、跟随系统（prefers-color-scheme: dark）、
 * 手动深色（:root[data-theme="dark"]）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* ---------- 1) 抽出 app.js 实际读取的 CSS 变量 ---------- */
// 匹配 g('--chart-xxx', 'fallback') 形式的取值调用
const used = new Set();
for (const m of app.matchAll(/g\(\s*'(--[a-z0-9-]+)'/gi)) used.add(m[1]);
// 也覆盖 getPropertyValue('--xxx') 直接调用
for (const m of app.matchAll(/getPropertyValue\(\s*'(--[a-z0-9-]+)'/gi)) used.add(m[1]);

/* ---------- 2) 按主题块切出各自定义的变量 ---------- */
// 三套主题块：:root{...}（浅色）/ @media prefers-color-scheme 内 :root:not([data-theme]){...}
// / :root[data-theme="dark"]{...}
function blockVars(re) {
  const m = re.exec(css);
  if (!m) return null;
  const out = new Set();
  for (const d of m[1].matchAll(/(--[a-z0-9-]+)\s*:/gi)) out.add(d[1]);
  return out;
}

const light = blockVars(/:root\s*\{([\s\S]*?)\n\}/);
const darkManual = blockVars(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
const darkAuto = blockVars(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([\s\S]*?)\n\s*\}/);

console.log(`\n— 主题变量契约 —`);
console.log(`  app.js 读取 ${used.size} 个变量；浅色块 ${light ? light.size : '未找到'} 个；`
  + `深色(手动) ${darkManual ? darkManual.size : '未找到'} 个；深色(跟随系统) ${darkAuto ? darkAuto.size : '未找到'} 个\n`);

check('三套主题块都能解析到', !!light && !!darkManual && !!darkAuto);

/* ---------- 3) 核心断言：app.js 用到的每个变量都必须在三套主题里定义 ---------- */
const missingLight = [...used].filter((v) => !light.has(v)).sort();
const missingDark = [...used].filter((v) => !darkManual.has(v)).sort();
const missingAuto = [...used].filter((v) => !darkAuto.has(v)).sort();

check('浅色主题定义了 app.js 用到的全部变量', missingLight.length === 0,
  missingLight.length ? `缺少 ${missingLight.join(', ')}` : `${used.size} 个全覆盖`);
check('深色主题（手动切换）定义了全部变量', missingDark.length === 0,
  missingDark.length ? `缺少 ${missingDark.join(', ')}` : `${used.size} 个全覆盖`);
check('深色主题（跟随系统）定义了全部变量', missingAuto.length === 0,
  missingAuto.length ? `缺少 ${missingAuto.join(', ')}` : `${used.size} 个全覆盖`);

/* ---------- 4) 反向：定义了但没人用的 chart 变量（提示冗余，不算失败） ---------- */
const allDefined = new Set([...(light || []), ...(darkManual || [])]);
const chartDefined = [...allDefined].filter((v) => v.startsWith('--chart-')).sort();
const unusedChart = chartDefined.filter((v) => !used.has(v));
check('无定义后从未被读取的 --chart-* 变量', unusedChart.length === 0,
  unusedChart.length ? `未被使用：${unusedChart.join(', ')}` : `${chartDefined.length} 个都在用`);

/* ---------- 5) 缓存版本号一致性：改样式必须同步升 index.html 的 ?v= ---------- */
const cssV = /style\.css\?v=(\d+)/.exec(html);
const jsV = /app\.js\?v=(\d+)/.exec(html);
check('index.html 为 style.css 与 app.js 都带了缓存版本号', !!cssV && !!jsV,
  cssV && jsV ? `style.css?v=${cssV[1]}  app.js?v=${jsV[1]}` : '缺少 ?v= 版本号');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
