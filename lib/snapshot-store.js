'use strict';
/**
 * 按需采集的存储与状态机（第 7 周）
 *
 * 为什么要有这个模块：本周的两个当堂验证都是「状态被错误地当成成功」类缺陷 ——
 *   ① 上次成功图像不得被标为本次采集成功；
 *   ② 采集失败保持明确状态。
 * 2026-11-19 在真实实例上实测到这两个缺陷都存在：
 *   抓拍失败（framesize:99）后 /api/cam/snapshot.jpg 仍返回 200 + 旧图，
 *   页面据此显示「已抓拍」；失败后旧图与绿色标签一起留着。
 *
 * 所以采集不能再用「snapshotAt 变没变」这种间接信号来判，必须有一个带身份的
 * 采集记录：每次采集一个 shot_id，状态只能沿状态机向前走，终止态不可逆。
 *
 * 状态机：
 *
 *   requested ──markCapturing──> capturing ──complete──> captured（落盘）
 *       │                            │
 *       │                            ├──complete（画面不可用）──> blocked
 *       └──fail（超时/板端拒绝）──────┴──fail──────────────────> failed
 *
 * 三条不可逆规则：
 *   · 终止态（captured / blocked / failed）之后一律拒绝迁移；
 *   · 失败之后到达的帧不能把状态改回成功（迟到帧会被当成「本次成功」）；
 *   · 序号未递增的帧、超出时间窗的帧一律拒绝，且不落盘。
 *
 * 本模块只做状态与字节，不碰 HTTP、不碰串口、不解码 JPEG。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SHOT_ID_RE = /^shot-\d{8}-\d{6}-\d{3}-[0-9a-f]{4}$/;

const STATE_REQUESTED = 'requested';
const STATE_CAPTURING = 'capturing';
const STATE_CAPTURED = 'captured';
const STATE_BLOCKED = 'blocked';
const STATE_FAILED = 'failed';

/** 终止态：进去就出不来，只能开新的一次采集 */
const TERMINAL = new Set([STATE_CAPTURED, STATE_BLOCKED, STATE_FAILED]);

const DEFAULT_KEEP = 5;          // 用户 2026-11-19 选定：磁盘只留最近 5 张
const DEFAULT_WINDOW_MS = 15000; // 命令发出后 15 秒内到达的帧才认
const MIN_BYTES = 1500;          // 实测正常 320x240 约 3.5 KB
const MIN_ENTROPY = 2.0;         // bit/byte；正常场景 6~7，纯色/全黑约 0
/* 主帧序号跌幅超过这个值就判板子重启。取值理由：固件 s_seq 约 10Hz，
 * 一次上电内不会回退；双通道 / 乱序最多让序号小幅抖动几帧。
 * 重启的跌幅是「上次跑到几十万」对「从 0 开始」，差着数量级。 */
const BOOT_SEQ_DROP = 1000;

/** 把毫秒时间戳格式化成 shot id 用的两段（本地时间，便于人肉对表） */
function stampParts(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return {
    date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`,
  };
}

/**
 * 压缩后字节的香农熵（bit/byte）。
 * 纯色图几乎全是一个字节 → 熵接近 0；真实场景的 JPEG 约 6~7。
 * 这是「不解码 JPEG 也能判断画面是否有细节」的最低成本手段。
 */
function byteEntropy(buf) {
  if (!buf || !buf.length) return 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) hist[buf[i]]++;
  let h = 0;
  const n = buf.length;
  for (let i = 0; i < 256; i++) {
    if (!hist[i]) continue;
    const p = hist[i] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * 判断一帧画面是否「可用」。
 *
 * ★ 这是启发式，不是物体识别：只能识别全黑 / 全白 / 纯色 / 严重失焦这类
 *   压缩后几乎没有细节的画面。判不出「镜头被纸巾挡住但仍有纹理」，也判不出
 *   「拍到的是天花板」。要真正判亮度需要固件从 RGB565 帧算 mean/var 上报，
 *   本次不做（用户 2026-11-19 选择先做服务端启发式）。
 *
 * @returns {{usable:boolean, reason:string|null, bytes:number, entropy:number}}
 */
function assessFrame(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
    return { usable: false, reason: '没有收到图像数据', bytes: 0, entropy: 0 };
  }
  const bytes = buf.length;
  const entropy = byteEntropy(buf);
  if (bytes < MIN_BYTES) {
    return {
      usable: false,
      reason: `帧太小（${bytes} 字节，低于 ${MIN_BYTES}）：可能是纯色画面或编码失败`,
      bytes,
      entropy,
    };
  }
  if (entropy < MIN_ENTROPY) {
    return {
      usable: false,
      reason: `画面几乎无细节（字节熵 ${entropy.toFixed(2)} bit/byte）：可能是纯色、全黑或被遮挡`,
      bytes,
      entropy,
    };
  }
  return { usable: true, reason: null, bytes, entropy };
}

/**
 * 采集记录仓库。
 *
 * @param {object} opts
 * @param {string} opts.dir        落盘目录（JPEG 与 events.ndjson 都在这）
 * @param {number} [opts.keep]     保留张数，默认 5
 * @param {number} [opts.windowMs] 抓拍帧的有效时间窗，默认 15000
 */
function createSnapshotStore(opts = {}) {
  const dir = opts.dir;
  if (!dir) throw new Error('createSnapshotStore 需要 dir');
  const keep = Number.isFinite(opts.keep) && opts.keep > 0 ? Math.floor(opts.keep) : DEFAULT_KEEP;
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : DEFAULT_WINDOW_MS;
  const eventsFile = path.join(dir, 'events.ndjson');

  /** shot_id -> record（插入顺序即创建顺序） */
  const records = new Map();
  /** 已见过的最新抓拍帧序号；只接受更大的 */
  let lastSeq = 0;
  /**
   * lastSeq 是在「板端主帧序号 = 多少」的时候建立的。
   *
   * ★ 这是判断板子重启的锚点（2026-11-25 真机实测）：固件里两个序号都是 RAM 变量，
   *   上电归零 —— s_seq（主帧）与 s_cam_seq（抓拍帧）。抓拍序号不能跨重启比较，
   *   但主帧序号可以告诉我们「现在还是不是同一次上电」：重启后主帧序号会明显
   *   小于上次记录时的值。只用抓拍序号判断是不行的（它没有别的参照）。
   */
  let lastBootSeq = null;
  /**
   * lastSeq 属于哪一次上电。
   *
   * 取值语义（三种状态，缺一不可）：
   *   · `0`            —— 本进程还没见过主帧，同进程内的序号可以直接比；
   *   · 某个主帧序号    —— 那次上电的标识，只有相等才允许比序号；
   *   · `-1`           —— 明确「不知道上次的序号是哪次上电的」，下一次不比较。
   *
   * 为什么要这么细：2026-11-25 真机 —— 服务端重启后 lastSeq 从历史恢复（2），
   * 板子也在期间重启（抓拍序号回到 1），于是第一张抓拍帧永远被判「上一张的帧」。
   * 而如果干脆关掉序号比较，「上次图像冒充本次成功」这个本周头号要求就失守了。
   * 折中：无法证明同属一次上电时，只放过【一次】，之后立刻重新建立可比基准。
   */
  let lastSeqEpoch = 0;
  /** 历史记录里存在「没有 boot_seq 字段」的旧采集（本周之前的数据） */
  let sawLegacyRecord = false;
  let idCounter = 0;

  fs.mkdirSync(dir, { recursive: true });

  /* ---------------- 持久化 ---------------- */

  function appendEvent(rec, ev) {
    try {
      const line = JSON.stringify(Object.assign({}, rec, { ev: ev || rec.state })) + '\n';
      fs.appendFileSync(eventsFile, line, 'utf8');
    } catch (e) {
      console.error('[snapshot] 写事件失败：' + e.message);
    }
  }

  function load() {
    if (!fs.existsSync(eventsFile)) return;
    let text = '';
    try { text = fs.readFileSync(eventsFile, 'utf8'); } catch (_) { return; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o = null;
      try { o = JSON.parse(line); } catch (_) { continue; }
      if (!o || !o.shot_id) continue;
      // 同一 shot_id 的多行是状态演进，后写覆盖先写
      records.set(o.shot_id, o);
      if (o.state === STATE_CAPTURED && Number.isFinite(o.board_seq) && o.board_seq > lastSeq) {
        lastSeq = o.board_seq;
      }
      /* 恢复「上次采集时板端主帧序号」：服务端自己重启后，用它判断板子是不是
       * 在服务端停着的那段时间里也重启了。
       * 旧记录没有这个字段 → 标记 epoch 未知（-1），下一次序号比较放过一次，
       * 避免拿上一次上电的序号把重启后的第一张抓拍帧判成「上一张」。 */
      if (Number.isFinite(o.boot_seq)) {
        if (lastBootSeq == null || o.boot_seq > lastBootSeq) lastBootSeq = o.boot_seq;
      } else if (o.state === STATE_CAPTURED) {
        sawLegacyRecord = true;
      }
    }
    /* 有旧记录（没有 boot_seq）→ 无法证明 lastSeq 属于哪次上电，放过一次比较。
     * 只放过一次：第一次成功采集会把 epoch 重新锚到当前上电，之后恢复正常判据。 */
    if (sawLegacyRecord) lastSeqEpoch = -1;
  }
  load();

  /* ---------------- 工具 ---------------- */

  function newId(now) {
    const t = now || Date.now();
    const { date, time } = stampParts(t);
    // 计数器保证同一毫秒内也唯一（4 位十六进制，够 65536 次）
    const hex = (idCounter++ & 0xffff).toString(16).padStart(4, '0');
    return `shot-${date}-${time}-${hex}`;
  }

  function fileFor(shotId) {
    return path.join(dir, shotId + '.jpg');
  }

  function get(shotId) {
    sweep();
    return records.get(shotId) || null;
  }

  function list() {
    sweep();
    return [...records.values()].slice(-keep);
  }

  /** 当前在途的那一条（requested / capturing），没有则 null */
  function inFlight() {
    for (const r of records.values()) {
      if (r.state === STATE_REQUESTED || r.state === STATE_CAPTURING) return r;
    }
    return null;
  }

  /** 更新记录并落一行事件 */
  function update(rec, patch, ev) {
    Object.assign(rec, patch);
    records.set(rec.shot_id, rec);
    appendEvent(rec, ev);
    return rec;
  }

  /* ---------------- 状态迁移 ---------------- */

  /**
   * 超时清理：把卡在 requested / capturing 超过时间窗的记录判为失败。
   *
   * ★ 为什么必须有：单飞靠「有没有在途记录」判断，而帧被拒（stale_frame）时
   *   记录会留在 capturing —— 2026-11-19 实测，一次 stale_frame 之后这条记录
   *   永远不结束，后续每次 begin() 都 409，页面再也抓不了图。
   *   所以「在途」必须有明确的生命上限，超了就如实判失败。
   *
   * 幂等：可以随便调，没有超时记录时什么都不做。
   */
  function sweep(now) {
    const t = now || Date.now();
    const expired = [];
    for (const r of records.values()) {
      if (r.state !== STATE_REQUESTED && r.state !== STATE_CAPTURING) continue;
      if (t - r.requested_at <= windowMs) continue;
      r.state = STATE_FAILED;
      r.reason = `板端在 ${Math.round(windowMs / 1000)} 秒内没有回传抓拍帧（命令发出于 ${new Date(r.requested_at).toISOString()}）`;
      r.failed_at = t;
      records.set(r.shot_id, r);
      appendEvent(r, 'failed');
      expired.push(r);
    }
    return expired;
  }

  /**
   * 发起一次采集。单飞：已有在途采集时拒绝（返回当前那条，方便前端显示进度）。
   */
  function begin(o = {}) {
    const now = o.now || Date.now();
    sweep(now);            // 先把过期的在途记录判失败，否则单飞会永久卡住
    const cur = inFlight();
    if (cur) {
      return { ok: false, error: 'shot_in_progress', current: cur };
    }
    const rec = {
      shot_id: newId(now),
      request_id: o.requestId || null,
      trigger: o.trigger || 'ui',
      state: STATE_REQUESTED,
      requested_at: now,
      captured_at: null,
      board_ts: null,
      board_seq: null,
      bytes: 0,
      size: null,
      reason: null,
    };
    records.set(rec.shot_id, rec);
    appendEvent(rec, 'requested');
    return { ok: true, record: rec };
  }

  /** 板端已回执，开始等帧。 */
  function markCapturing(shotId, o = {}) {
    const rec = records.get(shotId);
    if (!rec) return { ok: false, error: 'unknown_shot' };
    if (rec.state !== STATE_REQUESTED) {
      return { ok: false, error: TERMINAL.has(rec.state) ? 'terminal_state' : 'bad_state', record: rec };
    }
    const patch = { state: STATE_CAPTURING, capturing_at: o.now || Date.now() };
    if (o.boardAck) patch.board_ack = String(o.boardAck);
    return { ok: true, record: update(rec, patch, 'capturing') };
  }

  /**
   * 收到一帧，尝试完成采集。
   *
   * 拒绝的三种情形（都不落盘、不改状态为成功）：
   *   · 状态不是 capturing（必须经过回执阶段）；
   *   · 帧序号没有递增（很可能是上一张的帧）；
   *   · 超出时间窗（命令发出太久之后才到）。
   * 画面不可用时转入 blocked —— 这算「拿到了帧，但画面没法用」，与 failed 区分。
   */
  function complete(shotId, o = {}) {
    const rec = records.get(shotId);
    if (!rec) return { ok: false, error: 'unknown_shot' };
    if (rec.state !== STATE_CAPTURING) {
      return { ok: false, error: TERMINAL.has(rec.state) ? 'terminal_state' : 'not_capturing', record: rec };
    }

    const now = o.now || Date.now();
    const seq = Number.isFinite(o.boardSeq) ? o.boardSeq : null;

    // 时间窗：命令发出太久之后才到的帧，宁可不认（会与下一次采集混淆）
    /* ★ 这两种「帧不能用」必须结束本次采集（判 failed），不能只记个原因就留在
     * capturing —— 2026-11-19 实测：单飞靠「有没有在途记录」，记录卡在 capturing
     * 会让后续每次 begin() 都 409，页面再也抓不了图。 */
    if (now - rec.requested_at > windowMs) {
      const reason = `帧超出时间窗（命令发出后 ${now - rec.requested_at}ms 才到，上限 ${windowMs}ms）`;
      update(rec, { state: STATE_FAILED, reason, failed_at: now, captured_at: null }, 'stale_frame');
      return { ok: false, error: 'stale_frame', record: rec, reason };
    }

    // 序号单调：小于等于上次的帧一定是旧帧
    /* ★ 但只有当「上次的序号」和「这次的帧」能证明属于同一次上电时，这个比较
     *   才成立。2026-11-25 真机：历史记录里的 lastSeq=2 来自上一次上电，板子
     *   重启后第一张抓拍帧 seq=1 被永远判旧，页面报「板端没有回传抓拍帧」。
     *   判定不了归属时只放过一次（epoch 置 -1），下次起重新按新基准比较 ——
     *   既不让重启后永久失效，也不放弃「上次图像不得冒充本次」这条要求。 */
    const sameEpoch = lastSeqEpoch === 0
      || (lastBootSeq != null && lastSeqEpoch === lastBootSeq);
    if (seq != null && lastSeqEpoch !== -1 && sameEpoch && seq <= lastSeq) {
      /* 注意：这里【不】结束采集。抓拍帧可能乱序到达（上一张先到），
       * 本次命令真正的新帧随后还会来；提前判死会把好帧一起丢掉。
       * 卡住的记录由 sweep() 在超时后如实判失败。 */
      const reason = `帧序号 ${seq} 不大于上次的 ${lastSeq}：这是上一张的帧，不能当成本次结果`;
      update(rec, { reason }, 'stale_frame');
      return { ok: false, error: 'stale_frame', record: rec, reason };
    }

    const assess = assessFrame(o.jpeg);
    if (!assess.usable) {
      const done = update(rec, {
        state: STATE_BLOCKED,
        reason: assess.reason,
        bytes: assess.bytes,
        captured_at: now,      // 帧确实到了，只是不可用；时间照记，便于排查
        board_seq: seq,
        board_ts: Number.isFinite(o.boardTs) ? o.boardTs : null,
      }, 'blocked');
      return { ok: false, error: 'blocked', record: done, reason: assess.reason };
    }

    const file = fileFor(rec.shot_id);
    try {
      fs.writeFileSync(file, o.jpeg);
    } catch (e) {
      const reason = `写图像文件失败：${e.message}`;
      update(rec, { state: STATE_FAILED, reason }, 'failed');
      return { ok: false, error: 'write_failed', record: rec, reason };
    }

    if (seq != null) {
      lastSeq = seq;
      lastSeqEpoch = lastBootSeq == null ? 0 : lastBootSeq;
    }
    const done = update(rec, {
      state: STATE_CAPTURED,
      captured_at: now,
      board_seq: seq,
      board_ts: Number.isFinite(o.boardTs) ? o.boardTs : null,
      /* 记下当时的板端主帧序号：服务端自己重启后，就靠它判断板子是不是
       * 在服务端停着的那段时间里也重启了（内存里的 lastBootSeq 那时是空的）。 */
      boot_seq: lastBootSeq,
      bytes: o.jpeg.length,
      size: o.size || null,
      reason: null,
    }, 'captured');

    prune();
    return { ok: true, record: done };
  }

  /**
   * 重建抓拍帧序号的基准（板子重启后必须调用）。
   *
   * ★ 为什么需要（2026-11-25 真机实测）：固件里的 s_cam_seq 是 RAM 变量，
   *   每次上电从 0 开始。而这里的 lastSeq 来自 events.ndjson 的历史记录。
   *   板子重启后第一张抓拍帧 seq=1 < lastSeq=2 → 被判成「这是上一张的帧」
   *   → stale_frame，15 秒后 failed。页面显示「板端没有回传抓拍帧」，而板端
   *   日志写着「抓拍命令执行完毕：成功（耗时 194 ms）」—— 两边都在说真话，
   *   错的是「跨重启沿用序号」这个假设。序号只在一次上电内单调。
   *
   * 只清基准，不动任何记录（历史仍可查、图仍可按 shot_id 取）。
   */
  function resetSeq() {
    lastSeq = 0;
    lastSeqEpoch = 0;   // 新上电：同进程内的序号从头比
  }

  /**
   * 用主帧序号（固件的 s_seq，约 10Hz）判断板子有没有重启，重启则重建抓拍序号基准。
   *
   * 为什么用主帧而不是抓拍帧：抓拍帧序号只在抓拍时前进，没有别的参照，单看它
   * 无法区分「上一张的帧迟到」与「重启后从头计数」；主帧序号一直在跑，掉头就是
   * 重启。两者的共同点是都是 RAM 变量、上电归零。
   *
   * 判据取「跌幅超过 BOOT_SEQ_DROP」而不是「比上次小」：双通道与乱序到达会让
   * 序号偶尔小幅回退（几帧），那不是重启。重启的跌幅是几十万帧级别的。
   *
   * @returns {boolean} 本次调用是否检测到重启
   */
  function observeBootSeq(seq, now) {
    if (!Number.isFinite(seq) || seq < 0) return false;
    const prev = lastBootSeq;
    let rebooted = false;
    if (prev != null && prev - seq > BOOT_SEQ_DROP) {
      resetSeq();
      rebooted = true;
      try {
        fs.appendFileSync(eventsFile, JSON.stringify({
          ev: 'board_reboot',
          at: now || Date.now(),
          prev_boot_seq: prev,
          boot_seq: seq,
          note: '主帧序号大幅回退，判定板子重启；已重建抓拍序号基准',
        }) + '\n', 'utf8');
      } catch (_) { /* 留痕失败不影响判定 */ }
    }
    if (prev == null || seq > prev) lastBootSeq = seq;
    return rebooted;
  }

  /** 显式失败（命令超时 / 板端报 no_camera / 解码失败）。 */
  function fail(shotId, reason, o = {}) {
    const rec = records.get(shotId);
    if (!rec) return { ok: false, error: 'unknown_shot' };
    if (TERMINAL.has(rec.state)) {
      return { ok: false, error: 'terminal_state', record: rec };
    }
    const done = update(rec, {
      state: STATE_FAILED,
      reason: reason || '采集失败（未给出原因）',
      failed_at: o.now || Date.now(),
    }, 'failed');
    return { ok: true, record: done };
  }

  /** 保留策略：成功落盘的图只留最近 keep 张，多出来的删掉并留记录。 */
  function prune() {
    const captured = [...records.values()]
      .filter((r) => r.state === STATE_CAPTURED)
      .sort((a, b) => (a.captured_at || 0) - (b.captured_at || 0));
    const overflow = captured.slice(0, Math.max(0, captured.length - keep));
    for (const r of overflow) {
      const f = fileFor(r.shot_id);
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {
        console.error('[snapshot] 删除旧图失败：' + e.message);
      }
      r.pruned = true;
      r.pruned_at = Date.now();
      records.set(r.shot_id, r);
      appendEvent(r, 'pruned');
    }
    // 已淘汰的记录不再出现在列表里（但事件流水保留，盘上可查）
    for (const r of overflow) records.delete(r.shot_id);
    return overflow.length;
  }

  return {
    dir,
    keep,
    windowMs,
    eventsFile,
    newId,
    fileFor,
    get,
    list,
    inFlight,
    begin,
    sweep,
    markCapturing,
    complete,
    fail,
    resetSeq,
    observeBootSeq,
    assessFrame,
  };
}

module.exports = {
  createSnapshotStore,
  assessFrame,
  byteEntropy,
  SHOT_ID_RE,
  DEFAULT_KEEP,
  DEFAULT_WINDOW_MS,
  MIN_BYTES,
  MIN_ENTROPY,
  STATE_REQUESTED,
  STATE_CAPTURING,
  STATE_CAPTURED,
  STATE_BLOCKED,
  STATE_FAILED,
  TERMINAL,
};
