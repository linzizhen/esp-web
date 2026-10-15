/* 退避行为硬件在环测试：制造「服务端不可达」，测量板子的稳态重试节奏。
 *
 * 为什么必须这样测：退避是纯状态机，而本机没有主机 C 编译器（只有 ESP-IDF
 * 的 xtensa/riscv 交叉编译器与 esp-clang），无法编主机单元测试。只能让板子
 * 真实经历「连不上服务器」，再测量帧间隔分布。
 *
 * 判定原理（这是本测试的核心，务必理解）：
 *   主循环每 REPORT_INTERVAL_MS(100ms) 调 send_frame()，其中【同步】调 http_post()。
 *   服务端不可达时 http_post 要等 http 超时（timeout_ms=3000）才返回。
 *
 *   退避【生效】：只有每 UPLOAD_BACKOFF_MS(10s) 才放行一次尝试
 *     → 绝大多数帧间隔 ≈0.1s，约每 10s 出现一次 ≈3.0s
 *     → 中位帧间隔 ≈ 0.1s，平均 ≈ 0.4s
 *
 *   退避【失效】（本次修复的 bug）：next_try_us 停留在过去，每帧都尝试
 *     → 每一帧都被 3s 超时阻塞
 *     → 中位帧间隔 ≈ 3.0s，平均 ≈ 3.0s
 *
 *   ★ 因此判据用【中位帧间隔】：它对少数慢帧不敏感，能干净区分两种状态。
 *     早期版本用「快/慢次数比」，在板子刚进入失败状态的过渡期会误判。
 *
 * 预热期：必须等板子连续失败 5 次（约 15s）进入退避、并再稳定一段时间，
 *         否则测到的是「过渡期」，不是稳态行为。
 *
 * 用法：node test/backoff-hil.js [端口]
 *   ⚠ 运行前必须先停掉 server.js（否则它独占串口，且板子上传会成功）。
 */
'use strict';
const { SerialPort } = require('serialport');

const PORT = process.argv[2] || 'COM4';
const WARMUP_SECS = Number(process.env.WARMUP_SECS || 40);   // 进入稳态失败
const SAMPLE_SECS = Number(process.env.SAMPLE_SECS || 30);   // 采样窗口

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* 被动监听串口 N 秒，返回每行的到达时刻。只读：不置 DTR/RTS、不发字节。 */
function captureSerial(portPath, secs) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const p = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });
    let buf = '';

    p.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) lines.push({ at: Date.now(), line });
      }
    });
    p.on('error', (e) => { try { p.close(() => {}); } catch (_) {} reject(e); });

    p.open((err) => {
      if (err) return reject(err);
      p.set({ dtr: false, rts: false }, () => {});
      setTimeout(() => p.close(() => resolve(lines)), secs * 1000);
    });
  });
}

/* 挑出固件上报的 JSON 帧 */
function frameTimes(lines) {
  const out = [];
  for (const { at, line } of lines) {
    const s = line.trim();
    if (s.startsWith('{') && s.includes('"seq"')) out.push(at);
  }
  return out;
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

(async () => {
  console.log('=== 退避行为硬件在环测试（稳态）===\n');
  console.log(`端口 ${PORT}｜预热 ${WARMUP_SECS}s｜采样 ${SAMPLE_SECS}s`);
  console.log('⚠ 需先停止 server.js（否则串口被独占、且上传会成功）\n');

  console.log(`— 预热 ${WARMUP_SECS}s：让板子连续失败并进入稳态退避 —`);
  try {
    await captureSerial(PORT, WARMUP_SECS);
  } catch (e) {
    console.log(`  串口打开失败：${e.message}`);
    console.log('  串口可能正被 server.js 独占，请先停止服务端。');
    process.exit(1);
  }
  console.log('  预热完成\n');

  console.log(`— 采样 ${SAMPLE_SECS}s —`);
  const lines = await captureSerial(PORT, SAMPLE_SECS);
  const ts = frameTimes(lines);

  if (ts.length < 5) {
    console.log(`  仅收到 ${ts.length} 帧，样本不足。`);
    console.log('  可能原因：串口被占用、板子未运行、或板子卡死。');
    process.exit(1);
  }

  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 1000);

  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const med = median(gaps);
  const fast = gaps.filter((g) => g < 0.5).length;
  const slow = gaps.filter((g) => g > 2.5).length;

  console.log(`  收到 ${ts.length} 帧，${gaps.length} 个间隔`);
  console.log(`  帧率       ${(1 / avg).toFixed(2)} 帧/秒`);
  console.log(`  平均间隔   ${avg.toFixed(3)}s`);
  console.log(`  中位间隔   ${med.toFixed(3)}s   ← 判据`);
  console.log(`  间隔分布   <0.5s: ${fast} 次 ｜ >2.5s: ${slow} 次\n`);

  /* ★ 核心判据：中位帧间隔。
   *   退避生效 → 绝大多数帧是 0.1s 节拍，中位 ≈0.1s
   *   退避失效 → 每帧都撞 3s 超时，中位 ≈3.0s */
  check('退避生效：中位帧间隔 < 1.0s（未被超时主导）', med < 1.0,
    `中位 ${med.toFixed(3)}s`);

  check('退避生效：平均帧间隔 < 1.5s', avg < 1.5,
    `平均 ${avg.toFixed(3)}s`);

  check('快速帧占多数（证明退避确实放行了大部分帧）', fast > slow,
    `快 ${fast} vs 慢 ${slow}`);

  check('确实发生过 http 超时（证明「服务端不可达」场景成立）', slow > 0,
    `慢间隔 ${slow} 次`);

  if (med > 2.5 && fast === 0) {
    console.log('\n  ★ 判定：退避【失效】—— 每一帧都被 http 超时阻塞。');
    console.log('     特征：中位间隔 ≈ http timeout(3s)，无快速帧。');
    console.log('     根因：next_try_us 在 consec_fail 超过阈值后不再更新');
    console.log('           （原代码用 == 判定进入退避，计数继续增长后该判断再不成立）。');
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
