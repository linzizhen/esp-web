/* WiFi 上传阻塞取证：测量「主循环被 http_post 阻塞」的真实代价。
 *
 * 原理：主循环每 REPORT_INTERVAL_MS(100ms) 发一帧，且**同步**等 http_post 返回。
 *   - 上传成功时：帧间隔 ≈ max(100ms, 上传耗时)
 *   - 上传失败时：帧间隔 ≈ max(100ms, 超时 3000ms)  ← 这就是帧率塌陷的根源
 * 因此只要统计「服务端收到的相邻帧间隔分布」，就能反推阻塞情况：
 *   间隔 ≈ 3.0s 的帧 = 经历了一次超时；间隔 ≈ 0.1s 的帧 = 上传正常。
 *
 * 用法：node test/upload-block-forensics.js [采样秒数]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const secs = Number(process.argv[2] || 20);
const ROOT = path.join(__dirname, '..');
const RECORDS = path.join(ROOT, 'data', 'records.ndjson');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tailRecords() {
  if (!fs.existsSync(RECORDS)) return [];
  const raw = fs.readFileSync(RECORDS, 'utf8');
  const out = [];
  // 从尾部倒着取，避免读整个大文件
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < 400; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch (_) {}
  }
  return out.reverse();
}

(async () => {
  console.log(`=== WiFi 上传阻塞取证（采样 ${secs}s）===\n`);
  const before = tailRecords();
  const seqBefore = before.length ? before[before.length - 1].seq : 0;

  await sleep(secs * 1000);

  const recs = tailRecords().filter((r) => r.seq > seqBefore);
  if (recs.length < 3) {
    console.log('样本不足（服务端未收到足够帧）。请确认 server.js 在跑且板子在连接。');
    process.exit(0);
  }

  // 相邻帧的接收时间间隔
  const gaps = [];
  for (let i = 1; i < recs.length; i++) gaps.push((recs[i].recv_ts - recs[i - 1].recv_ts) / 1000);

  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sorted = [...gaps].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const maxGap = sorted[sorted.length - 1];
  const minGap = sorted[0];

  console.log(`样本帧数: ${recs.length}`);
  console.log(`帧间隔  平均=${avg.toFixed(3)}s  中位=${p50.toFixed(3)}s  P90=${p90.toFixed(3)}s  最大=${maxGap.toFixed(3)}s  最小=${minGap.toFixed(3)}s`);
  console.log(`实际帧率: ${(1 / avg).toFixed(2)} 帧/秒（期望 10.00）\n`);

  // 按间隔归类：超时阻塞 vs 正常
  const timeoutish = gaps.filter((g) => g > 2.5).length;   // 接近 3s 超时
  const normal = gaps.filter((g) => g < 0.5).length;
  console.log('=== 间隔分布（判断阻塞）===');
  console.log(`  < 0.5s（上传正常）  : ${normal} 次`);
  console.log(`  > 2.5s（疑似超时阻塞）: ${timeoutish} 次`);
  if (timeoutish) {
    console.log(`  → 估算因超时损失的时间: ${(gaps.filter((g) => g > 2.5).reduce((a, b) => a + b - 0.1, 0)).toFixed(1)}s`);
  }

  const transports = {};
  for (const r of recs) transports[r.transport] = (transports[r.transport] || 0) + 1;
  console.log(`\n通道分布: ${JSON.stringify(transports)}`);
  console.log(`(transport=serial 表示数据从 USB 串口来，=wifi 表示走 WiFi 上行)`);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
