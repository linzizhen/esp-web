'use strict';
/**
 * 第 8 周：视觉推理核心逻辑（保底本地判定 + 拓展模型场景分类 + 三对应记录）
 *
 * 设计依据见 docs/week8-vision-design.md。要点：
 *   · 2026-11-27 实测：真实模型 glm-4v-flash 对纯黑图会幻觉成「穿黑衣服的人」，
 *     且自报 score 恒为 1；故「画面可用性 / 遮挡」不由模型判定，改用本地
 *     可解释指标（脚本 scripts/vision/image-metrics.py 提供指标）。
 *   · 模型只做场景粗分类，score 一律 score_calibrated=false，任何地方不出「正确率」。
 *   · 云端默认关闭；关闭时绝不调用模型。画面不可用时也不调用模型（避开幻觉）。
 *   · 每条推理 inference_id 绑定输入 shot_id；人工纠正只写 human_*，不覆盖 model_*。
 *
 * 本模块纯逻辑：measureMetrics / modelClient 全部注入，测试不起服务、不出网。
 */

const fs = require('node:fs');
const path = require('node:path');

const SCENES = ['室内', '桌面', '户外', '无法判断'];

const DEFAULT_THRESHOLDS = {
  darkLuma: 8,       // 亮度均值低于此 → 偏黑
  brightLuma: 247,   // 亮度均值高于此 → 过曝
  maxGrayLevels: 3,  // 灰度级种数 ≤ 此 → 近乎纯色
  minEntropy: 2.0,   // 压缩字节熵低于此 → 无细节（正常 6~7，纯色≈0）
  blurLaplacian: 3.0,// 拉普拉斯方差低于此 → 严重模糊（真机清晰图 25~300，模糊 0.5）
  softLaplacian: 15.0,// 介于模糊与清晰之间 → 可用但偏软
};

const OUTCOMES = ['ok', 'low_score', 'unknown', 'parse_failed', 'model_unavailable', 'cloud_disabled', 'timeout', 'blocked', 'metrics_unavailable'];

/* 只保留本地指标里的数值项，避免把本机绝对路径（python 返回的 path 字段）写进记录 */
const METRIC_KEYS = ['brightness_mean', 'contrast_std', 'laplacian_var', 'gray_levels', 'byte_entropy'];
function pickMetrics(m) {
  if (!m || typeof m !== 'object') return null;
  const o = {};
  for (const k of METRIC_KEYS) if (m[k] != null) o[k] = m[k];
  return o;
}

/** 本地指标 → 可用性判定（确定性、可解释） */
function classifyMetrics(m, thresholds) {
  const t = Object.assign({}, DEFAULT_THRESHOLDS, thresholds || {});
  if (!m || typeof m !== 'object') {
    return { usability: 'unknown', reason: '本地指标不可用，无法判断画面质量', soft: false };
  }
  const luma = Number(m.brightness_mean);
  const levels = Number(m.gray_levels);
  const ent = Number(m.byte_entropy);
  const lap = Number(m.laplacian_var);

  // 先判过曝：纯白图同时满足「灰度级 ≤3」，但语义上应报过曝而非遮挡
  if (Number.isFinite(luma) && luma > t.brightLuma) {
    return { usability: 'overexposed', reason: '画面接近全白，可能过曝或镜头贴墙', soft: false };
  }
  if ((Number.isFinite(luma) && luma < t.darkLuma) ||
      (Number.isFinite(levels) && levels <= t.maxGrayLevels) ||
      (Number.isFinite(ent) && ent < t.minEntropy)) {
    return { usability: 'blocked', reason: '画面接近全黑 / 纯色，可能镜头被遮挡', soft: false };
  }
  if (Number.isFinite(lap) && lap < t.blurLaplacian) {
    return { usability: 'blurred', reason: '画面边缘极弱，可能失焦或抖动', soft: false };
  }
  const soft = Number.isFinite(lap) && lap < t.softLaplacian;
  return { usability: 'usable', reason: soft ? '画面可用（可能偏软，建议靠近或稳定）' : '画面可用', soft };
}

/** 场景只允许四个枚举，越界一律归「无法判断」 */
function sanitizeScene(s) {
  return SCENES.includes(s) ? s : '无法判断';
}

/**
 * 解析模型输出：容忍 ```json 围栏与前后噪声；只抽取白名单字段，
 * 坐标 / 安全类等越界字段一律丢弃。
 * 返回 { ok, label, scene, score }；非法 JSON → { ok:false }。
 */
function parseModelOutput(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false };
  let s = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return { ok: false };
  let obj;
  try { obj = JSON.parse(s.slice(i, j + 1)); } catch (_) { return { ok: false }; }
  if (!obj || typeof obj !== 'object') return { ok: false };

  const label = typeof obj.label === 'string' ? obj.label.trim() : '';
  const scene = sanitizeScene(obj.scene);
  let score = null;
  if (typeof obj.score === 'number' && Number.isFinite(obj.score)) {
    score = Math.min(1, Math.max(0, obj.score));
  }
  // 只返回白名单字段：不返回 usable / coords / safety 等
  return { ok: true, label, scene, score };
}

function defaultGenId(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  const rnd = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `vis-${date}-${time}-${rnd}`;
}

function createVisionInfer(opts = {}) {
  const recordsFile = opts.recordsFile;
  const keep = Number.isFinite(opts.keep) ? opts.keep : 50;
  const enabled = !!opts.enabled;
  const lowScore = Number.isFinite(opts.lowScore) ? opts.lowScore : 0.4;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;
  const modelVersion = opts.modelVersion || 'glm-4v-flash';
  const thresholds = Object.assign({}, DEFAULT_THRESHOLDS, opts.thresholds || {});
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const genId = typeof opts.genId === 'function' ? opts.genId : defaultGenId;
  const measureMetrics = opts.measureMetrics;
  const modelClient = opts.modelClient;

  let records = [];
  if (recordsFile && fs.existsSync(recordsFile)) {
    try {
      records = fs.readFileSync(recordsFile, 'utf8').split('\n')
        .map((l) => l.trim()).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean);
    } catch (_) { records = []; }
  }

  function persist() {
    if (!recordsFile) return;
    if (records.length > keep) records = records.slice(records.length - keep);
    try {
      fs.mkdirSync(path.dirname(recordsFile), { recursive: true });
      const tmp = recordsFile + '.tmp';
      fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
      fs.renameSync(tmp, recordsFile);   // 原子替换：写一半崩溃也不会把整份历史截断
    } catch (_) { /* 落盘失败不阻断推理 */ }
  }

  function callModel(imageB64) {
    if (typeof modelClient !== 'function') {
      return Promise.resolve({ status: 0, text: '', error: 'no_client' });
    }
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
    });
    const call = Promise.resolve()
      .then(() => modelClient({ model: modelVersion, imageB64 }))
      .catch((e) => ({ __error: (e && e.message) || String(e) }));
    return Promise.race([call, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }

  async function infer({ shotId, trigger, imagePath, imageB64 } = {}) {
    const t0 = now();
    const inference_id = genId(t0);
    const rec = {
      inference_id,
      shot_id: shotId || null,
      trigger: trigger || 'ui',
      model_version: modelVersion,
      model_label: null,
      scene: '无法判断',
      score: null,
      score_calibrated: false,      // ★ 永远不校准；页面必须标注「未校准」
      usability: 'unknown',
      usability_reason: '尚未判定',
      metrics: null,
      outcome: 'unknown',
      requested_at: t0,
      completed_at: null,
      latency_ms: null,
      replay: false,
      human_label: null,
    };

    // 1) 保底层：本地指标
    let m = null;
    if (typeof measureMetrics === 'function') {
      try { m = await measureMetrics(imagePath); } catch (_) { m = null; }
    }
    rec.metrics = pickMetrics(m);
    /* 保底层指标不可用（缺 Pillow / 脚本失败）时，不能静默把画面交给模型：
     * 那样「本地可解释保底」形同虚设，还可能误把不可用画面当可用上传。
     * 明确记为 metrics_unavailable，且不调用模型。 */
    if (!m) {
      rec.usability = 'unknown';
      rec.usability_reason = '本地画面指标不可用（缺少 Pillow 或脚本失败），为安全起见不调用模型';
      rec.outcome = 'metrics_unavailable';
      rec.model_version = 'local_metrics_only';
      return finish(rec, t0);
    }
    const cls = classifyMetrics(m, thresholds);
    rec.usability = cls.usability;
    rec.usability_reason = cls.reason;

    // 2) 不可用 → 不调模型
    if (cls.usability === 'blocked' || cls.usability === 'overexposed' || cls.usability === 'blurred') {
      rec.outcome = 'blocked';
      rec.model_version = 'local_metrics_only';
      return finish(rec, t0);
    }

    // 3) 云端关闭 → 只给本地判定
    if (!enabled) {
      rec.outcome = 'cloud_disabled';
      rec.model_version = 'local_metrics_only';
      return finish(rec, t0);
    }

    // 4) 调用真实模型
    const resp = await callModel(imageB64);
    if (resp && resp.__timeout) {
      rec.outcome = 'timeout';
      return finish(rec, t0);
    }
    if (resp && resp.__error) {
      rec.outcome = 'model_unavailable';
      return finish(rec, t0);
    }
    if (!resp || resp.status !== 200) {
      rec.outcome = 'model_unavailable';
      return finish(rec, t0);
    }
    const parsed = parseModelOutput(resp.text);
    if (!parsed.ok) {
      rec.outcome = 'parse_failed';
      return finish(rec, t0);
    }
    rec.model_label = parsed.label || null;
    rec.scene = parsed.scene;
    rec.score = parsed.score;
    if (!parsed.label || parsed.score == null) {
      rec.outcome = 'unknown';
    } else if (parsed.score < lowScore) {
      rec.outcome = 'low_score';
    } else {
      rec.outcome = 'ok';
    }
    return finish(rec, t0);
  }

  function finish(rec, t0) {
    rec.completed_at = now();
    rec.latency_ms = Math.max(0, rec.completed_at - t0);
    records.push(rec);
    persist();
    return rec;
  }

  function list() { return records.slice(); }
  function get(id) { return records.find((r) => r.inference_id === id) || null; }

  function correct(id, payload = {}) {
    const rec = get(id);
    if (!rec) return { ok: false, error: 'not_found' };
    const label = typeof payload.human_label === 'string' ? payload.human_label.trim() : '';
    if (!label) return { ok: false, error: 'human_label_required' };
    rec.human_label = {
      label,
      scene: sanitizeScene(payload.human_scene),
      note: typeof payload.note === 'string' ? payload.note.slice(0, 500) : '',
      at: now(),
    };
    persist();
    return { ok: true, record: rec };
  }

  function config() {
    return { enabled, model: modelVersion, low_score: lowScore, thresholds };
  }

  return { infer, list, get, correct, config };
}

module.exports = {
  classifyMetrics,
  sanitizeScene,
  parseModelOutput,
  createVisionInfer,
  DEFAULT_THRESHOLDS,
  SCENES,
  OUTCOMES,
};
