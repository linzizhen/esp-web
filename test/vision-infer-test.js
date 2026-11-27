#!/usr/bin/env node
/**
 * 第 8 周：视觉推理核心逻辑（纯单元测试，不起服务、不出网、不碰硬件）
 *
 * 锁死的语义（对应 docs/week8-vision-design.md）：
 *   · 保底层用本地可解释指标判「全黑 / 过曝 / 严重模糊 / 可用」，不依赖模型；
 *   · 模型只做场景粗分类，其 score 一律 score_calibrated=false，任何地方不出「正确率」；
 *   · 云端默认关闭（cloud_disabled），关闭时绝不调用模型（断言调用次数=0）；
 *   · 画面不可用（blocked）时也不调用模型（省流量、避开模型幻觉）；
 *   · 结果结构含输入 shot_id / 结果 inference_id / 反馈 human_label 三者对应；
 *   · 人工纠正只写 human_*，不覆盖 model_*；保留最近 keep 条。
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

const TMP = path.join(os.tmpdir(), `vision-infer-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let lib;
try {
  lib = require('../lib/vision-infer.js');
} catch (e) {
  console.error('\n✗ 无法加载 lib/vision-infer.js：' + e.message);
  console.error('  （红灯第一步：模块还不存在）\n');
  process.exit(1);
}
const { classifyMetrics, sanitizeScene, parseModelOutput, createVisionInfer } = lib;

const M = {
  dark:  { brightness_mean: 0,   contrast_std: 0,   laplacian_var: 0,   gray_levels: 1,   byte_entropy: 1.7 },
  white: { brightness_mean: 255, contrast_std: 0,   laplacian_var: 0,   gray_levels: 1,   byte_entropy: 4.9 },
  blur:  { brightness_mean: 128, contrast_std: 30,  laplacian_var: 0.5, gray_levels: 200, byte_entropy: 7.9 },
  sharp: { brightness_mean: 130, contrast_std: 40,  laplacian_var: 200, gray_levels: 220, byte_entropy: 7.5 },
  soft:  { brightness_mean: 130, contrast_std: 30,  laplacian_var: 8,   gray_levels: 210, byte_entropy: 7.4 },
};

console.log('\n— ① 保底层：本地指标 → 可用性判定 —');
{
  const d = classifyMetrics(M.dark);
  ok(d.usability === 'blocked', '全黑 → blocked', d.usability);
  const w = classifyMetrics(M.white);
  ok(w.usability === 'overexposed', '纯白 → overexposed', w.usability);
  const b = classifyMetrics(M.blur);
  ok(b.usability === 'blurred', '严重模糊 → blurred', b.usability);
  const s = classifyMetrics(M.sharp);
  ok(s.usability === 'usable' && s.soft === false, '清晰 → usable，不标偏软', String(s.usability));
  const sf = classifyMetrics(M.soft);
  ok(sf.usability === 'usable' && sf.soft === true, '偏软 → usable 但标 soft', `${sf.usability}/${sf.soft}`);
  ok(typeof d.reason === 'string' && d.reason.length > 0, '每个判定都带人可读原因');
}

console.log('\n— ② 场景枚举收敛 —');
{
  ok(sanitizeScene('桌面') === '桌面', '合法场景原样保留');
  ok(sanitizeScene('火星') === '无法判断', '越界场景 → 无法判断', sanitizeScene('火星'));
  ok(sanitizeScene('') === '无法判断', '空场景 → 无法判断');
  ok(sanitizeScene(undefined) === '无法判断', '缺失场景 → 无法判断');
}

console.log('\n— ③ 结构化解析与字段裁剪（越界字段必须被丢弃） —');
{
  const good = parseModelOutput('```json\n{"label":"桌上有个盒子","scene":"桌面","usable":true,"score":0.9,"coords":[12,34],"safety":"危险"}\n```');
  ok(good.ok === true && good.label === '桌上有个盒子', '解析 fenced JSON 取到 label', good.label);
  ok(good.scene === '桌面', 'scene 正常');
  ok(good.score === 0.9, 'score 取到 0.9', String(good.score));
  ok(!('coords' in good) && !('safety' in good), '★ 坐标 / 安全类越界字段被裁掉');

  const clamped = parseModelOutput('{"label":"x","scene":"火星","score":1.7}');
  ok(clamped.scene === '无法判断', '越界场景被收敛');
  ok(clamped.score === 1, 'score 超界被夹到 1', String(clamped.score));

  const bad = parseModelOutput('这不是 JSON');
  ok(bad.ok === false, '非法 JSON → ok=false');

  const noLabel = parseModelOutput('{"scene":"室内"}');
  ok(noLabel.ok === true && noLabel.label === '', '缺 label 但可解析：label 为空串（交由上层判 unknown）');
}

/* 造一个可控的推理器：measureMetrics / modelClient 全部注入，测试不碰真模型。 */
function mkInfer(over = {}) {
  const calls = { model: 0 };
  const opts = Object.assign({
    recordsFile: path.join(TMP, `rec-${Math.random().toString(16).slice(2)}.ndjson`),
    keep: 5,
    enabled: true,
    lowScore: 0.4,
    timeoutMs: 60,
    modelVersion: 'glm-4v-flash',
    thresholds: undefined,
    measureMetrics: async () => M.sharp,
    modelClient: async () => { calls.model++; return { status: 200, text: '{"label":"桌上有个盒子","scene":"桌面","score":0.9}' }; },
    now: () => 1795748000000,
  }, over);
  const vi = createVisionInfer(opts);
  return { vi, calls, opts };
}

(async () => {
  console.log('\n— ④ 云端默认关闭：绝不调用模型 —');
  {
    const { vi, calls } = mkInfer({ enabled: false });
    const rec = await vi.infer({ shotId: 'shot-20261127-100000-000-0001', trigger: 'ui', imagePath: 'x.jpg', imageB64: 'AAAA' });
    ok(rec.outcome === 'cloud_disabled', '关闭时 outcome=cloud_disabled', rec.outcome);
    ok(calls.model === 0, '★ 关闭时模型调用次数为 0', String(calls.model));
    ok(rec.usability === 'usable', '关闭时仍给本地可用性判定', rec.usability);
    ok(rec.score_calibrated === false, 'score_calibrated 恒 false');
  }

  console.log('\n— ⑤ 画面不可用：不调用模型 —');
  {
    const { vi, calls } = mkInfer({ measureMetrics: async () => M.dark });
    const rec = await vi.infer({ shotId: 'shot-20261127-100001-000-0002', trigger: 'ui', imagePath: 'x.jpg', imageB64: 'AAAA' });
    ok(rec.outcome === 'blocked', '全黑 → outcome=blocked', rec.outcome);
    ok(calls.model === 0, '★ blocked 时不调用模型（避开幻觉）', String(calls.model));
    ok(/遮挡|全黑|纯色/.test(rec.usability_reason), '带人可读原因', rec.usability_reason);
  }

  console.log('\n— ⑥ 正常推理：ok / 三对应 —');
  {
    const { vi, calls } = mkInfer();
    const rec = await vi.infer({ shotId: 'shot-20261127-100002-000-0003', trigger: 'ui', imagePath: 'x.jpg', imageB64: 'AAAA' });
    ok(calls.model === 1, '启用时模型被调用一次', String(calls.model));
    ok(rec.outcome === 'ok', 'outcome=ok', rec.outcome);
    ok(rec.model_label === '桌上有个盒子' && rec.scene === '桌面', '标签与场景落库', `${rec.model_label}/${rec.scene}`);
    ok(typeof rec.inference_id === 'string' && rec.inference_id.startsWith('vis-'), 'inference_id 有格式', rec.inference_id);
    ok(rec.shot_id === 'shot-20261127-100002-000-0003', '★ 输入 shot_id 与结果绑定');
    ok(rec.model_version === 'glm-4v-flash', '模型版本落库', rec.model_version);
    ok(rec.human_label === null, '初始无人工反馈');
  }

  console.log('\n— ⑦ 低分 / 未知 / 解析失败 / 模型不可用 / 超时 —');
  {
    const low = mkInfer({ modelClient: async () => ({ status: 200, text: '{"label":"模糊的东西","scene":"无法判断","score":0.2}' }) });
    const r1 = await low.vi.infer({ shotId: 'shot-20261127-100003-000-0004', trigger: 'ui', imagePath: 'x.jpg', imageB64: 'A' });
    ok(r1.outcome === 'low_score', '自报分数低 → low_score', r1.outcome);
    ok(r1.model_label === '模糊的东西', '低分仍保留标签供对照');

    const unk = mkInfer({ modelClient: async () => ({ status: 200, text: '{"scene":"无法判断","score":0.9}' }) });
    const r2 = await unk.vi.infer({ shotId: 'shot-20261127-100004-000-0005', trigger: 'ui', imagePath: 'x.jpg', imageB64: 'A' });
    ok(r2.outcome === 'unknown', '无标签 → unknown', r2.outcome);

    const pf = mkInfer({ modelClient: async () => ({ status: 200, text: '我看到的是一张桌子' }) });
    const r3 = await pf.vi.infer({ shotId: 'shot-20261127-100005-000-0006', trigger: 'ui', imagePath: 'x.jpg', imageB64: 'A' });
    ok(r3.outcome === 'parse_failed', '非 JSON → parse_failed', r3.outcome);

    const mu = mkInfer({ modelClient: async () => { throw new Error('ECONNRESET'); } });
    const r4 = await mu.vi.infer({ shotId: 'shot-20261127-100006-000-0007', trigger: 'ui', imagePath: 'x.jpg', imageB64: 'A' });
    ok(r4.outcome === 'model_unavailable', '调用抛错 → model_unavailable', r4.outcome);

    const to = mkInfer({ timeoutMs: 30, modelClient: () => new Promise(() => {}) });
    const r5 = await to.vi.infer({ shotId: 'shot-20261127-100007-000-0008', trigger: 'ui', imagePath: 'x.jpg', imageB64: 'A' });
    ok(r5.outcome === 'timeout', '超时 → timeout', r5.outcome);
  }

  console.log('\n— ⑧ 人工纠正：只写 human_*，不覆盖 model_* —');
  {
    const { vi } = mkInfer();
    const rec = await vi.infer({ shotId: 'shot-20261127-100008-000-0009', trigger: 'ui', imagePath: 'x.jpg', imageB64: 'A' });
    const before = rec.model_label;
    const c = vi.correct(rec.inference_id, { human_label: '桌上是一个盒子', human_scene: '桌面', note: '模型漏了颜色' });
    ok(c.ok === true, '纠正成功');
    const got = vi.get(rec.inference_id);
    ok(got.human_label && got.human_label.label === '桌上是一个盒子', '写入 human_label', got.human_label && got.human_label.label);
    ok(got.model_label === before, '★ model_label 未被覆盖（保留对照）', got.model_label);
    const bad = vi.correct('vis-不存在', { human_label: 'x' });
    ok(bad.ok === false, '纠正不存在的记录 → 失败');
  }

  console.log('\n— ⑨ 保留最近 keep 条 + 落盘可回读 —');
  {
    const file = path.join(TMP, 'keep.ndjson');
    const mk = () => mkInfer({ recordsFile: file, keep: 3 });
    const a = mk();
    for (let i = 0; i < 5; i++) {
      await a.vi.infer({ shotId: `shot-20261127-10100${i}-000-000a`, trigger: 'ui', imagePath: 'x.jpg', imageB64: 'A' });
    }
    ok(a.vi.list().length === 3, '★ 保留最近 keep=3 条', String(a.vi.list().length));
    const reload = mkInfer({ recordsFile: file, keep: 3 });
    ok(reload.vi.list().length === 3, '新实例从 ndjson 回读记录', String(reload.vi.list().length));
    const line = fs.readFileSync(file, 'utf8').trim().split('\n').pop();
    const obj = JSON.parse(line);
    ok(obj.score_calibrated === false, '落盘记录也带 score_calibrated=false');
    ok(!('正确率' in obj) && !('accuracy' in obj), '记录里没有「正确率 / accuracy」字段');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
  process.exit(fail ? 1 : 0);
})();
