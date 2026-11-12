/* 语音页「旧快照不许冒充当前状态」契约（静态检查）
 *
 * 存在理由：服务端只保留最后一条语音快照。2026-11-12 用户打开页面时，
 * 看到的是 10-30 11:21 那条录音留下的红色「识别失败」，误以为刚刚又失败了。
 * 实际上那只是 13 天前的历史。规则：快照超过 10 分钟就按历史渲染 ——
 * 不弹失败横幅、不占四段链路的“当前状态”。
 *
 * 用法：node test/voice-stale-test.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

function fnBody(src, name) {
  const at = src.indexOf(name);
  if (at < 0) return '';
  const p = src.indexOf('(', at);
  const start = src.indexOf('{', p);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
}

console.log('=== 语音页「旧快照不许冒充当前状态」契约 ===\n');

check('定义了陈旧阈值 VOICE_STALE_MS = 10 分钟',
  /const\s+VOICE_STALE_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/.test(APP));
check('定义了 voiceSnapshotIsStale()', /function\s+voiceSnapshotIsStale\(/.test(APP));
check('定义了 voiceAgoText() 输出“N 分钟/小时/天前”',
  /function\s+voiceAgoText\(/.test(APP) && /分钟前/.test(APP) && /天前/.test(APP));

const stageSegs = fnBody(APP, 'function voiceApplyStageToSegments(');
check('voiceApplyStageToSegments 会判断陈旧', /voiceSnapshotIsStale\(sv\)/.test(stageSegs));
check('陈旧时提前返回（不再走 asr_failed 等当前状态分支）',
  /if\s*\(\s*voiceSnapshotIsStale\(sv\)\s*\)\s*\{[\s\S]{0,700}?return;/.test(stageSegs));
check('陈旧时四段标注“历史”', /历史/.test(stageSegs));

const applySnap = fnBody(APP, 'function voiceApplySnapshot(');
check('voiceApplySnapshot 的总状态标签区分历史',
  /历史记录/.test(applySnap) || /voiceAgoText/.test(applySnap));

const renderLink = fnBody(APP, 'function renderVoiceLink(');
check('链路自检「最近一次录音」标注历史',
  /voiceSnapshotIsStale/.test(renderLink) && /历史/.test(renderLink));

check('index.html 的 app.js 版本号 >= 38', /app\.js\?v=(3[89]|[4-9]\d+)/.test(HTML),
  (HTML.match(/app\.js\?v=\d+/) || [''])[0]);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
