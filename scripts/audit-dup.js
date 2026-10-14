#!/usr/bin/env node
/* 重复代码检测（只读）
 * 方法：把每个函数的源码体（去掉空白）算哈希，找出完全相同的函数体；
 * 再用"归一化后逐行比对"找出高度相似但不完全相同的函数（拷贝粘贴的典型特征）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

function extractFunctions(src, rel) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(lines[i]);
    if (!m) continue;
    // 花括号配平
    let depth = 0, started = false, body = [];
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; }
      }
      body.push(lines[j]);
      if (started && depth === 0) break;
    }
    out.push({ name: m[1], line: i + 1, body: body.join('\n'), rel });
  }
  return out;
}

const all = [];
for (const f of ['server.js', 'public/app.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  all.push(...extractFunctions(src, f));
}
console.log(`共提取 ${all.length} 个函数体\n`);

// ---- 1) 完全相同的函数体 ----
const groups = new Map();
for (const fn of all) {
  const key = fn.body.replace(/\s+/g, '');
  if (key.length < 60) continue; // 太短容易误判（getter 之类）
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(fn);
}
console.log('='.repeat(72));
console.log('[1] 完全重复的函数体（可直接合并）');
console.log('='.repeat(72));
let dupCount = 0;
for (const [, g] of groups) {
  if (g.length < 2) continue;
  dupCount++;
  console.log(`\n  ${g[0].body.replace(/\s+/g, ' ').trim().slice(0, 70)}...`);
  for (const x of g) console.log(`    ${x.rel}:${x.line}  ${x.name}()`);
}
if (!dupCount) console.log('  无');

// ---- 2) 高度相似（归一化后行集合 Jaccard > 0.85 但不完全相同）----
console.log('\n' + '='.repeat(72));
console.log('[2] 高度相似的函数（拷贝粘贴嫌疑，需人工判断是否该合并）');
console.log('='.repeat(72));
const normLines = (b) => new Set(
  b.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l.length > 8)
);
const sets = all.map((fn) => ({ fn, s: normLines(fn.body) }));
let simCount = 0;
const seen = new Set();
for (let i = 0; i < sets.length; i++) {
  for (let j = i + 1; j < sets.length; j++) {
    const A = sets[i].s, B = sets[j].s;
    if (A.size < 6 || B.size < 6) continue;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const union = new Set([...A, ...B]).size;
    const jc = inter / union;
    if (jc >= 0.85) {
      const key = [sets[i].fn.name, sets[j].fn.name].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      simCount++;
      console.log(`\n  相似度 ${(jc * 100).toFixed(0)}%`);
      console.log(`    ${sets[i].fn.rel}:${sets[i].fn.line}  ${sets[i].fn.name}()  [${A.size} 行]`);
      console.log(`    ${sets[j].fn.rel}:${sets[j].fn.line}  ${sets[j].fn.name}()  [${B.size} 行]`);
    }
  }
}
if (!simCount) console.log('  无');

console.log('\n' + '='.repeat(72));
console.log(`完成：完全重复 ${dupCount} 组，高度相似 ${simCount} 组`);
console.log('='.repeat(72));