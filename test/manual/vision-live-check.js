#!/usr/bin/env node
/**
 * 第 8 周：真实模型受控验证（人工执行，需要联网 + config.local.json 的智谱 Key）
 *
 * 用法：node test/manual/vision-live-check.js
 *
 * 目的：用「真实板载快照」+「真实云端视觉模型 glm-4v-flash」跑一次，留下可复核的
 * 证据表；同时复现「模型对纯黑图会幻觉、score 恒为 1」这一决定架构分工的事实。
 *
 * 说明：
 *   · 属人工脚本，不进 run-all.js（依赖网络、Key 与 .asr-venv）。
 *   · 不写真实 data/ 的推理记录到生产；记录写到临时目录，跑完留给人看并清理。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createVisionInfer } = require('../../lib/vision-infer.js');

const ROOT = path.join(__dirname, '..', '..');
const PY = process.env.ASR_VOSK_PYTHON || path.join(ROOT, '..', '.asr-venv', 'Scripts', 'python.exe');
const METRICS = path.join(ROOT, 'scripts', 'vision', 'image-metrics.py');
const TMP = path.join(os.tmpdir(), `vision-live-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8'));
let base = (cfg.nlEndpoint || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
base = base.replace(/\/chat\/completions$/, '');
const KEY = cfg.nlApiKey;

function measure(imagePath) {
  return new Promise((resolve) => {
    execFile(PY, [METRICS, imagePath], { timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (e, out) => {
      if (e) return resolve(null);
      try { resolve((JSON.parse(String(out)) || [])[0] || null); } catch (_) { resolve(null); }
    });
  });
}
async function modelClient({ model, imageB64 }) {
  const body = {
    model, temperature: 0.1,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageB64 } },
      { type: 'text', text: '只输出 JSON：{"label":"一句话描述看到什么","scene":"室内/桌面/户外/无法判断","score":0到1}。不要多余文字。' },
    ]}],
  };
  const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await r.text();
  if (r.status !== 200) return { status: r.status, text: raw };
  let c = raw; try { c = JSON.parse(raw).choices[0].message.content; } catch (_) {}
  return { status: 200, text: c };
}

function mkInfer(recordsName, enabled) {
  return createVisionInfer({
    recordsFile: path.join(TMP, recordsName), keep: 20, enabled,
    lowScore: 0.4, timeoutMs: 12000, modelVersion: 'glm-4v-flash',
    measureMetrics: measure, modelClient,
  });
}

(async () => {
  const sharp = path.join(ROOT, 'data', 'snapshots', 'shot-20261125-103823-521-0002.jpg');
  const soft = path.join(ROOT, 'data', 'snapshots', 'shot-20261119-161441-425-0000.jpg');
  const black = process.argv[2] || '';
  const rows = [];

  async function runOne(label, file, enabled) {
    if (!fs.existsSync(file)) { console.log(`[跳过] ${label}：文件不存在 ${file}`); return; }
    const b64 = fs.readFileSync(file).toString('base64');
    const vi = mkInfer(`rec-${label}-${enabled ? 'on' : 'off'}.ndjson`, enabled);
    const rec = await vi.infer({ shotId: `shot-live-${label}`, trigger: 'ui', imagePath: file, imageB64: b64 });
    rows.push({
      样本: label, 启用: enabled,
      可用性: rec.usability, 拉普拉斯方差: rec.metrics && rec.metrics.laplacian_var,
      结果: rec.outcome, 场景: rec.scene, 标签: rec.model_label, 分数: rec.score,
      分数已校准: rec.score_calibrated,
    });
  }

  await runOne('清晰真机图', sharp, true);
  await runOne('清晰真机图-cloud关闭', sharp, false);
  await runOne('偏软真机图', soft, true);
  if (black) await runOne('纯黑图', black, true);

  // 直接对纯黑图调模型，复现「幻觉 + score=1」，与本地判定对照
  if (black && fs.existsSync(black)) {
    const b64 = fs.readFileSync(black).toString('base64');
    const r = await modelClient({ model: 'glm-4v-flash', imageB64: b64 });
    console.log('\n[纯黑图直接问模型] 原始返回：', String(r.text).replace(/\s+/g, ' ').slice(0, 200));
  }

  console.table(rows);
  console.log('\n临时记录目录：', TMP);
  // 保留目录供人工查看；如需清理自行删除
})();
