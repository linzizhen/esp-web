'use strict';
/**
 * 本机离线识别 —— Vosk 引擎（voice-vosk-asr.js）回归测试
 *
 * 为什么要单独测这一条：
 *   板载麦克风录到的声音又轻又带低频轰鸣，Windows 自带的 SAPI5 听写模型只能
 *   扒出「我也区」这类碎片（2026-11-13 实测）。换成 Vosk small-cn 后，同一段
 *   录音直接听出「喂喂喂听得到吗听得到吗你听得到吗听得到吗」（置信度 0.907）。
 *   这条测试就是钉住「首选引擎是 Vosk」与「它真的能出字」这两件事。
 *
 * 判据：
 *   · 真识别一段合成语音，文本要含关键词（不是只跑通不报错）
 *   · 静音 WAV 必须如实返回空文本，不能瞎猜
 *   · 服务端接线：require、优先 Vosk、SAPI 兜底、配置里报出 local_engine
 * 引擎或模型缺失时明确「跳过」，绝不假通过。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { createVoskAsr } = require(path.join(ROOT, 'voice-vosk-asr.js'));
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let pass = 0;
let fail = 0;
let skip = 0;

function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS ' + label + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.error('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function skipped(label, why) { skip++; console.log('  ⊘ ' + label + '  -> ' + why); }

function writeWavSilence(file, ms, rate) {
  const r = rate || 16000;
  const n = Math.floor((r * ms) / 1000) * 2;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(r, 24); h.writeUInt32LE(r * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(n, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.alloc(n)]));
}

function synthSpeech(text, file) {
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "zh*" } | Select-Object -First 1',
    'if (-not $v) { exit 3 }',
    '$s.SelectVoice($v.VoiceInfo.Name)',
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$s.SetOutputToWaveFile("' + file.replace(/\\/g, '\\\\') + '", $fmt)',
    '$s.Speak("' + text + '")',
    '$s.Dispose()',
  ].join('; ');
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { timeout: 60000, windowsHide: true });
}

(async () => {
  console.log('\n① 模块与引擎可用性');
  const asr = createVoskAsr({ timeoutMs: 40000 });
  ok(typeof asr.transcribe === 'function' && typeof asr.available === 'function', '导出 available() / transcribe()');
  ok(asr.engine === 'vosk', 'engine 标为 vosk', asr.engine);
  ok(fs.existsSync(path.join(ROOT, 'scripts', 'asr-vosk.py')), '识别脚本 scripts/asr-vosk.py 存在');

  const info = await asr.available();
  if (info && info.ok) {
    ok(true, 'Vosk 与中文模型可用', (info.model_dir || '') + ' / ' + (info.vosk_version || '?'));
    ok(fs.existsSync(path.join(info.model_dir, 'am', 'final.mdl')) || fs.existsSync(path.join(info.model_dir, 'am')),
      '模型目录确实有内容（不是空目录冒充）');
  } else {
    skipped('Vosk 可用', '引擎或模型缺失：' + ((info && (info.error || info.message)) || '未知'));
  }

  console.log('\n② 真识别');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vosk-test-'));
  const ttsWav = path.join(tmpDir, 'speech.wav');
  const silWav = path.join(tmpDir, 'silence.wav');
  writeWavSilence(silWav, 800);

  let haveTts = false;
  try { synthSpeech('请把空调温度调到二十六度', ttsWav); haveTts = fs.existsSync(ttsWav) && fs.statSync(ttsWav).size > 1000; } catch (_) { haveTts = false; }

  if (!(info && info.ok)) {
    skipped('合成语音识别', '没有可用 Vosk 引擎');
    skipped('静音返回空文本', '没有可用 Vosk 引擎');
  } else if (!haveTts) {
    skipped('合成语音识别', '本机没有中文合成语音，无法生成测试音频');
  } else {
    const r = await asr.transcribe(ttsWav);
    ok(r.ok === true, '合成语音识别调用成功', JSON.stringify({ ok: r.ok, error: r.error, text: r.text }).slice(0, 160));
    ok(r.ok === true && typeof r.text === 'string' && r.text.length > 0, '识别出非空文本', r.ok ? '「' + r.text + '」' : '-');
    ok(r.ok === true && /空调|温度|二十六|26/.test(r.text || ''), '识别文本包含关键词（空调/温度/26）', r.ok ? r.text : '-');
    ok(r.ok === true && Number.isFinite(r.confidence), '给出了词级平均置信度', String(r.ok ? r.confidence : '-'));

    const s = await asr.transcribe(silWav);
    ok(s.ok === true, '静音 WAV 不报错（如实返回空文本）', JSON.stringify({ ok: s.ok, reason: s.reason }).slice(0, 120));
    ok(s.ok === true && (s.text === '' || s.text == null), '静音 WAV 的文本为空（不瞎猜）', s.ok ? '「' + (s.text || '') + '」' : '-');
    ok(s.ok === true && s.reason === 'no_speech', '空文本标记 no_speech，便于页面区分「没听清」与「出错」', s.reason || '-');

    const miss = await asr.transcribe(path.join(tmpDir, 'nope.wav'));
    ok(miss.ok === false && miss.error === 'wav_not_found', '文件不存在如实报 wav_not_found', JSON.stringify(miss).slice(0, 100));
  }

  console.log('\n③ 服务端接线（Vosk 优先，SAPI 兜底）');
  ok(/require\('\.\/voice-vosk-asr\.js'\)/.test(SERVER), 'server.js 引入 voice-vosk-asr.js');
  ok(/createVoskAsr\(\{/.test(SERVER), 'server.js 构造 VOSK_ASR');
  ok(/function localAsrEngine\(\)/.test(SERVER), 'server.js 有 localAsrEngine() 统一裁决引擎');
  const engBody = (SERVER.match(/function localAsrEngine\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/VOSK_ASR\.probed[\s\S]{0,40}return 'vosk'/.test(engBody), 'localAsrEngine 首选 vosk');
  ok(engBody.indexOf("'vosk'") < engBody.indexOf("'windows_system_speech'"), 'vosk 的判定在 SAPI 之前');
  ok(/async function transcribeLocal\(file\)/.test(SERVER), 'server.js 有 transcribeLocal() 统一入口');
  ok(/local_engine: localEngine/.test(SERVER), 'asrConfigView 报出实际引擎 local_engine');
  ok(/local_available: !!localEngine/.test(SERVER), 'asrConfigView 的 local_available 跟随实际引擎');
  ok(/const lr = await transcribeLocal\(file\)/.test(SERVER), '转写接口走 transcribeLocal（不是只认一条引擎）');
  ok(/transcribeLocal\(file\)\.then\(/.test(SERVER), '录音到站后的自动转写也走 transcribeLocal');
  ok(/asr_engine: lr\.engine/.test(SERVER), '写入状态的 asr_engine 用真实引擎名');
  ok(/Promise\.all\(\[VOSK_ASR\.available\(\), LOCAL_ASR\.available\(\)\]\)/.test(SERVER), '启动时两条引擎都探测并打日志');
  ok(/function voiceLocalEngineLabel\(cfg\)/.test(APP), '前端有 voiceLocalEngineLabel() 区分引擎名');
  ok(/local_engine === 'vosk'/.test(APP), '前端按 local_engine 显示「Vosk 中文模型」');
  ok(/vxTextMeta/.test(APP) && /本机离线识别（Vosk）/.test(APP), '识别结果标签能标出 Vosk');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败' + (skip ? ', ' + skip + ' 跳过' : ''));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e && e.stack);
  process.exit(1);
});