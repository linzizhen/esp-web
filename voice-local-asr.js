'use strict';
/**
 * 本机离线语音识别（Windows 自带 System.Speech，中文桌面识别器）
 *
 * 为什么需要它：板载麦克风在板端录音，识别原先只有两条路 ——
 *   ① 浏览器 Web Speech API：只能听【麦克风】，本机没有麦克风就走不通；
 *   ② 云端 GLM-ASR：要把 WAV 上传给厂商，涉及隐私与费用，默认关闭。
 * 结果就是「板子录了，页面上看不到文字」。这条通道把识别放在本机：
 * 录音不出这台电脑，不需要账号，也不花钱。
 *
 * 局限（必须如实告知，不能假装能用）：
 *   · 只在 Windows 上可用；没有安装中文识别器时 available=false；
 *   · 桌面识别器的模型很老，安静环境、离板子近、语速正常时可用；
 *     远场/嘈杂/口音重时识别率明显下降，返回空文本时按「没识别到」处理，
 *     绝不拿猜测的文本冒充识别结果。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'scripts', 'asr-local.ps1');
const PS = process.env.DSH_POWERSHELL_51
  || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function runPs(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT].concat(args),
      { timeout: timeoutMs || 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ ok: false, error: 'spawn_failed', message: (err.message || '') + (stderr ? ' | ' + stderr : '') });
        resolve({ ok: true, raw: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
      });
  });
}

function parseJson(raw) {
  if (!raw) return null;
  const line = raw.split(/\r?\n/).filter((s) => s.trim().startsWith('{')).pop();
  if (!line) return null;
  try { return JSON.parse(line); } catch (_) { return null; }
}

/**
 * 读一个 16 bit 单声道 PCM WAV 的 data 块位置。
 * 板端与浏览器上传的都是标准 44 字节头，但仍按块遍历找，避免被非标准头骗。
 */
function locatePcm(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12;
  const fmt = { channels: 1, bits: 16, rate: 16000 };
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt.channels = buf.readUInt16LE(body + 2);
      fmt.rate = buf.readUInt32LE(body + 4);
      fmt.bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, buf.length - body);
      break;
    }
    off = body + size + (size % 2);
  }
  if (dataOff < 0 || dataLen < 2) return null;
  return { fmt, dataOff, dataLen };
}

/**
 * 为识别做简单的电平归一化。
 *
 * 为什么需要（2026-11-13 实测）：板载 MEMS 麦克风的远场灵敏度本来就低，实测用户
 * 说话那段 WAV 的 RMS 只有 −43 ~ −48 dBFS，而桌面识别器对这么低的电平几乎抓不到，
 * 只回一个「嗯」。但录音本身没坏，只是「太小声」。这里把有效段（跳过开头的按键
 * 撞击声）整体放大到接近满刻度，再交给识别器；仍然是本机处理，不上传。
 *
 * 返回 { path, gainDb } —— 不需要放大时直接返回原路径（gainDb = 0）。
 */
function normalizeForAsr(srcPath, dstPath, opts) {
  const o = opts || {};
  const skipMs = Number.isFinite(o.skipMs) ? o.skipMs : 300;
  const maxGainDb = Number.isFinite(o.maxGainDb) ? o.maxGainDb : 24;
  const targetPeak = Number.isFinite(o.targetPeak) ? o.targetPeak : 0.9;
  const hpfHz = Number.isFinite(o.hpfHz) ? o.hpfHz : 200;
  const buf = fs.readFileSync(srcPath);
  const loc = locatePcm(buf);
  if (!loc) return { path: srcPath, gainDb: 0, reason: 'not_pcm16' };
  const { fmt, dataOff, dataLen } = loc;
  if (fmt.bits !== 16 || fmt.channels !== 1) return { path: srcPath, gainDb: 0, reason: 'not_pcm16_mono' };
  const rate = fmt.rate || 16000;
  const total = Math.floor(dataLen / 2);

  // ① 高通：板载麦克风录到的低频轰鸣（空调/风扇/桌面震动）占了大半能量，
  //    实测两块录音 300 Hz 以下占 52%~70%，人声被埋在里面。先切掉 200 Hz 以下，
  //    识别器拿到的才是「像语音」的信号。
  const pcm = Buffer.alloc(total * 2);
  const a = Math.exp(-2 * Math.PI * hpfHz / rate);
  let yPrev = 0;
  let xPrev = 0;
  for (let i = 0; i < total; i++) {
    const x = buf.readInt16LE(dataOff + i * 2);
    const y = a * (yPrev + x - xPrev);
    xPrev = x;
    yPrev = y;
    let v = Math.round(y);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    pcm.writeInt16LE(v, i * 2);
  }

  // ② 归一化：跳过开头的按键撞击声后统计峰值，把有效段放大到接近满刻度
  const skip = Math.min(total, Math.floor((rate * skipMs) / 1000));
  let peak = 0;
  let sum = 0;
  for (let i = skip; i < total; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2));
    if (v > peak) peak = v;
    sum += v * v;
  }
  const n = Math.max(1, total - skip);
  const rms = Math.sqrt(sum / n);
  const rmsDb = Math.round(20 * Math.log10(Math.max(1, rms) / 32768) * 10) / 10;
  let gainDb = 0;
  if (peak >= 8) {
    gainDb = Math.min(maxGainDb, 20 * Math.log10((targetPeak * 32767) / peak));
    if (!Number.isFinite(gainDb) || gainDb < 1) gainDb = 0;
  }
  const gain = Math.pow(10, gainDb / 20);
  if (gain > 1.0001) {
    for (let i = 0; i < total; i++) {
      let v = Math.round(pcm.readInt16LE(i * 2) * gain);
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;
      pcm.writeInt16LE(v, i * 2);
    }
  }
  const out = Buffer.from(buf.subarray(0, dataOff));
  fs.writeFileSync(dstPath, Buffer.concat([out, pcm]));
  return {
    path: dstPath,
    gainDb: Math.round(gainDb * 10) / 10,
    rmsDb,
    peakDb: Math.round(20 * Math.log10(Math.max(1, peak) / 32768) * 10) / 10,
    hpfHz,
  };
}

function createLocalAsr(options) {
  const opts = options || {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 25000;
  let probe = null;   // { ok, count, recognizers } 缓存探测结果

  async function available() {
    if (process.platform !== 'win32') return false;
    if (probe) return probe.ok === true;
    const r = await runPs(['-Probe'], 20000);
    probe = r.ok ? (parseJson(r.raw) || { ok: false, error: 'bad_output' }) : { ok: false, error: r.error };
    if (probe.ok !== true) {
      console.warn('[voice] 本机离线识别不可用：' + (probe.error || probe.message || '未知原因'));
    } else {
      const names = (probe.recognizers || []).map((x) => `${x.name}(${x.culture})`).join(', ');
      console.log(`[voice] 本机离线识别可用：${names}`);
    }
    return probe.ok === true;
  }

  /**
   * 识别一个 WAV 文件（16 bit / 单声道 PCM）。
   * 返回 { ok:true, text, confidence, recognizer } —— text 为空表示「没识别到内容」；
   *      { ok:false, error, message } —— 引擎不可用/文件读不了/识别报错。
   */
  async function transcribe(wavPath) {
    if (process.platform !== 'win32') return { ok: false, error: 'unsupported_platform', message: '本机离线识别只在 Windows 上可用。' };
    if (!wavPath || !fs.existsSync(wavPath)) return { ok: false, error: 'wav_not_found', message: '找不到要识别的 WAV 文件。' };
    const outFile = path.join(os.tmpdir(), `asr-local-${process.pid}-${Date.now()}.json`);
    // 板载麦克风录到的说话电平常常只有 −45 dBFS，直接喂识别器只能换来一个「嗯」；
    // 先在本地把有效段放大（跳过开头的按键撞击声），再识别。
    const normFile = path.join(os.tmpdir(), `asr-norm-${process.pid}-${Date.now()}.wav`);
    let norm = { path: wavPath, gainDb: 0 };
    try {
      norm = normalizeForAsr(wavPath, normFile);
    } catch (e) {
      norm = { path: wavPath, gainDb: 0, error: e.message };
    }
    const r = await runPs(['-Wav', norm.path, '-Out', outFile], timeoutMs);
    let result = null;
    try {
      if (fs.existsSync(outFile)) result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (e) {
      result = { ok: false, error: 'bad_result', message: e.message };
    } finally {
      try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) {}
      try { if (norm.path !== wavPath && fs.existsSync(norm.path)) fs.unlinkSync(norm.path); } catch (_) {}
    }
    if (!result) result = parseJson(r.raw) || { ok: false, error: 'no_result', message: r.stderr || r.message || '识别进程没有输出结果' };
    if (result && result.ok) {
      result.gain_db = norm.gainDb || 0;
      if (norm.rmsDb != null) result.input_rms_db = norm.rmsDb;
    }
    return result;
  }

  return { available, transcribe, get probed() { return probe; } };
}

module.exports = { createLocalAsr, normalizeForAsr, locatePcm };
