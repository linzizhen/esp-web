#!/usr/bin/env node
/* 接口交叉核对（只读）
 * 目的：找出「前端调用了但服务端没有」的接口 —— 这类会导致 404 的失效引用是真 bug。
 * 反向也查：服务端有但前端从不调用（可能是遗留，也可能前端漏调）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const idxHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// ---- 前端请求的接口 ----
// 注意：app.js 大量使用模板字符串拼接（`/api/records?limit=${limit}`），
// 直接用 fetch('...') 正则会漏掉，必须额外扫"以 /api/ 开头的字符串字面量"。
const fe = new Set();
for (const m of appJs.matchAll(/['"`](\/api\/[A-Za-z0-9/_\-.]*)/g)) {
  fe.add(m[1]);
}

// ---- 服务端路由 ----
const srvSet = new Set();
for (const m of srv.matchAll(/p\s*===\s*'(\/api\/[^']+)'/g)) srvSet.add(m[1]);
for (const m of srv.matchAll(/p\.startsWith\('(\/api\/[^']+)'/g)) srvSet.add(m[1].replace(/\/$/, '/:'));

console.log('='.repeat(72));
console.log('接口交叉核对：前端调用 → 服务端实现');
console.log('='.repeat(72));
console.log(`前端引用 ${fe.size} 个，服务端实现 ${srvSet.size} 个\n`);

const norm = (s) => s.replace(/\.mjpg$/, '.mjpg').replace(/:$/, '');
let missing = [];
for (const f of [...fe].sort()) {
  if (f === '/api/cam.mjpg' || f === '/api/cam.jpg') { /* 别名，也在服务端 */ }
  const hit = srvSet.has(f) || [...srvSet].some((s) => {
    const sp = s.replace(/:$/, '');
    if (s.endsWith('/:')) return f.startsWith(sp);
    return f.startsWith(sp);
  });
  if (!hit) missing.push(f);
}
console.log(`[A] 前端引用但服务端未找到（潜在 404）：${missing.length} 个`);
for (const m of missing) console.log(`    ${m}`);

console.log(`\n[B] 服务端实现但前端从未调用（可能是遗留接口）：`);
const unused = [];
for (const s of [...srvSet].sort()) {
  if (s.endsWith('/:')) continue;
  const used = [...fe].some((f) => f === s || f.startsWith(s.replace(/\/$/, '')));
  if (!used) unused.push(s);
}
if (!unused.length) console.log('    无');
for (const u of unused) console.log(`    ${u}`);

console.log('\n' + '='.repeat(72));