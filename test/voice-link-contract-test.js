'use strict';
/** 语音链路自检面板的静态契约测试（纯静态，不起服务、不碰硬件）
 *
 * 存在理由（2026-11-12 真实反馈）：
 *   用户按了板子上的键，页面什么都不动，根本无法判断「是没录上、还是录了没传上来」。
 *   实测发现最常见的真实原因是：板端录完音要靠 WiFi 把 WAV 传到本机服务端，
 *   而板端 WiFi 没连上时 —— 服务端 upload_ok=0 / upload_fail=0，页面完全没有信号。
 *   所以页面必须主动把「板端在不在线 / 上传通道正不正常 / 板端 WiFi 有没有连上 /
 *   最近一次录音是什么时候」直接显示出来，而不是等人去猜。
 *
 * 这个测试锁住四件事：
 *   ① index.html 里确实有这四个展示位（少一个，页面就少一条线索）；
 *   ② app.js 的 els 映射确实把这些 id 接上了（只写 HTML 不接 JS 等于没有）；
 *   ③ app.js 有 renderVoiceLink()，且它真的读了这几个 els 并在渲染路径里被调用；
 *   ④ 缓存版本号跟着升（否则用户刷新拿到的还是旧 JS，看不到新面板）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

console.log('\n— 语音链路自检面板契约 —\n');

/* ---------- 1) HTML 展示位 ---------- */
const ids = ['voiceLinkTag', 'voiceLinkBoard', 'voiceLinkUpload', 'voiceLinkWifi', 'voiceLinkLast'];
for (const id of ids) {
  check(`index.html 有展示位 #${id}`, new RegExp(`id="${id}"`).test(html));
}

/* ---------- 2) els 映射 ---------- */
for (const id of ids) {
  check(`app.js 把 #${id} 接进 els`, new RegExp(`${id}:\\s*\\$\\(\\s*'${id}'\\s*\\)`).test(app));
}

/* ---------- 3) 渲染函数存在且真的读了这些 els ---------- */
const fnMatch = /function renderVoiceLink\s*\(/.exec(app);
check('app.js 定义了 renderVoiceLink()', !!fnMatch);

// 取函数体（按花括号配平），避免只看函数名不看实现
let body = '';
if (fnMatch) {
  const start = app.indexOf('{', fnMatch.index);
  let depth = 0, end = start;
  for (let i = start; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  body = app.slice(start, end + 1);
}
const readIds = ['voiceLinkTag', 'voiceLinkBoard', 'voiceLinkUpload', 'voiceLinkWifi', 'voiceLinkLast'];
for (const id of readIds) {
  check(`renderVoiceLink() 读取 els.${id}`, body.includes('els.' + id));
}

/* ---------- 4) 数据来源：S.link 采集 upload_ok / upload_fail / rssi ---------- */
check('S 里有 link 状态位', /link:\s*\{/.test(app));
check('captureLink() 采集 upload_ok / upload_fail / rssi 并写回 S.link',
  /'upload_ok',\s*'upload_fail',\s*'rssi'/.test(app) && /S\.link\[k\]\s*=/.test(app),
  '需在 captureLink 里按这三个键写入 S.link');
check('采样帧与 hello 快照都会调用 captureLink()',
  (app.match(/captureLink\(/g) || []).length >= 3,
  `实际出现 ${(app.match(/captureLink\(/g) || []).length} 次（定义 1 次 + 调用 2 处）`);

/* ---------- 5) 渲染被调用（否则函数写了也没人跑） ---------- */
check('renderVoiceLink() 在渲染路径里被调用',
  /renderStatus\s*\([^)]*\)\s*\{[\s\S]{0,4000}?renderVoiceLink\s*\(/.test(app)
  || /voiceApplySnapshot\s*\([^)]*\)\s*\{[\s\S]{0,4000}?renderVoiceLink\s*\(/.test(app),
  '需在 renderStatus 或 voiceApplySnapshot 内调用');

/* ---------- 6) 文案必须点明「上传走 WiFi」这一真实成因 ---------- */
check('面板文案点明录音上传依赖 WiFi', /WiFi/.test(html) && /上传/.test(html));

/* ---------- 7) 缓存版本号 ---------- */
const jsV = /app\.js\?v=(\d+)/.exec(html);
check('index.html 的 app.js 版本号已升级到 >= 37', !!jsV && Number(jsV[1]) >= 37,
  jsV ? `app.js?v=${jsV[1]}` : '缺少 ?v= 版本号');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
