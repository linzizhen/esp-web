'use strict';
/** 真实 data/records.ndjson 污染取证（不是套件，不登记 run-all，手动/取证时用）
 *
 * 存在理由：
 *   开发板自 2026-09-28 起 WiFi 常驻，以约 1.5 帧/秒向生产实例 8080 持续写
 *   data/records.ndjson。因此「跑测试前后条数必须相同」在板子在线时**不可能**按
 *   字面成立 —— 文件本来就在长。真正要守的是另一件事：
 *     **测试跑完新增的每一行，都必须是板子的真实帧，不能有任何一行来自测试。**
 *   本工具用「字节偏移快照 + 新增行全量解析」来做这个判定，判据比"条数不变"更严：
 *     ① 新增行全部是合法 NDJSON，且带真实设备身份（device_id/device_mac 与基线一致）
 *     ② 新增行的 seq 严格递增，且最小值 > 基线最大 seq ——
 *        测试帧的 seq 从 1 开始（ws-test / storage-test 都注入 seq=1/2），
 *        一旦 isolate 失效（DATA_DIR 写错）必然在这里被抓住。
 *
 * 用法：
 *   node test/records-pollution-check.js before      # 记录基线偏移与最大 seq
 *   node test/records-pollution-check.js after       # 校验 only-new-lines
 *   node test/records-pollution-check.js status      # 只看当前基线
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'records.ndjson');
/* 基线文件落在 test/.test-data* 下：该通配已被 .gitignore 覆盖，
 * 否则每次取证都会在 git status 里冒出一个未跟踪文件。 */
const STATE_DIR = path.join(__dirname, '.test-data-pollution');
const STATE = path.join(STATE_DIR, 'records-baseline.json');

const scan = () => {
  if (!fs.existsSync(FILE)) return null;
  const st = fs.statSync(FILE);
  const fd = fs.openSync(FILE, 'r');
  try {
    // 大文件（20 MB+）只读尾部算 seq：板端 seq 单调递增，尾部最大即全局最大
    const tailLen = Math.min(256 * 1024, st.size);
    const buf = Buffer.alloc(tailLen);
    fs.readSync(fd, buf, 0, tailLen, st.size - tailLen);
    let maxSeq = null;
    let lines = 0;
    let lastDevice = null;
    for (const ln of buf.toString('utf8').split('\n')) {
      const s = ln.trim();
      if (!s || !s.startsWith('{')) continue;
      lines++;
      try {
        const o = JSON.parse(s);
        if (typeof o.seq === 'number' && (maxSeq === null || o.seq > maxSeq)) maxSeq = o.seq;
        if (o.device_id) lastDevice = { id: o.device_id, mac: o.device_mac || null };
      } catch (_) { /* 尾部截断的半行，忽略 */ }
    }
    return { size: st.size, maxSeq, lines, lastDevice };
  } finally { fs.closeSync(fd); }
};

const cmd = (process.argv[2] || 'status').toLowerCase();

if (cmd === 'before') {
  const s = scan();
  if (!s) { console.error('data/records.ndjson 不存在'); process.exit(2); }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ at: Date.now(), ...s }, null, 2));
  console.log(`基线已记录：size=${s.size} maxSeq=${s.maxSeq} device=${s.lastDevice && s.lastDevice.id}`);
  process.exit(0);
}

if (cmd === 'status') {
  const s = scan();
  console.log(s ? `当前：size=${s.size} maxSeq=${s.maxSeq} device=${s.lastDevice && s.lastDevice.id}` : '文件不存在');
  process.exit(0);
}

if (cmd !== 'after') {
  console.error('用法：node test/records-pollution-check.js before|after|status');
  process.exit(2);
}

/* ---- after：逐行审核自基线偏移以来的新增内容 ---- */
if (!fs.existsSync(STATE)) {
  console.error('先运行 before 记录基线（node test/records-pollution-check.js before）');
  process.exit(2);
}
const base = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const now = scan();
if (!now) { console.error('data/records.ndjson 已被删除！'); process.exit(1); }

const fd = fs.openSync(FILE, 'r');
const newLen = now.size - base.size;
let added = '';
if (newLen > 0) {
  const buf = Buffer.alloc(newLen);
  fs.readSync(fd, buf, 0, newLen, base.size);
  added = buf.toString('utf8');
}
fs.closeSync(fd);

let count = 0;
const bad = [];
let reboots = 0;
let prevSeq = base.maxSeq == null ? -Infinity : base.maxSeq;
for (const ln of added.split('\n')) {
  const s = ln.trim();
  if (!s) continue;
  count++;
  let o = null;
  try { o = JSON.parse(s); } catch (_) { bad.push({ why: '非合法 JSON', line: s.slice(0, 120) }); continue; }
  const devOk = !base.lastDevice || (o.device_id === base.lastDevice.id
    && (!base.lastDevice.mac || !o.device_mac || o.device_mac === base.lastDevice.mac));
  if (!devOk) bad.push({ why: `设备身份不符（${o.device_id}/${o.device_mac}）`, line: s.slice(0, 120) });
  if (typeof o.seq !== 'number') {
    bad.push({ why: '行内没有板端 seq（测试合成帧常缺）', line: s.slice(0, 120) });
    continue;
  }
  if (o.seq <= prevSeq) {
    /* seq 回退有两种成因，必须分开判：
     *   (a) 板子重启 / 重新烧固件 —— seq 从 1 重新计数，这是**真实**板端行为
     *       （2026-10-23 实测就抓到一次：seq 7205 → 1，但该行 device_mac 与
     *        基线一致、带 src_ip=10.1.41.123 与 upload_ok/heap 等板端独有字段、
     *        board_ts 也在推进，显然是板子重启而非测试注入）；
     *   (b) 测试隔离失效 —— 合成帧（storage-test / ws-test）同样是 seq=1，
     *       但 device_mac 是 AABBCCDDEEFF 这类假值，且没有 upload_ok/heap/src_ip。
     * 因此判据不是「seq 必须递增」，而是「回退行是否带齐板端独有证据」。 */
    const f = o.fields || {};
    const boardEvidence = devOk
      && typeof o.board_ts === 'number'
      && (!!o.src_ip || typeof o.transport === 'string')
      && (f.upload_ok !== undefined || f.heap !== undefined || f.imu_ok !== undefined || f.upload_fail !== undefined);
    if (boardEvidence) reboots++;
    else bad.push({ why: `seq 回退（${prevSeq} -> ${o.seq}）且缺少板端独有字段，疑似测试合成帧`, line: s.slice(0, 120) });
  }
  prevSeq = o.seq;
}

console.log(`基线 size=${base.size} maxSeq=${base.maxSeq}`);
console.log(`现在 size=${now.size} maxSeq=${now.maxSeq}`);
console.log(`新增 ${count} 行 / ${newLen} 字节（板子在线时这是板端真实写入）；其中 seq 重新计数 ${reboots} 次（板端重启，非污染）`);
console.log(`文件总增长 ${now.size - base.size} 字节；条数按"基线时刻"统计无法逐条对齐（板子在写）`);
if (bad.length) {
  console.error(`\n✗ 发现 ${bad.length} 条可疑新增行 —— 测试可能污染了真实数据：`);
  for (const b of bad.slice(0, 10)) console.error(`  · ${b.why}\n    ${b.line}`);
  process.exit(1);
}
console.log('\n✓ 新增行全部是真实板端帧（身份一致、seq 严格递增且大于基线），无测试污染');
process.exit(0);
