'use strict';
/**
 * 本机离线识别（voice-local-asr.js）回归测试
 *
 * 目标：保证「板子录音 → 页面看到文字」这条路在本机可用，并且：
 *   · 真能识别一段合成语音（不是只写了个壳子）
 *   · 静音 WAV 必须返回空文本，不能瞎猜
 *   · 服务端确实把这条通道接进了转写接口与自动转写
 * 引擎不存在时明确「跳过」，绝不假通过。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { createLocalAsr } = require(path.join(ROOT, 'voice-local-asr.js'));

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
  const asr = createLocalAsr({ timeoutMs: 25000 });
  ok(typeof asr.transcribe === 'function' && typeof asr.available === 'function', '导出 available() / transcribe()');

  const avail = await asr.available();
  if (process.platform !== 'win32') {
    skipped('引擎可用', '非 Windows 平台');
  } else {
    ok(avail === true, '本机存在中文离线识别器');
  }

  console.log('\n② 真识别');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-test-'));
  const ttsWav = path.join(tmpDir, 'speech.wav');
  const silWav = path.join(tmpDir, 'silence.wav');
  writeWavSilence(silWav, 800);

  let haveTts = false;
  try { synthSpeech('请把空调温度调到二十六度', ttsWav); haveTts = fs.existsSync(ttsWav) && fs.statSync(ttsWav).size > 1000; } catch (_) { haveTts = false; }

  if (!avail) {
    skipped('合成语音识别', '没有可用识别器');
    skipped('静音返回空文本', '没有可用识别器');
  } else if (!haveTts) {
    skipped('合成语音识别', '本机没有中文合成语音，无法生成测试音频');
  } else {
    const r = await asr.transcribe(ttsWav);
    ok(r.ok === true, '合成语音识别调用成功', JSON.stringify(r).slice(0, 160));
    ok(r.ok === true && typeof r.text === 'string' && r.text.length > 0, '合成语音识别出非空文本', r.ok ? '「' + r.text + '」' : '-');
    ok(r.ok === true && /空调|温度|二十六|26/.test(r.text || ''), '识别文本包含关键词（空调/温度/26）', r.ok ? r.text : '-');

    const s = await asr.transcribe(silWav);
    ok(s.ok === true, '静音 WAV 不报错（如实返回空文本）', JSON.stringify(s).slice(0, 120));
    ok(s.ok === true && (s.text === '' || s.text == null), '静音 WAV 的文本为空（不瞎猜）', s.ok ? '「' + (s.text || '') + '」' : '-');
  }

  const missing = await asr.transcribe(path.join(tmpDir, 'no-such-file.wav'));
  ok(missing.ok === false && missing.error === 'wav_not_found', '文件不存在时如实报错', JSON.stringify(missing));

  console.log('\n②b 录音预处理（高通 + 归一化）：板载麦克风录到的声音很轻，必须先把低频轰鸣切掉再放大');
  const { normalizeForAsr } = require(path.join(ROOT, 'voice-local-asr.js'));
  ok(typeof normalizeForAsr === 'function', '导出 normalizeForAsr()');
  const rawSrc = fs.readFileSync(path.join(ROOT, 'voice-local-asr.js'), 'utf8');
  ok(/hpfHz/.test(rawSrc) && /Math\.exp\(-2 \* Math\.PI \* hpfHz/.test(rawSrc), '确实做了一阶高通（系数按 hpfHz 与采样率算）');
  ok(/targetPeak/.test(rawSrc) && /maxGainDb/.test(rawSrc), '归一化有目标峰值与最大增益上限（不会无限放大噪声）');
  ok(/32767/.test(rawSrc) && /-32768/.test(rawSrc), '放大后按 16 bit 上下限夹紧（不产生环绕失真）');
  const psSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'asr-local.ps1'), 'utf8');
  ok(/while\s*\(/.test(psSrc), 'PowerShell 侧循环识别（长录音里有多句话）');
  ok(/parts/.test(psSrc), 'PowerShell 侧把多段结果拼起来返回');

  if (haveTts && avail) {
    // 把合成语音衰减 30 dB，模拟「板载麦克风录到的很轻的声音」：
    // 归一化后仍应识别出关键词，否则说明放大/切低频没生效。
    const quiet = path.join(tmpDir, 'quiet.wav');
    const src = fs.readFileSync(ttsWav);
    const quietBuf = Buffer.from(src);
    let dataOff = 44;
    for (let off = 12; off + 8 <= quietBuf.length;) {
      const id = quietBuf.toString('ascii', off, off + 4);
      const sz = quietBuf.readUInt32LE(off + 4);
      if (id === 'data') { dataOff = off + 8; break; }
      off += 8 + sz + (sz % 2);
    }
    for (let i = dataOff; i + 1 < quietBuf.length; i += 2) {
      quietBuf.writeInt16LE(Math.round(quietBuf.readInt16LE(i) * 0.0316), i); // -30 dB
    }
    fs.writeFileSync(quiet, quietBuf);
    const q = await asr.transcribe(quiet);
    ok(q.ok === true && typeof q.text === 'string' && q.text.length > 0, '轻 30 dB 的语音经预处理后仍能识别', JSON.stringify({ text: q.text, gain_db: q.gain_db, rms: q.input_rms_db }).slice(0, 160));
    ok(q.ok === true && /空调|温度|二十六|26/.test(q.text || ''), '轻语音的关键词仍识别正确', q.ok ? q.text : '-');
    ok(Number(q.gain_db) > 10, '确实施加了明显增益', String(q.gain_db) + ' dB');
  } else {
    skipped('轻语音预处理识别', '缺少识别器或合成语音');
  }

  console.log('\n③ 服务端与前端接线契约');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok(/require\(['"]\.\/voice-local-asr\.js['"]\)/.test(serverSrc), 'server.js 引入 voice-local-asr.js');
  ok(/LOCAL_ASR\.available\(\)/.test(serverSrc), 'server.js 探测本机离线识别是否可用');
  ok(/LOCAL_ASR\.transcribe\(/.test(serverSrc), 'server.js 调用本机离线识别');
  ok(/transcribed_local|local_transcribed/.test(serverSrc), '本机识别结果会推进链路并记事件');
  ok(/local_available/.test(serverSrc), 'publicVoice() 暴露 asr.local_available');
  ok(/local_available/.test(appSrc), '前端依据 asr.local_available 决定是否走本机识别');

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败' + (skip ? ', ' + skip + ' 跳过' : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
