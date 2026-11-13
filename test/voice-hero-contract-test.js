/* 语音页「现在在做什么」决策卡 —— 静态契约测试（无硬件、无浏览器）
 *
 * 为什么要这组断言（2026-11-12 用户原话）：
 *   「当我长按 paly 按键后，指示灯会灭掉，然后不再亮起。你重新修改这个语音的网页部分。
 *     要容易让人能看懂。是否录音。录音采集到的文字。」
 * 也就是两个诉求：①「是否在录音」必须一眼可见；②「识别出的文字」必须一眼可读。
 * 硬件侧靠 rec/up 两个上报字段 + 指示灯四种图案；网页侧靠顶部决策卡与大字文字卡。
 * 这里把两端的接线钉死，避免以后有人删了其中一个而页面又变成「只能猜」。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('public/index.html');
const APP = read('public/app.js');
const CSS = read('public/style.css');
const MAIN_C = read('firmware/s3eye_imu_idf/main/main.c');
const VR_C = read('firmware/s3eye_imu_idf/main/voice_record.c');
const VR_H = read('firmware/s3eye_imu_idf/main/voice_record.h');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? ' -> ' + extra : '')); }
}
/** 取函数体：从 "function 名字(" 起按花括号配平 */
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const s = src.indexOf('{', i);
  if (s < 0) return '';
  let depth = 0;
  for (let k = s; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(s, k + 1); }
  }
  return '';
}

console.log('语音页决策卡／文字卡契约');

// ① 页面结构
for (const id of ['vxTag', 'vxState', 'vxHint', 'vxTimer', 'vxDot', 'vxSteps', 'vxText', 'vxTextMeta', 'vxCopy']) {
  ok(new RegExp('id="' + id + '"').test(HTML), `index.html 有 #${id}`);
}
ok(/data-step="record"/.test(HTML) && /data-step="upload"/.test(HTML)
  && /data-step="asr"/.test(HTML) && /data-step="text"/.test(HTML), '四步进度条四个节点齐全');
ok(/识别出的文字/.test(HTML), '页面有「识别出的文字」标题（用户原话要求）');
ok(/aria-live="polite"/.test(HTML), '状态区带 aria-live，读屏与视线之外也能感知变化');
ok(/app\.js\?v=(\d+)/.test(HTML) && Number(HTML.match(/app\.js\?v=(\d+)/)[1]) >= 40, 'app.js 版本号 >= 40');

// ② 前端接线
for (const id of ['vxTag', 'vxState', 'vxHint', 'vxTimer', 'vxDot', 'vxSteps', 'vxText', 'vxTextMeta', 'vxCopy']) {
  ok(new RegExp(id + ": \\$\\('" + id + "'\\)").test(APP), `app.js els 映射了 ${id}`);
}
ok(/function renderVoiceHero\(/.test(APP), '存在 renderVoiceHero()');
ok(/function voiceHeroStartTimer\(/.test(APP), '存在录音计时器启动函数');
const hero = fnBody(APP, 'renderVoiceHero');
ok(!!hero && /els\.vxState\.textContent/.test(hero), 'renderVoiceHero 会写 vxState 文案');
ok(!!hero && /els\.vxText\.textContent/.test(hero), 'renderVoiceHero 会写 vxText 大字文字');
ok(!!hero && /S\.link\.rec === 1/.test(hero), 'renderVoiceHero 用板端实时字段 rec 判断「正在录音」');
ok(!!hero && /S\.link\.up === 1/.test(hero), 'renderVoiceHero 用板端实时字段 up 判断「正在回传」');
ok(/for \(const k of \['upload_ok', 'upload_fail', 'upload_skip', 'rssi', 'rec', 'up'\]\)/.test(APP),
  'captureLink 采集 rec/up 两个实时字段');
const snap = fnBody(APP, 'voiceApplySnapshot');
ok(/renderVoiceHero\(\)/.test(snap), 'voiceApplySnapshot 会刷新决策卡');
ok(/renderVoiceHero\(\)/.test(APP.slice(APP.indexOf('function renderStatus'), APP.indexOf('function renderStatus') + 4000)),
  'renderStatus 会刷新决策卡（离线时要提示插 USB）');
ok(/els\.vxCopy\.onclick/.test(APP), '复制文字按钮绑定了点击事件');

// ③ 样式：语义色 + 动效降级
for (const cls of ['.vx-dot.is-rec', '.vx-dot.is-busy', '.vx-dot.is-ok', '.vx-state', '.vx-timer', '.vx-step.is-run', '.vx-step.is-done', '.vx-text']) {
  ok(CSS.includes(cls), `style.css 定义了 ${cls}`);
}
ok(/prefers-reduced-motion/.test(CSS), '尊重「减少动效」系统设置');

// ④ 固件：把「在不在录音」如实上报
ok(/\\"rec\\":%d,\\"up\\":%d/.test(MAIN_C), 'main.c 上报帧带 rec/up 字段');
ok(/voice_record_is_recording\(\) \? 1 : 0/.test(MAIN_C) && /voice_record_is_uploading\(\) \? 1 : 0/.test(MAIN_C),
  'rec/up 取值来自真实的录音/回传状态');
ok(/bool voice_record_is_uploading\(void\);/.test(VR_H), 'voice_record.h 声明了 voice_record_is_uploading');
ok(/bool voice_record_is_uploading\(void\) \{ return s_uploading; \}/.test(VR_C),
  'voice_record.c 实现返回 s_uploading');

// ⑤ 指示灯：不能再出现「空闲全黑」
ok(/now % 2000\) < 120/.test(MAIN_C), '空闲态有心跳脉冲（120ms / 2s），灯不会长时间全黑');
ok(/led_state_name\(vled\)/.test(MAIN_C), '指示灯状态变化会写串口日志（现场可核对）');
for (const s of ['录音中（常亮）', '回传中（快闪 120ms）', '成功（慢闪 400ms）', '失败（急闪 60ms）', '空闲（心跳 120ms/2s）']) {
  ok(MAIN_C.includes(s), `指示灯日志含「${s}」`);
}

// ⑥ 语音事件文案：事件流水（只有 ev、没有 stage）也必须查到中文，
//    否则整片显示成「未知事件」——用户会以为又出新故障
for (const k of ['transcribed_local', 'local_asr_empty', 'local_asr_error', 'received_via_serial', 'serial_rx_error']) {
  ok(APP.includes(k + ":"), `事件文案表含 ${k}`);
}
ok(/e\.stage \|\| e\.status \|\| e\.ev/.test(APP), '事件行取键时回落到 ev 字段');
ok(/\/app\.js\?v=(4[1-9]|[5-9]\d)/.test(HTML), 'app.js 版本号已推进（>=41）');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
