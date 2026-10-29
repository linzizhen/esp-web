'use strict';
/** 第 5 周：按键说话 / 语音链路 集成测试 + 静态契约
 *
 * 存在理由（为什么必须自动化）：
 *   语音链路的失败分支几乎全是「静默失败」：上传非 WAV 时若不校验，服务端会把
 *   垃圾字节当录音存下来；超过 1 MB 若不设上限，板端一次长按录音就能把内存吃满；
 *   阶段枚举若不校验，一个错拼的 stage 会让前端四段状态永远停在「等待」。
 *   这些都不会抛异常，只能靠测试断言拦住。
 *
 * 覆盖：
 *   ⓪ 静态契约：页面 data-page="voice" / 关键元素 id / app.js 引用 / zh-CN / 版本号
 *   ① 合法 WAV 上传 → 200 + 落盘（含最小 44 字节头）
 *   ② 非 WAV → 400 且不落盘
 *   ③ 超大 payload（>1 MB）→ 400 且不落盘
 *   ④ GET 回放 → 200 + audio/wav（含 Range 206）；download → attachment
 *   ⑤ 不存在的 id → 404；非法 id → 400（兼防路径穿越）
 *   ⑥ POST state 各分支（transcribed / asr_failed / silent / timeout）可读回；
 *      非法 stage → 400；失败原因不跨阶段继承
 *   ⑦ 事件落盘 data/voice/events.ndjson，且重启实例后历史仍可读回
 *   ⑧ WS 广播 {type:"voice"} 与 hello 里的语音快照（刷新不丢链路）
 *
 * 隔离纪律（test/isolation-contract-test.js 强制）：
 *   · 独立端口 8090（8091 已被 handleline-guard 占用，8092-8099 亦被占用，
 *     见 run-all.js 的端口注释）
 *   · 独立 DATA_DIR＝test/.test-data-voice（被 .gitignore 的 test/.test-data* 覆盖）
 *   · 用 test/.test-config.json（autoDetect=false），绝不打开真实板子串口
 *
 * 无法自动化、必须人工实测的部分（本测试**不**覆盖，交给人工验收）：
 *   · 真实板端按键录音：按住 ESP32-S3-EYE 按键 → I2S 板载 MEMS 麦克风采集 →
 *     固件生成 WAV → POST /api/voice/audio。串口/麦克风/按键都在物理世界，
 *     自动化只能注入合成 WAV（本测试正是这么做的），证不了真实录音质量。
 *   · 浏览器 Web Speech API 识别：需要真人说话 + 麦克风权限 + Chrome/Edge
 *     的云端识别服务，且链路是「扬声器外放录音 → 浏览器麦克风听到」，
 *     必须在有扬声器与麦克风的真实桌面上人工确认。
 *   · speechSynthesis 播报：同上，必须有人耳确认「听到了回复」。
 *   · 无声判定的人工对照：本测试只用全零 PCM 断言 silent_hint=true，
 *     真实环境「说话太轻 / 环境太吵」的阈值仍需人工听感校验。
 *
 * 用法：node test/voice-test.js
 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');

const PORT = Number(process.env.VOICE_PORT || 8090);
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, '.test-data-voice');
const VOICE_DIR = path.join(DATA_DIR, 'voice');
const EVENTS_FILE = path.join(VOICE_DIR, 'events.ndjson');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 通用 HTTP：用 http.request 才能可靠发送二进制 body ---------- */
function httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        buf: Buffer.concat(chunks),
      }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const base = (p) => ({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' });
const jget = async (p) => JSON.parse((await httpReq(base(p))).buf.toString('utf8'));
const jpost = async (p, o) => {
  const s = JSON.stringify(o);
  const r = await httpReq(Object.assign(base(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) },
  }), s);
  return { status: r.status, json: JSON.parse(r.buf.toString('utf8') || '{}') };
};
const uploadWav = async (buf, extraHeaders) => {
  const r = await httpReq(Object.assign(base('/api/voice/audio'), {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'audio/wav',
      'Content-Length': buf.length,
      'device': 'QA-VOICE-TEST',
    }, extraHeaders || {}),
  }), buf);
  return { status: r.status, json: JSON.parse(r.buf.toString('utf8') || '{}') };
};

/* ---------- 构造 WAV：44 字节头 + 可选 PCM（16 kHz / 16 bit / 单声道） ---------- */
function makeWav(dataBytes = 0, amplitude = 0) {
  const n = Math.max(0, dataBytes | 0);
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);      // fmt 块长度
  b.writeUInt16LE(1, 20);       // PCM
  b.writeUInt16LE(1, 22);       // 单声道
  b.writeUInt32LE(16000, 24);   // 采样率
  b.writeUInt32LE(16000 * 2, 28); // 字节率
  b.writeUInt16LE(2, 32);       // 块对齐
  b.writeUInt16LE(16, 34);      // 位深
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(n, 40);
  // 填充采样：amplitude=0 为数字静音（silent_hint 应为 true）
  for (let i = 0; i + 1 < n; i += 2) b.writeInt16LE(amplitude, 44 + i);
  return b;
}

/* 分段合成 WAV：segments = [{ seconds, amplitude }]，按顺序拼 PCM。
 * 存在理由（2026-10-28 t8）：服务端曾只读文件前 64 KB 做电平统计，
 * 6 秒录音约 190 KB 就只看了前 ~2 秒 —— 用「前段静音 + 后段有信号」这种
 * 形状才能把该缺陷照出来（整段等幅度的 WAV 无论只读前段还是读全量，
 * RMS 都一样，永远测不出来）。
 * 幅度用常数（DC）而不是正弦，是为了理论值可精确手算：
 *   peak = amp；RMS = amp × sqrt(有信号样本占比)。 */
function makeWavSegments(segments) {
  const perSec = 16000;
  const counts = segments.map((s) => Math.round(s.seconds * perSec));
  const samples = counts.reduce((a, b) => a + b, 0);
  const dataBytes = samples * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(perSec, 24);
  b.writeUInt32LE(perSec * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(dataBytes, 40);
  let off = 44;
  segments.forEach((seg, i) => {
    for (let k = 0; k < counts[i]; k++) { b.writeInt16LE(seg.amplitude, off); off += 2; }
  });
  return b;
}

/* 与 makeWavSegments 配套的「标准答案」：按全量 PCM 手算峰值 / RMS（dBFS）。
 * 断言服务端自报值时用它做独立参照，而不是拿服务端自己的算法自证。 */
function expectedLevel(segments) {
  const perSec = 16000;
  let sum = 0, n = 0, peak = 0;
  for (const seg of segments) {
    const cnt = Math.round(seg.seconds * perSec);
    for (let k = 0; k < cnt; k++) {
      const v = seg.amplitude;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      sum += v * v;
      n++;
    }
  }
  const rms = Math.sqrt(sum / n);
  const db = (x) => (x <= 0 ? -Infinity : Math.round(20 * Math.log10(x / 32768) * 10) / 10);
  return { peak, rms, peakDb: db(peak), rmsDb: db(rms), samples: n };
}

/* 把 data 块挪到非 44 偏移：在 fmt 与 data 之间插一个 2 字节的 'LIST' 块，
 * 使 data 从 46 开始。用来验证服务端是否按块遍历、而不是硬编码偏移 44。 */
function shiftDataBlock(buf) {
  const dataBody = buf.subarray(44);
  const extra = Buffer.alloc(10);              // 8 字节块头 + 2 字节内容（偶数对齐）
  extra.write('LIST', 0, 'latin1');
  extra.writeUInt32LE(2, 4);
  extra.writeUInt16LE(0, 8);
  const out = Buffer.concat([buf.subarray(0, 36), extra, Buffer.from('data', 'latin1')]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(dataBody.length, 0);
  const head = Buffer.concat([out, size]);
  const full = Buffer.concat([head, dataBody]);
  full.writeUInt32LE(full.length - 8, 4);      // 重算 RIFF 长度
  return full;
}

/* 把 fmt 块撑大，使 data 块的起点超过 64 KB（服务端回读只读前 64 KB 做头解析）。
 * 存在理由（2026-10-28 t8 复查）：回读路径只读文件前 64 KB 去遍历块，
 * 一旦 data 起点在这之外，就找不到 data 块、兜底成「偏移 44 + 全文件剩余」，
 * 于是把 fmt 块的内容当成 PCM 读 —— 电平值会算错，但不会报错，属静默错误。
 * 现实中固件不会写 64 KB 的 fmt 块，但「按块遍历」的健壮性正是这条用例守的。 */
function makeWavWideFmt(extraFmtBytes, segments) {
  const fmtBody = Buffer.alloc(16 + extraFmtBytes);
  fmtBody.writeUInt16LE(1, 0);                 // PCM
  fmtBody.writeUInt16LE(1, 2);                 // 单声道
  fmtBody.writeUInt32LE(16000, 4);
  fmtBody.writeUInt32LE(16000 * 2, 8);
  fmtBody.writeUInt16LE(2, 12);
  fmtBody.writeUInt16LE(16, 14);
  const parts = [];
  const h = Buffer.alloc(12);
  h.write('RIFF', 0, 'latin1');
  h.write('WAVE', 8, 'latin1');
  parts.push(h);
  const fh = Buffer.alloc(8);
  fh.write('fmt ', 0, 'latin1');
  fh.writeUInt32LE(fmtBody.length, 4);
  parts.push(fh, fmtBody);
  if (fmtBody.length % 2) parts.push(Buffer.alloc(1));
  const perSec = 16000;
  const counts = segments.map((s) => Math.round(s.seconds * perSec));
  const samples = counts.reduce((a, b) => a + b, 0);
  const dataBytes = samples * 2;
  const dh = Buffer.alloc(8);
  dh.write('data', 0, 'latin1');
  dh.writeUInt32LE(dataBytes, 4);
  parts.push(dh);
  const pcm = Buffer.alloc(dataBytes);
  let off = 0;
  segments.forEach((seg, i) => {
    for (let k = 0; k < counts[i]; k++) { pcm.writeInt16LE(seg.amplitude, off); off += 2; }
  });
  parts.push(pcm);
  const all = Buffer.concat(parts);
  all.writeUInt32LE(all.length - 8, 4);
  return all;
}

const listWavs = () => {
  try { return fs.readdirSync(VOICE_DIR).filter((n) => n.endsWith('.wav')); } catch (_) { return []; }
};
const readEvents = () => {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  return fs.readFileSync(EVENTS_FILE, 'utf8').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
};

/* ---------- 启动 / 等待 / 停止隔离实例 ---------- */
function startServer() {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1',
      CONFIG_PATH: path.join(__dirname, '.test-config.json'),
      DATA_DIR,
      NL_CONFIG_PATH: path.join(__dirname, '.test-nl-local-absent.json'),
      NL_ENDPOINT: '', NL_API_KEY: '',
    }),
    stdio: 'ignore',
  });
}

/** 轮询就绪，不用固定 sleep：机器慢时固定 1.3s 会造成「连接被拒」类假失败 */
async function waitReady(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await httpReq(base('/api/state'));
      if (r.status === 200) return true;
    } catch (_) { /* 还没起来，继续等 */ }
    await sleep(100);
  }
  return false;
}

async function stopServer(srv) {
  if (!srv || srv.killed) return;
  srv.kill('SIGKILL');
  await sleep(400);
}

/* ---------- ⓪ 静态契约（纯文件检查，最快的失败点） ---------- */
function staticContract() {
  console.log('\n— ⓪ 静态契约（页面 / 前端 / 服务端三方对齐）—');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  ok(/data-page="voice"/.test(html), 'index.html 含语音页 data-page="voice"');
  ok(/id="voiceSegments"/.test(html), 'index.html 含四段状态容器 voiceSegments');

  // 页面上的语音元素 id 必须被 app.js 引用（否则元素存在但无人渲染）
  const htmlIds = [...html.matchAll(/id="(voice[A-Za-z0-9]+|btnVoice[A-Za-z0-9]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(htmlIds)];
  const notRef = uniq.filter((id) => !new RegExp(`\\$\\(['"]${id}['"]\\)`).test(app));
  ok(uniq.length >= 20 && notRef.length === 0,
    `页面 ${uniq.length} 个语音 id 全部被 app.js 引用`,
    notRef.length ? '未被引用：' + notRef.join(', ') : '无死元素');

  ok(/rec\.lang\s*=\s*'zh-CN'/.test(app), '识别语言 rec.lang = zh-CN（硬性要求）');
  ok(/u\.lang\s*=\s*'zh-CN'/.test(app), '播报语言 utterance.lang = zh-CN');

  const jsV = /app\.js\?v=(\d+)/.exec(html);
  ok(!!jsV && Number(jsV[1]) >= 32, 'index.html 的 app.js 版本号已升到 32 以上',
    jsV ? `app.js?v=${jsV[1]}` : '缺少版本号');
  ok(/style\.css\?v=\d+/.test(html), 'index.html 保留 style.css 版本号');

  // 服务端 8 个阶段枚举必须与前端历史事件中文映射一一对应
  const srvStages = (() => {
    const m = /const VOICE_STAGES\s*=\s*\[([^\]]*)\]/.exec(server);
    return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
  })();
  const appEventMap = /const VOICE_EVENT_TEXT\s*=\s*\{([\s\S]*?)\n\};/.exec(app);
  const appKeys = appEventMap ? [...appEventMap[1].matchAll(/^\s{2}([a-z_]+)\s*:/gm)].map((x) => x[1]) : [];
  ok(srvStages.length === 8, 'server.js 阶段枚举 8 项', srvStages.join(','));
  const missingEvt = srvStages.filter((s) => !appKeys.includes(s));
  ok(srvStages.length > 0 && missingEvt.length === 0,
    '前端历史事件映射覆盖服务端全部阶段',
    missingEvt.length ? '缺失：' + missingEvt.join(', ') : `前端映射 ${appKeys.length} 项全覆盖`);

  // 音频来源与运行位置必须由服务端如实给出（前端不编造）
  ok(/audio_source:\s*'board_mic_i2s'/.test(server) && /asr_runs_on:\s*'browser_web_speech'/.test(server)
    && /tts_runs_on:\s*'browser_speech_synthesis'/.test(server),
    '服务端声明音频来源=板端 / 识别与播报=浏览器');
}

/* ---------- 主流程 ---------- */
(async () => {
  staticContract();

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let srv = startServer();
  const ready = await waitReady();
  ok(ready, `隔离实例已就绪（端口 ${PORT}，DATA_DIR=${path.relative(ROOT, DATA_DIR)}）`);

  try {
    console.log('\n— ① 上传合法 WAV → 200 且落盘 —');
    const before = listWavs().length;
    const min = makeWav(0);                  // 最小 44 字节 WAV 头
    const up = await uploadWav(min, { 'duration_ms': '1500' });
    ok(up.status === 200 && up.json.ok === true, '最小 44 字节 WAV 上传返回 200', `bytes=${min.length}`);
    const aid = up.json.audio_id;
    ok(/^voice-\d{8}-\d{6}-\d{3}(-[0-9a-f]{4})?$/.test(String(aid)), 'audio_id 格式合法', String(aid));
    ok(up.json.riff === 'RIFF' && up.json.wave === 'WAVE', '服务端回读前 4 字节 RIFF / 8-11 字节 WAVE');
    ok(up.json.bytes === min.length, `落盘字节数一致（${up.json.bytes}）`);
    ok(up.json.duration_ms === 1500, 'duration_ms 采用固件自报值', String(up.json.duration_ms));
    ok(fs.existsSync(path.join(VOICE_DIR, aid + '.wav')), 'data/voice/<audio_id>.wav 已存在');
    ok(listWavs().length === before + 1, `wav 文件数 +1（${before} → ${listWavs().length}）`);
    ok(up.json.event_persisted === true, 'recorded 事件已落盘');
    ok(up.json.state && up.json.state.stage === 'recorded', '上传后阶段 = recorded');
    ok(up.json.state && up.json.state.audio_source === 'board_mic_i2s', '快照声明音频来源=板端 mic_i2s');
    ok(up.json.silent_hint === true, '全零 PCM 的 44 字节 WAV 被标记 silent_hint=true（无声有依据）');

    // 有声音的录音：峰值应可算，silent_hint 应为 false
    const loud = makeWav(3200, 8000);        // 100 ms @16k/16bit
    const up2 = await uploadWav(loud);
    ok(up2.status === 200 && up2.json.silent_hint === false,
      '有声音录音 silent_hint=false', `peak=${up2.json.peak_dbfs} dBFS`);
    ok(up2.json.duration_ms === 100, '未自报时长时由 WAV 头算出 100ms', String(up2.json.duration_ms));

    /* ---- ①-3 电平统计必须覆盖全量 PCM，不能只看开头 ----
     * 缺陷背景（2026-10-28）：readVoiceAudioMeta() 曾只把文件前 64 KB 读进来做
     * 电平统计。6 秒录音约 190 KB，等于只看了前 ~2 秒 —— 前段安静、后段有人
     * 说话时服务端会报静音，前端提示「未录到声音」，而其实录到了。
     * 形状特意做成「前 2 秒全零 + 后 4 秒满幅」：只读前段的实现必然报静音，
     * 全量实现则能算出真实电平，两者结果差异极大，测不出来就说明判据失效。 */
    console.log('\n— ①-3 电平统计覆盖全量 PCM（不是只看开头 64 KB）—');
    const mixed = [{ seconds: 2, amplitude: 0 }, { seconds: 4, amplitude: 8000 }];
    const mixedWav = makeWavSegments(mixed);
    const exp = expectedLevel(mixed);
    ok(mixedWav.length > 64 * 1024,
      `用例 WAV 大于 64 KB（${mixedWav.length} 字节），能照出「只读前 64 KB」的缺陷`);
    const upMix = await uploadWav(mixedWav);
    ok(upMix.status === 200, '分段 WAV 上传返回 200', `bytes=${mixedWav.length}`);
    ok(upMix.json.duration_ms === 6000, '分段 WAV 时长由头算出 6000ms', String(upMix.json.duration_ms));
    ok(typeof upMix.json.rms_dbfs === 'number' && Math.abs(upMix.json.rms_dbfs - exp.rmsDb) <= 1.0,
      'rms_dbfs 反映全量 PCM（后段信号没有被漏掉）',
      `服务端 ${upMix.json.rms_dbfs} dBFS vs 全量手算 ${exp.rmsDb} dBFS` +
      `（只读前 2 秒的实现会得到静音/无值）`);
    ok(upMix.json.silent_hint === false,
      '前静音后有声的录音不得被判为静音（silent_hint=false）',
      `silent_hint=${upMix.json.silent_hint}，peak_dbfs=${upMix.json.peak_dbfs}`);
    ok(typeof upMix.json.peak_dbfs === 'number' && Math.abs(upMix.json.peak_dbfs - exp.peakDb) <= 1.0,
      'peak_dbfs 反映全量 PCM 的峰值', `服务端 ${upMix.json.peak_dbfs} vs 手算 ${exp.peakDb} dBFS`);

    /* 反向用例：前段有信号 + 后段静音。只读前段的实现会算出「有声」，
     * 全量实现应得到被后段拉低的 RMS —— 两个方向都要覆盖，避免只修一半。 */
    const mixed2 = [{ seconds: 2, amplitude: 8000 }, { seconds: 4, amplitude: 0 }];
    const exp2 = expectedLevel(mixed2);
    const upMix2 = await uploadWav(makeWavSegments(mixed2));
    ok(upMix2.status === 200 &&
      typeof upMix2.json.rms_dbfs === 'number' &&
      Math.abs(upMix2.json.rms_dbfs - exp2.rmsDb) <= 1.0,
      '前有声后静音的录音，rms_dbfs 同样按全量计算',
      `服务端 ${upMix2.json.rms_dbfs} dBFS vs 全量手算 ${exp2.rmsDb} dBFS`);

    /* 电平统计不能硬编码 data 块在偏移 44：这里把 data 块挪到偏移 54，
     * 若实现写死 44 就会把 LIST 块的内容当 PCM 读，结果必然错。 */
    const shifted = shiftDataBlock(mixedWav);
    const upShift = await uploadWav(shifted);
    ok(upShift.status === 200, 'data 块不在偏移 44 的 WAV 仍能上传', `bytes=${shifted.length}`);
    ok(typeof upShift.json.rms_dbfs === 'number' &&
      Math.abs(upShift.json.rms_dbfs - exp.rmsDb) <= 1.0,
      'data 块不在偏移 44 时电平统计仍正确（按块遍历，不硬编码 44）',
      `服务端 ${upShift.json.rms_dbfs} dBFS vs 全量手算 ${exp.rmsDb} dBFS`);

    /* ---- ①-4 回读路径的电平统计也必须覆盖全量 ----
     * 上传路径拿到的是内存里的完整 buf，天然是全量；但 GET /api/voice 走的是
     * readVoiceAudioMeta()，它只从盘上读文件开头 64 KB 再算电平 —— 这才是
     * 2026-10-28 真机实测「服务端 -39.8 dBFS vs 全量 -44.3 dBFS」的来源
     * （test/voice-hil.js ② 段正是拿这个值和本地全量解码比对）。
     * 所以缺陷必须在这条路径上被照出来，否则测试是假绿。 */
    // 重新上传一次分段 WAV，确保 latest 就是它（前面几个用例已经把它挤下去了）
    const upMix3 = await uploadWav(mixedWav);
    ok(upMix3.status === 200, '为回读断言重新上传分段 WAV');
    const vMix = await jget('/api/voice');
    ok(vMix.latest && vMix.latest.audio_id === upMix3.json.audio_id,
      'GET /api/voice 的 latest 指向刚上传的分段录音');
    ok(vMix.latest && typeof vMix.latest.rms_dbfs === 'number' &&
      Math.abs(vMix.latest.rms_dbfs - exp.rmsDb) <= 1.0,
      '回读路径（GET /api/voice）的 rms_dbfs 也按全量 PCM 计算',
      `回读 ${vMix.latest && vMix.latest.rms_dbfs} dBFS vs 全量手算 ${exp.rmsDb} dBFS` +
      `（只读前 64 KB 会得到静音/无值）`);
    ok(vMix.latest && vMix.latest.silent_hint === false,
      '回读路径不得把「前静音后有声」判成静音',
      `silent_hint=${vMix.latest && vMix.latest.silent_hint}`);
    ok(vMix.latest && typeof vMix.latest.peak_dbfs === 'number' &&
      Math.abs(vMix.latest.peak_dbfs - exp.peakDb) <= 1.0,
      '回读路径的 peak_dbfs 也按全量 PCM 计算',
      `回读 ${vMix.latest && vMix.latest.peak_dbfs} vs 手算 ${exp.peakDb} dBFS`);

    /* 最近录音列表也走 readVoiceAudioMeta，一并盯住 */
    const inRecent = (vMix.recent || []).find((r) => r.audio_id === upMix3.json.audio_id);
    ok(inRecent && typeof inRecent.rms_dbfs === 'number' &&
      Math.abs(inRecent.rms_dbfs - exp.rmsDb) <= 1.0,
      'recent 列表里的 rms_dbfs 同样按全量计算',
      `recent ${inRecent && inRecent.rms_dbfs} dBFS vs 全量手算 ${exp.rmsDb} dBFS`);

    /* ---- ①-5 data 块起点超出「前 64 KB 头部窗口」时仍要按块遍历 ----
     * 回读路径只把文件前 64 KB 读进来做头解析。若 data 起点在这之外，
     * 解析器找不到 data 块就会兜底成「偏移 44 + 全文件剩余」，
     * 把 fmt 块内容当 PCM 读 —— 电平值算错却不报错（静默错误）。
     * 这里用 70 KB 的 fmt 块把 data 推到偏移 70044，直接验证这一点。 */
    const wide = makeWavWideFmt(70000, mixed);
    const expWide = expectedLevel(mixed);
    ok(wide.length > 70000, `宽 fmt 用例 WAV 的 data 起点在 64 KB 之外（${wide.length} 字节）`);
    const upWide = await uploadWav(wide);
    ok(upWide.status === 200, '宽 fmt 块 WAV 上传返回 200', `bytes=${wide.length}`);
    ok(upWide.json.duration_ms === 6000,
      '上传路径：宽 fmt 块时 data_bytes 由块头正确读出（时长 6000ms 而非按 44 兜底）',
      `duration_ms=${upWide.json.duration_ms}`);
    const vWide = await jget('/api/voice');
    const rowWide = (vWide.recent || []).find((r) => r.audio_id === upWide.json.audio_id);
    ok(rowWide && rowWide.data_bytes === 192000,
      '回读路径：宽 fmt 块的 data_bytes 同样正确',
      `回读 data_bytes=${rowWide && rowWide.data_bytes}`);
    ok(rowWide && typeof rowWide.rms_dbfs === 'number' &&
      Math.abs(rowWide.rms_dbfs - expWide.rmsDb) <= 1.0,
      '回读路径：宽 fmt 块时电平仍按真正的 data 段计算（不把 fmt 当 PCM）',
      `回读 ${rowWide && rowWide.rms_dbfs} dBFS vs 全量手算 ${expWide.rmsDb} dBFS`);

    console.log('\n— ② 非 WAV → 400 且不落盘 —');
    let n0 = listWavs().length;
    const bad = Buffer.from('这不是 WAV，只是一段普通文本。'.repeat(4), 'utf8');
    const rBad = await uploadWav(bad);
    ok(rBad.status === 400 && rBad.json.error === 'not_wav', '非 WAV 返回 400 not_wav', `error=${rBad.json.error}`);
    ok(typeof rBad.json.message === 'string' && rBad.json.message.length > 0, '错误带中文原因', rBad.json.message);
    ok(listWavs().length === n0, '非 WAV 未落盘（wav 文件数不变）');

    const short = Buffer.from('RIFF', 'latin1');    // 只 4 字节，连头都不完整
    const rShort = await uploadWav(short);
    ok(rShort.status === 400 && rShort.json.error === 'not_wav', '不足 12 字节返回 400 not_wav');

    console.log('\n— ③ 超大 payload（>1 MB）→ 400 —');
    n0 = listWavs().length;
    const big = makeWav(1024 * 1024 + 8);           // 1 MB + 52 字节
    const rBig = await uploadWav(big);
    ok(rBig.status === 400 && rBig.json.error === 'payload_too_large',
      '超 1 MB 返回 400 payload_too_large', `bytes=${big.length}`);
    ok(rBig.json.max_bytes === 1048576, '响应回显上限 1048576');
    ok(listWavs().length === n0, '超限请求未落盘');

    console.log('\n— ④ GET 回放 / 下载 —');
    const get = await httpReq(base(`/api/voice/audio/${aid}`));
    ok(get.status === 200, 'GET /api/voice/audio/:id 返回 200');
    ok(String(get.headers['content-type'] || '').startsWith('audio/wav'),
      'Content-Type = audio/wav', String(get.headers['content-type']));
    ok(get.headers['accept-ranges'] === 'bytes', '支持 Range（Accept-Ranges: bytes）');
    ok(get.buf.length === min.length && get.buf.subarray(0, 4).toString('latin1') === 'RIFF',
      '回读内容前 4 字节为 RIFF', `${get.buf.length} 字节`);

    const range = await httpReq(Object.assign(base(`/api/voice/audio/${aid}`), {
      headers: { Range: 'bytes=0-11' },
    }));
    ok(range.status === 206 && range.buf.length === 12, 'Range 请求返回 206 + 12 字节',
      `status=${range.status} len=${range.buf.length}`);

    const dl = await httpReq(base(`/api/voice/audio/${aid}/download`));
    ok(dl.status === 200 && /attachment/.test(String(dl.headers['content-disposition'] || '')),
      'download 返回 attachment 取证下载');
    ok(/\.wav/.test(String(dl.headers['content-disposition'] || '')), '下载文件名带 .wav 后缀');

    console.log('\n— ⑤ 不存在的 id → 404；非法 id → 400 —');
    const miss = await httpReq(base('/api/voice/audio/voice-20260101-000000-000-dead'));
    ok(miss.status === 404 && JSON.parse(miss.buf.toString()).error === 'not_found',
      '合法格式但不存在 → 404 not_found');
    const evil = await httpReq(base('/api/voice/audio/..%2F..%2Fserver.js'));
    ok(evil.status === 400 || evil.status === 404, '路径穿越尝试被拒绝（400/404）', `status=${evil.status}`);
    const evil2 = await httpReq(base('/api/voice/audio/not-an-audio-id'));
    ok(evil2.status === 400 && JSON.parse(evil2.buf.toString()).error === 'invalid_audio_id',
      '非法 id → 400 invalid_audio_id');

    console.log('\n— ⑥ POST state 各分支可读回 —');
    const st0 = await jget('/api/voice/state');
    ok(st0.ok === true && st0.stage === 'recorded', '初始状态可读（stage=recorded）');
    ok(Array.isArray(st0.stages) && st0.stages.length === 8, '状态快照带 8 个阶段枚举');

    const branches = [
      ['transcribed', { transcript: '查看上次数据' }],
      ['asr_failed', {}],
      ['silent', {}],
      ['timeout', {}],
    ];
    for (const [stage, extra] of branches) {
      const r = await jpost('/api/voice/state', Object.assign({ stage }, extra));
      const got = await jget('/api/voice/state');
      ok(r.status === 200 && r.json.ok === true, `POST stage=${stage} 返回 200`, `persisted=${r.json.persisted}`);
      ok(got.stage === stage, `GET state 读回 stage=${stage}`, `实际 ${got.stage}`);
      if (stage === 'transcribed') {
        ok(got.transcript === '查看上次数据', 'transcribed 带识别文本');
      } else {
        ok(typeof got.reason === 'string' && got.reason.length > 0,
          `${stage} 自动补中文原因`, got.reason);
      }
    }

    // 恢复成功阶段后，失败原因不得残留（避免「已播报」与「识别失败」同时显示）
    await jpost('/api/voice/state', { stage: 'transcribed', transcript: '重新采集一次' });
    const stClean = await jget('/api/voice/state');
    ok(stClean.reason == null && stClean.error == null, 'reason/error 不跨阶段继承（成功阶段已清空）');

    const badStage = await jpost('/api/voice/state', { stage: 'listening' });
    ok(badStage.status === 400 && badStage.json.error === 'invalid_stage',
      '非法 stage 被拒绝（400 invalid_stage）', `返回 ${badStage.status}`);
    ok(Array.isArray(badStage.json.stages) && badStage.json.stages.length === 8,
      '拒绝时回显合法阶段枚举');
    const noStage = await jpost('/api/voice/state', {});
    ok(noStage.status === 400 && noStage.json.error === 'missing_stage', '缺 stage → 400 missing_stage');
    const badAid = await jpost('/api/voice/state', { stage: 'transcribed', audio_id: '../../x' });
    ok(badAid.status === 400 && badAid.json.error === 'invalid_audio_id', '非法 audio_id → 400');

    console.log('\n— ⑦ 事件落盘 + 重启后历史可读回 —');
    const evs = readEvents();
    ok(evs.length >= 7, `events.ndjson 已追加事件（${evs.length} 条）`);
    ok(evs[0] && evs[0].stage === 'recorded' && evs[0].audio_id === aid,
      '首条事件是 recorded 且带 audio_id');
    ok(evs.some((e) => e.stage === 'asr_failed' && e.reason), '失败事件带可读原因');
    const stageSeq = evs.map((e) => e.stage);
    ok(stageSeq.includes('transcribed') && stageSeq.includes('silent') && stageSeq.includes('timeout'),
      '四个分支都留下了事件证据', stageSeq.join(' → '));

    // 所有 stage 一律以 event 的 stage 字段为准（兼容 status 别名）
    ok(evs.every((e) => ['recorded', 'transcribed', 'asr_failed', 'task_running',
      'task_done', 'spoken', 'silent', 'timeout'].includes(e.stage)),
      '落盘事件阶段值全部合法');

    const eventsBefore = evs.length;
    await stopServer(srv);
    srv = startServer();
    ok(await waitReady(), '实例已重启（同一 DATA_DIR）');
    const stRestart = await jget('/api/voice/state');
    ok(Array.isArray(stRestart.history) && stRestart.history.length > 0,
      `重启后历史仍可读（恢复 ${stRestart.history.length} 条）`);
    ok(stRestart.history.some((e) => e.audio_id === aid), '重启后仍能追溯 audio_id');
    ok(stRestart.history.some((e) => e.stage === 'asr_failed'), '重启后仍能看到失败事件');
    ok(stRestart.has_audio === true, '重启后 has_audio=true（WAV 仍在盘上）');
    ok(readEvents().length >= eventsBefore, `重启不回写、不丢盘上事件（${eventsBefore} → ${readEvents().length}）`);
    const audioAfter = await httpReq(base(`/api/voice/audio/${aid}`));
    ok(audioAfter.status === 200 && audioAfter.buf.subarray(0, 4).toString('latin1') === 'RIFF',
      '重启后 WAV 仍可回读且前 4 字节 RIFF');

    console.log('\n— ⑧ WS 广播 voice + hello 快照 —');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const wsMsgs = [];
    ws.on('message', (buf) => { try { wsMsgs.push(JSON.parse(buf.toString())); } catch (_) {} });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    await sleep(300);
    const hello = wsMsgs.find((m) => m.type === 'hello');
    ok(!!hello, 'WS 收到 hello');
    ok(!!hello && !!hello.voice && Array.isArray(hello.voice.history),
      'hello 携带语音快照（刷新页面不丢链路）');
    ok(!!hello && hello.voice.stages && hello.voice.stages.length === 8, 'hello.voice 带 8 个阶段枚举');

    const wsUp = await uploadWav(makeWav(3200, 6000));
    ok(wsUp.status === 200, 'WS 在线时再上传一段录音成功');
    await sleep(400);
    const voicePush = wsMsgs.filter((m) => m.type === 'voice');
    ok(voicePush.length > 0, `收到 {type:"voice"} 阶段广播（${voicePush.length} 条）`);
    ok(voicePush.some((m) => m.voice && m.voice.audio_id === wsUp.json.audio_id),
      '广播里的 audio_id 与本次上传一致');
    ws.close();
    await sleep(150);

    console.log('\n— 取证入口 GET /api/voice —');
    const v = await jget('/api/voice');
    ok(v.ok === true && v.latest && v.latest.riff === 'RIFF' && v.latest.wave === 'WAVE',
      'GET /api/voice 回读最近录音前 4 字节 RIFF / 8-11 字节 WAVE');
    ok(v.latest && v.latest.bytes > 0 && typeof v.latest.duration_ms === 'number',
      '取证入口带字节数与时长', `${v.latest && v.latest.bytes} B / ${v.latest && v.latest.duration_ms} ms`);
    ok(v.audio_total >= 3, `audio_total 统计到 ${v.audio_total} 段录音`);
    ok(v.events_total >= 7, `events_total 统计到 ${v.events_total} 条事件`);

    console.log('\n— 隔离自检（绝不能污染真实 data/）—');
    ok(!fs.existsSync(path.join(ROOT, 'data', 'voice', aid + '.wav')),
      '测试录音不存在于仓库真实 data/voice（隔离有效）');
    ok(DATA_DIR.includes('.test-data'), 'DATA_DIR 落在 test/.test-data-voice（被 .gitignore 覆盖）');
  } catch (e) {
    console.error('测试异常：', e);
    fail++;
  } finally {
    /* 注意：这里**不**再 POST /api/config —— 那会触发服务端 saveConfig() 把
     * test/.test-config.json 这个夹具文件重写一遍（内容一样、行尾被改成 LF），
     * 每跑一次测试就在 git status 里多一个 M。夹具本身已是 autoDetect=false。 */
    await stopServer(srv);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
