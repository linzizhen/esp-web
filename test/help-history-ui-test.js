'use strict';
/** 求助历史展示契约（静态检查，0.1s，不起服务、不碰硬件）
 *
 * 存在理由：前端把服务端落盘的 help 事件名（ev）映射成中文说明。若 server.js
 * 新增了一个事件却没在 app.js 补映射，页面会直接显示原始英文标识（如 ack_mock），
 * 用户看到的是内部术语。这类不一致没有任何运行时异常，只能静态检查。
 *
 * 同时校验 index.html 的元素 id 与 app.js 的引用一一对应 —— 拼错 id 时
 * $() 返回 null，渲染会静默跳过（页面永远显示「尚无历史事件」）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* ---------- 1) 收集 server.js 实际产生的 help 事件名 ---------- */
const produced = new Set();
for (const m of server.matchAll(/helpLog\(\s*'([a-z_]+)'/g)) produced.add(m[1]);

/* ---------- 2) 收集 app.js 的映射表 ---------- */
// 抓取 EV_TEXT = { ... } 的对象字面量
const block = /const\s+EV_TEXT\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(app);
const mapped = new Set();
if (block) {
  for (const m of block[1].matchAll(/([a-z_]+)\s*:/g)) mapped.add(m[1]);
}

console.log(`\n— 求助历史展示契约 —`);
console.log(`  server.js 产生 ${produced.size} 种事件；app.js 映射 ${mapped.size} 种\n`);

check('app.js 里有 EV_TEXT 事件名映射表', !!block,
  block ? `${mapped.size} 个条目` : '未找到 EV_TEXT');

const missing = [...produced].filter((e) => !mapped.has(e)).sort();
check('每个落盘事件都有中文说明', missing.length === 0,
  missing.length ? `未映射（页面会显示英文标识）：${missing.join(', ')}` : `${produced.size} 个全覆盖`);

/* 反向：映射了但服务端从不产生（拼写错误或已废弃） */
const extra = [...mapped].filter((e) => !produced.has(e)).sort();
check('映射表不含服务端从不产生的事件名', extra.length === 0,
  extra.length ? `多余/拼错：${extra.join(', ')}` : '无冗余条目');

/* ---------- 3) index.html 的 id 与 app.js 的 $() 引用对应 ---------- */
const htmlIds = new Set();
for (const m of html.matchAll(/id="([A-Za-z0-9_-]+)"/g)) htmlIds.add(m[1]);

const needIds = ['helpHistory', 'helpHistoryCount'];
const notFound = needIds.filter((id) => !htmlIds.has(id));
check('历史区块的两个 id 都存在于 index.html', notFound.length === 0,
  notFound.length ? `缺少：${notFound.join(', ')}` : needIds.join(', '));

/* app.js 必须引用这两个 id（否则渲染不会发生） */
const refMissing = needIds.filter((id) => !new RegExp(`\\$\\(['"]${id}['"]\\)`).test(app));
check('app.js 引用了这两个 id', refMissing.length === 0,
  refMissing.length ? `未引用：${refMissing.join(', ')}` : '都已引用');

/* ---------- 4) 缓存版本号：改了 app.js 必须升 ?v= ---------- */
const jsV = /app\.js\?v=(\d+)/.exec(html);
check('index.html 带 app.js 缓存版本号', !!jsV, jsV ? `v=${jsV[1]}` : '缺少');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
