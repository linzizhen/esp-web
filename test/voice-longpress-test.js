'use strict';
/** 第 5 周：语音键「长按 2 秒」契约（静态检查，无需硬件）
 *
 * 需求（用户 2026-11-02 提出）：
 *   长按 play 键 2 秒 → 开始录音；录音中再按一次 → 立即结束并上传。
 *
 * 回归的是两类问题：
 *   ① 原来的实现是「按下瞬间就 toggle」——手一抖就开始录音，误触成本高；
 *   ② 长按判定如果写成「按下瞬间看按了多久」，人根本按不出来（那一刻是 0 ms），
 *      必须在按住期间持续计时，到阈值再触发。
 *
 * 还有一条容易漏的：录音进行中按键必须**立即**结束，不能再等 2 秒。
 */
const fs = require('node:fs');
const path = require('node:path');

const MAIN_DIR = path.join(__dirname, '..', 'firmware', 's3eye_imu_idf', 'main');
const read = (f) => fs.readFileSync(path.join(MAIN_DIR, f), 'utf8');
const cSrc = read('voice_record.c');
const hSrc = read('voice_record.h');
const mSrc = read('main.c');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};
const grab = (src, re) => { const m = src.match(re); return m ? m[1] : null; };

/** 取出一个函数的函数体（按花括号配平，够用且不依赖正则贪婪） */
function fnBody(src, needle) {
  const i = src.indexOf(needle);
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return null;
}

console.log('\n' + '='.repeat(64));
console.log('  第 5 周 语音键长按契约（静态）');
console.log('  目标：firmware/s3eye_imu_idf/main/{voice_record.c,voice_record.h,main.c}');
console.log('='.repeat(64));

console.log('\n— ① 长按阈值必须是可引用的常量，且为 2000ms —');
const thr = grab(hSrc, /#define\s+VOICE_LONGPRESS_MS\s+(\d+)/);
ok(thr === '2000', 'VOICE_LONGPRESS_MS == 2000（在 voice_record.h 里）', thr === null ? '未定义' : thr);

console.log('\n— ② 对外接口：开始 / 结束 / 查询 三件套 —');
for (const sig of ['voice_record_start', 'voice_record_stop', 'voice_record_is_recording']) {
  ok(new RegExp(`bool\\s+${sig}\\s*\\(\\s*void\\s*\\)`).test(hSrc), `voice_record.h 声明 ${sig}()`);
  ok(new RegExp(`bool\\s+${sig}\\s*\\(\\s*void\\s*\\)`).test(cSrc), `voice_record.c 定义 ${sig}()`);
}

console.log('\n— ③ 按键任务不能再「按下就 toggle」 —');
const vbtn = fnBody(cSrc, 'static void voice_btn_task');
ok(!!vbtn, '找到 voice_btn_task');
if (vbtn) {
  ok(!/voice_record_toggle\s*\(/.test(vbtn),
    '★ voice_btn_task 内不得直接调 voice_record_toggle()（那会在按下瞬间就开始录音）');
  ok(/esp_timer_get_time\s*\(\s*\)/.test(vbtn), '用 esp_timer_get_time() 记录按下时刻');
  ok(/VOICE_LONGPRESS_MS/.test(vbtn), '按住期间与 VOICE_LONGPRESS_MS 比较');
  ok(/voice_record_start\s*\(/.test(vbtn), '到达阈值后调 voice_record_start()');
  ok(/voice_record_is_recording\s*\(/.test(vbtn), '按下时先查是否正在录音');
}

console.log('\n— ④ 录音中按下必须立即结束（不能再等 2 秒） —');
if (vbtn) {
  const recIdx = vbtn.indexOf('voice_record_is_recording');
  const stopIdx = vbtn.indexOf('voice_record_stop');
  ok(recIdx > 0 && stopIdx > recIdx, '先判断 is_recording，再调 voice_record_stop()');
  const longIdx = vbtn.indexOf('VOICE_LONGPRESS_MS');
  ok(recIdx < longIdx, '结束分支排在长按计时之前（录音中按键不等 2 秒）');
}

console.log('\n— ⑤ 短按不录音，且要给出可诊断的日志 —');
ok(/短按/.test(cSrc) && /不录音/.test(cSrc), '存在「短按…不录音」的提示日志');

console.log('\n— ⑥ ADC 那几个键（K0–K2）也要支持长按录音 —');
const btn = fnBody(mSrc, 'static void btn_task');
ok(!!btn, '找到 btn_task');
if (btn) {
  ok(/voice_record_is_recording\s*\(/.test(btn), 'btn_task 里查录音状态（录音中按键即结束）');
  ok(/voice_record_stop\s*\(/.test(btn), 'btn_task 里调 voice_record_stop()');
  ok(/voice_record_start\s*\(/.test(btn), 'btn_task 里调 voice_record_start()（长按到达阈值）');
  ok(/VOICE_LONGPRESS_MS/.test(btn), 'btn_task 用同一个阈值常量，避免两个 2000 各写一遍');
  ok(/s_key_adc\[idx\]\s*==\s*HELP_KEY_ADC/.test(btn) || /pressed_idx/.test(btn),
    '求助键仍走求助分支，不被录音抢走');
}

console.log('\n— ⑦ 远程命令 / 网页按钮的语义保持不变 —');
ok(/bool\s+voice_record_toggle\s*\(\s*void\s*\)/.test(cSrc), 'voice_record_toggle() 仍然存在（远程与网页点一次即切换）');
ok(/voice_record_toggle\s*\(/.test(mSrc), 'main.c 的远程命令分支仍调 toggle');

console.log('\n— ⑧ 固件里必须写清这套语义，避免下次又被改回去 —');
ok(/长按/.test(cSrc), 'voice_record.c 注释记录了「长按」语义');
ok(/2\s*秒|2000/.test(cSrc), '注释写明了 2 秒阈值');

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`  结果：${pass} 项通过，0 项失败`);
} else {
  console.log(`  ✗ ${fail} 项失败 / ${pass} 项通过`);
}
console.log('='.repeat(64));
console.log('\n  注：静态契约只防「改回去」，真机手感请烧录后实测');
process.exit(fail === 0 ? 0 : 1);