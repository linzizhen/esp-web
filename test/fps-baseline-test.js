'use strict';
/**
 * 帧率基线回归测试（真实板子 · 只读 · 不进 run-all.js 编排器）
 *
 * 为什么要有这个文件：本项目**两次**帧率塌陷都是人工肉眼看出来的，没有测试盯着：
 *   · 2026-10-15 WiFi 退避失效 → 0.33 fps（应 10 fps），修完 6.93 fps
 *   · 2026-10-26 烧第 5 周固件后 9.43 fps → 2.2 fps，至今未恢复
 * 两次的共同点：接口全部正常、页面照常出数，只有「帧间隔」这一个量在变坏。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ 先读这一节：本测试测的是「上传帧率」，不是「采样帧率」
 * ══════════════════════════════════════════════════════════════════════
 * 服务端只能看到**成功上传**的帧。固件 send_frame()（main.c:987-1041）里有两处
 * 「不计数就 return」，被跳过的帧永远不上传、服务端永远收不到、也不会落盘：
 *   · main.c:996  if (!wifi_wait(0)) return;      WiFi 没连上
 *   · main.c:999  if (now < s_next_try_us) return; 退避窗口内
 * 而 s_seq++ 发生在主循环里、send_frame() 之前（main.c:1667），所以这些帧
 * **seq 照样递增**，只是没到服务端。
 *
 * 实测佐证（2026-10-28，60 秒三路对照）：
 *   板端 seq +177（2.95/秒）   records 行数 +33（0.55/秒）   upload_ok +33 / fail +6
 * 另一窗口（无退避时）：seq +27 / lines +26 / upload_ok +26 —— seq 增量 ≈ 上传次数。
 * 我也独立复核过：records 最近 1200 行里，落盘行数增量 1199 ≈ upload_ok 增量 1169，
 * 即**每条记录恰好对应一次上传成功**，没有任何「只采样未上传」的帧混进来。
 *
 * 结论与两个口径：
 *   · 上传帧率 = 服务端实收帧数 / 时间跨度   ← 本测试的中位数判据量的就是它
 *   · 采样帧率 = 板端主循环真实节拍         ← 只能靠 seq 增量估算（ΣΔseq / 跨度），
 *     或串口侧直接读帧（.git-work/probe-serial-branch.js），或板端日志
 *     「上传成功 成功=N」行的间隔。**服务端侧测不到采样率。**
 *
 * ★ 因此：板子纯 WiFi 上报时，即使主循环采样满速 10 fps，上传帧率也可能只有
 *   0.47–2.2 fps（帧间隔 ≈ 100ms + k×RTT，实测 k ≈ 2.86；根因是 send_frame() 里
 *   http_upload() 同步阻塞，main.c:1001）。此时本测试**报 FAIL 是如实报警**，
 *   不是测试本身坏了 —— 别把红灯当成噪声关掉。
 *
 * ── 判据：相邻帧间隔的**中位数** ────────────────────────────────────
 * 为什么不用「快慢帧次数比」（例如「间隔 > 200ms 的帧占比」）：
 * 2026-10-15 那次退避失效时，固件是「每帧阻塞 3s」，但同时也存在少量快速帧，
 * 用次数比统计在未修复固件上会误报全绿 —— 快帧把慢帧摊平了。中位数对
 * 「一半以上帧变慢」这种整体性退化最敏感，也不会被少量异常帧带偏。
 *
 * 阈值依据（全部是实测值，不是拍脑袋）：
 *   · 设计值：固件 `REPORT_INTERVAL_MS = 100`（firmware/s3eye_imu_idf/main/app_config.h），
 *     即理想 10 fps / 100ms 一帧；
 *   · 正常实测：6.93 fps（2026-10-15 修复后）、8.5 fps（2026-10-26 现场 /api/state 实测，
 *     中位间隔 117.5ms）、9.35 fps（2026-10-28 串口在线时，中位 107ms）
 *     → 正常区间中位间隔约 110-150ms；
 *   · 退化实测：2.2 fps（2026-10-26，中位间隔约 450ms）、0.33 fps（2026-10-15，约 3000ms）、
 *     0.47-1.17 fps（2026-10-28 纯 WiFi 上报）；
 *   · 因此把上限取在 250ms（≈4 fps）：比正常值高约 2 倍留足抖动余量，
 *     又远低于退化值 450ms，两侧都不踩线。可用 FPS_MAX_MEDIAN_MS 覆盖。
 *   · 阈值**不得放宽到 450ms**：那会漏掉 2.2 fps 这类退化的早期阶段。
 *
 * ── 多窗口判定（防止「挑到链路好的几十秒」）──────────────────────────
 * 帧率随 WiFi RTT 剧烈波动，单一窗口可能恰好落在链路好的时段而假绿。
 * 因此把采集到的间隔按顺序切成 FPS_WINDOWS（默认 4）个等量窗口，各自算中位数：
 *   · 每个窗口给出「超标 / 正常 / 样本不足」三种状态；
 *   · 有结论的窗口里，超标占比 ≥ 2/3 → 判 FAIL；
 *   · 另外保留「全局中位数超标」作为硬门（任一触发即失败）。
 * 这样既能抓住持续退化，也能抓住「大部分时间在退化、偶尔回光返照」。
 *
 * ── 采集中断 vs 上传缺帧：必须分开，不能混成一个「seq 断号」──────────
 * 这是本文件最容易写错、也最要命的一处（2026-10-28 修正）：
 *   · seq **回退/归零**（Δseq ≤ 0）→ 真中断：板子重启、拔线重连、串口重开。
 *     这一对间隔必须剔除，否则会把「关机 10 分钟」算成帧间隔。
 *   · seq **前跳**（Δseq > 1）→ 上传缺帧：中间 Δseq-1 帧板端采样了但没到服务端
 *     （退避跳过 / HTTP 失败 / WiFi 丢包）。**这些间隔必须保留**：
 *     它们正是「上传变慢」的证据，丢掉就等于把要测的东西过滤掉了。
 * 旧实现把两者都当「seq 断号」剔除，后果是：退避跳过的慢间隔全被丢掉，
 * 只剩「连续上传成功」的帧对参与中位数 → 量到的天然偏高，结构上**无法**
 * 测出「采样正常但上传慢」，会把它报成「seq 断号很多、样本不足 → SKIP」。
 *
 * 同理，不能用「间隔 > 5s 就丢弃」来排除中断：帧率塌到 0.1 fps 时每个间隔
 * 都会被丢掉，样本清零 → 退化成 skip，恰好把最该报警的极端退化掩盖掉。
 * `MAX_GAP_MS`（5s）只用于 Δseq === 1 但板端 ts 跳了 5s 以上的 NTP 时钟跳变兜底：
 * 若服务端接收侧没有对应空档，说明是板端时钟被校正，排除；接收侧同样空着，
 * 说明板子真的这么久才发一帧，保留。
 *
 * ── 采样方式 ────────────────────────────────────────────────────────
 * `/api/state` 的 `raw` 是环形缓冲（服务端 RAW_LOG_MAX=200），只回最后 60 条，
 * 且其中还混着 ESP-IDF 日志行（`ok:false`，如「上传成功 成功=N」）与 ack/help/voice
 * 回执，单次快照不一定够 60 帧。所以本测试轮询 `/api/state`，按板端 `ts` 去重累积。
 * `raw` 元素是 `{ts, text, ok}` 对象，`text` 才是串口原文 JSON（板端 `ts` 在 text 里）。
 *
 * ── 跳过而不是假通过 ────────────────────────────────────────────────
 * 需要真实板子，所以下列情况一律 SKIP（退出码 0，但明确打印「跳过 ≠ 通过」）：
 *   · 服务端不可达（没在跑 / 端口不对）
 *   · connected=false（没有设备在线）
 *   · 采集窗口没跑满就退出（观测窗口不完整，比如中途抛错）
 *   · frames.size < 2 且 raw 里连数据帧都没有 —— 并且**分别**打印是
 *     「帧里没有板端 ts（NTP 未同步）」还是「JSON 解析失败 / text 不是字符串」
 *     还是「raw 里根本不是数据帧」，不要糊成一句
 * 跳过时绝不打印「通过」，避免制造「测过了」的错觉。
 *
 * ★ 但「窗口跑满却帧数不够」**不是** SKIP，是 FAIL（F3，2026-10-28 修复）：
 *   0.33 fps 时 30s 只能拿 10 帧、90s 也只能拿 30 帧，永远到不了
 *   MIN_FRAMES×WINDOWS(240)，循环必然靠超时退出 → 帧数恒 < 60 → 旧实现一律 skip、
 *   exit 0，最该报警的极端退化被静默放过（桩实测：raw 从空开始 12 帧 skip、
 *   预填 60 帧历史 27 帧也 skip）。现在改为用手里有限的帧照算中位数并判 FAIL，
 *   同时单独记一条「采集窗口内收到 ≥ MIN_FRAMES 帧」的失败项。
 *
 * ★ 「帧数不足」与「ts 缺失」是两件独立的事（F3 附带项，2026-10-29 修复）：
 *   旧实现在 `frames.size < 2` 时只看 `auditRaw(lastState).noTs > 0` 就打印
 *   「帧里没有板端 ts（NTP 未同步）」—— 哪怕本轮明明收到过带 ts 的帧。
 *   桩实测复现（D:\tmp\fps-mixed-stub.js 8180 3000 20：每 20 帧只有 1 帧带 ts）：
 *   累积到 1 帧带 ts 的数据帧，旧实现仍报「帧里没有板端 ts」，属误报。
 *   现在先看 frames（它只装**带板端 ts** 的帧，size>0 即证明 ts 字段存在），
 *   再把 raw 快照的成分（带 ts / 无 ts / 解析失败 / 非字符串 / 结构异常）
 *   作为独立事实一并打印，不拿它反推「有没有 ts」。
 *
 * ★ 「真中断」与「上传缺帧」必须分开统计（2026-10-29 复核，桩实测）：
 *   · seq 回退/归零（Δseq ≤ 0）→ 真中断（重启 / 拔线），该间隔剔除；
 *   · seq 前跳（Δseq > 1）→ 上传缺帧（退避跳过 / HTTP 失败 / 丢包），
 *     该间隔**保留**进中位数 —— 它正是「上传变慢」的证据。
 *   实测（D:\tmp\fps-gap-stub.js 8190 300 3：每帧 seq +3）：135 对前跳、累计漏
 *   270 帧、占板端采样 66.5%，上传帧率 3.27 fps vs 采样帧率估算 9.82 fps ——
 *   两个口径差 3 倍，混着说「帧率」必然误导。
 *   对照（8191 300 1 40：第 40 帧 seq 归零）：真中断 1 次、上传缺帧 0、
 *   采样帧率不给估算。两种情形分别打印，互不污染。
 *
 * ── 为什么默认打 8080 而不是自建隔离实例 ────────────────────────────
 * 本测试要观察**真实串口/WiFi** 上的板子；自建隔离实例拿不到板子，只能观察到
 * 0 帧，等于永远 skip。因此默认连 8080 上的运行实例，但**只发 GET /api/state**，
 * 不写任何数据、不注入合成帧、不动 /api/report，不污染真实采集。
 *
 * 用法：
 *   node test/fps-baseline-test.js                       默认 http://127.0.0.1:8080
 *   FPS_PORT=8099 node test/fps-baseline-test.js         指定端口
 *   FPS_BASE=http://192.168.1.10:8080 node ...           指定完整地址（VPS 部署时）
 *   FPS_MAX_MEDIAN_MS=200 node ...                       临时收紧阈值（调试用，默认 250）
 *   FPS_MIN_FRAMES=120 node ...                          要求更多样本（默认 60）
 *   FPS_WINDOWS=6 node ...                               切更多窗口（默认 4）
 *   FPS_COLLECT_MS=120000 node ...                       延长采集时长（默认 90s）
 */
const http = require('node:http');

const PORT = Number(process.env.FPS_PORT) || 8080;
const BASE = process.env.FPS_BASE || `http://127.0.0.1:${PORT}`;

const MIN_FRAMES = Math.max(3, Number(process.env.FPS_MIN_FRAMES) || 60);
const MAX_MEDIAN_MS = Number(process.env.FPS_MAX_MEDIAN_MS) || 250;
const WINDOWS = Math.max(1, Number(process.env.FPS_WINDOWS) || 4);
const MIN_WINDOW_INTERVALS = 3;   // 一个窗口至少要这么多间隔才给结论
/* 退化路径的最小间隔数（F3，2026-10-28）：采集窗口跑满却凑不满 MIN_FRAMES 帧时，
 * 仍要用手里有限的帧算出中位间隔并判定，否则极端退化会被「样本不足」跳过。
 * 3 个间隔 = 4 帧，够算中位数（此时中位数动辄 3000ms，离 250ms 阈值极远，
 * 统计稳健性不是问题；真正的问题在「有结论 vs 没结论」）。 */
const MIN_DEGRADED_INTERVALS = 3;
const FAIL_WINDOW_RATIO = 2 / 3;  // 有结论的窗口里超标占比达到它即判失败
const POLL_MS = 500;              // 轮询间隔：raw 有 60 条缓冲，0.5s 一次不会漏帧
/* 采集时长：既要够 MIN_FRAMES 帧，又要够切 WINDOWS 个窗口。
 * 8 fps 时 MIN_FRAMES*WINDOWS=240 帧约 30s 就能采满；2.2 fps 时要 109s，
 * 因此超时给到 90s，退化时靠「时间跨度够」而不是「帧数够」来保证有结论。 */
const COLLECT_TIMEOUT_MS = Number(process.env.FPS_COLLECT_MS) || 90000;
/* 采集中断的判据用 **seq 方向**，不用「间隔多大」。
 * 理由：若按「间隔 > 5s 就丢弃」，那么帧率塌陷到 0.1 fps 时每个间隔都被丢掉，
 * 样本清零 → 退化成 skip，正好把最该报警的极端退化掩盖掉。
 * 而 seq 回退/归零才是真正的中断证据（拔线、板子重启）；seq 前跳是上传缺帧，要保留。 */
const MAX_GAP_MS = 5000;      // 仅用于「Δseq===1 但 ts 跳了 5s 以上」的时钟跳变兜底

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 只读 GET，永不 POST —— 本测试对生产实例零副作用。 */
function getState(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL('/api/state', BASE);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'GET', timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('响应不是合法 JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`超时 ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/* 从 /api/state 的 raw 里挑出「周期数据帧」并取板端 ts。
 * 过滤理由：
 *   · item.ok !== true  → ESP-IDF 日志行，不是帧；
 *   · text 不是字符串   → 结构异常（reviewer 实测这里能抛，先判类型再 parse）；
 *   · text 解析失败      → 同上；
 *   · 没有数字 ts        → 板端 NTP 未同步（固件 time(NULL) < 2023 时不写 ts 字段），
 *                          这类帧无法用于间隔统计；
 *   · 没有数字 seq       → ack / help / voice 回执，不是周期帧。
 * 这里用板端 ts 而不是服务端接收时间 ts：服务端接收时刻受串口/USB 调度抖动影响，
 * 板端 ts 才是「固件主循环真实节拍」的证据。 */
function extractFrames(st) {
  const out = [];
  for (const item of (st && st.raw) || []) {
    if (!item || typeof item !== 'object' || item.ok !== true) continue;
    if (typeof item.text !== 'string') continue;
    let obj;
    try { obj = JSON.parse(item.text); } catch (_) { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) continue;
    if (typeof obj.seq !== 'number' || !Number.isFinite(obj.seq)) continue;
    // at = 服务端接收该行的时刻，只用于区分「板端时钟跳变」与「真的很久才出一帧」
    out.push({ ts: obj.ts, seq: obj.seq, at: typeof item.ts === 'number' ? item.ts : 0 });
  }
  return out;
}

/* raw 成分体检：用于在「样本不足」时给出**分得清**的原因，而不是一句笼统的
 * 「帧数不够」。三类要分开数：结构异常 / JSON 解析失败 / 解析成功但没有板端 ts。 */
function auditRaw(st) {
  const a = { total: 0, notObject: 0, notString: 0, parseFail: 0, noTs: 0, noSeq: 0, frames: 0 };
  for (const item of (st && st.raw) || []) {
    a.total++;
    if (!item || typeof item !== 'object') { a.notObject++; continue; }
    if (typeof item.text !== 'string') { a.notString++; continue; }
    let obj;
    try { obj = JSON.parse(item.text); } catch (_) { a.parseFail++; continue; }
    if (!obj || typeof obj !== 'object') { a.parseFail++; continue; }
    const hasTs = typeof obj.ts === 'number' && Number.isFinite(obj.ts);
    const hasSeq = typeof obj.seq === 'number' && Number.isFinite(obj.seq);
    if (!hasTs) { a.noTs++; continue; }
    if (!hasSeq) { a.noSeq++; continue; }
    a.frames++;
  }
  return a;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
  return s[i];
}

let pass = 0, fail = 0, skip = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};
const skipped = (m, why) => { skip++; console.log('  ⊘', m + '  -> ' + why); };

function summary() {
  console.log('\n' + '='.repeat(72));
  if (skip && !fail) {
    console.log(`  跳过：${skip} 项（跳过 ≠ 通过 —— 没有真实板子时本测试不产生任何结论）`);
  } else if (fail === 0) {
    console.log(`  帧率基线通过：${pass} 项断言`);
  } else {
    console.log(`  ✗ ${fail} 项失败 / ${pass} 项通过`);
  }
  console.log('='.repeat(72));
  // 跳过也退出 0：这不是失败，但上面已明确标注「跳过 ≠ 通过」
  process.exit(fail === 0 ? 0 : 1);
}

/* 失败时的排查指引。内容都是本项目真实踩过的坑，不是通用套话。 */
function printCauses() {
  console.log('\n  可能原因（按本项目已发生过的顺序）：');
  console.log('    1) 上传路径同步阻塞：固件 send_frame() 里 http_upload() 是同步等待（main.c:1001），');
  console.log('       每帧要等一次 HTTP 往返，帧间隔 ≈ 100ms + k×RTT（实测 k≈2.86）。');
  console.log('       WiFi RTT 一高帧率就塌。2026-10-26 的 9.43 → 2.2 fps 即此类。');
  console.log('       取证：node test/fps-upload-correlate.js（看 RTT 与间隔的相关性）');
  console.log('    2) WiFi 退避失效：每一帧都撞 HTTP 超时（约 3s），帧间隔恒 ≈3.0s。');
  console.log('       2026-10-15 的 0.33 fps 即此类。取证：node test/firmware-backoff-test.js');
  console.log('    3) 退避窗口内跳过上传：连续失败 5 次后每 10s 才重试一次，中间帧只采样不上传。');
  console.log('       表现是 seq 前跳（Δseq 很大）而 ts 间隔同样很大 —— 见上面「上传缺帧」统计。');
  console.log('    4) 主循环被其他任务抢占：摄像头采集/上传、语音上传、LCD 重绘。');
  console.log('       取证：.git-work/probe-serial-branch.js COM4 30（串口侧直接量采样节拍）');
  console.log('    5) 板端时钟跳变：NTP 重新同步导致 ts 跳变（本测试会丢弃异常间隔并提示）。');
  console.log('\n  ★ 注意：本测试量的是**上传帧率**。板子纯 WiFi 上报时 0.47-2.2 fps 是已知现状，');
  console.log('    报 FAIL 是如实报警，不是测试坏了。要区分「采样慢」还是「上传慢」，看下面');
  console.log('    的「采样帧率估算」：采样正常而上传慢 = 根因在 HTTP 阻塞，不在主循环。');
  console.log('\n  另外：网页照常出数、接口全部 200 不代表帧率正常 —— 这就是两次塌陷都靠人工发现的原因。');
}

/* 把一个窗口的间隔数组算成「超标 / 正常 / 样本不足」三态。 */
function windowVerdict(seg) {
  if (seg.length < MIN_WINDOW_INTERVALS) return { state: 'few', med: NaN };
  const med = median(seg.map((x) => x.d));
  return { state: med > MAX_MEDIAN_MS ? 'bad' : 'good', med };
}

(async () => {
  console.log('\n— 帧率基线回归测试（真实板子 · 只读）—');
  console.log(`  目标：${BASE}`);
  console.log(`  判据：**中位上传间隔** ≤ ${MAX_MEDIAN_MS}ms（≈${(1000 / MAX_MEDIAN_MS).toFixed(1)} fps 以上）`);
  console.log(`        并且 ${WINDOWS} 个窗口里超标占比 < ${(FAIL_WINDOW_RATIO * 100).toFixed(0)}%`);
  console.log(`  依据：设计值 REPORT_INTERVAL_MS=100；正常实测 6.9-9.4 fps（间隔约 107-150ms）；`);
  console.log(`        退化实测 2.2 fps（约 450ms）/ 0.33 fps（约 3000ms）/ 0.47-1.17 fps（纯 WiFi）。`);
  console.log(`  ★ 本测试量的是**上传帧率**（服务端实收），不是板端采样率；两者可能相差一个数量级。\n`);

  /* ---------- ① 前置：服务端可达 ---------- */
  let st;
  try {
    st = await getState();
  } catch (e) {
    skipped('服务端可达', `${BASE} 连不上（${e.message}）—— 请先 npm start，或用 FPS_PORT/FPS_BASE 指定地址`);
    summary();
    return;
  }

  /* ---------- ② 前置：有真实设备在线 ---------- */
  if (st.connected !== true) {
    skipped('设备在线', `connected=false（transport=${st.transport || '无'}）—— 本测试需要真实板子持续上报`);
    summary();
    return;
  }
  console.log(`  设备：${st.deviceId || '(未知)'}  transport=${st.transport}  seq=${st.seq}` +
    `  upload_ok=${st.fields && st.fields.upload_ok}  upload_fail=${st.fields && st.fields.upload_fail}\n`);

  /* ---------- ③ 累积采样：轮询 /api/state，按板端 ts 去重 ---------- */
  const frames = new Map();       // key = 板端 ts，天然去重
  const targetFrames = MIN_FRAMES * WINDOWS;   // 够切 WINDOWS 个窗口的帧数目标
  const t0 = Date.now();
  let polls = 0;
  let lastErr = null;
  let lastState = st;
  process.stdout.write('  采集中');
  while (Date.now() - t0 < COLLECT_TIMEOUT_MS && frames.size < targetFrames) {
    try {
      const s = await getState();
      lastState = s;
      for (const f of extractFrames(s)) frames.set(f.ts, f);
      lastErr = null;
    } catch (e) { lastErr = e; }
    polls++;
    if (polls % 2 === 0) process.stdout.write('.');
    if (frames.size >= targetFrames) break;
    await sleep(POLL_MS);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  轮询 ${polls} 次 / ${elapsed}s，收到 ${frames.size} 帧有效数据帧（目标 ${targetFrames}）\n`);

  /* ---------- ④ 样本量不足：先分清「观测不到」和「就是慢」 ---------- */
  /* ★ 2026-10-28 修复（审查 F3：极端退化被 SKIP 掩盖）。
   * 旧实现只要 frames.size < MIN_FRAMES(60) 就 skip，理由是「样本不够算不出中位数」。
   * 但采集循环的条件是 `frames.size < MIN_FRAMES*WINDOWS(240)`，帧率低时**永远到不了
   * 240**，循环必然靠超时退出 → 于是 frames.size 恒 < 60 → 极端退化（0.33 fps）
   * 一律被判 skip、exit 0。桩实测（0.33 fps）：raw 从空开始只收到 12 帧 → skip；
   * 连 raw 预填 60 帧历史也只收到 27 帧 → 同样 skip。最该报警的场景被静默放过。
   *
   * 现在的口径：
   *   · frames.size < 2      → 确实没有可算的数据，skip（原因分得清：无 ts / 解析失败 / 无数据帧）
   *   · 窗口已跑满但帧不够   → **不是 skip，是退化**。用手里有限的帧照算中位数，
   *                            并在判定段作为独立失败项报出（见 ⑧ 的 sampleStarved）。
   *     窗口没跑满（异常提前退出）→ skip（确实没有观测窗口）。 */
  const windowRanFull = (Date.now() - t0) >= COLLECT_TIMEOUT_MS * 0.95;
  let sampleStarved = false;

  if (frames.size < MIN_FRAMES) {
    /* 原因必须分得清：是「根本没有板端 ts」，还是「帧类型不对」，还是「只是采得慢」。
     * 判断依据用**已累积的 frames**（它只装带 ts 的帧），而不是采样结束那一刻的
     * st.raw 快照 —— 快照可能恰好滚动掉了证据。raw 成分另用 auditRaw 体检。 */
    const a = auditRaw(lastState);
    if (frames.size < 2) {
      /* ★ 2026-10-29 修复（审查 F3 的附带缺陷）：「帧数不足」与「ts 缺失」是两件事，
       * 旧实现用 `a.noTs > 0` 单条件二选一，于是只要 raw 快照里有几条无 ts 的帧，
       * 就会打印「帧里没有板端 ts（NTP 未同步）」——哪怕本轮明明收到过带 ts 的帧。
       * 实测复现（混合帧桩 D:\tmp\fps-mixed-stub.js 8180 3000 20：每 20 帧只有 1 帧带 ts）：
       * 累积到 1 帧带 ts 的数据帧，旧实现却报「帧里没有板端 ts」，属误报。
       *
       * 现在：① 先看 frames（它只装**带板端 ts** 的帧，size>0 就证明 ts 字段存在）；
       *       ② 再把 raw 快照的成分（带 ts / 无 ts / 解析失败 / 非字符串 / 结构异常）
       *          作为独立事实一并打印，不拿它去反推「有没有 ts」。 */
      const cov = `raw 快照 ${a.total} 条中：带 ts 的数据帧 ${a.frames} 条、` +
        `有 seq 无 ts ${a.noTs} 条、JSON 解析失败 ${a.parseFail} 条、` +
        `text 非字符串 ${a.notString} 条、结构异常 ${a.notObject} 条`;
      let why;
      if (frames.size === 1) {
        /* 出现过 ts，只是帧太少 —— 这是「帧数不足」，不是「ts 缺失」。 */
        why = `只累积到 1 帧带板端 ts 的数据帧（算间隔至少要 2 帧）—— ` +
          `板端 ts 是有的，不属于「NTP 未同步」；${cov}`;
      } else if (a.noTs > 0) {
        why = `帧里没有板端 ts（NTP 未同步，固件 time(NULL) 早于 2023 时不写 ts 字段）：${cov}`;
      } else if (a.parseFail + a.notString + a.notObject > 0) {
        why = `raw 里没有可解析的数据帧：${cov}`;
      } else {
        why = `raw ${a.total} 条里一帧周期数据都没有（可能全是 ESP-IDF 日志行 / ack 回执）：${cov}`;
      }
      skipped('样本量足够', why + (lastErr ? `；最后一次错误：${lastErr.message}` : ''));
      summary();
      return;
    }
    if (!windowRanFull) {
      skipped('样本量足够',
        `只采到 ${frames.size} 帧（需 ≥ ${MIN_FRAMES}），但采集窗口只跑了 ${elapsed}s` +
        `（应 ≥ ${(COLLECT_TIMEOUT_MS * 0.95 / 1000).toFixed(0)}s）—— 观测窗口不完整，不给结论` +
        (lastErr ? `；最后一次错误：${lastErr.message}` : ''));
      summary();
      return;
    }
    /* 窗口跑满、帧却不够 —— 这本身就是慢的证据，继续往下算。 */
    sampleStarved = true;
    console.log(`  ★ 采集窗口已跑满 ${elapsed}s，却只收到 ${frames.size} 帧有效数据帧` +
      `（需 ≥ ${MIN_FRAMES}）—— 等价于帧率不足 ${(frames.size / Number(elapsed)).toFixed(2)} fps`);
    console.log(`    这不是「样本不足无法判定」：窗口内该来的帧没来，本身就是退化。`);
    console.log(`    下面用手里这 ${frames.size} 帧照算中位数，并在判定段单独记一条失败。\n`);
  }

  /* ---------- ⑤ 算间隔，并把「真中断」与「上传缺帧」分开 ---------- */
  const list = [...frames.values()].sort((a, b) => a.ts - b.ts);
  const all = [];                 // [{d, ts}] 参与中位数的上传间隔
  let nonPositive = 0;            // 板端时钟回跳（ts 不增）
  let restart = 0;                // Δseq ≤ 0 = 真中断（重启 / 拔线 / seq 归零）
  let uploadGapPairs = 0;         // Δseq > 1 的对数 = 上传缺帧（退避跳过 / HTTP 失败 / 丢包）
  let uploadGapFrames = 0;        // 累计缺的帧数 Σ(Δseq-1)
  let clockJump = 0;              // Δseq===1 但 ts 跳 5s 以上且接收侧无空档 = NTP 校正
  let sampledFrames = 1;          // 板端实际采样帧数（按 seq 增量累加）

  for (let i = 1; i < list.length; i++) {
    const d = list[i].ts - list[i - 1].ts;          // 板端时间戳差
    const ds = list[i].seq - list[i - 1].seq;       // 板端 seq 差
    const recv = list[i].at - list[i - 1].at;       // 服务端接收时刻差
    if (d <= 0) { nonPositive++; continue; }        // 板端时钟回跳，不能参与统计

    /* ★ 这里是最关键的一处分流（旧实现把两种都当「seq 断号」剔除，是错的）：
     *   · Δseq ≤ 0 → seq 回退/归零，只可能是重启、拔线重连、串口重开。
     *     这一对间隔跨越了一次重启，必须剔除，否则「关机 10 分钟」会被算成帧间隔。
     *   · Δseq > 1 → 板端 seq 照常前进，中间 Δseq-1 帧采样了却没到服务端
     *     （退避窗口跳过上传 / HTTP 失败 / WiFi 丢包）。这**不是中断，是上传变慢本身**，
     *     必须保留进中位数 —— 丢掉它就等于把要测的现象过滤掉了。 */
    if (ds <= 0) { restart++; continue; }
    if (ds > 1) { uploadGapPairs++; uploadGapFrames += ds - 1; }
    sampledFrames += ds;

    /* Δseq === 1（板子确实只发了这一帧）但板端 ts 跳了 5s 以上：
     * 若服务端接收侧没有对应空档，说明是板端时钟被 NTP 校正跳变，不是帧率；
     * 若接收侧同样空着，那就是真的这么久才出一帧 —— 保留，让它进入中位数。
     * 接收时刻缺失（at=0）时无法判断，按「真的慢」处理，宁可报警不可漏报。 */
    const recvKnown = list[i].at > 0 && list[i - 1].at > 0;
    if (ds === 1 && d > MAX_GAP_MS && recvKnown && recv < d / 2) { clockJump++; continue; }

    all.push({ d, ts: list[i].ts });
  }

  /* 跨度必须用**净跨度**（Σ 有效间隔），不能用 last.ts - first.ts：
   * 后者把「重启关机的那段时间」也算进去，会让两个帧率都严重偏低。
   * 净跨度 = 所有参与统计的间隔之和，与 all/sampledFrames 口径自洽。 */
  const spanSec = all.reduce((s, x) => s + x.d, 0) / 1000;
  const arrivalFps = spanSec > 0 ? all.length / spanSec : 0;   // 上传帧率（实收）
  const sampledFps = spanSec > 0 ? sampledFrames / spanSec : 0; // 采样帧率估算（按 seq）
  const lossRate = sampledFrames > 0 ? uploadGapFrames / sampledFrames : 0;

  console.log('— 帧间隔分布 —');
  console.log(`  帧数 ${list.length}，时间跨度 ${spanSec.toFixed(1)}s，有效间隔 ${all.length} 个`);
  console.log(`  丢弃：时钟回跳 ${nonPositive}（ts 不增），真中断 ${restart}（seq 回退/归零 = 重启/拔线）`);
  if (uploadGapPairs > 0) {
    console.log(`  上传缺帧：${uploadGapPairs} 对相邻帧之间 seq 前跳，累计漏 ${uploadGapFrames} 帧` +
      `（占板端采样 ${(lossRate * 100).toFixed(1)}%）—— 这些间隔**已保留**在中位数里`);
  } else {
    console.log('  上传缺帧：0（板端每采样一帧就成功上传一帧）');
  }
  if (clockJump > 0) console.log(`  时钟跳变：${clockJump} 对（Δseq=1 但 ts 跳 5s 以上，已剔除）`);
  console.log('');
  console.log('  两个口径（务必分清，别混着说「帧率」）：');
  console.log(`    · 上传帧率（服务端实收，本测试判据）= ${arrivalFps.toFixed(2)} 帧/秒`);
  if (restart === 0) {
    console.log(`    · 采样帧率估算（按 seq 增量，仅无丢帧时可信）= ${sampledFps.toFixed(2)} 帧/秒`);
    /* 两种情形要分开说，否则会误导：
     *   A) 采样≈设计值 10 fps，只是上传少 → 纯「上传丢帧」（退避跳过上传）；
     *   B) 采样也明显低于 10 fps → 主循环节拍本身被拖慢了。因为 send_frame() 是在
     *      主循环里**同步**调用的（main.c:1668 → main.c:1001 http_upload()），
     *      HTTP 一阻塞，下一帧的 100ms 定时就到不了，seq 增量随之下降。
     *      实测 2026-10-28 生产：上传 1.08 fps / 采样估算 3.08 fps，属 B。 */
    const DESIGN_FPS = 10;
    if (sampledFps > arrivalFps * 1.3 && sampledFps >= DESIGN_FPS * 0.7) {
      console.log(`      → 板端采样 ${sampledFps.toFixed(2)} fps 接近设计值，只是上传稀疏 ${(sampledFps / arrivalFps).toFixed(1)} 倍：`);
      console.log(`        纯「上传丢帧」形态（退避跳过 / 单次上传失败），主循环节拍没被拖慢。`);
    } else if (sampledFps > arrivalFps * 1.3) {
      console.log(`      → 板端采样 ${sampledFps.toFixed(2)} fps 也远低于设计值 ${DESIGN_FPS} fps：`);
      console.log(`        主循环节拍**已被拖慢**（send_frame 在主循环里同步调用 http_upload，`);
      console.log(`        HTTP 阻塞期间下一帧的 ${100}ms 定时到不了），上传又进一步稀疏 ${(sampledFps / arrivalFps).toFixed(1)} 倍。`);
    } else {
      console.log(`      → 采样与上传节拍基本一致（每帧采样都成功上传）：` +
        `若两者都低于设计值，慢在整体节拍（主循环被同步 HTTP 往返拖住）。`);
    }
  } else {
    console.log(`    · 采样帧率估算：因检测到 ${restart} 次重启，seq 不连续，本次不给估算`);
  }
  console.log('');

  /* 有效间隔的底线（F3）：正常路径要求 MIN_FRAMES-1 个间隔才给结论；但「窗口跑满
   * 却帧稀疏」这条路径已经判定为退化，只要够 MIN_DEGRADED_INTERVALS 个间隔就必须算，
   * 否则 0.33 fps 又会掉回 skip。此时中位数在 3000ms 量级，离 250ms 阈值极远，
   * 有限样本的统计风险远小于「漏报极端退化」的风险。 */
  const intervalFloor = sampleStarved ? MIN_DEGRADED_INTERVALS : MIN_FRAMES - 1;
  if (all.length < intervalFloor) {
    skipped('有效间隔足够',
      `只剩 ${all.length} 个间隔（需 ≥ ${intervalFloor}${sampleStarved ? '，退化路径下限' : ''}），无法给出中位数` +
      (restart ? `；其中 ${restart} 对因 seq 回退被排除（重启/拔线）` : ''));
    summary();
    return;
  }

  /* ---------- ⑥ 全局中位数（硬门） ---------- */
  const gaps = all.map((x) => x.d);
  const med = median(gaps);
  const fps = 1000 / med;
  console.log('— 全局 —');
  console.log(`  中位上传间隔 ${med.toFixed(1)}ms  →  ${fps.toFixed(2)} fps`);
  console.log(`  p10 ${pct(gaps, 0.10).toFixed(0)}ms / p90 ${pct(gaps, 0.90).toFixed(0)}ms` +
    ` / min ${Math.min(...gaps).toFixed(0)}ms / max ${Math.max(...gaps).toFixed(0)}ms`);
  console.log(`  阈值 ${MAX_MEDIAN_MS}ms（中位间隔不得超过它）\n`);

  /* ---------- ⑦ 多窗口：防止恰好挑到链路好的几十秒 ---------- */
  const wins = [];
  for (let w = 0; w < WINDOWS; w++) {
    const from = Math.floor((w * all.length) / WINDOWS);
    const to = Math.floor(((w + 1) * all.length) / WINDOWS);
    const seg = all.slice(from, to);
    const v = windowVerdict(seg);
    const wSpan = seg.reduce((s, x) => s + x.d, 0) / 1000;   // 净跨度，与全局口径一致
    wins.push({ seg, v, wSpan });
  }
  console.log('— 分窗口（各窗口按时间顺序等量切分）—');
  wins.forEach((w, i) => {
    const tag = w.v.state === 'bad' ? '超标 ✗' : w.v.state === 'good' ? '正常' : '样本不足 ⊘';
    const medTxt = Number.isFinite(w.v.med) ? `${w.v.med.toFixed(0)}ms` : '—';
    console.log(`  窗口${i + 1}  ${medTxt.padStart(7)}  ${String(w.seg.length).padStart(3)} 个间隔` +
      ` / ${w.wSpan.toFixed(1)}s  ${tag}`);
  });
  const judged = wins.filter((w) => w.v.state !== 'few');
  const badWins = judged.filter((w) => w.v.state === 'bad').length;
  const badRatio = judged.length ? badWins / judged.length : 0;
  console.log('');

  /* ---------- ⑧ 判定 ---------- */
  console.log('— 判定 —');
  /* ★ 采样量硬门（F3，2026-10-28）：窗口跑满却凑不满 MIN_FRAMES 帧，本身就是退化。
   * 旧实现把它当 skip（exit 0），0.33 fps 这种最该报警的场景被静默放过。
   * 这里与中位数判据并列成独立失败项，避免「有限的帧恰好算出一个好看的中位数」把人骗过去。 */
  ok(!sampleStarved,
    `采集窗口内收到 ≥ ${MIN_FRAMES} 帧有效数据帧`,
    sampleStarved
      ? `只收到 ${frames.size} 帧 / ${elapsed}s，等价帧率 ${(frames.size / Number(elapsed)).toFixed(2)} fps —— ` +
        `低于 ${(MIN_FRAMES / Number(elapsed)).toFixed(2)} fps 即视为退化（不是「样本不足无法判定」）`
      : `${frames.size} 帧 / ${elapsed}s`);
  ok(med <= MAX_MEDIAN_MS,
    `全局中位上传间隔 ≤ ${MAX_MEDIAN_MS}ms`,
    `实测 ${med.toFixed(1)}ms（${fps.toFixed(2)} fps），阈值 ${MAX_MEDIAN_MS}ms（${(1000 / MAX_MEDIAN_MS).toFixed(1)} fps）`);
  /* 窗口占比判据只在「有窗口能给出结论」时才有意义。退化路径下帧太少时，切出来的
   * 每段可能都不足 MIN_WINDOW_INTERVALS（judged.length===0），此时这条判据无从谈起
   * —— 但退化本身已由上面的「采样量硬门」「全局中位数」两条判失败，所以这里记为
   * SKIP 而不是 FAIL，避免打出「有结论窗口 0 个，超标 0 个（0%）」这种自相矛盾的报错。 */
  if (judged.length === 0) {
    skipped(`${WINDOWS} 个窗口里超标占比 < ${(FAIL_WINDOW_RATIO * 100).toFixed(0)}%`,
      `${WINDOWS} 个窗口每段都不足 ${MIN_WINDOW_INTERVALS} 个间隔（总间隔只有 ${all.length} 个）` +
      ` —— 退化已由「采样量」「全局中位数」两条判定，本条不参与`);
  } else {
    ok(badRatio < FAIL_WINDOW_RATIO,
      `${WINDOWS} 个窗口里超标占比 < ${(FAIL_WINDOW_RATIO * 100).toFixed(0)}%`,
      `有结论窗口 ${judged.length} 个，其中超标 ${badWins} 个（${(badRatio * 100).toFixed(0)}%）` +
      (judged.length < WINDOWS ? `；另有 ${WINDOWS - judged.length} 个窗口样本不足未参与判定` : ''));
  }

  // 辅助信息：不判失败，但把「退化到什么程度」写清楚，便于人工判断要不要立案排查
  if (sampleStarved || med > MAX_MEDIAN_MS || badRatio >= FAIL_WINDOW_RATIO) {
    const ratio = med / 100;   // 相对设计值 100ms 慢了几倍
    console.log(`\n  ★ 上传帧率退化：比设计值 REPORT_INTERVAL_MS=100 慢 ${ratio.toFixed(1)} 倍` +
      `（${fps.toFixed(2)} fps，应 ≥ ${(1000 / MAX_MEDIAN_MS).toFixed(1)} fps）`);
    if (restart === 0 && sampledFps > arrivalFps * 1.3) {
      console.log(`    采样帧率估算 ${sampledFps.toFixed(2)} fps 高于上传帧率 ${arrivalFps.toFixed(2)} fps：`);
      console.log(`    → 除上传本身外，还有 ${(sampledFps / arrivalFps).toFixed(1)} 倍的帧没上传成功（退避跳过 / HTTP 失败）。`);
    }
    printCauses();
  } else if (med > 150) {
    console.log(`\n  提示：中位上传间隔 ${med.toFixed(1)}ms 已高于正常区间（110-150ms），` +
      `虽在阈值内但建议观察趋势。`);
  }

  // 时钟跳变是独立问题，只提示不判失败（否则会掩盖真正的帧率结论）
  if (nonPositive > 0) {
    skipped('板端时钟单调递增', `${nonPositive} 个非正间隔（NTP 回跳），已从统计中剔除`);
  }

  summary();
})().catch((e) => {
  console.error('\n测试异常终止：', e && e.stack || e);
  process.exit(1);
});
