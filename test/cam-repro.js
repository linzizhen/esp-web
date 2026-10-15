/* 摄像头推流复现取证：开启 cam_on，持续采样服务端状态，捕捉重启/帧率塌陷。
 * 用法：node test/cam-repro.js [持续秒数]
 */
'use strict';
const BASE = 'http://127.0.0.1:8080';
const secs = Number(process.argv[2] || 45);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then((r) => r.json());

const get = (p) => fetch(BASE + p).then((r) => r.json());

(async () => {
  console.log('=== 摄像头推流复现取证 ===\n');

  const before = await get('/api/state');
  console.log(`开启前: seq=${before.seq} connected=${before.connected} transport=${before.transport}`);

  // 记录帧率基线（开启前 5 秒）
  const t0 = Date.now();
  const seqStart = before.seq;
  await sleep(5000);
  const s1 = await get('/api/state');
  const baseFps = (s1.seq - seqStart) / ((Date.now() - t0) / 1000);
  console.log(`开启前基线帧率: ${baseFps.toFixed(2)} 帧/秒\n`);

  console.log('>>> 下发 cam_on');
  const r = await post('/api/cam', { action: 'start' });
  console.log('    响应:', JSON.stringify(r));

  // 持续采样：每 2 秒记录一次 seq，检测归零（=重启）
  let prevSeq = s1.seq;
  let resets = 0;
  const samples = [];
  const start = Date.now();
  let lastLog = 0;

  while ((Date.now() - start) / 1000 < secs) {
    await sleep(2000);
    let st;
    try { st = await get('/api/state'); } catch (e) { console.log('  状态查询失败:', e.message); continue; }

    const seq = st.seq;
    const cam = await get('/api/cam').catch(() => ({}));
    const dropped = (seq != null && prevSeq != null && seq < prevSeq);
    if (dropped) {
      resets++;
      console.log(`  ★★★ 检测到 seq 归零：${prevSeq} -> ${seq}（板子重启 #${resets}）`);
    }
    samples.push({ t: Date.now() - start, seq, camFrames: cam.frames });

    const el = ((Date.now() - start) / 1000).toFixed(0);
    if (el - lastLog >= 6) {
      lastLog = Number(el);
      const fps = (seq != null && prevSeq != null && seq >= prevSeq) ? '' : '';
      console.log(`  [${el}s] seq=${seq} connected=${st.connected} camStreaming=${st.camStreaming} cam帧数=${cam.frames || 0} cam尺寸=${cam.size || '-'} ${fps}`);
    }
    prevSeq = seq;
  }

  const end = await get('/api/state');
  const totalSecs = (Date.now() - start) / 1000;
  const totalFrames = end.seq - s1.seq;

  console.log('\n=== 结论 ===');
  console.log(`  推流期间 seq 增量: ${totalFrames}（${totalSecs.toFixed(1)}s）`);
  console.log(`  推流期间平均帧率: ${(totalFrames / totalSecs).toFixed(2)} 帧/秒`);
  console.log(`  基线帧率:         ${baseFps.toFixed(2)} 帧/秒`);
  console.log(`  帧率变化:         ${((totalFrames / totalSecs / baseFps - 1) * 100).toFixed(1)}%`);
  console.log(`  检测到重启次数:   ${resets}`);
  const camFinal = await get('/api/cam').catch(() => ({}));
  console.log(`  摄像头收到帧数:   ${camFinal.frames || 0}`);

  console.log('\n>>> 下发 cam_off 收流');
  console.log('    响应:', JSON.stringify(await post('/api/cam', { action: 'stop' })));
})().catch((e) => { console.error('异常:', e); process.exit(1); });
