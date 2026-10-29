'use strict';
/** 第 5 周收尾：命令通道「下发 ≠ 板端已接受」回归测试
 *
 * 存在理由（实测缺陷，不是推测）：
 *   2026-10-26 POST /api/voice/record 返回 ok=true accepted=true，
 *   但板端固件 voice_record.c:571 的 voice_record_toggle() 首段是
 *     if (s_uploading) { ESP_LOGW(...); return false; }
 *   main.c:1377-1388 据此回 cmd_ack(rid, "busy") —— 命令被板端丢弃，
 *   服务端却报成功。根因：sendCommand() 里 port.write(..., cb) 的回调
 *   只记错误、不等回执，于是「字节写进驱动缓冲」被当成了「板端已接受」。
 *
 * 本测试覆盖的四种结局（全部通过真实 HTTP 交互驱动，不打桩）：
 *   accepted           —— 板端回 ack 且 status 非 busy/error
 *   busy               —— 板端回 ack status=busy（命令被丢弃）
 *   timeout            —— 命令确实下发，但超时内没等到 ack
 *   channel_unavailable—— 串口没开且板端未轮询，必须如实报失败
 * 外加 mockDevice 模式：不得假装收到真实 ack。
 *
 * 隔离纪律（test/isolation-contract-test.js 强制）：
 *   · 端口从 8090-8099 里挑一个当前空闲的（不固定占用，避免与其它测试撞车）
 *   · 独立 DATA_DIR = test/.test-data-ack（被 .gitignore 的 test/.test-data* 覆盖）
 *   · 独立 CONFIG_PATH = test/.test-data-ack/config.json（运行时拷贝夹具再改，
 *     绝不 POST /api/config 去重写 test/.test-config.json 这个受版本控制的夹具）
 *   · autoDetect=false：绝不打开真实板子的串口
 *
 * 用法：node test/command-ack-test.js
 */
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
/* 每个进程一个独立目录（审查 F8）：原写法是固定 `.test-data-ack`，两个实例并发时
 * 会互相 rmSync、互相重写 config.json，实测一方 68/0、另一方 46/3（ECONNRESET）——
 * 红点会指向被测代码而不是测试自身。run-all 串行执行时不触发，但多成员/CI 并行时会。
 * 端口已由 pickPort() 动态挑，这里补上目录唯一性即可。 */
const DATA_DIR = path.join(__dirname, `.test-data-ack-${process.pid}`);
const CONFIG_FIXTURE = path.join(__dirname, '.test-config.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ACK_TIMEOUT_MS = 700;      // 测试用的 ack 等待时长，靠 COMMAND_ACK_TIMEOUT_MS 注入
const DEVICE = 'S3EYE-ACKTEST';

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.error('  ✗', m + (extra ? '  -> ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- HTTP 小工具（http.request 而不是 fetch：要显式控制超时） ---------- */
function httpReq(port, method, p, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(body === undefined ? null : body);
    const r = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: body === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text || '{}'); } catch (_) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('timeout', () => { r.destroy(new Error(`请求超时（${timeoutMs}ms）：${method} ${p}`)); });
    r.on('error', reject);
    if (body !== undefined) r.write(s);
    r.end();
  });
}

/* ---------- 端口：8090-8099 里挑一个空闲的 ---------- */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function pickPort() {
  for (let p = 8090; p <= 8099; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error('8090-8099 全被占用，无法自建隔离实例');
}

/* ---------- 启动 / 等待 / 停止隔离实例 ---------- */
function startServer(port, { mockDevice = false, ackExtraMs = 0 } = {}) {
  // 每次启动都重新拷贝夹具，避免上一个实例的 saveConfig 影响下一个
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FIXTURE, 'utf8'));
  cfg.mockDevice = mockDevice;
  cfg.autoDetect = false;
  cfg.autoReconnect = false;
  cfg.httpPort = port;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1',
      CONFIG_PATH,
      DATA_DIR,                                   // ★ 隔离数据目录，绝不写真实 data/
      COMMAND_ACK_TIMEOUT_MS: String(ACK_TIMEOUT_MS),
      /* WiFi 通道的额外回执预算默认关掉（0）：本套件多数用例要测「等不到回执」，
       * 保留生产默认值会让每个 timeout 用例多等 1.2 秒。单独用 ⑨ 号用例验它。 */
      COMMAND_ACK_WIFI_EXTRA_MS: String(ackExtraMs),
      NL_CONFIG_PATH: path.join(__dirname, '.test-nl-local-absent.json'),
      NL_ENDPOINT: '', NL_API_KEY: '',
    }),
    stdio: 'ignore',
  });
}
async function waitReady(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await httpReq(port, 'GET', '/api/state');
      if (r.status === 200) return true;
    } catch (_) { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}
async function stopServer(srv) {
  if (!srv || srv.killed) return;
  try { srv.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
  await sleep(200);
}

/* 让服务端认为「板端正通过 WiFi 轮询取命令」（wifiDownlinkActive 判据是
 * stats.lastCmdPollAt 在 2 秒内）。这是模拟板端轮询的唯一手段，不发命令。 */
const pollOnce = (port) => httpReq(port, 'GET', `/api/cmd?device=${DEVICE}`);

/* 排空下行队列：sendCommand() 在通道不可用时也会入队（这是既有设计，
 * 让板端上线后仍能取走），必须清干净，否则后面的用例会取到上一条陈旧命令。 */
async function drainQueue(port, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await pollOnce(port);
    if (!r.json || !r.json.cmd) return true;
  }
  return false;
}

/* 等 /api/cmd 真的吐出我们关心的那条命令（带 request_id 的命令对象） */
async function waitForQueuedCommand(port, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await pollOnce(port);
    const cmd = r.json;
    if (cmd && cmd.cmd) return cmd;
    await sleep(40);
  }
  return null;
}

/* 板端回执上行：走真实上行入口 POST /api/data（与固件同一路径） */
const postAck = (port, rid, status, seq = 4434) => httpReq(port, 'POST', '/api/data', {
  type: 'ack', device: DEVICE, request_id: rid, seq, status,
});
/* 发一次录音命令；返回 { resp, cmd } —— cmd 是被板端取走的那条下行命令。
 * 先 pollOnce()：wifiDownlinkActive() 的判据是「板端 2 秒内来取过命令」，
 * 不先让服务端看到轮询，命令会被判成通道不可用（那是另一个用例的语义）。 */
async function sendRecordAndAck(port, ackStatus) {
  await pollOnce(port);
  const pending = httpReq(port, 'POST', '/api/voice/record', { action: 'start' });
  const cmd = await waitForQueuedCommand(port);
  if (cmd && ackStatus) {
    await postAck(port, cmd.request_id, ackStatus);
  }
  const resp = await pending;
  return { resp, cmd };
}

/* ---------- 静态契约：确认改造点确实存在且旧写法已移除 ---------- */
function staticContract() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/function sendCommandAndWaitAck\s*\(/.test(src), 'server.js 提供 sendCommandAndWaitAck()（发命令 + 等 ack）');
  ok(/function createAckWaiter\s*\(/.test(src), 'server.js 提供按 request_id 登记的等待槽');
  ok(/function settlePendingAck\s*\(/.test(src), 'server.js 在上行 ack 到达时结算等待槽');
  ok(/settlePendingAck\(obj\.request_id/.test(src), 'handleLine 的 type:"ack" 分支已接入等待槽结算');
  ok(/function classifyAckStatus\s*\(/.test(src), 'server.js 区分 ack status（busy / error / accepted）');
  ok(/commandAckTimeoutMs/.test(src) && /COMMAND_ACK_TIMEOUT_MS/.test(src),
    'ack 超时时长可配置（config.commandAckTimeoutMs / 环境变量 COMMAND_ACK_TIMEOUT_MS）');
  /* 2026-10-28 修复：channel 必须取真实写路径，不能再用 serialOpen() 反推。
   * 反推写法在 port.write() 抛异常（落到入队分支）时会把 wifi 命令报成 serial，
   * 取证时把人引向「串口开着为什么没回执」的错误方向。 */
  ok(/function sendCommandEx\s*\(/.test(src), 'server.js 提供 sendCommandEx()（返回真实通道）');
  /* 按行判定，跳过注释行 —— 修复说明里会引用旧写法原文，
   * 直接对全文做正则会把注释里的引用当成"仍在使用"。 */
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  });
  ok(!codeLines.some((l) => /serialOpen\(\) \? 'serial' : 'wifi'/.test(l)),
    '旧写法 channel = serialOpen() ? "serial" : "wifi"（用串口开关猜通道）已从代码中移除');
  ok(/settlePendingAck\(\s*obj\.request_id,\s*obj\.status,\s*obj\.seq,\s*\n?\s*\(source && source\.transport\)/
    .test(src), 'ack 结算时记录回执实际到达的上行通道（第 4 参数）');
  ok(/function ackTimeoutNote\s*\(/.test(src), 'server.js 提供 ackTimeoutNote()（超时给出可执行排查方向）');
  // 两个分支都要能落地：串口模式指向 raw 里的 ack 原文，WiFi 模式指向轮询状态
  const noteFn = /function ackTimeoutNote\(channel\)[\s\S]{0,2200}?\n\}/.exec(src);
  ok(!!noteFn, '找到 ackTimeoutNote() 实现');
  if (noteFn) {
    ok(/channel === 'serial'/.test(noteFn[0]), 'ackTimeoutNote 按通道分流（串口 / WiFi 两套排查方向）');
    ok(/raw/.test(noteFn[0]) && /request_id/.test(noteFn[0]),
      '串口分支指向 /api/state 的 raw 与 request_id 比对（可落地）');
    ok(/wifiPolling/.test(noteFn[0]) && /queued/.test(noteFn[0]),
      'WiFi 分支指向 downlink.wifiPolling / queued（区分"没取走"与"回执上行失败"）');
  }
  // 旧缺陷写法：把 sendCommand 的返回值直接当 accepted
  const voiceBlock = /if \(p === '\/api\/voice\/record'[\s\S]{0,2400}?\n  \}/.exec(src);
  ok(!!voiceBlock, '找到 /api/voice/record 处理块');
  if (voiceBlock) {
    const b = voiceBlock[0];
    ok(!/accepted:\s*ok\b/.test(b), '旧写法 accepted: ok（把写串口当板端接受）已移除');
    ok(/sendCommandAndWaitAck\s*\(/.test(b), '/api/voice/record 改用 sendCommandAndWaitAck()');
    ok(/outcome/.test(b), '返回体带 outcome 字段（accepted/busy/timeout/…）');
    ok(/dispatched/.test(b), '返回体把 dispatched 与 accepted 分开');
    ok(/queued/.test(b) && /ack_channel/.test(b),
      '返回体带 queued（是否入队）与 ack_channel（回执走哪条上行）');
    ok(/withdrawn/.test(b), '返回体带 withdrawn（通道不可用时命令是否已撤回）');
    /* 审查 blocker F1 的静态契约：request_id 必须带单调序号。
     * 旧写法 `voice-rec-${Date.now()}` 同毫秒撞号 → 等待槽被覆盖 → 请求永久挂死。 */
    ok(/voice-rec-\$\{Date\.now\(\)\}-\$\{\+\+ackRequestSeq\}/.test(b),
      'request_id 带单调序号（同毫秒并发也不会撞号）');
  }
  // 撞号时不得静默覆盖旧等待槽（否则先登记的请求永不结算）
  ok(/PENDING_ACKS\.has\(requestId\)/.test(src), 'createAckWaiter 检测 request_id 撞号');
  ok(/request_id_collision/.test(src), '撞号时返回明确结局 outcome=request_id_collision');
  ok(/hardTimer/.test(src), '等待槽有硬兜底定时器（任何异常都不许永久挂起）');
  ok(/COMMAND_ACK_WIFI_EXTRA_MS/.test(src) && /commandAckWifiExtraMs/.test(src),
    'WiFi 通道额外回执预算可配置（config.commandAckWifiExtraMs / 环境变量 COMMAND_ACK_WIFI_EXTRA_MS）');
  ok(/function withdrawQueuedCommand\s*\(/.test(src),
    'server.js 提供 withdrawQueuedCommand()（通道不可用时撤回已入队命令）');
}

(async () => {
  console.log('\n— 命令通道 ack 回归（第 5 周收尾）—\n');
  console.log('  ① 静态契约');
  staticContract();

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const port = await pickPort();
  let srv = startServer(port);
  const ready = await waitReady(port);
  ok(ready, `隔离实例已就绪（端口 ${port}，DATA_DIR=${path.relative(ROOT, DATA_DIR)}）`);

  try {
    /* ---------- ② 通道不可用：不得谎报成功 ---------- */
    console.log('\n  ② 通道不可用（串口未开 + 板端未轮询）');
    const none = await httpReq(port, 'POST', '/api/voice/record', { action: 'start' });
    ok(none.json && none.json.ok === false, 'ok=false（不谎报成功）', `ok=${none.json && none.json.ok}`);
    ok(none.json && none.json.accepted === false, 'accepted=false');
    ok(none.json && none.json.dispatched === false, 'dispatched=false（命令没进任何通道）');
    ok(none.json && none.json.outcome === 'channel_unavailable',
      'outcome=channel_unavailable', none.json && none.json.outcome);
    ok(none.json && typeof none.json.note === 'string' && /[\u4e00-\u9fa5]/.test(none.json.note),
      '给出明确中文原因', none.json && none.json.note);
    /* 审查 F5（2026-10-28 修复）：通道不可用时命令不能留在队列里。
     * 原实现只 cancel 等待槽、命令仍入队（TTL 15s），实测 POST 返回
     * channel_unavailable 后板端 GET /api/cmd 仍能取到这条命令 ——
     * 用户按报错重试就会录两段，而服务端只认后面那条的回执。
     * 现在必须撤回：withdrawn=true 且 queued=false。 */
    ok(none.json && none.json.withdrawn === true,
      '命令已从下行队列撤回（板端不会再执行这条被报"没送达"的命令）',
      `withdrawn=${none.json && none.json.withdrawn}`);
    ok(none.json && none.json.queued === false,
      'queued=false —— 撤回成功就不再声称"已入队待取"',
      `queued=${none.json && none.json.queued}`);
    // 撤回必须是真的：再去队列里取一次，不应再拿到任何命令
    ok(await drainQueue(port), '撤回后队列里已取不到这条命令（真的撤掉了，不是只改了字段）');

    /* ---------- ③ 纯 WiFi 在线时，ack 不会被「串口优先」规则挡掉 ----------
     * 固件 ack_task 走 POST /api/data，而 /api/data 有一条「串口优先」规则：
     * state.transport==='serial' && state.connected 时直接返回 {ignored:'serial-active'}
     * 并把 body 整个丢掉。所以必须实测：纯 WiFi 场景（transport='wifi' 且
     * connected=true）下 ack 真能进 handleLine 并结算 —— 否则固件双通道改了也白改。
     * 先发一帧真实观测把 connected 置 true（ack 行本身不会置 connected）。 */
    console.log('\n  ③ 纯 WiFi 在线（transport=wifi, connected=true）时 ack 不被挡掉');
    const frame = await httpReq(port, 'POST', '/api/data', {
      device: DEVICE, seq: 9001, temp_c: 25.5, adc0: 1800, uptime: 1,
    });
    ok(frame.status === 200 && !(frame.json || {}).ignored,
      '/api/data 接受了合成观测帧（未被「串口优先」忽略）', JSON.stringify(frame.json));
    const stOnline = (await httpReq(port, 'GET', '/api/state')).json || {};
    ok(stOnline.transport === 'wifi' && stOnline.connected === true,
      '此时确实处于纯 WiFi 在线态（transport=wifi, connected=true）',
      `transport=${stOnline.transport} connected=${stOnline.connected}`);
    // 在这个状态下走一次完整闭环：WiFi 下行 + WiFi 上行 ack
    await pollOnce(port);
    const wifiPending = httpReq(port, 'POST', '/api/voice/record', { action: 'start' });
    const wifiCmd = await waitForQueuedCommand(port);
    if (wifiCmd) await postAck(port, wifiCmd.request_id, 'recording');
    const wifiAck = await wifiPending;
    const wj = wifiAck.json || {};
    ok(wj.outcome === 'accepted' && wj.ack_channel === 'wifi',
      '纯 WiFi 在线态下 ack 真的从 POST /api/data 进来并结算（下行 WiFi → 上行 WiFi 闭环成立）',
      `outcome=${wj.outcome} ack_channel=${wj.ack_channel}`);

    /* ---------- ④ 板端回 ack status=recording → accepted ---------- */
    console.log('\n  ④ 板端回 ack status=recording → accepted');
    await pollOnce(port);                       // 先让服务端看到「板端在轮询」
    const a = await sendRecordAndAck(port, 'recording');
    const aj = a.resp.json || {};
    ok(!!a.cmd, '命令确实经 WiFi 队列下发到板端（/api/cmd 取到 voice_record）',
      a.cmd ? JSON.stringify(a.cmd) : '没取到命令');
    ok(aj.ok === true, 'ok=true（向后兼容字段仍在）');
    ok(aj.accepted === true, 'accepted=true（板端真的接受了）');
    ok(aj.dispatched === true, 'dispatched=true');
    ok(aj.outcome === 'accepted', 'outcome=accepted', aj.outcome);
    ok(aj.ack_status === 'recording', 'ack_status 原样回传板端状态', aj.ack_status);
    ok(aj.channel === 'wifi', 'channel=wifi', aj.channel);
    /* 2026-10-28：纯 WiFi 模式（串口不开）下命令只能走队列，
     * 回执也只能从 WiFi 上行回来 —— 这两个字段是取证链路的关键，
     * 之前固件 ack 只走串口，这种模式下必然 timeout（从"谎报成功"翻成"谎报失败"）。 */
    ok(aj.queued === true, 'queued=true（命令进了 WiFi 待取队列）', String(aj.queued));
    ok(aj.ack_channel === 'wifi', 'ack_channel=wifi（回执确实从 WiFi 上行回来）', aj.ack_channel);
    ok(typeof aj.waited_ms === 'number' && aj.waited_ms >= 0, 'waited_ms 有实测值', `${aj.waited_ms}ms`);
    ok(aj.request_id === (a.cmd && a.cmd.request_id), 'request_id 与下发的一致（回环校验）');
    // /api/state 要能取证「下发」与「板端接受」的区别，便于事后核查
    const stAck = (await httpReq(port, 'GET', '/api/state')).json || {};
    ok(stAck.commandAck && stAck.commandAck.lastOutcome === 'accepted',
      '/api/state 记录最近一次回执结局（commandAck.lastOutcome=accepted）',
      JSON.stringify(stAck.commandAck));
    ok(stAck.commandAck && stAck.commandAck.timeoutMs > 0, '超时时长可观测（commandAck.timeoutMs）',
      stAck.commandAck && stAck.commandAck.timeoutMs);
    ok(stAck.commandAck && stAck.commandAck.lastCommandChannel === 'wifi',
      '/api/state 记录命令实际走的下行通道（lastCommandChannel=wifi）',
      stAck.commandAck && stAck.commandAck.lastCommandChannel);
    ok(stAck.commandAck && stAck.commandAck.lastAckChannel === 'wifi',
      '/api/state 记录回执实际回来的上行通道（lastAckChannel=wifi）',
      stAck.commandAck && stAck.commandAck.lastAckChannel);
    // /api/diag 与 /api/state 两处的 commandAck 必须口径一致，
    // 否则排查时看哪个接口得出的结论不同（历史上两处曾各写一套）
    const dgAck = (await httpReq(port, 'GET', '/api/diag')).json || {};
    ok(dgAck.commandAck && dgAck.commandAck.lastOutcome === 'accepted'
      && dgAck.commandAck.lastCommandChannel === 'wifi'
      && dgAck.commandAck.lastAckChannel === 'wifi',
      '/api/diag 的 commandAck 与 /api/state 口径一致（结局 + 上下行通道）',
      JSON.stringify(dgAck.commandAck));
    /* ★ 纯 WiFi 模式下 ack 能进 handleLine 的实测证据（不靠读代码）。
     * /api/data 有一条「串口优先」规则：state.transport==='serial' && connected
     * 时直接返回 {ignored:'serial-active'} 并把 body 丢掉。固件 ack_task 走的正是
     * /api/data，所以必须确认纯 WiFi 场景（transport='wifi'、connected=true）
     * 不会踩到那条规则 —— 否则固件双通道改了也白改（已在 ③ 号用例里单独验证）。 */
    ok(stAck.transport === 'wifi' && stAck.connected === true,
      '当前是纯 WiFi 模式（transport=wifi, connected=true），不会触发「串口优先」忽略',
      `transport=${stAck.transport} connected=${stAck.connected}`);

    /* ---------- ④ 板端回 ack status=busy → 不得报成功（本次缺陷的核心） ---------- */
    console.log('\n  ④ 板端回 ack status=busy → busy（命令被丢弃）');
    const b = await sendRecordAndAck(port, 'busy');
    const bj = b.resp.json || {};
    ok(bj.ok === false, 'ok=false —— 板端 busy 时不再报成功（原缺陷：ok=true）');
    ok(bj.accepted === false, 'accepted=false');
    ok(bj.dispatched === true, 'dispatched=true —— 但「写出去了」与「板端接受」已分开');
    ok(bj.outcome === 'busy', 'outcome=busy', bj.outcome);
    ok(bj.ack_status === 'busy', 'ack_status=busy', bj.ack_status);
    ok(typeof bj.note === 'string' && /忙/.test(bj.note), 'note 说明板端忙', bj.note);

    /* ---------- ⑤ 下发成功但没等到 ack → timeout ---------- */
    console.log(`\n  ⑤ 板端取走命令但不回执 → timeout（等待 ${ACK_TIMEOUT_MS}ms）`);
    const t0 = Date.now();
    const c = await sendRecordAndAck(port, null);
    const elapsed = Date.now() - t0;
    const cj = c.resp.json || {};
    ok(!!c.cmd, '命令确实被板端取走（不是通道问题）');
    ok(cj.ok === false, 'ok=false —— 没收到回执就不算成功');
    ok(cj.accepted === false, 'accepted=false');
    ok(cj.dispatched === true, 'dispatched=true');
    ok(cj.outcome === 'timeout', 'outcome=timeout', cj.outcome);
    ok(elapsed >= ACK_TIMEOUT_MS - 100, `确实等满了超时时长（实测 ${elapsed}ms）`);
    ok(typeof cj.note === 'string' && /回执|超时/.test(cj.note), 'note 说明是没收到回执', cj.note);
    /* 超时文案必须能落地：按实际通道给出下一步该看哪里。
     * WiFi 通道要看 wifiPolling / queued —— 区分「板端没来取命令」与
     * 「命令取走了但回执上行失败」，这两者修法完全不同。 */
    ok(cj.channel === 'wifi' && /wifiPolling/.test(String(cj.note)),
      'WiFi 通道超时的 note 指向 downlink.wifiPolling / queued（可落地排查）', cj.note);
    ok(cj.ack_channel === null,
      '超时时 ack_channel 为空（没收到回执就不能编造上行通道）', String(cj.ack_channel));

    /* ---------- ⑥ 回执必须按 request_id 匹配（别人的 ack 不算我的） ---------- */
    console.log('\n  ⑥ 回执按 request_id 匹配：不相关 rid 的 ack 不能冒充');
    await pollOnce(port);
    const dPending = httpReq(port, 'POST', '/api/voice/record', { action: 'start' });
    const dCmd = await waitForQueuedCommand(port);
    await postAck(port, 'voice-rec-完全不相关的-rid', 'recording');   // 先回一条假的
    const dResp = await dPending;
    const dj = dResp.json || {};
    ok(dj.outcome === 'timeout', '不匹配 rid 的 ack 不会让本次判 accepted', dj.outcome);
    ok(dj.ok === false, 'ok=false');

    /* ---------- ⑦ 板端明确报错 → error ---------- */
    console.log('\n  ⑦ 板端回 ack status=no_camera → error');
    const e = await sendRecordAndAck(port, 'no_camera');
    const ej = e.resp.json || {};
    ok(ej.outcome === 'error', 'outcome=error（板端拒绝/失败不再算接受）', ej.outcome);
    ok(ej.ok === false && ej.accepted === false, 'ok=false 且 accepted=false');

    /* ---------- ⑧ 并发：request_id 不得撞号，任何请求都不许永久挂死 ----------
     * 审查 blocker F1 的回归用例。旧实现 `voice-rec-${Date.now()}` 在同一毫秒内
     * 会撞号，等待槽被后登记的覆盖，先登记的那个 await 永不 resolve ——
     * 实测同 tick 发 8 个 POST 只回 2 个、挂死 6 个，且再等 3 倍超时也不恢复。
     * 本用例要求：8 个请求全部在有限时间内返回、rid 互不相同、结局一致为 timeout。 */
    console.log('\n  ⑧ 并发 8 个请求：rid 不撞号、无请求永久挂死');
    await pollOnce(port);
    const N = 8;
    const t1 = Date.now();
    const many = await Promise.all(Array.from({ length: N }, () =>
      httpReq(port, 'POST', '/api/voice/record', { action: 'start' }, 15000)));
    const waited = Date.now() - t1;
    const rids = many.map((r) => (r.json || {}).request_id);
    ok(many.every((r) => r.status === 200),
      `${N} 个并发请求全部拿到响应（没有一个挂死）`,
      `耗时 ${waited}ms`);
    ok(new Set(rids).size === N, `request_id 互不相同（${new Set(rids).size}/${N} 唯一）`,
      rids.join(', '));
    const outcomes = many.map((r) => (r.json || {}).outcome);
    ok(outcomes.every((o) => o === 'timeout'),
      '全部如实报 timeout（板端取走但没回执）', outcomes.join(', '));
    ok(many.every((r) => (r.json || {}).ok === false),
      '全部 ok=false —— 并发下也不谎报成功');
    // 兜底：等超过「超时 + 硬兜底」后，仍不能有任何等待槽残留
    const stAfter = (await httpReq(port, 'GET', '/api/state')).json || {};
    ok(stAfter.commandAck && stAfter.commandAck.pendingAcks === 0,
      '并发结束后没有残留等待槽（pendingAcks=0）',
      JSON.stringify(stAfter.commandAck));
    await drainQueue(port);

    /* ---------- ⑨ WiFi 通道额外回执预算（2026-10-28） ----------
     * 背景：固件 ack 走 http_post，每次 esp_http_client_init 新建 TCP、无 keep-alive，
     * 板端空口 RTT 实测 p50 124–409ms，一次「建连 + 发一行」在丢包重传下可达 1–3s，
     * 与 1800ms 默认预算同量级。所以纯 WiFi 通道单独加一份预算（默认 +1200ms）。
     * 这里用「ack 超时 700ms + 额外 800ms」验证：回执在 700ms 之后、1500ms 之前到达时，
     * 改造前会被判 timeout（谎报失败），改造后应判 accepted。 */
    console.log('\n  ⑨ WiFi 通道额外回执预算：慢回执（700ms 后到达）不再误判 timeout');
    await stopServer(srv);
    srv = startServer(port, { ackExtraMs: 800 });
    ok(await waitReady(port), '带额外预算的实例已就绪');
    await pollOnce(port);
    const slowPending = httpReq(port, 'POST', '/api/voice/record', { action: 'start' });
    const slowCmd = await waitForQueuedCommand(port);
    ok(!!slowCmd, '命令已下发到板端');
    await sleep(ACK_TIMEOUT_MS + 250);          // 故意越过基础超时 700ms
    if (slowCmd) await postAck(port, slowCmd.request_id, 'recording');
    const slow = await slowPending;
    const sj = slow.json || {};
    ok(sj.outcome === 'accepted',
      `慢回执仍被判 accepted（改造前会误判 timeout，谎报失败）`, sj.outcome);
    ok(sj.ack_status === 'recording', 'ack_status=recording', sj.ack_status);
    ok(typeof sj.waited_ms === 'number' && sj.waited_ms > ACK_TIMEOUT_MS,
      `waited_ms 超过基础超时（实测 ${sj.waited_ms}ms > ${ACK_TIMEOUT_MS}ms）`);
    ok(sj.timeout_ms === ACK_TIMEOUT_MS + 800,
      '返回体如实报出 WiFi 通道的实际等待预算', String(sj.timeout_ms));

    /* ---------- ⑩ mockDevice：不得假装收到真实 ack ---------- */
    console.log('\n  ⑩ mockDevice=true：不伪造板端回执');
    await stopServer(srv);
    srv = startServer(port, { mockDevice: true });
    ok(await waitReady(port), 'mock 实例已就绪');
    const m = await httpReq(port, 'POST', '/api/voice/record', { action: 'start' });
    const mj = m.json || {};
    ok(mj.outcome === 'mock', 'outcome=mock（不是 accepted）', mj.outcome);
    ok(mj.ok === false && mj.accepted === false, 'ok=false 且 accepted=false（没有真实回执就不算接受）');
    ok(mj.simulated === true, 'simulated=true 明确标注模拟');
    ok(mj.ack_status == null, 'ack_status 为空 —— 没有伪造板端状态', String(mj.ack_status));
    ok(mj.channel === null && mj.queued === false,
      'mock 下 channel 为空、queued=false —— 不假装走过任何真实通道',
      `channel=${mj.channel} queued=${mj.queued}`);
    ok(typeof mj.note === 'string' && /模拟/.test(mj.note), 'note 说明是模拟模式', mj.note);
  } catch (err) {
    console.error('测试异常：', err);
    fail++;
  } finally {
    await stopServer(srv);
  }

  /* 隔离自检：本测试的数据只能落在 test/.test-data-ack-<pid> 下 */
  ok(DATA_DIR.includes('.test-data'), 'DATA_DIR 落在 test/.test-data-ack-<pid>（被 .gitignore 覆盖）');
  ok(fs.existsSync(path.join(DATA_DIR, 'records.ndjson')) || fs.existsSync(DATA_DIR),
    '数据确实写进了隔离目录，而不是仓库真实 data/');
  console.log(`\n  隔离：DATA_DIR=${path.relative(ROOT, DATA_DIR)}，端口 ${port}，未触碰 8080 生产实例`);

  /* 自清：断言做完就把本次进程的隔离目录删掉，否则每跑一次都会在 test/ 下
   * 留一个 .test-data-ack-<pid>（虽然被 .gitignore 覆盖，但会越积越多）。 */
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
