#!/usr/bin/env node
/* 慢相/快相逐帧对照：帧间隔 vs 本帧上传结果。
 * 目的：判断长间隔是否由「HTTP 上传超时」造成，还是主任务被调度挤占。
 * 只读 data/*.ndjson。
 * 用法：node test/fps-upload-correlate.js <startISO> <endISO>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['data/records.2026-10-26T02-49-37.ndjson', 'data/records.ndjson'];

function load(p) {
  const full = path.join(ROOT, p);
  if (!fs.existsSync(full)) return [];
  const out = [];
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) {}
  }
  return out;
}

let all = [];
for (const f of FILES) all = all.concat(load(f));
const seen = new Set();
const rows = [];
for (const o of all) {
  if (typeof o.board_ts !== 'number') continue;
  const k = o.seq + '|' + o.recv_ts;
  if (seen.has(k)) continue;
  seen.add(k);
  rows.push(o);
}
rows.sort((a, b) => a.board_ts - b.board_ts);

const t0 = Date.parse(process.argv[2] || '2026-10-26T02:00:00Z');
const t1 = Date.parse(process.argv[3] || '2026-10-26T03:00:00Z');
const win = rows.filter(o => o.board_ts >= t0 && o.board_ts < t1);

console.log('窗口 ' + new Date(t0).toISOString() + ' → ' + new Date(t1).toISOString() +
            '  帧数=' + win.length);
if (win.length < 20) process.exit(0);

/* 逐帧：gap 是本帧到下一帧的板端间隔；upload 是本帧的上传结果 */
const samples = [];
for (let i = 0; i + 1 < win.length; i++) {
  const a = win[i], b = win[i + 1];
  if (b.seq !== a.seq + 1) continue;
  const fa = a.fields || {}, fb = b.fields || {};
  let up = 'unknown';
  if (typeof fa.upload_ok === 'number' && typeof fb.upload_ok === 'number') {
    const dOk = fb.upload_ok - fa.upload_ok;
    const dFail = (fb.upload_fail || 0) - (fa.upload_fail || 0);
    up = dOk === 1 ? 'ok' : dFail >= 1 ? 'fail' : 'none';
  }
  samples.push({ gap: b.board_ts - a.board_ts, up, seq: a.seq });
}

function summarize(label, arr) {
  if (!arr.length) { console.log(label + ': 无样本'); return; }
  const d = arr.map(s => s.gap).sort((x, y) => x - y);
  const q = p => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  const mean = d.reduce((x, y) => x + y, 0) / d.length;
  console.log(label.padEnd(18) + ' n=' + String(d.length).padStart(5) +
              '  mean=' + mean.toFixed(0).padStart(5) + 'ms' +
              '  p10=' + String(q(0.1)).padStart(5) +
              '  p50=' + String(q(0.5)).padStart(5) +
              '  p90=' + String(q(0.9)).padStart(5) +
              '  p99=' + String(q(0.99)).padStart(5) +
              '  fps=' + (1000 / mean).toFixed(2));
}

for (const up of ['ok', 'fail', 'none', 'unknown']) {
  summarize('下一帧上传=' + up, samples.filter(s => s.up === up));
}
summarize('全部', samples);

/* 长间隔里，下一帧上传失败占多少 */
const long = samples.filter(s => s.gap >= 500);
const short = samples.filter(s => s.gap < 500);
console.log('\n长间隔(≥500ms) ' + long.length + ' 个，占 ' +
            (100 * long.length / samples.length).toFixed(1) + '%；其中下一帧上传失败 ' +
            long.filter(s => s.up === 'fail').length + ' 个（' +
            (long.length ? (100 * long.filter(s => s.up === 'fail').length / long.length).toFixed(1) : '0') + '%）');
console.log('短间隔(<500ms) ' + short.length + ' 个；其中下一帧上传失败 ' +
            short.filter(s => s.up === 'fail').length + ' 个');
const totalFail = samples.filter(s => s.up === 'fail').length;
console.log('整窗上传失败帧 ' + totalFail + ' 个；被 ≥500ms 长间隔覆盖 ' +
            long.filter(s => s.up === 'fail').length + ' 个（' +
            (totalFail ? (100 * long.filter(s => s.up === 'fail').length / totalFail).toFixed(1) : '0') + '%）');

/* 长间隔的数值聚集：看是否集中在 ~3000ms（HTTP 超时）附近 */
const hist = new Map();
for (const s of long) {
  const b = Math.floor(s.gap / 100) * 100;
  hist.set(b, (hist.get(b) || 0) + 1);
}
console.log('\n长间隔直方（100ms 桶，只列 ≥500ms）:');
for (const k of Array.from(hist.keys()).sort((a, b) => a - b)) {
  console.log('  ' + String(k).padStart(5) + 'ms : ' + '#'.repeat(Math.min(60, hist.get(k))) + ' ' + hist.get(k));
}
