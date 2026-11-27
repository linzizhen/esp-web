#!/usr/bin/env node
/**
 * 第 8 周：视觉识别反馈的前端静态契约（读源码 / HTML 断言，不起服务）
 *
 * 锁死「当堂验证」两条：
 *   · 未校准分数不得写成正确率 —— 页面必须出现「未校准」，且不得出现「准确率」；
 *   · 场景类别不得转成坐标 / 人身安全判断 —— 前端不得出现 latitude/longitude 等字段。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};

console.log('\n— ① 页面结构：识别结果卡与纠正入口 —');
for (const id of ['visTag', 'visState', 'visUsability', 'visScene', 'visLabel', 'visScore',
  'visPriv', 'visHumanLabel', 'btnVisionInfer', 'btnVisionRecapture', 'btnVisionCorrect', 'visList']) {
  ok(new RegExp(`id="${id}"`).test(html), `页面有 #${id}`);
}

console.log('\n— ② 未校准声明（当堂验证①） —');
ok(/未校准/.test(html), '页面出现「未校准」字样');
ok(/不代表正确率/.test(html), '页面明确「不代表正确率」');
ok(!/准确率/.test(html), '页面不出现「准确率」');
ok(/未校准/.test(app), 'app.js 也带「未校准」措辞');
ok(/score_calibrated/.test(app) || /未校准/.test(app), '前端表达与 score_calibrated=false 语义一致');

console.log('\n— ③ 越界防护（当堂验证②）：不得出现坐标 / 人身安全字段 —');
ok(!/latitude|longitude/i.test(app) && !/latitude|longitude/i.test(html), '前端无 latitude/longitude 字段');
ok(!/"lat"\s*:/.test(app) && !/"lng"\s*:/.test(app), '前端不构造 lat/lng');
ok(/glm-4v-flash/.test(html), '页面写明真实模型名 glm-4v-flash');
ok(/\.vis-input/.test(css), 'style.css 定义了 .vis-input（纠正输入框有真实样式）');

console.log('\n— ④ 接口接线与分支 —');
ok(/\/api\/vision\/infer/.test(app), '前端调用 /api/vision/infer');
ok(/\/api\/vision\/correct/.test(app), '前端调用 /api/vision/correct');
ok(/\/api\/vision\/config/.test(app), '前端读取 /api/vision/config（隐私状态）');
ok(/cloud_disabled/.test(app), '前端处理 cloud_disabled（云端未启用）');
ok(/model_unavailable/.test(app) && /parse_failed/.test(app), '前端处理模型不可用 / 解析失败');
ok(/renderVisionRecord/.test(app) && /renderVisionList/.test(app), '前端有结果渲染与记录列表');

console.log('\n— ⑤ 版本号推进（避免浏览器缓存旧 JS） —');
const av = Number((/app\.js\?v=(\d+)/.exec(html) || [])[1] || 0);
const sv = Number((/style\.css\?v=(\d+)/.exec(html) || [])[1] || 0);
ok(av >= 51, 'app.js 版本 >= 51', String(av));
ok(sv >= 16, 'style.css 版本 >= 16', String(sv));

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
