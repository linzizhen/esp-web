'use strict';
/**
 * 本机离线中文识别（Vosk small-cn，Kaldi 系 DNN，CPU 推理，录音不出本机）
 *
 * 为什么换掉 Windows 自带的 System.Speech：
 *   同一段板载录音，SAPI5 只能扒出「我也区」「我因为我有欧盟万多万」这类碎片；
 *   Vosk 直接听出「喂喂喂听得到吗听得到吗你听得到吗听得到吗」（置信度 0.907）。
 *   差距在模型：SAPI5 是 2007 年的听写模型，Vosk 是近年的 DNN 声学模型。
 *
 * 约定：
 *   · Python 解释器默认取仓库同级的 .asr-venv（可用 ASR_VOSK_PYTHON 覆盖）；
 *     模型默认取同级的 .asr-model/vosk-model-small-cn-0.22（可用 ASR_VOSK_MODEL 覆盖）。
 *   · 结果由 Python 写 UTF-8 JSON 再读回：控制台按 GBK 输出会把中文写成乱码。
 *   · 引擎或模型缺失时 available() 返回 false，绝不假装可用。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = __dirname;
const SCRIPT = path.join(ROOT, 'scripts', 'asr-vosk.py');
const DEFAULT_MODEL = path.join(ROOT, '..', '.asr-model', 'vosk-model-small-cn-0.22');

/* 中间 JSON 写这里而不是系统临时目录：
 * 实测系统 TMP 下 Python 子进程会 PermissionError（沙箱/杀软拦截写入），
 * 换成本机仓库内的 data/.asr-tmp（data/ 已被 .gitignore 覆盖）就正常。 */
const ASR_TMP = path.join(ROOT, 'data', '.asr-tmp');
function tmpFile(tag) {
  fs.mkdirSync(ASR_TMP, { recursive: true });
  return path.join(ASR_TMP, tag + '-' + process.pid + '-' + Date.now() + '.json');
}

function defaultPython() {
  if (process.env.ASR_VOSK_PYTHON) return process.env.ASR_VOSK_PYTHON;
  return path.join(ROOT, '..', '.asr-venv', 'Scripts', 'python.exe');
}

function createVoskAsr(opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 40000;
  const probeTimeoutMs = Number.isFinite(o.probeTimeoutMs) ? o.probeTimeoutMs : 30000;
  const python = o.python || defaultPython();
  const modelDir = o.model || process.env.ASR_VOSK_MODEL || DEFAULT_MODEL;
  let probed = null;
  let probing = null;

  function run(args, timeout) {
    return new Promise((resolve) => {
      execFile(python, [SCRIPT].concat(args), { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    });
  }

  function available() {
    if (probed) return Promise.resolve(probed);
    if (probing) return probing;
    const outFile = tmpFile('vosk-probe');
    /* 注意参数顺序：asr-vosk.py 把「最后一个以 .json 结尾的参数」当输出文件，
     * 所以 --model 必须写在输出文件之前，否则它会被当成 --model 的值而丢掉结果。 */
    probing = run(['--probe', '--model', modelDir, outFile], probeTimeoutMs).then(({ err }) => {
      let info = null;
      try { info = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (_) { info = null; }
      try { fs.unlinkSync(outFile); } catch (_) { /* 忽略 */ }
      if (!info) info = { ok: false, engine: 'vosk', error: err ? String(err.message || err) : 'probe_no_output' };
      probed = info;
      return info;
    });
    return probing;
  }

  async function transcribe(wavPath) {
    if (!wavPath || !fs.existsSync(wavPath)) return { ok: false, error: 'wav_not_found', message: '找不到要识别的 WAV 文件。' };
    const info = await available();
    if (!info || !info.ok) return { ok: false, error: 'engine_unavailable', message: (info && info.error) || '本机离线识别引擎不可用。' };
    const outFile = tmpFile('vosk');
    const { err, stderr } = await run([wavPath, '--model', modelDir, outFile], timeoutMs);
    let res = null;
    try { res = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (_) { res = null; }
    try { fs.unlinkSync(outFile); } catch (_) { /* 忽略 */ }
    if (!res) return { ok: false, error: 'no_result', message: (err && String(err.message)) || stderr || '识别进程没有产出结果。' };
    if (res.ok && !res.text) res.reason = 'no_speech';
    return res;
  }

  return {
    available,
    transcribe,
    get probed() { return probed; },
    engine: 'vosk',
    python,
    model: modelDir,
  };
}

module.exports = { createVoskAsr };