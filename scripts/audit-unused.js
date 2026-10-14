#!/usr/bin/env node
/* 一次性静态审计脚本（只读，不修改任何文件）
 * 用途：找出 server.js / public/app.js 中的
 *   1) 定义了但从未被调用的函数
 *   2) 定义了但从未被引用的顶层常量
 *   3) 重复的函数体（同名实现高度相似）
 *   4) 空 catch 块（吞异常）
 *   5) 注释掉的疑似死代码
 * 用法：node scripts/audit-unused.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'server.js'),
  path.join(ROOT, 'public', 'app.js'),
];

function stripComments(src) {
  // 粗略移除 // 与 /* */ 注释（保留字符串内的不算，够用即可）
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));
}

const wordCount = (src) => {
  const m = src.match(/[A-Za-z_$][\w$]*/g) || [];
  return m;
};

let totalIssues = 0;

for (const file of TARGETS) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const rel = path.relative(ROOT, file);
  const lines = src.split('\n');
  const tokens = wordCount(src);
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);

  console.log('\n' + '='.repeat(70));
  console.log(`审计：${rel}`);
  console.log('='.repeat(70));

  // ---- 1) 未使用的函数 ----
  const fnDefs = [];
  const fnRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = fnRe.exec(src)) !== null) {
    fnDefs.push({ name: m[1], line: src.slice(0, m.index).split('\n').length });
  }
  // 箭头函数常量（顶层）
  const arrowDefs = [];
  const arrowRe = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm;
  while ((m = arrowRe.exec(src)) !== null) {
    arrowDefs.push({ name: m[1], line: src.slice(0, m.index).split('\n').length });
  }

  const unusedFns = [];
  for (const d of fnDefs) {
    const n = freq.get(d.name) || 0;
    if (n <= 1) unusedFns.push({ ...d, kind: 'function' });
  }
  for (const d of arrowDefs) {
    const n = freq.get(d.name) || 0;
    if (n <= 1) unusedFns.push({ ...d, kind: 'arrow' });
  }
  console.log(`\n[1] 定义但从未调用（出现次数<=1）：${unusedFns.length} 个`);
  for (const u of unusedFns) console.log(`    L${String(u.line).padStart(5)}  ${u.kind.padEnd(8)} ${u.name}`);
  totalIssues += unusedFns.length;

  // ---- 2) 未使用的顶层常量 ----
  const constDefs = [];
  const cRe = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm;
  while ((m = cRe.exec(src)) !== null) {
    const name = m[1];
    if (!/^[A-Z_]/.test(name)) continue; // 只查常量风格（全大写）
    const line = src.slice(0, m.index).split('\n').length;
    const n = freq.get(name) || 0;
    if (n <= 1) constDefs.push({ name, line });
  }
  console.log(`\n[2] 全大写常量定义但从未引用：${constDefs.length} 个`);
  for (const c of constDefs) console.log(`    L${String(c.line).padStart(5)}  ${c.name}`);
  totalIssues += constDefs.length;

  // ---- 3) 空 catch / 吞异常 ----
  const emptyCatch = [];
  const ecRe = /catch\s*\([^)]*\)\s*\{\s*\}/g;
  while ((m = ecRe.exec(src)) !== null) {
    emptyCatch.push(src.slice(0, m.index).split('\n').length);
  }
  console.log(`\n[3] 空 catch 块（静默吞异常）：${emptyCatch.length} 个`);
  for (const l of emptyCatch) console.log(`    L${l}`);
  totalIssues += emptyCatch.length;

  // ---- 4) 被注释掉的疑似代码行（连续 >=2 行、含分号或括号） ----
  const commentedCode = [];
  const linesRaw = raw.split('\n');
  let run = [];
  linesRaw.forEach((ln, i) => {
    const t = ln.trim();
    const isCommentedCode =
      /^\/\/[ ]*(const|let|var|function|if|for|while|return|await|import|export)\b/.test(t) ||
      /^\*[ ]*(const|let|var|function|if|for|while|return)\b/.test(t);
    if (isCommentedCode) run.push(i + 1);
    else {
      if (run.length >= 2) commentedCode.push(run);
      run = [];
    }
  });
  if (run.length >= 2) commentedCode.push(run);
  console.log(`\n[4] 注释掉的代码块（>=2 连续行）：${commentedCode.length} 处`);
  for (const r of commentedCode) console.log(`    L${r[0]}-${r[r.length - 1]}  (${r.length} 行)`);
  totalIssues += commentedCode.length;

  // ---- 5] 悬挂的 else / 缺分号之类交给语法检查，这里统计函数总览 ----
  console.log(`\n[5] 规模：${raw.split('\n').length} 行，函数 ${fnDefs.length} 个，顶层箭头常量 ${arrowDefs.length} 个`);
}

console.log('\n' + '='.repeat(70));
console.log(`审计完成，共 ${totalIssues} 处待人工确认`);
console.log('='.repeat(70));