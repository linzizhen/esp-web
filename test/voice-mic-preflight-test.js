'use strict';
/** 语音第②步「麦克风前置自检」契约（静态检查 + 纯函数行为验证，不起服务、不碰硬件）
 *
 * 存在理由（2026-10-30 实测取证）：
 * 用户截图第②步报「浏览器拒绝了麦克风权限：…请在地址栏重新允许麦克风后点『重新识别这段录音』」。
 * 但按这句话去操作永远不会成功 —— 本机
 *   HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture 下 12 个录音端点
 *   状态全是 NOTPRESENT / UNPLUGGED，**没有任何一个 ACTIVE**；输出侧才有 ACTIVE。
 * 而 Windows 麦克风隐私策略是 Allow、浏览器没有企业策略、站点权限例外为空、
 * 访问地址是 127.0.0.1（安全上下文）—— 四条「权限类」成因全部排除。
 * data/voice/events.ndjson 也印证：recorded → asr_failed 只隔 87ms，根本没进拾音阶段。
 *
 * 结论：`not-allowed` 在这里的成因是「没有录音设备」而不是「权限被拒」。
 * 页面只有一句「去允许权限」，等于把人指向永远解决不了的方向 —— 这是可用性缺陷，
 * 不是硬件问题本身。本测试守住两件事：
 *   ① 识别前先自检录音设备，没有设备时给出**准确**原因（别再说「去地址栏允许」）；
 *   ② `not-allowed` 的兜底文案必须同时覆盖「权限被拒」与「本机没设备」两种成因。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

console.log('\n— 语音麦克风前置自检契约 —\n');

/* ---------- 1) 存在自检函数，且它真的读 enumerateDevices ---------- */
const verdictSrc = /function voiceMicVerdict\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/.exec(app);
check('app.js 定义了纯函数 voiceMicVerdict(devices)', !!verdictSrc,
  verdictSrc ? `参数 ${verdictSrc[1].trim()}` : '未找到 —— 无法在没有 Web Speech API 报错前判断设备缺失');

const probeSrc = /async function voiceProbeMic\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/.exec(app);
check('app.js 定义了 voiceProbeMic() 前置自检', !!probeSrc,
  probeSrc ? '存在' : '未找到 —— 识别前不会检查本机是否有录音设备');

const probeBody = probeSrc ? probeSrc[2] : '';
check('前置自检会枚举设备（mediaDevices + enumerateDevices）',
  /navigator\.mediaDevices/.test(probeBody) && /enumerateDevices\s*\(/.test(probeBody),
  /enumerateDevices\s*\(/.test(probeBody) ? '会枚举设备' : '没有枚举设备，无法发现「零麦克风」');

check('枚举失败时不阻断识别（不误伤能用的机器）',
  /catch\s*\(/.test(probeBody) && /ok:\s*true/.test(probeBody),
  /catch\s*\(/.test(probeBody) && /ok:\s*true/.test(probeBody)
    ? '旧浏览器 / 抛错时放行，交回 Web Speech API 自己报错'
    : '枚举失败就阻断会在本来能用的机器上误拦');

check('判定函数按 kind === "audioinput" 筛选录音设备',
  /kind\s*===\s*'audioinput'/.test(verdictSrc ? verdictSrc[2] : ''),
  'Chrome 在未授权时隐藏 label，但仍给出 kind，只能按 kind 判定');

/* ---------- 2) 行为验证：把纯函数抠出来直接跑 ---------- */
/* 不启浏览器也能验：函数体只用参数，不碰 window/navigator，故可原地求值。 */
let verdict = null;
try {
  verdict = new Function(`${verdictSrc[0]}; return voiceMicVerdict;`)();
} catch (e) {
  verdict = null;
}
check('voiceMicVerdict 可独立求值（只依赖入参，不碰全局）', typeof verdict === 'function',
  typeof verdict === 'function' ? '可单独跑' : '求值失败，说明函数体依赖了浏览器全局，无法静态验证');

if (typeof verdict === 'function') {
  /* 2a) 零录音设备 —— 就是本机 2026-10-30 的真实情形 */
  const none = verdict([
    { kind: 'audiooutput', label: '扬声器 (3- Senary Audio)' },
    { kind: 'videoinput', label: 'USB 摄像头' },
  ]);
  check('只有输出设备时判为不可识别', none && none.ok === false,
    none && none.ok === false ? `error=${none.error}` : '把「没有麦克风」误判为可用');

  check('零设备的原因里点名「没有可用录音设备」',
    !!(none && /没有可用(的)?(录音设备|麦克风)/.test(none.reason || '')),
    none && none.reason ? none.reason.slice(0, 40) + '…' : '无 reason');

  check('零设备的原因里给出「插麦克风」或「文字输入」的可执行下一步',
    !!(none && /(插上|接上|插入)[^。]{0,20}(麦克风|耳麦)/.test(none.reason || '')
      && /文字(输入|入口)/.test(none.reason || '')),
    '必须给出用户真的能做到的动作，而不是「去允许权限」');

  check('零设备的 error 是可判别的枚举值（不是自由文本）',
    !!(none && typeof none.error === 'string' && /^[a-z_]+$/.test(none.error)),
    none ? String(none.error) : '');

  /* 2b) 有录音设备 —— 但未授权时 label 为空，仍必须判为可用 */
  const hasUnlabeled = verdict([{ kind: 'audioinput', label: '' }]);
  check('有录音设备但 label 为空时判为可用（未授权场景）',
    hasUnlabeled && hasUnlabeled.ok === true,
    hasUnlabeled && hasUnlabeled.ok === true ? '不误伤未授权但插了麦克风的机器' : JSON.stringify(hasUnlabeled));

  /* 2c) 入参异常不得抛 */
  let threw = false;
  try { verdict(null); verdict(undefined); verdict([]); } catch (_) { threw = true; }
  check('入参为 null/undefined/空数组时不抛异常', !threw, threw ? '抛了异常' : '安全返回');
}

/* ---------- 3) 识别前真的接上了自检，而不是定义了没人用 ---------- */
const chainSrc = /async function voiceStartChain\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(app);
const chainBody = chainSrc ? chainSrc[1] : '';
const probeCallIdx = chainBody.search(/await\s+voiceProbeMic\s*\(/);
const asrIdx = chainBody.search(/voiceStartAsr\s*\(/);
check('voiceStartChain 调用了前置自检', probeCallIdx >= 0,
  probeCallIdx >= 0 ? '已接入' : '定义了但没调用，等于没做');
check('自检发生在启动识别之前', probeCallIdx >= 0 && asrIdx > probeCallIdx,
  probeCallIdx >= 0 && asrIdx > probeCallIdx
    ? `自检@${probeCallIdx} < 识别@${asrIdx}`
    : '顺序不对：先启动识别再自检就没意义了');

/* ---------- 4) 无设备分支必须落到 asr_failed 且带原因 ---------- */
const micBlock = /\n\s*if\s*\(\s*!\s*mic\s*\.\s*ok\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(chainBody);
check('存在「无录音设备」分支（if (!mic.ok)）', !!micBlock,
  micBlock ? '已分支处理' : '自检结果没被使用，等于没做');
check('无设备分支上报服务端 stage: asr_failed',
  !!(micBlock && /stage:\s*'asr_failed'/.test(micBlock[1])),
  micBlock && /stage:\s*'asr_failed'/.test(micBlock[1])
    ? '不落库就查不到「这台机器没麦克风」这件事'
    : '没上报，服务端看不到这类失败');
check('无设备分支把准确原因写进上报（reason）',
  !!(micBlock && /reason/.test(micBlock[1])),
  micBlock && /reason/.test(micBlock[1]) ? '原因可追溯' : '只报了失败没报原因');
check('无设备分支在播放之前返回（不做无意义的外放）',
  !!(micBlock && /return\s*;/.test(micBlock[1])),
  micBlock && /return\s*;/.test(micBlock[1]) ? '提前返回' : '会继续往下走，白放一遍录音');

/* ---------- 5) not-allowed 兜底文案必须覆盖两种成因 ---------- */
const naMatch = /'not-allowed'\s*:\s*'([^']+)'/.exec(app);
const naText = naMatch ? naMatch[1] : '';
check('not-allowed 文案提到「没有可用录音设备/麦克风」这一成因',
  /没有可用(的)?(录音设备|麦克风)|没接(麦克风|录音设备)|未接入/.test(naText),
  naText ? naText.slice(0, 50) + '…' : '未找到 not-allowed 文案');
check('not-allowed 文案同时保留「允许权限」这条路径',
  /允许/.test(naText) && /权限/.test(naText),
  /允许/.test(naText) ? '两种成因都覆盖' : '把权限被拒的可能抹掉了，同样不准确');
check('not-allowed 文案给出文字输入兜底',
  /文字(输入|入口)/.test(naText),
  /文字(输入|入口)/.test(naText) ? '有兜底指引' : '缺兜底指引');

/* ---------- 6) 失败横幅的「处理建议」同样不能只写权限 ---------- */
const bannerSrc = /asr_failed:\s*\{\s*title:[^}]*desc:\s*\(reason\)\s*=>\s*`([\s\S]*?)`/.exec(app);
const bannerText = bannerSrc ? bannerSrc[1] : '';
check('识别失败横幅的处理建议提到「先确认接了麦克风」',
  /(接了?|插上|接上)[^。]{0,20}麦克风|没有录音设备/.test(bannerText),
  bannerText ? bannerText.slice(0, 46) + '…' : '未找到 asr_failed 横幅文案');
check('识别失败横幅的处理建议保留站点权限这条路径',
  /站点设置|允许麦克风/.test(bannerText),
  /站点设置|允许麦克风/.test(bannerText) ? '两种成因都覆盖' : '只写了权限，遇到「没设备」仍会误导');
check('识别失败横幅的处理建议保留文字入口兜底',
  /文字入口|文字输入/.test(bannerText),
  /文字入口|文字输入/.test(bannerText) ? '有兜底' : '缺兜底');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);