#!/usr/bin/env node
/**
 * 第 7 周：按需采集的存储与状态机（纯单元测试，不起服务、不碰硬件）
 *
 * 为什么先写这个：本周的两个当堂验证都是「状态会被错误地当成成功」类缺陷 ——
 *   ① 上次成功图像不得被标为本次采集成功（实测：抓拍失败后 /api/cam/snapshot.jpg
 *      仍返回 200 + 旧图，页面据此显示「已抓拍」）。
 *   ② 采集失败保持明确状态（实测：失败后旧图与绿标一起留着）。
 * 这类缺陷靠人工点一遍很难发现，必须把状态机的迁移规则写死成断言。
 *
 * 锁死的语义：
 *   · 单飞：同时只允许一个在途采集（requested / capturing），第二次 begin 被拒；
 *   · 序号单调 + 时间窗：只接受比上次抓拍帧更新的帧，且必须在窗口内；
 *   · 画面不可用（blocked）与失败（failed）都是终止态，且必须带人可读原因；
 *   · 终止态之后才能开新的一次；
 *   · 保留：磁盘只留最近 keep 张，淘汰要留记录。
 *
 * 隔离：所有落盘都在临时目录，跑完即删。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};

const TMP = path.join(os.tmpdir(), `snapshot-store-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let lib;
try {
  lib = require('../lib/snapshot-store.js');
} catch (e) {
  console.error('\n✗ 无法加载 lib/snapshot-store.js：' + e.message);
  console.error('  （这是红灯的第一步：模块还不存在，先让测试跑起来）\n');
  process.exit(1);
}
const { createSnapshotStore, assessFrame, SHOT_ID_RE } = lib;

/* 造两种「帧」：
 *   · 纹理帧 —— 随机字节 + JPEG 魔数，字节分布接近真实照片（熵高）；
 *   · 平坦帧 —— 几乎全是同一个字节，模拟全黑/纯色/被遮挡（熵极低）。
 *
 * ★ 这里必须用 crypto.randomBytes，不能用 LCG 之类的廉价伪随机数：
 *   实测 LCG（x*1103515245+12345 取低 8 位）的字节熵只有 1.34 bit/byte，
 *   会被判成「画面无细节」，于是测试测的是夹具的缺陷而不是产品的行为。
 *   标定依据（2026-11-19 用板子真实回传的 JPEG 实测）：
 *     真实 320x240 帧（3636 字节）熵 = 7.485
 *     纯黑 / 纯白（6000 字节）   熵 = 0.000
 *   阈值取 2.0，落在两者之间的空旷区间里。
 *
 * 真机帧的端到端验证在 test/snapshot-test.js 里用板子真实回传做。 */
const crypto = require('node:crypto');
function texturedJpeg(n = 6000) {
  const b = crypto.randomBytes(n);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[3] = 0xE0;
  b[n - 2] = 0xFF; b[n - 1] = 0xD9;
  return b;
}
function flatJpeg(n = 6000, byte = 0x00) {
  const b = Buffer.alloc(n, byte);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[3] = 0xE0;
  b[n - 2] = 0xFF; b[n - 1] = 0xD9;
  return b;
}

console.log('\n— ① 画面可用性启发式（assessFrame） —');
{
  const t = assessFrame(texturedJpeg());
  ok(t.usable === true, '纹理帧判为可用', `entropy=${t.entropy && t.entropy.toFixed(2)}`);

  const flat = assessFrame(flatJpeg());
  ok(flat.usable === false, '纯色帧判为不可用（镜头遮挡/画面不可用的最基本形态）');
  ok(typeof flat.reason === 'string' && flat.reason.length > 0, '不可用时必须给出人可读原因', flat.reason);
  ok(/纯色|遮挡|无细节|全黑/.test(flat.reason), '原因文案说清是「画面几乎无细节」而不是含糊的「失败」', flat.reason);

  const tiny = assessFrame(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
  ok(tiny.usable === false, '过小的帧判为不可用');
  ok(/小|无细节/.test(tiny.reason), '过小的原因与「纯色」区分开', tiny.reason);

  ok(assessFrame(null).usable === false, 'null 不抛异常，如实判不可用');
  ok(assessFrame(Buffer.alloc(0)).usable === false, '空 buffer 不抛异常');
}

console.log('\n— ② shot_id 格式与唯一性 —');
{
  const store = createSnapshotStore({ dir: TMP, keep: 5 });
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(store.newId());
  ok(ids.size === 50, '50 次生成的 id 互不相同');
  const one = [...ids][0];
  ok(SHOT_ID_RE.test(one), 'id 符合 shot-YYYYMMDD-HHMMSS-mmm-hex 格式', one);
}

console.log('\n— ③ 单飞：同时只允许一个在途采集 —');
{
  const dir = path.join(TMP, 'c3'); fs.mkdirSync(dir, { recursive: true });
  const store = createSnapshotStore({ dir, keep: 5 });
  const a = store.begin({ trigger: 'ui', requestId: 'req-1' });
  ok(a.ok === true && a.record.state === 'requested', '第一次 begin → requested');
  ok(a.record.shot_id && a.record.trigger === 'ui', '记录带 shot_id 与触发来源');

  const b = store.begin({ trigger: 'ui', requestId: 'req-2' });
  ok(b.ok === false && b.error === 'shot_in_progress', '第二次 begin 被拒（单飞）', b.error);
  ok(b.current && b.current.shot_id === a.record.shot_id, '拒绝时回传当前在途的那一条');

  store.markCapturing(a.record.shot_id, { boardAck: 'shot' });
  const c = store.begin({ trigger: 'voice', requestId: 'req-3' });
  ok(c.ok === false, 'capturing 阶段同样不允许并发');
}

console.log('\n— ④ 合法迁移：requested → capturing → captured —');
{
  const dir = path.join(TMP, 'c4'); fs.mkdirSync(dir, { recursive: true });
  const store = createSnapshotStore({ dir, keep: 5 });
  const a = store.begin({ trigger: 'ui', requestId: 'req-1' });
  const id = a.record.shot_id;

  ok(store.markCapturing(id, { boardAck: 'shot' }).ok === true, 'requested → capturing');
  ok(store.get(id).state === 'capturing', '状态确实是 capturing');

  const jpeg = texturedJpeg();
  const r = store.complete(id, { jpeg, boardSeq: 100, boardTs: 1700000000000 });
  ok(r.ok === true && r.record.state === 'captured', 'capturing → captured');
  ok(r.record.bytes === jpeg.length, '记录里存了字节数', String(r.record.bytes));
  ok(r.record.captured_at > 0, '记录里有采集时间 captured_at');
  ok(r.record.requested_at > 0 && r.record.requested_at <= r.record.captured_at,
    '请求时刻不晚于采集时刻（能算出往返耗时）');
  ok(r.record.board_seq === 100, '记录里存了板端帧序号（对得上就是同一帧的证据）');
  ok(fs.existsSync(store.fileFor(id)), 'JPEG 已落盘');
  ok(fs.readFileSync(store.fileFor(id)).length === jpeg.length, '落盘字节数与原帧一致');
}

console.log('\n— ⑤ ★ 旧帧不得冒充本次（当堂验证第 1 条） —');
{
  const dir = path.join(TMP, 'c5'); fs.mkdirSync(dir, { recursive: true });
  const store = createSnapshotStore({ dir, keep: 5 });

  // 第一次：成功，板端帧序号 100
  const a = store.begin({ trigger: 'ui', requestId: 'req-1' });
  store.markCapturing(a.record.shot_id, {});
  store.complete(a.record.shot_id, { jpeg: texturedJpeg(), boardSeq: 100 });

  // 第二次：板端回执正常，但到达的帧还是上一张（序号没变）
  const b = store.begin({ trigger: 'ui', requestId: 'req-2' });
  store.markCapturing(b.record.shot_id, {});
  const stale = store.complete(b.record.shot_id, { jpeg: texturedJpeg(), boardSeq: 100 });
  ok(stale.ok === false, '序号未递增的帧被拒绝（不许当成本次结果）', stale.error);
  ok(stale.error === 'stale_frame', '拒绝原因是 stale_frame');
  ok(store.get(b.record.shot_id).state !== 'captured',
    '★ 上一次的成功图像没有被标成这一次的成功', store.get(b.record.shot_id).state);
  ok(!fs.existsSync(store.fileFor(b.record.shot_id)), '本次没有生成文件（不会出现一张冒充的图）');

  // 序号更新的帧才认
  const good = store.complete(b.record.shot_id, { jpeg: texturedJpeg(), boardSeq: 101 });
  ok(good.ok === true && good.record.state === 'captured', '序号递增的帧正常接受');
}

console.log('\n— ⑥ ★ 采集失败保持明确状态（当堂验证第 2 条） —');
{
  const dir = path.join(TMP, 'c6'); fs.mkdirSync(dir, { recursive: true });
  const store = createSnapshotStore({ dir, keep: 5 });
  const a = store.begin({ trigger: 'ui', requestId: 'req-1' });
  store.markCapturing(a.record.shot_id, {});

  const f = store.fail(a.record.shot_id, '板端 15 秒内没有回传抓拍帧');
  ok(f.ok === true && f.record.state === 'failed', '显式失败 → failed');
  ok(f.record.reason === '板端 15 秒内没有回传抓拍帧', '失败原因原样保留');
  ok(f.record.captured_at == null, '失败记录没有采集时间（不伪造）');
  ok(!fs.existsSync(store.fileFor(a.record.shot_id)), '失败不产生文件');

  // 失败之后再来的帧不能把状态改回 captured
  const late = store.complete(a.record.shot_id, { jpeg: texturedJpeg(), boardSeq: 200 });
  ok(late.ok === false, '失败之后到达的帧不能把状态改回成功', late.error);
  ok(store.get(a.record.shot_id).state === 'failed', '状态仍是 failed（失败是终止态）');
}

console.log('\n— ⑦ 画面不可用 → blocked，同样带原因且不落图 —');
{
  const dir = path.join(TMP, 'c7'); fs.mkdirSync(dir, { recursive: true });
  const store = createSnapshotStore({ dir, keep: 5 });
  const a = store.begin({ trigger: 'ui', requestId: 'req-1' });
  store.markCapturing(a.record.shot_id, {});
  const r = store.complete(a.record.shot_id, { jpeg: flatJpeg(), boardSeq: 300 });
  ok(r.ok === false, '画面不可用时不算成功');
  ok(r.record.state === 'blocked', '状态是 blocked（与 failed 区分开）', r.record.state);
  ok(/纯色|遮挡|无细节|全黑/.test(r.record.reason || ''), 'blocked 带具体原因', r.record.reason);
  ok(!fs.existsSync(store.fileFor(a.record.shot_id)), 'blocked 不落图（避免把废图当结果）');
}

console.log('\n— ⑧ 时间窗：太晚到的帧不认 —');
{
  const dir = path.join(TMP, 'c8'); fs.mkdirSync(dir, { recursive: true });
  const store = createSnapshotStore({ dir, keep: 5, windowMs: 1000 });
  const a = store.begin({ trigger: 'ui', requestId: 'req-1', now: 1000 });
  store.markCapturing(a.record.shot_id, { now: 1000 });
  const r = store.complete(a.record.shot_id, { jpeg: texturedJpeg(), boardSeq: 1, now: 1000 + 1500 });
  ok(r.ok === false && r.error === 'stale_frame', '超出时间窗的帧被拒', r.error);
  ok(/时间窗|窗口/.test(r.record.reason || ''), '原因里说明是超时', r.record.reason);
}

console.log('\n— ⑨ 终止态之后可以开新的一次 —');
{
  const dir = path.join(TMP, 'c9'); fs.mkdirSync(dir, { recursive: true });
  const store = createSnapshotStore({ dir, keep: 5 });
  const a = store.begin({ trigger: 'ui', requestId: 'req-1' });
  store.fail(a.record.shot_id, '超时');
  const b = store.begin({ trigger: 'help', requestId: 'req-2' });
  ok(b.ok === true, '上一次失败后能重新发起');
  ok(b.record.trigger === 'help', '新记录的触发来源正确');
  ok(b.record.shot_id !== a.record.shot_id, '新记录用新 shot_id');
}

console.log('\n— ⑩ 保留：磁盘只留最近 keep 张 —');
{
  const dir = path.join(TMP, 'c10'); fs.mkdirSync(dir, { recursive: true });
  const store = createSnapshotStore({ dir, keep: 5 });
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const a = store.begin({ trigger: 'ui', requestId: 'req-' + i });
    store.markCapturing(a.record.shot_id, {});
    const r = store.complete(a.record.shot_id, { jpeg: texturedJpeg(6000, i + 1), boardSeq: 1000 + i });
    if (r.ok) ids.push(a.record.shot_id);
  }
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.jpg'));
  ok(files.length === 5, '磁盘只剩 5 个 JPEG', String(files.length));
  const kept = new Set(files.map((n) => n.replace(/\.jpg$/, '')));
  const dropped = ids.filter((id) => !kept.has(id));
  ok(dropped.length === 3, '被淘汰 3 张', dropped.length + ' 张');
  ok(dropped.every((id) => !kept.has(id)), '淘汰的是最旧的那几张');
  ok(ids.slice(-5).every((id) => kept.has(id)), '保留的是最近 5 张');

  const list = store.list();
  ok(list.length === 5, 'list() 只回最近 5 条', String(list.length));
  ok(list.every((r) => r.state === 'captured'), '列表里的都是成功记录');
}

console.log('\n— ⑪ 记录流水可回读（重启后不丢） —');
{
  const dir = path.join(TMP, 'c11'); fs.mkdirSync(dir, { recursive: true });
  const s1 = createSnapshotStore({ dir, keep: 5 });
  const a = s1.begin({ trigger: 'voice', requestId: 'req-1' });
  s1.markCapturing(a.record.shot_id, {});
  s1.complete(a.record.shot_id, { jpeg: texturedJpeg(), boardSeq: 500 });
  const b = s1.begin({ trigger: 'help', requestId: 'req-2' });
  s1.fail(b.record.shot_id, '板端 no_camera 0x106');

  const s2 = createSnapshotStore({ dir, keep: 5 });
  const list = s2.list();
  ok(list.length === 2, '新实例能读回 2 条记录', String(list.length));
  ok(list.some((r) => r.trigger === 'voice' && r.state === 'captured'), '读回了成功那条（含触发来源）');
  ok(list.some((r) => r.trigger === 'help' && r.state === 'failed' && /0x106/.test(r.reason)),
    '读回了失败那条（含原因）');
  ok(s2.get(a.record.shot_id) != null, '能按 shot_id 查到历史记录');
}

console.log('\n— ⑫ 非法迁移一律拒绝（不许悄悄改成成功） —');
{
  const dir = path.join(TMP, 'c12'); fs.mkdirSync(dir, { recursive: true });
  const store = createSnapshotStore({ dir, keep: 5 });
  const a = store.begin({ trigger: 'ui', requestId: 'req-1' });

  ok(store.complete(a.record.shot_id, { jpeg: texturedJpeg(), boardSeq: 1 }).ok === false,
    'requested 阶段直接 complete 被拒（必须经过 capturing）');
  ok(store.markCapturing('shot-不存在', {}).ok === false, '对不存在的 shot_id 迁移被拒');
  ok(store.fail('shot-不存在', 'x').ok === false, '对不存在的 shot_id 失败被拒');

  store.markCapturing(a.record.shot_id, {});
  store.complete(a.record.shot_id, { jpeg: texturedJpeg(), boardSeq: 1 });
  ok(store.markCapturing(a.record.shot_id, {}).ok === false, 'captured 之后不能再回到 capturing');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
