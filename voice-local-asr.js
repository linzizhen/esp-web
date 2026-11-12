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
    const r = await runPs(['-Wav', wavPath, '-Out', outFile], timeoutMs);
    let result = null;
    try {
      if (fs.existsSync(outFile)) result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (e) {
      result = { ok: false, error: 'bad_result', message: e.message };
    } finally {
      try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) {}
    }
    if (!result) result = parseJson(r.raw) || { ok: false, error: 'no_result', message: r.stderr || r.message || '识别进程没有输出结果' };
    return result;
  }

  return { available, transcribe, get probed() { return probe; } };
}

module.exports = { createLocalAsr };
