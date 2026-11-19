# -*- coding: utf-8 -*-
"""本机离线中文语音识别（Vosk small-cn 模型，CPU 推理，录音不出本机）。

用法：
  python asr-vosk.py --probe <out.json>
  python asr-vosk.py <wav> <out.json> [--model <模型目录>] [--rate 16000]

为什么用 Vosk 而不是 Windows 自带的 System.Speech：
  后者是 2007 年的 SAPI5 听写模型，对板载麦克风这种远场、低频重的录音基本只能
  扒出碎片（实测「我也区」「我因为我有欧盟万多万」）。Vosk 是 Kaldi 系 DNN 模型，
  对噪声与远场明显更稳，且模型与推理都在本机。

结果一律写 UTF-8 JSON 文件再由 Node 读回（控制台按 GBK 输出会毁掉中文）。
"""
import json
import os
import sys
import wave

DEFAULT_MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '.asr-model', 'vosk-model-small-cn-0.22')


def write_out(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def main(argv):
    out = argv[-1] if argv and argv[-1].endswith('.json') else None
    if '--probe' in argv:
        try:
            import vosk  # noqa: F401
            model_dir = DEFAULT_MODEL
            if '--model' in argv:
                model_dir = argv[argv.index('--model') + 1]
            info = {
                'ok': bool(os.path.isdir(model_dir)),
                'engine': 'vosk',
                'model_dir': model_dir,
                'vosk_version': getattr(vosk, '__version__', 'unknown'),
            }
            if not info['ok']:
                info['error'] = 'model_missing'
        except Exception as e:  # noqa: BLE001
            info = {'ok': False, 'engine': 'vosk', 'error': str(e)}
        if out:
            write_out(out, info)
        else:
            print(json.dumps(info, ensure_ascii=False))
        return 0 if info['ok'] else 3

    if len(argv) < 3:
        print('usage: asr-vosk.py <wav> <out.json> [--model dir]', file=sys.stderr)
        return 2

    wav_path = argv[1]
    if not os.path.isfile(wav_path):
        write_out(out, {'ok': False, 'error': 'wav_not_found', 'message': '找不到要识别的 WAV 文件。'})
        return 1

    model_dir = DEFAULT_MODEL
    if '--model' in argv:
        model_dir = argv[argv.index('--model') + 1]

    try:
        import vosk
        from vosk import KaldiRecognizer, Model, SetLogLevel
    except Exception as e:  # noqa: BLE001
        write_out(out, {'ok': False, 'error': 'engine_unavailable', 'message': str(e)})
        return 3

    try:
        SetLogLevel(-1)  # 关掉 Kaldi 的日志刷屏
        with wave.open(wav_path, 'rb') as wf:
            rate = wf.getframerate()
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            if channels != 1 or width != 2:
                write_out(out, {'ok': False, 'error': 'not_pcm16_mono',
                                'message': '只支持 16 bit 单声道 WAV（当前 %d 声道 / %d 字节）' % (channels, width)})
                return 1
            model = Model(model_dir)
            rec = KaldiRecognizer(model, rate)
            rec.SetWords(True)
            parts = []
            all_words = []
            while True:
                data = wf.readframes(4000)
                if not data:
                    break
                if rec.AcceptWaveform(data):
                    res = json.loads(rec.Result() or '{}')
                    text = (res.get('text') or '').strip()
                    if text:
                        parts.append(text)
                    all_words.extend(res.get('result') or [])
            res = json.loads(rec.FinalResult() or '{}')
        final_text = (res.get('text') or '').strip()
        if final_text:
            parts.append(final_text)
        all_words.extend(res.get('result') or [])
        text = ''.join(parts).replace(' ', '')
        words = all_words
        conf = 0.0
        if words:
            conf = sum(float(w.get('conf', 0)) for w in words) / len(words)
        write_out(out, {
            'ok': True,
            'engine': 'vosk',
            'model': os.path.basename(model_dir),
            'rate': rate,
            'text': text,
            'parts': len(parts),
            'confidence': round(conf, 3),
            'words': words[:60],
        })
        return 0
    except Exception as e:  # noqa: BLE001
        write_out(out, {'ok': False, 'error': 'transcribe_failed', 'message': str(e)})
        return 4


if __name__ == '__main__':
    sys.exit(main(sys.argv))