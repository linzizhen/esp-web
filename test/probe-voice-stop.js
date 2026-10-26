'use strict';
/** 探针：连续多轮 start→N 秒→stop，看 stop 是否每次都生效
 *  目的：判断「录音 10000ms 撞上限」是偶发还是稳定复现。
 *  用法：node test/probe-voice-stop.js [轮数] [秒数]
 */
const http = require('node:http');
const BASE = 'http://127.0.0.1:8080';
const ROUNDS = Number(process.argv[2] || 3);
const SEC = Number(process.argv[3] || 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const t = Buffer.concat(cs).toString('utf8');
        let j = null; try { j = JSON.parse(t); } catch (_) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const latestId = async () => {
  const r = await req('GET', '/api/voice');
  return r.json && r.json.latest && r.json.latest.audio_id;
};
const latestOf = async (id) => {
  const r = await req('GET', '/api/voice');
  const items = (r.json && (r.json.recent || r.json.items)) || [];
  return items.find((a) => a.audio_id === id) || null;
};

(async () => {
  console.log(`探针：${ROUNDS} 轮，每轮 start → ${SEC}s → stop`);
  const rows = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const before = await latestId();
    const s = await req('POST', '/api/voice/record', { action: 'start' });
    console.log(`\n[第 ${i} 轮] start -> ok=${s.json && s.json.ok} channel=${s.json && s.json.channel}`);
    await sleep(SEC * 1000);
    const t = await req('POST', '/api/voice/record', { action: 'stop' });
    console.log(`           stop  -> ok=${t.json && t.json.ok} channel=${t.json && t.json.channel}`);

    let got = null;
    for (let k = 0; k < 40; k++) {
      await sleep(500);
      const id = await latestId();
      if (id && id !== before) { got = id; break; }
    }
    if (!got) { console.log('           ✗ 没等到新录音'); rows.push({ round: i, ms: null }); continue; }
    const a = await latestOf(got);
    const ms = a ? a.duration_ms : null;
    const verdict = ms == null ? '?' : (ms >= 10000 ? '✗ 撞上限（stop 未生效）' : (Math.abs(ms - SEC * 1000) <= 2000 ? '✓ 正常' : '? 偏差大'));
    console.log(`           新录音 ${got}  时长 ${ms}ms  ${verdict}`);
    rows.push({ round: i, ms, verdict });
    await sleep(1000);
  }
  console.log('\n=== 汇总 ===');
  rows.forEach((r) => console.log(`  第 ${r.round} 轮：${r.ms == null ? '无录音' : r.ms + 'ms'}  ${r.verdict || ''}`));
  const bad = rows.filter((r) => r.ms == null || r.ms >= 10000).length;
  console.log(`  期望 ${SEC * 1000}ms；异常 ${bad}/${rows.length} 轮`);
})().catch((e) => { console.error(e); process.exit(1); });
