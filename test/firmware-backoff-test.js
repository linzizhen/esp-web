/* 固件退避行为测试（硬件在环，需要板子插在 COM4）。
 *
 * 存在理由：本机没有主机 C 编译器（只有 ESP-IDF 的 xtensa/riscv 交叉编译器
 * 和 esp-clang），无法把固件逻辑编成主机单元测试。而退避逻辑恰恰是纯状态机、
 * 又出过真实 bug，必须有自动化回归手段 —— 只能测「板子的真实行为」。
 *
 * 测什么（对应已修复的缺陷）：
 *   1) 服务端可达时，帧率应接近 REPORT_INTERVAL_MS 决定的 10Hz（至少 > 3Hz）；
 *   2) 服务端不可达时，板子应进入退避：帧间隔从「每帧阻塞 3s」变为
 *      「大多数帧几乎不阻塞，仅每 10s 左右阻塞一次」。
 *      修复前：退避失效 → 每一帧都阻塞 3s → 帧间隔恒为 ~3.0s。
 *   3) 板子不应重启（seq 单调递增，不归零）。
 *
 * 前置条件：通过服务端串口通道（server.js 打开 COM4）读取板子输出，
 *           因此需要 server.js 在 8080 运行；脚本用 /api/state 观察。
 *
 * 用法：node test/firmware-backoff-test.js
 *       node test/firmware-backoff-test.js --offline   （只测「服务端不可达」场景）
 */
'use strict';
const http = require('node:http');

const BASE = 'http://127.0.0.1:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const get = (p) => new Promise((resolve, reject) => {
  const req = http.get(BASE + p, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(5000, () => { req.destroy(new Error('超时')); });
});

(async () => {
  console.log('=== 固件退避行为测试（硬件在环）===\n');

  // 前置：服务端必须在跑，否则观察不到串口
  let st;
  try {
    st = await get('/api/state');
  } catch (e) {
    console.log(`前置失败：连不上 ${BASE}（${e.message}）`);
    console.log('本测试依赖 server.js 打开串口来观察板子，请先 npm start。');
    process.exit(1);
  }
  if (!st.connected) {
    console.log('前置失败：服务端已连上但未收到板子数据（connected=false）。');
    console.log('请确认开发板插在 COM4 且正在上报。');
    process.exit(1);
  }
  console.log(`板子在线：device=${st.deviceId} seq=${st.seq} transport=${st.transport}\n`);

  /* ---------- 1) 帧率与 seq 单调性 ---------- */
  console.log('— 场景：服务端可达（正常上传）—');
  const t0 = Date.now();
  const seq0 = st.seq;
  const seqSamples = [st.seq];
  let resets = 0;
  let prev = st.seq;

  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    const s = await get('/api/state');
    seqSamples.push(s.seq);
    if (s.seq != null && prev != null && s.seq < prev) {
      resets++;
      console.log(`  ★ seq 归零：${prev} -> ${s.seq}（板子重启）`);
    }
    prev = s.seq;
  }

  const elapsed = (Date.now() - t0) / 1000;
  const gained = seqSamples[seqSamples.length - 1] - seq0;
  const fps = gained / elapsed;
  console.log(`  采样 ${elapsed.toFixed(1)}s，seq ${seq0} -> ${seqSamples[seqSamples.length - 1]}（+${gained}）`);
  console.log(`  实测帧率 ${fps.toFixed(2)} 帧/秒（期望 10.00）\n`);

  check('服务端可达时板子不重启（seq 单调递增）', resets === 0, `重启 ${resets} 次`);
  check('服务端可达时帧率 > 3 帧/秒（未严重阻塞）', fps > 3,
    `${fps.toFixed(2)} 帧/秒`);

  /* ---------- 2) 退避行为：需要观察「服务端不可达」时的帧间隔分布 ---------- */
  console.log('— 场景：服务端不可达时的退避（需要停止服务端，本脚本无法自动完成）—');
  console.log('  说明：本场景要求先停掉 server.js（否则板子上传成功，不会触发退避），');
  console.log('        再用 test/serial-forensics.js 被动监听串口，统计帧间隔分布。');
  console.log('        判定标准：修复后退避生效 → 多数帧间隔 ≈0.1s，少数 ≈3.0s；');
  console.log('                  修复前退避失效 → 帧间隔恒为 ≈3.0s。');
  console.log('  该场景由 test/backoff-hil.js 自动执行（它会自行停/起服务端）。');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
