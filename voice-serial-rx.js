'use strict';
/**
 * 语音 WAV 的串口回传组装器（第 5 周补充通道）
 *
 * 板端录音完成后，若 WiFi 不可用，就把 WAV 切成小块、base64 编码后
 * 用现有的 JSON 行协议从 USB 串口发上来：
 *
 *   {"type":"voice_begin","device":"S3EYE-GROUP01","bytes":196652,"duration_ms":6080,
 *    "sample_rate":16000,"bits":16,"channels":1,"peak":1234}
 *   {"type":"voice_chunk","seq":0,"data":"UklGR..."}   × N
 *   {"type":"voice_end","chunks":128}
 *
 * 这个模块只负责「拼字节」这一件事，不碰磁盘、不碰状态机 —— 便于单测
 * 直接喂二进制往返，确认 0x00 / 0xFF 不会被破坏，也确认半截数据绝不会
 * 被当成一条合法录音。
 *
 * 失败一律返回 { status:'error', error:<code> }，调用方据此丢弃缓冲并记日志：
 *   no_begin        没有 begin 就来了 chunk/end（上次会话残留或乱序）
 *   bad_bytes       begin 里的 bytes 不是正整数
 *   too_large       声明长度超过 maxBytes
 *   too_many_chunks 分块数超过上限（防内存被无限追加）
 *   overflow        实际收到的字节超过 begin 声明的长度
 *   timeout         距离 begin 超过 timeoutMs 还没收到 end
 */

function createVoiceRx(options) {
  const opts = options || {};
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 1024 * 1024;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000;
  const maxChunks = Number.isFinite(opts.maxChunks) ? opts.maxChunks : 2048;

  let active = false;
  let declared = 0;
  let parts = [];
  let got = 0;
  let chunks = 0;
  let startedAt = 0;
  let meta = {};

  function reset() {
    active = false;
    declared = 0;
    parts = [];
    got = 0;
    chunks = 0;
    startedAt = 0;
    meta = {};
  }

  function handle(obj, now) {
    const t = typeof now === 'number' ? now : Date.now();
    const type = obj && obj.type;

    // 超时优先判断：一次 begin 之后迟迟等不到 end，不能一直占着缓冲
    if (active && startedAt && t - startedAt > timeoutMs) {
      reset();
      return { status: 'error', error: 'timeout' };
    }

    if (type === 'voice_begin') {
      reset();
      const bytes = Number(obj.bytes);
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return { status: 'error', error: 'bad_bytes' };
      }
      if (bytes > maxBytes) {
        return { status: 'error', error: 'too_large', max_bytes: maxBytes };
      }
      active = true;
      declared = bytes;
      startedAt = t;
      meta = {
        device_id: obj.device || obj.device_id || null,
        duration_ms: Number.isFinite(Number(obj.duration_ms)) ? Number(obj.duration_ms) : null,
        sample_rate: Number.isFinite(Number(obj.sample_rate)) ? Number(obj.sample_rate) : null,
        bits: Number.isFinite(Number(obj.bits)) ? Number(obj.bits) : null,
        channels: Number.isFinite(Number(obj.channels)) ? Number(obj.channels) : null,
        peak: Number.isFinite(Number(obj.peak)) ? Number(obj.peak) : null,
      };
      return { status: 'begin', bytes: declared };
    }

    if (type === 'voice_chunk') {
      if (!active) return { status: 'error', error: 'no_begin' };
      if (chunks >= maxChunks) {
        reset();
        return { status: 'error', error: 'too_many_chunks' };
      }
      const buf = Buffer.from(typeof obj.data === 'string' ? obj.data : '', 'base64');
      if (got + buf.length > declared) {
        reset();
        return { status: 'error', error: 'overflow' };
      }
      parts.push(buf);
      got += buf.length;
      chunks += 1;
      return { status: 'chunk', got: got };
    }

    if (type === 'voice_end') {
      if (!active) return { status: 'error', error: 'no_begin' };
      const data = Buffer.concat(parts, got);
      const result = Object.assign({}, meta, { bytes: got, chunks: chunks });
      reset();
      return { status: 'done', data: data, meta: result };
    }

    return { status: 'ignored' };
  }

  return {
    handle: handle,
    reset: reset,
    get active() { return active; },
    get received() { return got; },
  };
}

module.exports = { createVoiceRx };
