/**
 * ESP32 传感器实时监控平台 —— 后端服务
 *
 * 设计原则（重要）：
 *   本服务【不生成、不模拟、不补插任何数据】。
 *   所有数值必须来自真实的硬件来源：
 *     1) USB 串口：ESP32 通过 Serial.println(JSON) 主动上报
 *     2) WiFi HTTP：ESP32 通过 POST /api/data 上报（可选）
 *   串口关闭 / 设备拔出 / 心跳超时 时，立刻清空前端数据并标记为离线。
 */

'use strict';

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { SerialPort } = require('serialport');

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const RECORD_DIR = path.join(ROOT, 'recordings');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const RECORDS_FILE = path.join(DATA_DIR, 'records.ndjson');
/* 求助事件单独落盘：低频事件（每次求助约 5 条），与高频采样语义不同，
 * 混进 records.ndjson 会弄脏采样文件的语义、也让求助查询变慢。 */
const HELP_FILE = path.join(DATA_DIR, 'help.ndjson');

// 设备身份元数据键：出现在数据帧里、但不作为传感器数值展示
const META_KEYS = new Set(['device', 'mac', 'src', 'ver', 'ver_', 'fw', 'id',
  'imu_ok', 'imu_id', 'imu_scan']); // 板端诊断字段，仅记录不展示
// 这些键是"板端时间戳/序号"，属于元数据，不画成传感器卡片
const META_NUMERIC_KEYS = new Set(['ts', 'seq', 'uptime_ms', 'boot_ms']);

const DEFAULT_CONFIG = {
  httpPort: 8080,
  host: '0.0.0.0',   // 电脑即服务器：监听所有网卡，开发板可经局域网/WiFi 直接上报
  baudRate: 115200,
  portPath: null,        // 指定串口，如 'COM3'；null = 自动识别
  autoDetect: true,      // 自动扫描并连接 ESP32
  autoReconnect: true,   // 断开后自动重连
  scanIntervalMs: 2500,  // 离线时的端口扫描间隔
  parseMode: 'auto',     // auto|json|kv|csv —— 兼容已烧好的、输出非 JSON 的固件
  staleAfterMs: 5000,    // 超过该时间无数据 => 判定为"静默"（仍连接）
  offlineAfterMs: 15000, // 超过该时间仍无任何数据 => 判定设备已移除，清空并重新扫描
  wifiTimeoutMs: 8000,   // WiFi 上报的心跳超时
  historyMax: 600,       // 前端图表的历史点数上限（由后端下发限制）
  // ---- 远程采集（第 2 周）----
  mockDevice: false,     // true = 模拟板端（服务端自答回执与观测），仅供无板联调；
                         //        所有模拟结果都会带 simulated 标记，绝不冒充实物命令
  collectTimeoutMs: 8000,// 下发采集命令后，多久没等到新观测判超时
  // ---- 命令回执（第 5 周收尾）：下发 ≠ 板端已接受 ----
  //   下发成功后等板端按 request_id 回 ack，超过该时长没等到就判 timeout。
  //   实测板端 ack 通常 <100ms，板端忙（正在上传上一段录音）时几百 ms；
  //   默认 1800ms 给足余量。可用环境变量 COMMAND_ACK_TIMEOUT_MS 覆盖。
  commandAckTimeoutMs: 1800,
  //   WiFi 下行通道额外再加一份回执预算（默认 1200ms，即纯 WiFi 时总计 3000ms）。
  //   依据（2026-10-28 实测）：板端 ack 走 ack_task → http_post("/api/data")，
  //   http_post 每次都 esp_http_client_init 新建 TCP、无 keep-alive，一次「建连 + 发一行」
  //   在丢包重传下可达 1–3 秒，与 1800ms 同量级；纯 WiFi 模式下不加这份预算就会把
  //   「慢回执」误判成 timeout（从"谎报成功"翻成"谎报失败"）。设 0 即关闭。
  //   可用环境变量 COMMAND_ACK_WIFI_EXTRA_MS 覆盖。
  commandAckWifiExtraMs: 1200,
  // ---- 持久化存储（作业要求：VPS 原始记录可查）----
  storageEnabled: true,  // 是否把每一帧真实数据落盘为 NDJSON，便于核对"一帧观测对应一条记录"
  storageMaxMb: 32,       // 单个记录文件超过该大小后滚动归档
  // ---- 停采策略（作业要求：停采后保留旧时间与值，提示"未更新"）----
  //   keep  = 超时/停采后保留最后一次真实值与旧时间，前端显示"未更新"（课程默认）
  //   clear = 超时超过 offlineAfterMs 后判定离线并清空（满足"拔线即无数据"原始要求）
  //   无论哪种：物理拔线（串口 disconnected 事件）或手动释放串口，必定清空。
  stalePolicy: 'keep',
  // ---- 本组设备身份校验（作业要求：核对数据来自"本组"设备，避免邻组数据混显）----
  //   设为固件里的 DEVICE_ID（如 "S3EYE-GROUP01"）后，平台会校验每帧上报的 device 是否匹配；
  //   不匹配则标记 deviceVerified=false，前端给出"⚠ 非本组设备"提示，但不丢弃（便于排查）。
  //   null = 不校验（接受任意设备，适合调试）。
  expectedDeviceId: null,
  // 单位与显示名映射（未列出的字段按原始 key 显示）
  fieldUnits: {
    temp_c: '°C', temperature: '°C', temp: '°C',
    humidity: '%', pressure: 'hPa', altitude: 'm',
    voltage: 'V', lux: 'lx', rssi: 'dBm', uptime: 's',
    hall: '', adc0: '', adc1: '', adc: '',
  },
  fieldLabels: {
    temp_c: '芯片温度', temperature: '温度', humidity: '湿度',
    pressure: '气压', altitude: '海拔',
    adc0: 'ADC0 (GPIO34)', adc1: 'ADC1 (GPIO35)', adc: 'ADC 原始值',
    voltage: '电压', hall: '霍尔传感器', lux: '光照度',
    rssi: 'WiFi 信号强度', uptime: '运行时长', millis: '运行时间',
  },
};

function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      for (const k of Object.keys(user)) {
        if (k === 'fieldUnits' || k === 'fieldLabels') {
          cfg[k] = Object.assign({}, cfg[k], user[k] || {});
        } else if (user[k] !== undefined && user[k] !== null) {
          cfg[k] = user[k];
        }
      }
    }
  } catch (e) {
    console.warn('[config] 读取失败，使用默认配置：', e.message);
  }
  return cfg;
}

function saveConfig() {
  try {
    // 防止环境变量覆盖（PORT/HOST）污染持久化文件：
    // 保存时恢复文件原始值，只在运行时使用环境变量值。
    const toSave = { ...config };
    if (process.env.PORT !== undefined) toSave.httpPort = _fileConfig.httpPort;
    if (process.env.HOST !== undefined) toSave.host = _fileConfig.host;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[config] 保存失败：', e.message);
    return false;
  }
}

let config = loadConfig();

// 快照文件原始配置（env 覆盖不会写入文件）
const _fileConfig = JSON.parse(JSON.stringify(config));

// 环境变量覆盖：部署 VPS 或并行测试时可设 PORT=8099 / HOST=0.0.0.0 改变监听
if (process.env.PORT) config.httpPort = Number(process.env.PORT) || config.httpPort;
if (process.env.HOST) config.host = process.env.HOST;

/* ------------------------------------------------------------------ */
/* 全局状态                                                            */
/* ------------------------------------------------------------------ */

const state = {
  connected: false,     // 是否有真实硬件在线
  live: false,          // 是否在"实时流动"状态（区别于停采保留）
  transport: null,      // 'serial' | 'wifi'
  device: null,         // 设备描述信息（串口路径 / WiFi IP）
  deviceId: null,       // 设备身份标识（来自固件上报的 device 字段，用于"核对数据来自本组设备"）
  deviceMac: null,      // 设备 MAC（辅助身份核对）
  deviceVerified: null, // 是否通过本组身份校验（expectedDeviceId 为空或匹配时为 true）
  lastDataAt: null,     // 最近一次收到真实数据的时间戳（服务端接收时刻）
  boardTs: null,        // 最近一次数据帧里的板端时间戳（毫秒，UTC）
  boardIso: null,       // 最近一次数据帧里的板端 ISO 时间
  seq: null,            // 板端自增序号（用于核对不丢帧）
  fields: {},           // 最新的真实字段值 { key: number }
  wifiSource: null,     // WiFi 上报来源 { ip }
  reportPaused: false,  // 周期上报是否被远程命令暂停（命令通道保持可用）
  camStreaming: false,  // 板端是否正在推摄像头画面
};

let port = null;            // 当前 SerialPort 实例
let lineBuffer = '';        // 串口行缓冲
let scanTimer = null;
let manualClose = false;    // 是否是用户主动断开
let openingPath = null;     // 正在打开的端口，防重入
const OPEN_TIMEOUT_MS = Number(process.env.OPEN_TIMEOUT_MS || 6000);  // 打开串口的看门狗上限
let portOpenedAt = null;    // 端口打开时刻（用于判断"开了但一直没数据"）
const rawLog = [];          // 最近若干条原始上报（仅真实数据）
const RAW_LOG_MAX = 200;

/* 串口是否打开 / 当前下行命令通道类型（此前 16+ 处手写同一判断） */
const serialOpen = () => !!(port && port.isOpen);
const currentChannelKind = () => (serialOpen() ? 'serial' : (wifiDownlinkActive() ? 'wifi' : null));

// 真实数据录制（只写入设备实际上报的采样，不生成任何数据）
const recording = { active: false, rows: [], startedAt: null, maxRows: 200000 };
const REC_TRIM_MARGIN = 1000;   // 录制缓冲裁剪余量（摊薄裁剪开销，见 appendRecording）

/* CSV 单元格转义：含逗号/引号/换行时加引号并把引号翻倍 —— 录制导出与 /api/records.csv 共用 */
const csvEsc = (v) => {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function writeRecording() {
  if (!recording.rows.length) return null;
  if (!fs.existsSync(RECORD_DIR)) fs.mkdirSync(RECORD_DIR, { recursive: true });

  const keys = [];
  const seen = new Set();
  for (const r of recording.rows) {
    for (const k of Object.keys(r.f)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  const esc = csvEsc;
  const header = ['timestamp_ms', 'iso_time', ...keys].join(',');
  const lines = recording.rows.map((r) =>
    [r.ts, new Date(r.ts).toISOString(), ...keys.map((k) => (r.f[k] !== undefined ? esc(r.f[k]) : ''))].join(',')
  );
  const stamp = new Date(recording.startedAt || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `esp32_${stamp}.csv`;
  // ﻿：BOM，保证 Excel 打开中文不乱码
  fs.writeFileSync(path.join(RECORD_DIR, name), '\uFEFF' + [header, ...lines].join('\n'), 'utf8');
  return name;
}

// ------------------------------------------------------------------ //
// 持久化存储：把每一帧真实数据落盘为 NDJSON，供 VPS 原始记录核对        //
// 仅写入设备实际上报的采样，绝不生成/补插任何数据。                     //
// ------------------------------------------------------------------ //

let storageSeq = 0; // 服务端自增序号，与板端 seq 区分

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 追加一条真实采样记录到 NDJSON 文件（同步、简单、足够课程演示） */
function appendRecord(rec) {
  if (!config.storageEnabled) return;
  try {
    ensureDataDir();
    // 文件过大则滚动归档，避免单文件无限增长
    if (fs.existsSync(RECORDS_FILE)) {
      const sz = fs.statSync(RECORDS_FILE).size;
      if (sz > config.storageMaxMb * 1024 * 1024) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fs.renameSync(RECORDS_FILE, path.join(DATA_DIR, `records.${ts}.ndjson`));
      }
    }
    fs.appendFileSync(RECORDS_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    console.error('[storage] 写入失败：', e.message);
  }
}

/** 读取并筛选 NDJSON 记录。返回数组（默认按接收时间倒序） */
function readRecords({ device = null, limit = 200, since = null, until = null, order = 'desc' } = {}) {
  if (!config.storageEnabled || !fs.existsSync(RECORDS_FILE)) return [];
  const out = [];
  const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n');
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch (_) { continue; }
    if (device && r.device_id !== device) continue;
    if (since != null && (r.recv_ts || 0) < since) continue;
    if (until != null && (r.recv_ts || 0) > until) continue;
    out.push(r);
  }
  out.sort((a, b) => (order === 'asc' ? (a.recv_ts || 0) - (b.recv_ts || 0) : (b.recv_ts || 0) - (a.recv_ts || 0)));
  if (limit && limit > 0 && out.length > limit) out.length = limit;
  return out;
}

/** 列出所有出现过的设备：计数、首次/末次出现、末次板端时间 */
function listDevices() {
  if (!config.storageEnabled || !fs.existsSync(RECORDS_FILE)) return [];
  const map = new Map();
  const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n');
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch (_) { continue; }
    const id = r.device_id || '(unknown)';
    let e = map.get(id);
    if (!e) { e = { device_id: id, count: 0, first_recv: r.recv_ts, last_recv: r.recv_ts, last_board: r.board_ts || null, transport: r.transport || null }; map.set(id, e); }
    e.count++;
    if (r.recv_ts > e.last_recv) { e.last_recv = r.recv_ts; e.last_board = r.board_ts || e.last_board; e.transport = r.transport || e.transport; }
    if (r.recv_ts < e.first_recv) e.first_recv = r.recv_ts;
  }
  return Array.from(map.values()).sort((a, b) => b.last_recv - a.last_recv);
}

// 链路统计，仅用于诊断，不参与任何数据展示
const stats = {
  bytesReceived: 0,
  linesTotal: 0,
  linesValid: 0,
  linesInvalid: 0,
  lastError: null,
  lastOpenError: null,
  startedAt: Date.now(),
};

/* ------------------------------------------------------------------ */
/* WebSocket 广播                                                      */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

/* ------------------------------------------------------------------ */
/* 远程采集请求（第 2 周）：请求 → 设备回执 → 新观测                    */
/*                                                                     */
/* 证明「是新采集、不是库里旧值」的四条证据：                            */
/*   ① request_id 回环：服务端生成 → 下发 → 板端原样回传；               */
/*      库里旧记录没有这个 id，物理上无法冒充                            */
/*   ② 板端 seq 严格递增：观测的 seq 必须大于下发前的 seq                 */
/*   ③ 时间先后：观测到达时刻必须晚于下发时刻                            */
/*   ④ 前端只认 request_id：只展示带该 id 的观测，绝不读库里最后一条       */
/* ------------------------------------------------------------------ */
const REQUESTS = new Map();          // request_id -> request
const REQUEST_KEEP = 50;             // 内存中保留最近 N 条
const collectTimeoutMs = () => config.collectTimeoutMs || 8000;   // 下发后多久没等到新观测 → 超时
/* 等板端 ack 的默认时长（第 5 周收尾）。
 * 环境变量 COMMAND_ACK_TIMEOUT_MS 优先，其次 config.commandAckTimeoutMs，最后 1800ms。
 * 为什么不是「写完就成功」：串口 write 回调只证明字节进了驱动缓冲，
 * 板端完全可能因为忙（如正在上传上一段录音）把命令丢弃 —— 只有 ack 才是板端的态度。 */
const commandAckTimeoutMs = () => {
  const env = Number(process.env.COMMAND_ACK_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  const cfg = Number(config.commandAckTimeoutMs);
  return Number.isFinite(cfg) && cfg > 0 ? cfg : 1800;
};

/* WiFi 通道额外的回执等待预算（2026-10-28 实测依据）。
 * 串口回执是「板端 printf 一行」，通常 <100ms；WiFi 回执走的是固件
 * ack_task → http_post("/api/data")，而 http_post 每次都 esp_http_client_init
 * 新建 TCP 连接（没有 keep-alive），板端当前空口 RTT 实测 p50 124–409ms，
 * 一次「建连 + 发一行」在丢包重传下可能要 1–3 秒 —— 与 1800ms 默认预算同量级。
 * 因此纯 WiFi 通道单独加一份预算，而不是把串口那条也一起拉长（那会让串口
 * 模式下的失败反馈变迟钝）。可用 COMMAND_ACK_WIFI_EXTRA_MS 覆盖，设 0 即关闭。 */
const commandAckWifiExtraMs = () => {
  const env = Number(process.env.COMMAND_ACK_WIFI_EXTRA_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  const cfg = Number(config.commandAckWifiExtraMs);
  return Number.isFinite(cfg) && cfg >= 0 ? cfg : 1200;
};
let requestCounter = 0;

function newRequestId() {
  requestCounter = (requestCounter % 9999) + 1;
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `req-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${String(requestCounter).padStart(4, '0')}`;
}

function publicRequest(r) {
  return {
    request_id: r.request_id,
    device_id: r.device_id,
    status: r.status,                 // submitted|dispatched|acked|completed|failed|timeout
    simulated: !!r.simulated,
    created_at: r.created_at,
    dispatched_at: r.dispatched_at || null,
    acked_at: r.acked_at || null,
    completed_at: r.completed_at || null,
    timeout_at: r.timeout_at || null,
    ack_status: r.ack_status || null,
    channel: r.channel || null,       // serial | wifi —— 命令走的是哪条下行通道
    seq_before: r.seq_before ?? null,
    seq_observed: r.seq_observed ?? null,
    observation: r.observation || null,
    error: r.error || null,
    note: r.note || null,
  };
}

function pushRequest(r) { broadcast({ type: 'collect', request: publicRequest(r) }); }

function trimRequests() {
  while (REQUESTS.size > REQUEST_KEEP) REQUESTS.delete(REQUESTS.keys().next().value);
}

function recentRequests(n = 20) {
  return [...REQUESTS.values()].slice(-n).reverse().map(publicRequest);
}

/* ------------------------------------------------------------------ */
/* 下行命令：两条通道                                                    */
/*                                                                     */
/*   ① 串口（首选，低延迟）：板子插着 USB 时直接写串口                    */
/*   ② WiFi 轮询（兜底）：板子是纯 HTTP 客户端，服务端连不上它，           */
/*      因此把命令放进队列，等板端 GET /api/cmd 来取（默认 400ms 一次）   */
/*                                                                     */
/* 两者互斥：串口在线时只写串口、队列为空，板端来取也拿不到东西，         */
/* 因此不会重复执行。板子拔掉 USB 后，闭环仍能完整跑通。                  */
/* ------------------------------------------------------------------ */
const CMD_QUEUE_MAX = 20;
const CMD_TTL_MS = 15000;      // 超过 15s 没被取走就作废，避免陈旧命令突然执行
const cmdQueue = [];           // { id, obj, device, queued_at, ttl }
let cmdSeq = 0;

function queueCommand(obj, device) {
  const item = { id: ++cmdSeq, obj, device: device || null, queued_at: Date.now(), ttl: CMD_TTL_MS };
  cmdQueue.push(item);
  while (cmdQueue.length > CMD_QUEUE_MAX) cmdQueue.shift();
  return item;
}

function dropExpiredCommands() {
  const now = Date.now();
  while (cmdQueue.length && now - cmdQueue[0].queued_at > cmdQueue[0].ttl) cmdQueue.shift();
}

/* 撤回一条还没被板端取走的命令（按 id）。
 * 用途见 sendCommandAndWaitAck 的 channel_unavailable 分支：既然已经告诉调用方
 * 「通道不可用、没下发」，就不能让这条命令 15 秒内又被板端取走执行 —— 否则
 * 用户按报错重试一次，板端会录两段，而服务端只认后面那条的回执。
 * 返回 true = 确实撤掉了；false = 已被板端取走（那就只能如实说"已发出"）。 */
function withdrawQueuedCommand(id) {
  if (!id) return false;
  const i = cmdQueue.findIndex((c) => c.id === id);
  if (i < 0) return false;
  cmdQueue.splice(i, 1);
  return true;
}

/* 板端来取命令：返回一条匹配本设备的命令，没有则 null */
function takeCommand(device) {
  dropExpiredCommands();
  if (!cmdQueue.length) return null;
  const i = cmdQueue.findIndex((c) => !c.device || !device || c.device === device);
  if (i < 0) return null;
  return cmdQueue.splice(i, 1)[0];
}

/* WiFi 下行是否"活着"：板端最近 2 秒内来取过命令 */
function wifiDownlinkActive() {
  return !!stats.lastCmdPollAt && (Date.now() - stats.lastCmdPollAt) < 2000;
}

/* 下发一行命令，并如实报出【实际走了哪条通道】。
 *
 * 返回 { ok, channel }：
 *   ok      = 当前确实能送达（串口写出成功，或板端正通过 WiFi 轮询来取）
 *   channel = 'serial' | 'wifi' | null —— 取的是【真实写路径】，
 *             不是用 serialOpen() 反推的（见下方 2026-10-28 修复说明）
 *   queued  = 是否进了 WiFi 待取队列（即便 ok=false 也可能入队，这是既有设计：
 *             板端 15 秒内上线仍能取走，不能丢命令）
 *
 * ★ 2026-10-28 修复：原 sendCommandAndWaitAck() 里的
 *     `const channel = serialOpen() ? 'serial' : 'wifi';`
 *   是用「串口此刻开着吗」去猜「这条命令走了哪条路」，两者并不等价：
 *   port.write() 抛异常（驱动已半死、写缓冲满）时会落到入队分支，命令其实
 *   走 WiFi，channel 却仍报 'serial'。取证时这条错信息会把排查引向
 *   「串口明明开着为什么板端没回执」的错误方向。现在由真正执行写入的
 *   分支直接给出 channel，调用方不再自己推断。 */
function sendCommandEx(obj, device) {
  if (config.mockDevice) return { ok: false, channel: null, queued: false };  // 模拟模式不走真实通道
  if (port && port.isOpen) {
    try {
      port.write(JSON.stringify(obj) + '\n', (err) => {
        if (err) stats.lastError = String(err.message || err);
      });
      stats.cmdSent = (stats.cmdSent || 0) + 1;
      stats.cmdViaSerial = (stats.cmdViaSerial || 0) + 1;
      return { ok: true, channel: 'serial', queued: false };
    } catch (e) {
      stats.lastError = String(e.message || e);
      // 写失败 → 继续走下面的入队分支，命令不丢
    }
  }
  // 串口不在线（或写出失败）→ 入队，等板端经 WiFi 来取
  const item = queueCommand(obj, device);
  stats.cmdViaWifi = (stats.cmdViaWifi || 0) + 1;
  // queueId 供调用方在「判定为通道不可用」时撤回这条命令（见 withdrawQueuedCommand）
  return { ok: wifiDownlinkActive(), channel: 'wifi', queued: true, queueId: item.id };
}

/* 兼容包装：旧调用方（/api/collect、求助、摄像头…）只关心「能不能送达」。
 * 行为与改前完全一致，只是内部改用 sendCommandEx() 以免两处逻辑漂移。 */
function sendCommand(obj, device) {
  return sendCommandEx(obj, device).ok;
}

/* ------------------------------------------------------------------ */
/* 板端回执等待（第 5 周收尾）：把「命令已下发」与「板端已接受」分开      */
/*                                                                     */
/* 背景（实测，非推测）：2026-10-26 POST /api/voice/record 返回          */
/* ok=true accepted=true，但固件 voice_record.c:571 的 voice_record_    */
/* toggle() 首段是 if (s_uploading) { ESP_LOGW(...); return false; }，   */
/* main.c:1377-1388 据此回 cmd_ack(rid,"busy") —— 命令被板端丢弃，      */
/* 服务端却报成功。串口 write 回调只说明字节进了驱动缓冲，不是板端态度。  */
/*                                                                     */
/* 做法：下发前按 request_id 登记一个等待槽，板端 ack 上行到达时结算；    */
/* 超时未结算 → timeout。三种基本结局：accepted / busy / timeout，       */
/* 另外把「板端明确报错」「通道不可用」「模拟模式」也如实区分。           */
/* ------------------------------------------------------------------ */
const PENDING_ACKS = new Map();   // request_id -> { settle, timer, sentAt }
/* 等 ack 类命令的序号：拼进 request_id，保证同一毫秒内的多个请求不会撞号。
 * 只用于本进程内唯一性（板端原样回传，跨重启无需全局唯一）。 */
let ackRequestSeq = 0;

/* ack status 分类：板端 status 是自由字符串（recording / uploading / busy /
 * paused / cam_on / "linked=1 ip=..." 等），只有明确表示"拒绝/失败"的才算负向。 */
function classifyAckStatus(status) {
  const s = String(status == null ? '' : status).trim();
  if (!s) return 'accepted';                 // 有回执但没带 status：视为已接受（至少证明板端处理了）
  if (/(^|[^a-z])busy([^a-z]|$)/i.test(s)) return 'busy';
  if (/^(error|failed|unknown_cmd|no_camera|no_active_help|rejected|denied)/i.test(s)) return 'error';
  return 'accepted';
}

/* 登记一个等待槽：返回 { promise, cancel, collision }。
 * 必须在 sendCommand() 之前调用 —— 否则极快的 ack 会赶在登记前到达而漏掉。
 *
 * ★ 2026-10-28 修复（审查 blocker F1：request_id 撞号导致请求永久挂死）：
 * 原实现 `PENDING_ACKS.set(requestId, entry)` 会直接覆盖同 id 的旧等待槽，
 * 而旧槽的 setTimeout 回调开头有守卫 `if (PENDING_ACKS.get(requestId) !== entry) return;`
 * —— 于是旧槽既不结算也不删除，那个 await 永不 resolve（cancel() 有同样守卫，救不回来）。
 * 实测（隔离实例、ACK 超时 400ms、同一 tick 发 8 个 POST、板端只取命令不回执）：
 * 返回 2/8、挂死 6/8，且再等 3 倍超时挂死数不变 —— 服务端没有任何兜底。
 * 现在两道保险：
 *   ① 撞号时不覆盖旧槽，新请求立刻拿到 outcome=request_id_collision 的明确结局；
 *   ② 每个等待槽额外挂一个 timeoutMs+2s 的硬兜底定时器，任何异常都不许永久挂起。
 */
function createAckWaiter(requestId, timeoutMs) {
  if (PENDING_ACKS.has(requestId)) {
    // 不覆盖：让新请求拿到明确结局，而不是把两个请求都拖进"永挂"
    const promise = Promise.resolve({
      outcome: 'request_id_collision', ack_status: null, ack_seq: null,
      ack_channel: null, waited_ms: 0,
    });
    return { promise, cancel: () => {}, collision: true };
  }
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  const entry = { sentAt: Date.now(), timer: null, hardTimer: null, settled: false };
  /* 唯一的结算出口：保证「只结算一次」+「一定从 PENDING_ACKS 里摘掉」。
   * 所有路径（ack 到达 / 超时 / 取消 / 硬兜底）都走这里，不再各自删表。 */
  const finish = (result) => {
    if (entry.settled) return;
    entry.settled = true;
    if (PENDING_ACKS.get(requestId) === entry) PENDING_ACKS.delete(requestId);
    clearTimeout(entry.timer);
    clearTimeout(entry.hardTimer);
    settle(result);
  };
  entry.timer = setTimeout(() => finish({
    outcome: 'timeout', ack_status: null, ack_seq: null,
    ack_channel: null, waited_ms: Date.now() - entry.sentAt,
  }), timeoutMs);
  entry.hardTimer = setTimeout(() => finish({
    outcome: 'timeout', ack_status: null, ack_seq: null, ack_channel: null,
    waited_ms: Date.now() - entry.sentAt, hard_timeout: true,
  }), timeoutMs + 2000);
  // settlePendingAck() 通过 entry.finish() 结算，必须挂到 entry 上（否则 ack 到达时会抛错）
  entry.finish = finish;
  // 定时器不应把进程钉在事件循环里（服务端长期运行，但测试要能干净退出）
  if (entry.timer.unref) entry.timer.unref();
  if (entry.hardTimer.unref) entry.hardTimer.unref();
  PENDING_ACKS.set(requestId, entry);
  const cancel = (result) => finish(result);   // finish 自带"已结算就不覆盖真实回执"的保护
  /* 延长等待预算（2026-10-28）：通道在登记之后才确定（串口 vs WiFi），
   * 而 WiFi 回执要新建 TCP 连接、可能吃掉 1–3 秒，所以允许在拿到真实通道后
   * 把超时重设一次。重设只对「尚未结算」的槽生效，且总预算仍受硬兜底约束。 */
  const extend = (extraMs) => {
    if (entry.settled || !(extraMs > 0)) return;
    const total = timeoutMs + extraMs;
    const left = () => Math.max(0, total - (Date.now() - entry.sentAt));
    clearTimeout(entry.timer);
    clearTimeout(entry.hardTimer);
    entry.timer = setTimeout(() => finish({
      outcome: 'timeout', ack_status: null, ack_seq: null,
      ack_channel: null, waited_ms: Date.now() - entry.sentAt,
    }), left());
    entry.hardTimer = setTimeout(() => finish({
      outcome: 'timeout', ack_status: null, ack_seq: null, ack_channel: null,
      waited_ms: Date.now() - entry.sentAt, hard_timeout: true,
    }), left() + 2000);
    if (entry.timer.unref) entry.timer.unref();
    if (entry.hardTimer.unref) entry.hardTimer.unref();
  };
  return { promise, cancel, collision: false, finish, extend };
}

/* 板端 ack 上行到达：结算对应等待槽。返回 true = 确有等待方被唤醒。
 * transport 是 ack 实际到达的那条上行（serial / wifi），用于取证
 * 「命令走 WiFi、回执也从 WiFi 回来」这类链路判断。 */
function settlePendingAck(request_id, status, seq, transport) {
  if (typeof request_id !== 'string' || !request_id) return false;
  const entry = PENDING_ACKS.get(request_id);
  if (!entry) return false;
  const outcome = classifyAckStatus(status);
  entry.finish({
    outcome,
    ack_status: status == null ? null : String(status),
    ack_seq: typeof seq === 'number' ? seq : null,
    ack_channel: transport || null,
    waited_ms: Date.now() - entry.sentAt,
  });
  return true;
}

/* 超时文案（2026-10-28）：只写「没收到回执」没法排查。
 * 固件改完后串口与 WiFi 两条上行都能回执，所以超时确实只剩两种成因：
 *   ① 板端真的没回（固件没跑 / 命令没被取走 / 卡在别处）
 *   ② 回执发了但回不来（WiFi 上行失败，或串口线被拔）
 * 下面按【这条命令实际走的通道】分别给出下一步动作，两者指向不同的取证位置。 */
function ackTimeoutNote(channel) {
  const diag = '/api/diag 的 downlink 与 commandAck、/api/state 的 raw 尾部';
  if (channel === 'serial') {
    return '命令已写进串口，但超时内没收到板端回执。排查顺序：'
      + `① 看 ${diag}，确认 raw 里有没有同一 request_id 的 {"type":"ack"} 原文；`
      + '② 若 raw 里完全没有该 request_id，说明板端没处理这条命令 —— 看板端串口日志有没有 '
      + '"WiFi 取到命令" / "远程录音命令" 字样，或命令是否被 pause 之类状态挡住；'
      + '③ 若 raw 里有 ack 但本接口仍报超时，那是 rid 不匹配，把两边 request_id 贴出来比对。';
  }
  return '命令已进 WiFi 待取队列，但超时内没收到板端回执。排查顺序：'
    + `① 看 ${diag}：downlink.wifiPolling=false 表示板端根本没来取命令（GET /api/cmd），`
    + '此时命令还躺在队列里（downlink.queued>0），不是"板端不回执"；'
    + '② wifiPolling=true 而 queued=0 说明命令已被取走 —— 那问题在回执上行：'
    + '板端日志里找 "★ 回执 WiFi 上行失败" 计数，它对应 http_post("/api/data") 失败；'
    + '③ 回执走的是和帧同一条 WiFi 上行，若帧能到而 ack 不到，检查板端是否刚好处在断网瞬间。';
}

const ACK_OUTCOME_TEXT = {
  accepted: '板端已接受命令',
  busy: '板端忙，命令被丢弃（板端返回 busy）',
  error: '板端拒绝或执行失败',
  timeout: '命令已写出，但在超时时间内没收到板端回执',
  channel_unavailable: '命令通道不可用（串口未打开，且板端未通过 WiFi 轮询取命令）',
  mock: '模拟模式（config.mockDevice=true）：未走真实通道，不伪造板端回执',
  no_request_id: '命令缺少 request_id，无法与板端回执配对',
  request_id_collision: 'request_id 已被另一条在途命令占用，本命令未下发（拒绝冒用同一 id）',
};

/* 下发一条带 request_id 的命令，并等板端 ack。
 * 返回（永不 reject）：
 *   { outcome, dispatched, accepted, channel, request_id, ack_status, ack_seq,
 *     waited_ms, timeout_ms, simulated, message }
 *   outcome ∈ accepted | busy | error | timeout | channel_unavailable | mock | no_request_id
 * 关键语义：
 *   · dispatched=true 只代表"确实写进了通道"，不代表板端接受；
 *   · accepted=true 只有在真的收到板端 ack 且 status 非 busy/error 时才成立；
 *   · 模拟模式下既不发命令也不伪造回执（outcome=mock）。 */
async function sendCommandAndWaitAck(obj, device, opts = {}) {
  const optTimeout = Number(opts.timeoutMs);
  const timeoutMs = Number.isFinite(optTimeout) && optTimeout > 0 ? optTimeout : commandAckTimeoutMs();
  const requestId = obj && obj.request_id ? String(obj.request_id) : null;
  const shell = {
    dispatched: false,
    accepted: false,
    channel: null,
    queued: false,
    withdrawn: false,   // 通道不可用时是否已把入队的命令撤回（撤回失败=板端可能已取走）
    request_id: requestId,
    ack_status: null,
    ack_seq: null,
    ack_channel: null,
    waited_ms: null,
    timeout_ms: timeoutMs,
    simulated: false,
    message: null,
  };
  const done = (o) => Object.assign({}, shell, o,
    { message: o.message || ACK_OUTCOME_TEXT[o.outcome] || null });

  // 模拟模式：绝不在没有真实板端时假装收到 ack
  if (config.mockDevice) return done({ outcome: 'mock', simulated: true });
  if (!requestId) return done({ outcome: 'no_request_id' });

  const waiter = createAckWaiter(requestId, timeoutMs);
  // 撞号：同一 request_id 已有在途命令，绝不能冒用同一个 id 下发
  // （否则板端的回执会被先登记的那条请求认领，两条命令的真实态度都失真）
  if (waiter.collision) {
    return done({ outcome: 'request_id_collision', dispatched: false });
  }
  // 用 sendCommandEx 而不是 sendCommand：要拿【真实写路径】给出的 channel，
  // 不能事后用 serialOpen() 猜（见 sendCommandEx 上方 2026-10-28 修复说明）。
  const sent = sendCommandEx(obj, device);
  if (!sent.ok) {
    /* ★ 2026-10-28 修复（审查 F5）：原实现在通道不可用时只 cancel 等待槽，
     * 命令却留在 WiFi 队列里（TTL 15s）—— 调用方收到「没下发」，板端随后
     * 却把它取走执行（实测：POST 返回 channel_unavailable 后板端 GET /api/cmd
     * 取到 {"cmd":"voice_record","request_id":"voice-rec-..."}，用户按报错重试
     * 就会录两段）。既然回答「没送达」，就必须把这条命令撤回来。
     * 撤回失败（刚好已被板端取走）则如实报 queued=true + withdrawn=false。 */
    let withdrawn = false;
    if (sent.queued && sent.queueId) withdrawn = withdrawQueuedCommand(sent.queueId);
    waiter.cancel({ outcome: 'channel_unavailable' });
    return done({
      outcome: 'channel_unavailable',
      channel: sent.channel,
      queued: sent.queued && !withdrawn,
      withdrawn,
    });
  }
  /* WiFi 通道单独加一份回执预算（2026-10-28 实测依据见 commandAckWifiExtraMs）。
   * 必须在 sendCommandEx() 之后调 —— 只有那时才知道命令真的走了哪条路。
   * 串口那条不改：printf 一行 <100ms，拉长只会让失败反馈变迟钝。 */
  let effectiveTimeout = timeoutMs;
  if (sent.channel === 'wifi') {
    const extra = commandAckWifiExtraMs();
    if (extra > 0) { waiter.extend(extra); effectiveTimeout = timeoutMs + extra; }
  }
  const acked = await waiter.promise;
  const outcome = acked.outcome;
  stats.lastAckOutcome = outcome;
  stats.lastAckAt = Date.now();
  stats.lastCommandChannel = sent.channel || null;
  stats.lastAckChannel = acked.ack_channel || null;
  const res = done(Object.assign({
    dispatched: true,
    channel: sent.channel,
    queued: sent.queued,
    timeout_ms: effectiveTimeout,
    accepted: outcome === 'accepted',
  }, acked));
  // 超时/通道类结局给出可执行的排查方向（不只是"没回执"三个字）
  if (outcome === 'timeout') res.message = ackTimeoutNote(sent.channel);
  return res;
}

/* 幂等闸门：返回仍在进行中的采集请求（submitted/dispatched/acked），没有则 null。
   防止并发点击、页面刷新重发、NL 助手与前端同时发起 → 多个在途采集命令 */
function findActiveCollectRequest() {
  for (const r of REQUESTS.values()) {
    if (r.status === 'submitted' || r.status === 'dispatched' || r.status === 'acked') return r;
  }
  return null;
}

/* 创建一次采集请求并下发 */
function createCollectRequest() {
  const r = {
    request_id: newRequestId(),
    device_id: state.deviceId || null,
    status: 'submitted',
    created_at: Date.now(),
    seq_before: state.seq ?? null,
    simulated: false,
  };
  REQUESTS.set(r.request_id, r);
  trimRequests();
  pushRequest(r);

  // 用 sendCommandEx 取真实写路径：原写法 sent 为真时用 serialOpen() 反推
  // channel，若 port.write() 抛异常落到入队分支，channel 会错报 'serial'。
  const sent = sendCommandEx({ cmd: 'collect_once', request_id: r.request_id }, r.device_id);
  if (sent.ok) {
    r.status = 'dispatched';
    r.dispatched_at = Date.now();
    r.channel = sent.channel;
  } else if (config.mockDevice) {
    // 模拟板端：明确标注 simulated，绝不冒充实物命令
    r.simulated = true;
    r.status = 'dispatched';
    r.dispatched_at = Date.now();
    r.note = '模拟模式：未走真实串口，由服务端自答回执与观测（仅供联调/演示）';
    mockDeviceReply(r.request_id);
  } else {
    // 命令通道不可用（设备关闭 / 串口未连接）：
    // 不伪造完成，也不立刻判死 —— 按作业要求「请求等待 / 超时」处理，
    // 但立刻给出原因提示，避免用户干等。
    r.error = '命令通道不可用（串口未打开，开发板也未在轮询）';
    r.note = '已提交，但命令尚未送达设备（串口未打开、开发板也未通过 WiFi 取命令）。命令已入队，若开发板在 15 秒内上线会被取走；否则按超时处理。超时≠硬件故障。';
  }
  // 三个分支共用同一条超时定时器（此前每个分支各写一遍）
  r.timer = setTimeout(() => onRequestTimeout(r.request_id), collectTimeoutMs());
  pushRequest(r);
  return r;
}

/* 模拟板端：先回执，再给一条带 request_id 的观测（明确标注模拟） */
function mockDeviceReply(request_id) {
  setTimeout(() => onDeviceAck(request_id, 'received', state.seq, true), 300);
  setTimeout(() => {
    const r = REQUESTS.get(request_id);
    if (!r || r.status === 'completed' || r.status === 'timeout') return;
    const f = state.fields || {};
    const obsFields = {
      acc_x_g: f.acc_x_g ?? null, acc_y_g: f.acc_y_g ?? null, acc_z_g: f.acc_z_g ?? null,
      temp_c: f.temp_c ?? null,
    };
    onObservation(request_id, obsFields, Date.now(), (state.seq || 0) + 1, true);
  }, 900);
}

/* 板端回执 */
function onDeviceAck(request_id, status, seq, simulated) {
  /* 板端回执：求助相关（help-*）路由到求助模块，不进采集请求表 */
  if (typeof request_id === 'string' && request_id.startsWith('help-')) {
    onHelpAck(request_id, status);
    return;
  }
  const r = REQUESTS.get(request_id);
  if (!r) return;
  if (r.status === 'completed' || r.status === 'timeout' || r.status === 'failed') return;
  r.status = 'acked';
  r.acked_at = Date.now();
  r.ack_status = status || 'received';
  if (simulated) r.simulated = true;
  if (typeof seq === 'number') r.ack_seq = seq;
  pushRequest(r);
}

/* 收到带 request_id 的观测 —— 这才是「新采集」的实证 */
function onObservation(request_id, fields, recvTs, seqOverride, simulated) {
  const r = REQUESTS.get(request_id);
  if (!r) return;
  if (r.status === 'completed' || r.status === 'timeout') return;
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }

  const seq = typeof seqOverride === 'number' ? seqOverride
    : (typeof state.seq === 'number' ? state.seq : null);
  const dispatched = r.dispatched_at || r.created_at;
  const checks = {
    arrived_after_dispatch: recvTs >= dispatched,
    seq_increased: (r.seq_before == null || seq == null) ? null : seq > r.seq_before,
  };

  r.status = 'completed';
  r.completed_at = recvTs;
  r.seq_observed = seq;
  r.observation = { recv_ts: recvTs, seq, fields, checks };
  if (simulated) r.simulated = true;
  pushRequest(r);
}

/* 超时：不把旧值标成本次完成，也不判定硬件故障 */
function onRequestTimeout(request_id) {
  const r = REQUESTS.get(request_id);
  if (!r || r.status === 'completed') return;
  r.timer = null;
  r.status = 'timeout';
  r.timeout_at = Date.now();
  r.note = '未在限定时间内收到本次新观测。超时≠硬件故障，也不代表旧值有效。';
  pushRequest(r);
}

/* ------------------------------------------------------------------ */
/* 教学求助（第 3 周）：按键 → 本地反馈 → 远端显示 → 回应 / 取消        */
/*                                                                     */
/* 当堂验证的两条硬指标，靠这里的数据流保证：                            */
/*   ① 本地确认不依赖网络：板端 LED/LCD 在按下瞬间就变，与本模块无关；   */
/*      本模块只记录「服务端确实收到了求助事件」这一事实。                */
/*   ② 无远端接收证据不得显示「对方已收到」：                            */
/*      - 服务端只有【真正收到】板端 help 事件，才把状态置为 received；   */
/*      - 网页只有【命令确实写出串口】才显示「回应已下发」；              */
/*      - 板端只有【收到 viewer_ack 命令】才显示「对方已收到」；          */
/*      - 板端回执 ack_shown 回来后，才把 ack_delivered 标为 true。       */
/* ------------------------------------------------------------------ */
const HELP_KEEP = 20;
const help = {
  active: false,
  help_id: null,
  device_id: null,
  status: 'idle',          // idle | received | acknowledged | cancelled
  event: null,             // request | cancel
  received_at: null,       // 服务端收到求助的时刻
  board_ts: null,          // 板端时间戳（毫秒 UTC）
  seq: null,               // 板端序号
  ack_sent_at: null,       // 网页点「已收到」的时刻
  ack_channel_ok: null,    // 回应命令是否成功写出串口
  ack_delivered: null,     // 板端回执确认已显示（true/false/null=等待）
  cancelled_at: null,
  note: null,
  history: [],             // 最近 N 条事件（时间 + 事件名）
};

function publicHelp() {
  return {
    active: help.active,
    help_id: help.help_id,
    device_id: help.device_id,
    status: help.status,
    event: help.event,
    received_at: help.received_at,
    board_ts: help.board_ts,
    seq: help.seq,
    ack_sent_at: help.ack_sent_at,
    ack_channel_ok: help.ack_channel_ok,
    ack_channel: help.ack_channel || null,   // serial | wifi
    ack_delivered: help.ack_delivered,
    cancelled_at: help.cancelled_at,
    note: help.note,
    history: help.history.slice(-HELP_KEEP),
    mockDevice: !!config.mockDevice,
    // 下行是否可用：串口在线，或板端正通过 WiFi 轮询来取命令
    channelReady: serialOpen() || wifiDownlinkActive(),
    channelKind: currentChannelKind(),
    pendingCommands: cmdQueue.length,
  };
}

function pushHelp() { broadcast({ type: 'help', help: publicHelp() }); }

/* 求助事件落盘：NDJSON，一行一事件，只追加不滚动（低频，一年也不大）。
 * 失败只记日志、不抛出 —— 存储是旁路，绝不能因写盘失败中断求助闭环。 */
function appendHelpEvent(entry) {
  if (!config.storageEnabled) return;
  try {
    ensureDataDir();
    fs.appendFileSync(HELP_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.error('[help] 事件落盘失败：', e.message);
  }
}

/** 启动时回读历史求助事件，恢复 help.history（服务重启不再丢失证据） */
function loadHelpHistory() {
  if (!config.storageEnabled || !fs.existsSync(HELP_FILE)) return;
  try {
    const lines = fs.readFileSync(HELP_FILE, 'utf8').split('\n');
    const all = [];
    for (const ln of lines) {
      const s = ln.trim();
      if (!s) continue;
      try { all.push(JSON.parse(s)); } catch (_) { /* 跳过坏行 */ }
    }
    // 只保留最近 HELP_KEEP 条进内存；磁盘上仍是全量，不受此限制
    help.history = all.slice(-HELP_KEEP);
    if (help.history.length) {
      console.log(`[help] 已从 ${path.basename(HELP_FILE)} 恢复 ${help.history.length} 条历史事件（盘上共 ${all.length} 条）`);
    }
  } catch (e) {
    console.error('[help] 历史回读失败：', e.message);
  }
}

function helpLog(ev, detail) {
  const entry = {
    at: Date.now(),
    ev,
    detail: detail || null,
    // 证据字段：便于事后追溯「哪台设备、哪次求助」
    help_id: help.help_id || null,
    device_id: help.device_id || state.deviceId || null,
  };
  help.history.push(entry);
  if (help.history.length > HELP_KEEP) help.history.shift();
  appendHelpEvent(entry);
}

/** 板端上报的求助事件（request / cancel）—— 这是「远端接收」的唯一证据来源 */
function onHelpEvent(obj) {
  const ev = obj.event === 'cancel' ? 'cancel' : 'request';
  if (ev === 'request') {
    help.active = true;
    help.help_id = obj.help_id || null;
    help.device_id = obj.device || state.deviceId || null;
    help.status = 'received';
    help.event = 'request';
    help.received_at = Date.now();
    help.board_ts = typeof obj.ts === 'number' ? obj.ts : null;
    help.seq = typeof obj.seq === 'number' ? obj.seq : null;
    help.ack_sent_at = null; help.ack_channel_ok = null; help.ack_delivered = null;
    help.cancelled_at = null;
    help.note = '已收到板端求助 —— 这是「远端接收」的证据。等待查看者回应。';
    helpLog('received', obj.help_id);
    console.log(`[help] 收到求助 ${obj.help_id} ← ${help.device_id}`);
  } else {
    help.active = false;
    help.status = 'cancelled';
    help.event = 'cancel';
    help.cancelled_at = Date.now();
    help.note = '佩戴者已取消求助（板端本地已显示「已取消」）。';
    helpLog('cancelled', obj.help_id);
    console.log(`[help] 收到取消 ${obj.help_id}`);
  }
  pushHelp();
}

/** 网页回应：把 viewer_ack 下发到板端 */
function createHelpAck() {
  if (!help.active || help.status === 'cancelled') {
    return { ok: false, note: '当前没有待回应的求助。' };
  }
  const rid = help.help_id || `help-${Date.now()}`;
  // 用 sendCommandEx 取真实写路径，别用 serialOpen() 反推（见其上方说明）
  const ackSent = sendCommandEx({ cmd: 'viewer_ack', request_id: rid }, help.device_id);
  const ok = ackSent.ok;
  help.ack_sent_at = Date.now();
  help.ack_channel_ok = ok;
  help.ack_channel = ok ? ackSent.channel : null;
  if (ok) {
    help.status = 'acknowledged';
    help.ack_delivered = null;   // 等板端回执
    help.note = '回应已下发到设备，等待板端回执确认显示。';
    helpLog('ack_sent', rid);
  } else if (config.mockDevice) {
    help.status = 'acknowledged';
    help.ack_delivered = null;
    help.note = '模拟模式：回应未走真实串口（仅供联调，不代表板端已显示）。';
    helpLog('ack_mock', rid);
  } else {
    help.status = 'received';    // 未送达 → 状态不前进
    help.note = '⚠ 回应尚未送达设备（串口未打开，开发板也未在轮询）。命令已入队，若开发板在 15 秒内上线会被取走；在此之前板端不会显示「对方已收到」。';
    helpLog('ack_failed', rid);
  }
  pushHelp();
  return { ok, note: help.note };
}

/** 网页取消 */
function createHelpCancel() {
  if (!help.active && help.status === 'idle') {
    return { ok: false, note: '当前没有进行中的求助。' };
  }
  const rid = help.help_id || `help-${Date.now()}`;
  const ok = sendCommand({ cmd: 'help_cancel', request_id: rid }, help.device_id);
  help.status = 'cancelled';
  help.active = false;
  help.cancelled_at = Date.now();
  help.note = ok ? '查看者已取消，取消命令已下发到设备。'
                 : '已标记取消（命令通道不可用，板端未收到取消命令）。';
  helpLog('cancel_sent', rid);
  pushHelp();
  return { ok, note: help.note };
}

/** 板端回执：确认「对方已收到」是否真的已在板端显示 */
function onHelpAck(help_id, status) {
  if (help.help_id && help_id && help.help_id !== help_id) return;
  if (status === 'ack_shown') {
    help.ack_delivered = true;
    help.status = 'acknowledged';
    help.note = '板端已回执：屏幕已显示「对方已收到」。';
    helpLog('ack_delivered', help_id);
  } else if (status === 'no_active_help') {
    help.ack_delivered = false;
    help.note = '板端回执：当前没有进行中的求助，未显示「对方已收到」。';
    helpLog('ack_rejected', help_id);
  } else if (status === 'cancelled') {
    helpLog('cancel_delivered', help_id);
  }
  pushHelp();
}

function resetHelp() {
  help.active = false; help.help_id = null; help.status = 'idle'; help.event = null;
  help.received_at = null; help.board_ts = null; help.seq = null;
  help.ack_sent_at = null; help.ack_channel_ok = null; help.ack_delivered = null;
  help.cancelled_at = null; help.note = null;
  helpLog('reset', null);
  pushHelp();
}

/* ------------------------------------------------------------------ */
/* 语音链路（第 5 周）：板端录音 → 服务端落盘 → 浏览器识别 / 播报        */
/*                                                                     */
/* 音频来源与运行位置（作业要求，必须如实记录，前端会原样展示）：         */
/*   · 录音：ESP32-S3-EYE 板载 MEMS 麦克风（板端 I2S 采集，输出标准 WAV）  */
/*   · 识别：电脑浏览器 Web Speech API（zh-CN）                          */
/*   · 播报：电脑浏览器 speechSynthesis（板端没有扬声器）                 */
/* 服务端只做三件事：收 WAV 落盘、提供回放 / 取证下载、维护四段状态链。    */
/* 不调用外部 ASR/TTS（本机密钥已失效），NL 判定一律复用第 4 周 /api/nl。  */
/*                                                                     */
/* 阶段枚举（stage 与 status 同值，固件 / 前端共用同一套字符串）：         */
/*   recorded      板端 WAV 已保存为 data/voice/<audio_id>.wav          */
/*   transcribed   浏览器识别成功，带 transcript                        */
/*   asr_failed    识别失败 / 浏览器不支持，带 reason                    */
/*   task_running  文本已交给第 4 周 /api/nl（仅状态标记）                */
/*   task_done     NL 已返回，带 intent + reply                        */
/*   spoken        浏览器播报结束                                       */
/*   silent        录音无声 / 过短，未进入识别                          */
/*   timeout       链路某一步超时（识别 / NL / 采集）                    */
/*                                                                     */
/* 接口契约（前端 / 固件对接按这里，字段名不要改）：                      */
/*                                                                     */
/* 1) POST /api/voice/audio —— 板端上传 WAV 二进制                       */
/*    请求头：device: <设备号>（或 x-device-id / ?device=）              */
/*            duration_ms: <整数，可选；缺省时由 WAV 头算出>            */
/*    body：完整 WAV（RIFF+WAVE+fmt+data，16kHz/16bit/单声道为约定格式） */
/*    200 → { ok, audio_id, file, path, bytes, duration_ms, riff:"RIFF", */
/*            wave:"WAVE", sample_rate, channels, bits,                  */
/*            peak_dbfs, rms_dbfs, silent_hint, device_id,              */
/*            audio_url, download_url, event_persisted, state }         */
/*    400 → { ok:false, error:"not_wav"|"payload_too_large"|"empty_body" */
/*            |"read_failed"|"aborted", message:<中文原因>, ... }        */
/*    500 → { ok:false, error:"write_failed"|"storage_unavailable" }    */
/*                                                                     */
/* 2) GET /api/voice/audio/:id —— 回放（inline, audio/wav, 支持 Range） */
/* 3) GET /api/voice/audio/:id/download —— 取证下载（attachment）      */
/*    两者：不存在 → 404 {error:"not_found"}；id 非法 → 400              */
/*                                                                     */
/* 4) GET /api/voice —— 最近一条录音元信息 + 全链状态（固件实测取证用）  */
/*    → { ok, latest:{audio_id,bytes,riff,wave,sample_rate,channels,     */
/*         bits,duration_ms,peak_dbfs,rms_dbfs,silent_hint,device_id,    */
/*         received_at,stage,audio_url,download_url}|null,              */
/*        recent:[...], audio_total, events_total, state }              */
/*                                                                     */
/* 5) GET /api/voice/state —— 四段状态 + 事件历史（前端轮询）            */
/*    → { ok, audio_id, device_id, stage, stage_text, transcript,        */
/*        intent, reply, error, reason, bytes, duration_ms,             */
/*        received_at, updated_at, has_audio, audio_url, download_url,  */
/*        stages:[8 个枚举], audio_source, asr_runs_on, tts_runs_on,     */
/*        limits:{max_bytes}, history:[最近 50 条事件], events_file }    */
/*                                                                     */
/* 6) POST /api/voice/state —— 前端推进阶段                              */
/*    body：{ stage(必填), audio_id?, transcript?, intent?, reply?,      */
/*           reason?, error?, duration_ms? }                            */
/*    200 → { ok, persisted, voice:<GET state 同构快照> }                */
/*    400 → { ok:false, error:"missing_stage"|"invalid_stage"           */
/*           |"invalid_audio_id", stages:[枚举] }                        */
/*    说明：asr_failed / silent / timeout 未给 reason 时服务端补中文原因；*/
/*          reason/error 不跨阶段继承（只描述失败那一刻）。               */
/*                                                                     */
/* 7) POST /api/voice/record —— 远程触发一次录音（等价按板端 BOOT 键）    */
/*    body：{ action?:"start"|"stop"|"toggle" }（缺省 toggle）           */
/*    200 → { ok, accepted, dispatched, outcome, action, request_id,     */
/*           channel, ack_status, ack_seq, waited_ms, timeout_ms, note } */
/*    说明：板端是纯 HTTP 客户端，命令走串口直写或 WiFi 轮询队列；       */
/*          第 5 周收尾起本接口【等板端 ack】再回答：                     */
/*            dispatched=true 只代表写进了通道，accepted=true 才代表      */
/*            板端真的接受了（ok 与 accepted 同义，保留 ok 兼容旧调用方）。*/
/*          板端回 busy/error、超时未回执、通道不可用、模拟模式 → ok=false */
/*          并在 note 里给中文原因，绝不谎报。                            */
/*                                                                     */
/* WS：阶段推进广播 { type:"voice", voice:<同上快照> }；                  */
/*     新连接 hello 消息里带 voice 快照，刷新页面不丢链路。               */
/* ------------------------------------------------------------------ */
const VOICE_DIR = path.join(DATA_DIR, 'voice');
const VOICE_EVENTS_FILE = path.join(VOICE_DIR, 'events.ndjson');
const VOICE_KEEP = 50;                    // 内存只留最近 N 条事件，盘上仍是全量
const VOICE_MAX_BYTES = 1024 * 1024;       // 单个 WAV 上限 1 MB
const VOICE_STAGES = ['recorded', 'transcribed', 'asr_failed', 'task_running', 'task_done', 'spoken', 'silent', 'timeout'];
const VOICE_STAGE_SET = new Set(VOICE_STAGES);
const VOICE_STAGE_TEXT = {
  idle: '尚无语音链路',
  recorded: '已收到板端 WAV',
  transcribed: '浏览器已识别为文字',
  asr_failed: '识别失败（可改用文字入口）',
  task_running: '正在执行第 4 周 NL 任务',
  task_done: '任务已完成',
  spoken: '已在浏览器播报',
  silent: '没有检测到语音（无声或过短）',
  timeout: '链路超时（可改用文字入口）',
};
/* audio_id 同时用作文件名，必须严格校验，杜绝路径穿越 */
const VOICE_ID_RE = /^voice-\d{8}-\d{6}-\d{3}(-[0-9a-f]{4})?$/;

const voice = {
  audio_id: null,
  device_id: null,
  stage: 'idle',
  transcript: null,
  intent: null,
  reply: null,
  error: null,
  reason: null,
  bytes: null,
  duration_ms: null,
  received_at: null,      // 服务端收到 WAV 的时刻
  updated_at: null,       // 最近一次阶段推进的时刻
  history: [],            // 最近 VOICE_KEEP 条事件（只是事件流水，不是全量）
};

function ensureVoiceDir() {
  if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });
}

/* 板端自报的录音时长缓存：audio_id → duration_ms。
 * 转写前要判断「是否超过智谱 30 秒上限」，而由 WAV 头算出的时长在「录音被截断」
 * 或「板端自报值与文件不一致」时会偏差；applyVoiceEventToState 是所有事件
 * （新事件与启动回读）的唯一入口，在这里记一份即可，重启后由历史自然重建。 */
const VOICE_DUR = new Map();

/** 给前端的状态快照：字段名即契约，历史事件原样带出 */
function publicVoice() {
  const rel = (p2) => path.relative(ROOT, p2).split(path.sep).join('/');
  return {
    ok: true,
    audio_id: voice.audio_id,
    device_id: voice.device_id,
    stage: voice.stage,
    stage_text: VOICE_STAGE_TEXT[voice.stage] || voice.stage,
    transcript: voice.transcript,
    intent: voice.intent,
    reply: voice.reply,
    error: voice.error,
    reason: voice.reason,
    bytes: voice.bytes,
    duration_ms: voice.duration_ms,
    received_at: voice.received_at,
    updated_at: voice.updated_at,
    has_audio: !!(voice.audio_id && fs.existsSync(path.join(VOICE_DIR, voice.audio_id + '.wav'))),
    audio_url: voice.audio_id ? `/api/voice/audio/${voice.audio_id}` : null,
    download_url: voice.audio_id ? `/api/voice/audio/${voice.audio_id}/download` : null,
    stages: VOICE_STAGES,
    // 音频来源与运行位置：写死在这里，避免前端各自编造
    audio_source: 'board_mic_i2s',
    audio_source_text: 'ESP32-S3-EYE 板载 MEMS 麦克风（I2S 录音，录音在板端）',
    asr_runs_on: 'browser_web_speech',
    asr_runs_on_text: '电脑浏览器 Web Speech API（zh-CN，本机有麦克风时优先走这条）；本机没有麦克风时降级为服务端转写',
    asr_fallback_runs_on: 'server_glm_asr',
    asr_fallback_text: '服务端转写（智谱 GLM-ASR）：把 WAV 直接交给识别接口，不需要本机声卡',
    asr: asrConfigView(),
    tts_runs_on: 'browser_speech_synthesis',
    tts_runs_on_text: '电脑浏览器 speechSynthesis（播放在浏览器；板端无扬声器）',
    limits: { max_bytes: VOICE_MAX_BYTES },
    history: voice.history.slice(-VOICE_KEEP),
    events_file: rel(VOICE_EVENTS_FILE),
    audio_dir: rel(VOICE_DIR),
  };
}

function pushVoice() { broadcast({ type: 'voice', voice: publicVoice() }); }

/* 语音事件落盘：NDJSON，一行一事件，只追加不滚动（低频，一年也不大）。
 * 失败只记日志、不抛出 —— 存储是旁路，绝不能因写盘失败中断语音链路。
 * 注意：语音事件是「链路证据」，不跟随 storageEnabled 开关关闭。 */
function appendVoiceEvent(entry) {
  try {
    ensureVoiceDir();
    fs.appendFileSync(VOICE_EVENTS_FILE, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch (e) {
    console.error('[voice] 事件落盘失败（链路继续，不中断）：', e.message);
    return false;
  }
}

/** 新链路开始：清空上一段的识别 / 任务 / 播报字段，互不串味 */
function voiceResetChain() {
  voice.transcript = null;
  voice.intent = null;
  voice.reply = null;
  voice.error = null;
  voice.reason = null;
  voice.bytes = null;
  voice.duration_ms = null;
  voice.received_at = null;
}

const VOICE_EVENT_FIELDS = ['audio_id', 'device_id', 'transcript', 'intent', 'reply',
  'error', 'reason', 'bytes', 'duration_ms', 'received_at'];

/** 把一条事件应用进内存状态（追加新事件与启动回读共用同一条路径，避免两套逻辑漂移） */
function applyVoiceEventToState(ev) {
  if (!ev || !VOICE_STAGE_SET.has(ev.stage)) return;
  const aid = ev.audio_id || null;
  // 新的 audio_id 出现即视为新链路：上一段的识别 / 任务 / 播报字段必须清掉，不能串味
  const newChain = ev.stage === 'recorded' || (!!aid && aid !== voice.audio_id);
  if (newChain) {
    voiceResetChain();
    voice.audio_id = aid;      // 新链路：没有 audio_id 就是 null，绝不沿用上一段
  }
  voice.stage = ev.stage;
  if (aid) voice.audio_id = aid;
  for (const k of VOICE_EVENT_FIELDS) {
    if (k === 'audio_id') continue;
    if (Object.prototype.hasOwnProperty.call(ev, k)) voice[k] = ev[k];
  }
  voice.updated_at = ev.updated_at || ev.at || Date.now();
  // 记下板端自报时长，供转写前的「超 30 秒」判断使用
  if (ev.stage === 'recorded' && aid && Number.isFinite(ev.duration_ms)) VOICE_DUR.set(aid, ev.duration_ms);
}

/** 推进阶段：写内存 → append 落盘 → WS 广播 → 返回最新快照 */
function voiceApply(stage, patch) {
  const p = patch || {};
  const now = Date.now();
  const patchAid = p.audio_id != null ? p.audio_id : null;
  // 新链路判定：新录音事件，或上报了一个与当前不同的 audio_id
  const newChain = stage === 'recorded' || (!!patchAid && patchAid !== voice.audio_id);
  /* reason / error 不跨阶段继承：它们只描述「失败那一刻」。
   * 否则会出现 stage=spoken 却仍挂着 asr_failed 的 reason 这种自相矛盾快照，
   * 前端据此渲染会误导（"已播报"与"识别失败"同时显示）。
   * 来源只有 patch（失败阶段由路由补默认中文原因）。 */
  const base = newChain ? {
    audio_id: patchAid,          // 未指定则留空：绝不沿用上一段的 audio_id 冒充本次
    device_id: p.device_id !== undefined ? p.device_id : null,
    transcript: null, intent: null, reply: null, error: null, reason: null,
    bytes: p.bytes !== undefined ? p.bytes : null,
    duration_ms: p.duration_ms !== undefined ? p.duration_ms : null,
    received_at: now,
  } : {
    audio_id: voice.audio_id,
    device_id: p.device_id !== undefined ? p.device_id : voice.device_id,
    transcript: voice.transcript, intent: voice.intent, reply: voice.reply,
    error: null, reason: null,
    bytes: voice.bytes, duration_ms: voice.duration_ms, received_at: voice.received_at,
  };
  const entry = { at: now, ts: now, stage, status: stage };
  for (const k of VOICE_EVENT_FIELDS) {
    entry[k] = Object.prototype.hasOwnProperty.call(p, k) ? p[k] : base[k];
  }
  entry.updated_at = now;
  applyVoiceEventToState(entry);
  voice.history.push(entry);
  if (voice.history.length > VOICE_KEEP) voice.history.shift();
  const persisted = appendVoiceEvent(entry);
  pushVoice();
  return { persisted, state: publicVoice() };
}

/** 启动时回读历史语音事件：重启后 GET /api/voice/state 仍能看到上次链路 */
function loadVoiceHistory() {
  try { ensureVoiceDir(); } catch (e) { console.error('[voice] 创建语音目录失败：', e.message); return; }
  if (!fs.existsSync(VOICE_EVENTS_FILE)) {
    console.log('[voice] 暂无语音事件历史（首次录音后自动创建 events.ndjson）');
    return;
  }
  try {
    const all = [];
    for (const ln of fs.readFileSync(VOICE_EVENTS_FILE, 'utf8').split('\n')) {
      const s = ln.trim();
      if (!s) continue;
      try { all.push(JSON.parse(s)); } catch (_) { /* 跳过坏行 */ }
    }
    voice.history = [];
    for (const ev of all) applyVoiceEventToState(ev);
    voice.history = all.slice(-VOICE_KEEP);   // 盘上仍是全量，内存只留最近 N 条
    if (all.length) {
      console.log(`[voice] 已从 ${path.basename(VOICE_EVENTS_FILE)} 恢复 ${voice.history.length} 条事件（盘上共 ${all.length} 条），当前阶段 ${voice.stage}`);
    }
  } catch (e) {
    console.error('[voice] 历史回读失败：', e.message);
  }
}

/* ---- WAV 头解析：只读头部，不解码 PCM（服务端不需要听声音） ---- */
/* totalBytes：文件真实总大小。只读头部时 buf 可能只是前 64 KB，
 * data 块声明的长度才是真实值，用 totalBytes 兜住，否则时长会被截短。
 *
 * 【2026-10-28 修复】块遍历原来只在 buf（文件前 64 KB）内进行：一旦 data 块
 * 起点落在这之外（例如 fmt 块异常大），就找不到 data 块，于是兜底成
 * 「偏移 44 + 全文件剩余」，把 fmt 块的内容当成 PCM 读 —— 电平算错却不报错，
 * 属静默错误。现在遍历上限改为文件真实大小 total，落在 buf 之外的块头用
 * 可选的 readAt(offset, len) 补读（回读路径传的是 fs.readSync）。
 * 不传 readAt 时行为与原来一致（只走内存，上传路径即如此）。 */
function parseWavHeader(buf, totalBytes, readAt) {
  const out = {
    ok: false, riff: null, wave: null, format: null, channels: null,
    sample_rate: null, bits: null, data_bytes: null, duration_ms: null, error: null,
  };
  if (!buf || buf.length < 12) { out.error = 'too_short'; return out; }
  out.riff = buf.toString('latin1', 0, 4);
  out.wave = buf.toString('latin1', 8, 12);
  if (out.riff !== 'RIFF') { out.error = 'not_riff'; return out; }
  if (out.wave !== 'WAVE') { out.error = 'not_wave'; return out; }
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : buf.length;
  /* 取 [from, to) 字节：完全落在 buf 内就直接切片，否则用 readAt 补读。
   * 补读失败（文件被截断 / IO 错误）返回 null，由调用处停止遍历。 */
  const need = (from, to) => {
    if (from < 0 || to < from) return null;
    if (to <= buf.length) return buf.subarray(from, to);
    if (typeof readAt !== 'function') return null;
    try {
      const b = readAt(from, to - from);
      return b && b.length === to - from ? b : null;
    } catch (_) { return null; }
  };
  let off = 12;
  let dataOff = null;
  while (off + 8 <= total) {
    const hdr = need(off, off + 8);
    if (!hdr) break;                         // 块头读不到：就此打住
    const id = hdr.toString('latin1', 0, 4);
    const size = hdr.readUInt32LE(4);
    const body = off + 8;
    if (id === 'fmt ') {
      const fb = need(body, body + 16);
      if (fb) {
        out.format = fb.readUInt16LE(0);
        out.channels = fb.readUInt16LE(2);
        out.sample_rate = fb.readUInt32LE(4);
        out.bits = fb.readUInt16LE(14);
      }
    } else if (id === 'data') {
      dataOff = body;
      // 声明长度可能大于实际文件（截断录音）：取二者较小者
      out.data_bytes = Math.min(size, Math.max(0, total - body));
      break;
    }
    if (!size) break;                        // 空块：防死循环
    off = body + size + (size % 2);          // 块按偶数字节对齐
  }
  if (out.data_bytes == null) {
    // 真的没有 data 块（或块头全读不到）：只能按最保守的 44 兜底
    out.data_bytes = Math.max(0, total - 44);
    dataOff = 44;
  }
  const bps = (out.sample_rate || 0) * (out.channels || 0) * ((out.bits || 0) / 8);
  out.duration_ms = bps > 0 ? Math.round((out.data_bytes / bps) * 1000) : null;
  out.data_offset = dataOff;
  out.ok = true;
  return out;
}

/* 电平统计：给「无声 / 过短」一个服务端可复核的依据，而不是只靠浏览器自述。
 *
 * 【2026-10-28 修复】此前回读路径（readVoiceAudioMeta）只把文件前 64 KB 读进
 * 来做统计：6 秒录音约 190 KB，等于只看了前 ~2 秒 —— 前段安静、后段有人说话
 * 时服务端会报静音，前端提示「未录到声音」，而实际录到了。真机实测同一文件
 * 服务端 -39.8 dBFS、全量 -44.3 dBFS，差 4.5 dB。
 * 现在拆成「累加器 + 两种喂法」：
 *   · wavLevelStats(buf, wav)              —— 上传路径，内存里已有完整 PCM；
 *   · wavLevelStatsFromFile(file, wav)     —— 回读路径，流式分块读全量 PCM。
 * 两条路径共用同一套累加逻辑，保证 /api/voice/audio 与 GET /api/voice 报的
 * 电平值一致（否则前端看到的值取决于走哪个接口）。
 *
 * 抽样步长固定 32 字节（= 16 个 16-bit 样本），分块大小取 32 的整数倍，
 * 这样「流式分块读」与「一次读完」的抽样点完全相同，结果逐位一致。 */
const LEVEL_STRIDE = 32;

function newLevelAcc() {
  return { peak: 0, sum: 0, n: 0, zeros: 0 };
}

/** 把 buf[from, to) 里的抽样点累加进 acc。from 必须与 data 起点 32 字节对齐。 */
function feedLevelAcc(acc, buf, from, to) {
  for (let i = from; i + 1 < to; i += LEVEL_STRIDE) {
    const v = buf.readInt16LE(i);
    const a = Math.abs(v);
    if (a > acc.peak) acc.peak = a;
    if (a <= 1) acc.zeros++;
    acc.sum += v * v;
    acc.n++;
  }
}

/** 累加器 → 对外字段。保留 peak / rms / peak_dbfs / rms_dbfs / silent_hint /
 *  zero_ratio 这些既有字段名（前端与 test/voice-test.js 都依赖）。 */
function finishLevelAcc(acc) {
  const out = { peak: 0, rms: 0, silent_hint: null, zero_ratio: null };
  if (!acc.n) return out;
  out.peak = acc.peak;
  out.peak_dbfs = acc.peak > 0 ? Math.round(20 * Math.log10(acc.peak / 32768) * 10) / 10 : null;
  out.rms = Math.round(Math.sqrt(acc.sum / acc.n));
  out.rms_dbfs = out.rms > 0 ? Math.round(20 * Math.log10(out.rms / 32768) * 10) / 10 : null;
  out.zero_ratio = Math.round((acc.zeros / acc.n) * 1000) / 1000;
  // 峰值 <= -40 dBFS（约 328）视为基本无声；仅作提示，最终 stage 由前端判定
  out.silent_hint = acc.peak < 328;
  return out;
}

const EMPTY_LEVEL = () => ({ peak: 0, rms: 0, silent_hint: null, zero_ratio: null });
const SILENT_LEVEL = () => ({ peak: 0, rms: 0, silent_hint: true, zero_ratio: null });

/** 上传路径：内存里已有完整 WAV，直接在 buf 上算。 */
function wavLevelStats(buf, wav) {
  try {
    if (!wav || !wav.ok || wav.format !== 1 || wav.bits !== 16) return EMPTY_LEVEL();
    const start = wav.data_offset || 44;
    const end = Math.min(buf.length, start + wav.data_bytes);
    if (end - start < 4) return SILENT_LEVEL();
    const acc = newLevelAcc();
    feedLevelAcc(acc, buf, start, end);
    return finishLevelAcc(acc);
  } catch (_) { return EMPTY_LEVEL(); }
}

/** 回读路径：只从盘上流式读 data 段的 PCM，**不把整个 WAV 读进内存**。
 * 块大小 64 KB（32 的整数倍，保证抽样点与一次读完一致）。
 * 10 秒上限 = 320 KB 虽然整读也可承受，但流式的好处是不随上限增长而变差：
 * 将来放宽 VOICE_MAX_BYTES 或写入更长的录音，这里的内存占用恒为 64 KB。 */
function wavLevelStatsFromFile(file, wav) {
  const CHUNK = 64 * 1024;
  try {
    if (!wav || !wav.ok || wav.format !== 1 || wav.bits !== 16) return EMPTY_LEVEL();
    const start = wav.data_offset || 44;
    const total = Math.max(0, wav.data_bytes || 0);
    if (total < 4) return SILENT_LEVEL();
    const acc = newLevelAcc();
    const chunk = Buffer.alloc(Math.min(CHUNK, total));
    const fd = fs.openSync(file, 'r');
    try {
      let pos = 0;
      while (pos < total) {
        const want = Math.min(chunk.length, total - pos);
        const got = fs.readSync(fd, chunk, 0, want, start + pos);
        if (got <= 0) break;
        feedLevelAcc(acc, chunk, 0, got);
        pos += got;
        if (got < want) break;        // 文件被截断：已读到的部分照样算，不补零
      }
    } finally { fs.closeSync(fd); }
    return finishLevelAcc(acc);
  } catch (e) {
    console.error('[voice] 电平统计读盘失败：', file, e.message);
    return EMPTY_LEVEL();
  }
}

/* audio_id → 绝对路径（严格校验，非法一律当不存在） */
function voiceAudioFile(audioId) {
  if (!audioId || !VOICE_ID_RE.test(audioId)) return null;
  return path.join(VOICE_DIR, audioId + '.wav');
}

function newVoiceId() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  for (let i = 0; i < 20; i++) {
    const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    const id = `voice-${stamp}-${ms}-${rand}`;
    if (!fs.existsSync(path.join(VOICE_DIR, id + '.wav'))) return id;
  }
  return `voice-${stamp}-${ms}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
}

/* 板端串口上传摘要（type:'voice'）：只作链路证据，绝不产生传感字段。
 * 固件在录音上传成功后 printf 一行 JSON，这里把它记进链路状态与事件流水，
 * 让「串口说 http:200 / audio_id=X」与「HTTP 侧实际存的 X」能对上。 */
function onVoiceUploadSummary(obj) {
  const audioId = typeof obj.audio_id === 'string' ? obj.audio_id.trim() : '';
  const entry = {
    stage: 'recorded',
    source: 'serial_summary',
    device_id: obj.device ? String(obj.device) : (state.deviceId || null),
    bytes: typeof obj.bytes === 'number' ? obj.bytes : null,
    duration_ms: typeof obj.duration_ms === 'number' ? obj.duration_ms : null,
    http_status: typeof obj.http === 'number' ? obj.http : null,
    riff: typeof obj.riff === 'string' ? obj.riff : null,
    note: obj.error ? String(obj.error) : null,
  };
  if (audioId && VOICE_ID_RE.test(audioId)) entry.audio_id = audioId;
  // 只在串口摘要确实指向一次成功上传时，才把 audio_id 回填进链路状态；
  // 失败摘要（http!=200 / error 非空）只留证据，不改状态，避免污染链路。
  const okUpload = entry.http_status == null || entry.http_status === 200 || entry.http_status === 201;
  if (okUpload && entry.audio_id && !voice.audio_id) {
    voice.audio_id = entry.audio_id;
    voice.device_id = voice.device_id || entry.device_id;
    voice.bytes = voice.bytes == null ? entry.bytes : voice.bytes;
    voice.duration_ms = voice.duration_ms == null ? entry.duration_ms : voice.duration_ms;
    voice.received_at = voice.received_at || Date.now();
    voice.updated_at = Date.now();
    pushVoice();
  }
  console.log(`[voice] 板端上传摘要 ← ${entry.device_id || '?'} http=${entry.http_status == null ? '?' : entry.http_status} audio_id=${entry.audio_id || '(无)'} ${entry.bytes == null ? '?' : entry.bytes} 字节`);
  return entry;
}

/** 读文件头生成元信息（不复用内存缓存，重启后也能如实反映盘上内容） */
function readVoiceAudioMeta(audioId) {
  const file = voiceAudioFile(audioId);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    /* 头部只读前 64 KB（绝大多数 WAV 的块头都在这一段里）；
     * 但**电平统计不能只看这一段** —— 见 wavLevelStatsFromFile 的说明。
     * 2026-10-28 修复前这里直接对 head 做统计，6 秒录音只覆盖了前 ~2 秒。
     * 另外块遍历的上限是文件真实大小：data 块起点若落在 64 KB 之外，
     * 用 readAt 补读块头，避免兜底成偏移 44 把 fmt 内容当 PCM（静默错误）。 */
    const headLen = Math.min(65536, st.size);
    const head = Buffer.alloc(headLen);
    const fd = fs.openSync(file, 'r');
    let wav;
    try {
      fs.readSync(fd, head, 0, headLen, 0);
      const readAt = (from, len) => {
        const b = Buffer.alloc(len);
        const got = fs.readSync(fd, b, 0, len, from);
        return got === len ? b : b.subarray(0, got);
      };
      wav = parseWavHeader(head, st.size, readAt);
    } finally { fs.closeSync(fd); }
    const lv = wavLevelStatsFromFile(file, wav);   // 流式读全量 PCM，不整文件进内存
    return {
      audio_id: audioId,
      file: path.basename(file),
      bytes: st.size,
      is_wav: wav.ok,
      riff: wav.riff,
      wave: wav.wave,
      bytes_head: wav.riff,
      sample_rate: wav.sample_rate,
      channels: wav.channels,
      bits: wav.bits,
      data_bytes: wav.data_bytes,
      duration_ms: wav.duration_ms,
      peak_dbfs: lv.peak_dbfs != null ? lv.peak_dbfs : null,
      rms_dbfs: lv.rms_dbfs != null ? lv.rms_dbfs : null,
      silent_hint: lv.silent_hint,
      mtime: st.mtimeMs,
      audio_url: `/api/voice/audio/${audioId}`,
      download_url: `/api/voice/audio/${audioId}/download`,
    };
  } catch (e) {
    console.error('[voice] 读取音频元信息失败：', audioId, e.message);
    return null;
  }
}

/** 列出最近的语音文件（按 audio_id 倒序，id 内含时间戳） */
function listVoiceAudios(limit) {
  try {
    ensureVoiceDir();
    const names = fs.readdirSync(VOICE_DIR).filter((n) => n.endsWith('.wav')).sort().reverse();
    const rows = [];
    for (const n of names.slice(0, Math.min(limit || 20, 50))) {
      const m = readVoiceAudioMeta(n.replace(/\.wav$/, ''));
      if (m) rows.push(m);
    }
    return { total: names.length, rows };
  } catch (e) {
    console.error('[voice] 列出音频失败：', e.message);
    return { total: 0, rows: [] };
  }
}

function voiceEventsTotal() {
  try {
    if (!fs.existsSync(VOICE_EVENTS_FILE)) return 0;
    return fs.readFileSync(VOICE_EVENTS_FILE, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch (_) { return 0; }
}

function pushStatus(reason) {
  broadcast({
    type: 'status',
    connected: state.connected,
    live: state.live,           // true=实时流动；false=停采保留（保留旧值旧时间）
    portOpen: serialOpen(),
    wifiDownlink: wifiDownlinkActive(),   // 板端正通过 WiFi 轮询取命令
    downlinkKind: currentChannelKind(),
    transport: state.transport,
    device: state.device,
    deviceId: state.deviceId,   // 设备身份标识（核对数据来自本组设备）
    deviceMac: state.deviceMac,
    deviceVerified: state.deviceVerified, // 是否通过本组身份校验
    expectedDeviceId: config.expectedDeviceId,
    lastDataAt: state.lastDataAt,
    boardTs: state.boardTs,     // 板端时间戳（毫秒 UTC）
    boardIso: state.boardIso,
    seq: state.seq,
    reportPaused: !!state.reportPaused,
    stale: isStale(),
    stalePolicy: config.stalePolicy,
    config: {
      portPath: config.portPath,
      baudRate: config.baudRate,
      autoDetect: config.autoDetect,
      autoReconnect: config.autoReconnect,
      storageEnabled: config.storageEnabled,
    },
    serverTime: Date.now(),
    reason: reason || null,
  });
}

function isStale() {
  if (!state.connected || !state.live || !state.lastDataAt) return false;
  return Date.now() - state.lastDataAt > config.staleAfterMs;
}

/** 离线 -> 清空全部数据（关键：拔出开发板/手动释放后不再显示任何值） */
function goOffline(reason) {
  state.connected = false;
  state.live = false;
  state.transport = null;
  state.device = null;
  state.deviceId = null;
  state.deviceMac = null;
  state.deviceVerified = null;
  state.lastDataAt = null;
  state.boardTs = null;
  state.boardIso = null;
  state.seq = null;
  state.fields = {};
  state.wifiSource = null;
  broadcast({ type: 'cleared', reason: reason || 'disconnected' });
  pushStatus(reason);
}

/**
 * 停采/静默 -> 保留最后一次真实值与旧时间，仅标记"未更新"。
 * 与 goOffline 的区别：不清空数值，前端据此显示"停采保留"状态。
 */
function goStale(reason) {
  state.live = false;
  broadcast({ type: 'stale', reason: reason || 'no-data-timeout', lastDataAt: state.lastDataAt, boardTs: state.boardTs });
  pushStatus(reason);
}

/* ------------------------------------------------------------------ */
/* 自然语言助手（第 4 周）：自然语言 → 意图 → 受限工具 → 真实结果        */
/*                                                                     */
/* 三条设计红线：                                                       */
/*   ① 密钥留服务端：LLM 密钥只读自 config.local.json（gitignored）或    */
/*      环境变量，绝不进 config.json（受版本控制），前端拿不到；          */
/*   ② 工具受限：只暴露 query_last / collect_once 两件事，               */
/*      设备白名单 + 意图白名单，越界一律拒绝；                           */
/*   ③ 诚实性：query 保留旧时间并声明"是历史记录"；                      */
/*      collect 必须等到状态机 completed 才说"采集成功"；                */
/*      无位置数据时如实说明，绝不生成坐标。                              */
/* ------------------------------------------------------------------ */

/* ---- LLM 配置（OpenAI 兼容协议；任意兼容服务均可接入） ----
 * 密钥只落 config.local.json（gitignored）或环境变量；前端任何时刻只能拿到脱敏值。
 * 环境变量优先级高于文件：设了 NL_ENDPOINT/NL_API_KEY 时界面只读（409 提示）。
 * NL_CONFIG_PATH 可指定其它配置文件路径（并行测试/多实例隔离用）。 */
const NL_LOCAL_PATH = process.env.NL_CONFIG_PATH || path.join(ROOT, 'config.local.json');
const NL_ENV_ACTIVE = !!(process.env.NL_ENDPOINT || process.env.NL_API_KEY);

function readNlFileCfg() {
  try {
    if (fs.existsSync(NL_LOCAL_PATH)) return JSON.parse(fs.readFileSync(NL_LOCAL_PATH, 'utf8'));
  } catch (e) { console.warn('[nl] config.local.json 读取失败：', e.message); }
  return {};
}

/* 运行期配置：env 覆盖文件；文件改动后调 reloadNlConfig() 重载
 * replyMode：回复文案由谁写 —— 'llm' = 模型基于真实证据组织（服务端数字核对，
 * 校验不过自动回落模板）；'template' = 始终用服务端模板。 */
const NL = { endpoint: null, apiKey: null, model: 'deepseek-chat', timeoutMs: 8000, replyMode: 'llm' };
function reloadNlConfig() {
  const f = readNlFileCfg();
  NL.endpoint = process.env.NL_ENDPOINT || f.nlEndpoint || null;
  NL.apiKey   = process.env.NL_API_KEY  || f.nlApiKey  || null;
  NL.model    = process.env.NL_MODEL    || f.nlModel   || 'deepseek-chat';
  NL.timeoutMs = Number(process.env.NL_TIMEOUT_MS || f.nlTimeoutMs || 8000);
  NL.replyMode = (process.env.NL_REPLY_MODE || f.nlReplyMode) === 'template' ? 'template' : 'llm';
}
reloadNlConfig();

/* 密钥脱敏：只回前 3 + 后 4 位，任何接口不得返回完整 key */
function maskKey(k) {
  if (!k) return null;
  const s = String(k);
  return s.length <= 7 ? '********' : s.slice(0, 3) + '****' + s.slice(-4);
}

/* 把 nl* 补丁合并写入 config.local.json（保留文件里其它键），返回是否成功 */
function writeNlFileCfg(patch) {
  const all = readNlFileCfg();
  for (const k of Object.keys(patch)) {
    if (patch[k] === null) delete all[k];
    else all[k] = patch[k];
  }
  fs.writeFileSync(NL_LOCAL_PATH, JSON.stringify(all, null, 2), 'utf8');
}

/* 校验 + 规范化一组 LLM 配置参数；不合法抛 Error（消息即用户提示） */
function validateNlParams(raw, { requireKey }) {
  const out = {};
  const ep = String(raw.endpoint ?? '').trim();
  if (!ep) throw new Error('API 地址不能为空');
  let u;
  try { u = new URL(ep); } catch (_) { throw new Error('API 地址不是合法 URL（示例：https://api.deepseek.com）'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('API 地址只支持 http:// 或 https://');
  out.endpoint = ep.replace(/\/+$/, '');
  const key = String(raw.apiKey ?? '').trim();
  if (requireKey && !key) throw new Error('API Key 不能为空');
  if (key.length > 300) throw new Error('API Key 过长（>300 字符）');
  if (/\s/.test(key)) throw new Error('API Key 不能包含空白字符');
  out.apiKey = key || null;
  const model = String(raw.model ?? '').trim();
  if (!model) throw new Error('模型名称不能为空');
  if (model.length > 100) throw new Error('模型名称过长（>100 字符）');
  out.model = model;
  const tm = Number(raw.timeoutMs ?? 8000);
  if (!Number.isFinite(tm) || tm < 1000 || tm > 30000) throw new Error('超时时间需在 1000~30000 毫秒之间');
  out.timeoutMs = Math.round(tm);
  // 仅在显式传入时改动回复模式，避免"测试连接"等调用顺手把它重置
  if (raw.replyMode !== undefined) out.replyMode = raw.replyMode === 'template' ? 'template' : 'llm';
  return out;
}

/* 脱敏视图：查看/保存/删除/测试都返回同一形状，绝不带完整 key */
function nlConfigView() {
  const src = NL_ENV_ACTIVE ? 'env' : (NL.endpoint && NL.apiKey ? 'file' : 'none');
  let host = null;
  try { if (NL.endpoint) host = new URL(NL.endpoint).host; } catch (_) {}
  return {
    ok: true,
    configured: !!(NL.endpoint && NL.apiKey),
    source: src,
    env_locked: NL_ENV_ACTIVE,
    endpoint: NL.endpoint,
    model: NL.model,
    timeoutMs: NL.timeoutMs,
    replyMode: NL.replyMode,
    apiKey_masked: maskKey(NL.apiKey),
    llm_host: host,
    // 可观测性：命中复用/熔断时为什么这次没真正调模型
    cache_size: NL_CACHE.size,
    breaker_open: nlBreakerOpen(),
    breaker_open_ms: nlBreakerOpen() ? (NL_CB.openUntil - Date.now()) : 0,
  };
}

/* 拼接 models 列表地址（与 chat 端点同样的版本段处理，避免 /v1/v1） */
function nlModelsUrl(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, '/models');
  if (/\/openai$/i.test(base)) return base + '/models';
  if (/\/v\d+[a-z0-9]*$/i.test(base)) return base + '/models';
  return base + '/v1/models';
}

/* 拼接 chat/completions 请求地址。兼容三种常见写法，避免出现 /v1/v1/... 这类重复路径：
 *   ① 纯域名                  https://api.deepseek.com          → +/v1/chat/completions
 *   ② 已带版本段/兼容前缀      https://x.com/v1、/compatible-mode/v1、/api/paas/v4、/v1beta/openai
 *                                                              → 只补 /chat/completions
 *   ③ 已是完整端点             https://x.com/v1/chat/completions → 原样使用
 * 这是 404「地址或模型不存在」最常见的成因：用户按厂商文档粘贴带 /v1 的 Base URL。 */
function nlChatCompletionsUrl(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;                 // ③ 完整端点
  if (/\/openai$/i.test(base)) return base + '/chat/completions';      // ② Gemini 兼容层 .../v1beta/openai
  if (/\/v\d+[a-z0-9]*$/i.test(base)) return base + '/chat/completions'; // ② 已带 /v1、/v2、/v4、/v1beta…
  return base + '/v1/chat/completions';                                // ① 纯域名补默认版本段
}

/* ===== 服务端语音转写（智谱 GLM-ASR）=====
 *
 * 为什么需要它（2026-10-30 实测，不是拍脑袋）：
 *   浏览器 Web Speech API **只能听麦克风**，没有任何接口能把一段 WAV 直接喂进去。
 *   所以原设计只能「扬声器外放这段录音 → 麦克风再听回来」，本质是放给自己听。
 *   在「电脑没麦克风、也没扬声器；板子只有麦克风」的机器上，这条路物理上走不通
 *   （实测 12 个录音端点全 NOTPRESENT/UNPLUGGED）。
 *   这里补一个「把 WAV 直接交给识别器」的服务端出口，识别不再依赖本机声卡。
 *
 * 有麦克风的机器仍优先走 Web Speech（课程 §12 原文要求），此接口作为降级路径。
 *
 * 配置优先级：环境变量 > config.local.json 的 asr* 字段 > 复用 NL 的 endpoint/apiKey
 * （同属智谱 open.bigmodel.cn 时无需另配一份密钥）。密钥只落 gitignored 文件或 env，
 * 前端任何时刻只拿得到 maskKey() 的脱敏值。
 */
const ASR_MAX_BYTES = 25 * 1024 * 1024;   // 智谱该接口限制 25 MB
const ASR_MAX_MS = 30000;                 // 智谱该接口限制 30 秒
const ASR_DEFAULT_MODEL = 'glm-asr-2512'; // 该接口文档里唯一枚举
const ASR = { enabled: false, endpoint: null, apiKey: null, model: ASR_DEFAULT_MODEL, timeoutMs: 20000 };

/* 默认**关闭**。这不是保守，是隐私边界：一旦启用，用户按下识别就会把录音发到厂商。
 * 所以启用必须是一次显式动作（config.local.json 里 asrEnabled: true，或 ASR_ENABLED=1），
 * 不靠「复用 NL 的 key」偷偷生效 —— 用户还没确认过账号与计费。 */
function asrEnabledByConfig(v) {
  if (v === true) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function reloadAsrConfig() {
  const f = readNlFileCfg();
  ASR.enabled = asrEnabledByConfig(process.env.ASR_ENABLED != null ? process.env.ASR_ENABLED : f.asrEnabled);
  ASR.endpoint = process.env.ASR_ENDPOINT || f.asrEndpoint || NL.endpoint || null;
  ASR.apiKey = process.env.ASR_API_KEY || f.asrApiKey || NL.apiKey || null;
  ASR.model = process.env.ASR_MODEL || f.asrModel || ASR_DEFAULT_MODEL;
  const t = Number(process.env.ASR_TIMEOUT_MS || f.asrTimeoutMs || 20000);
  ASR.timeoutMs = Number.isFinite(t) && t > 0 ? t : 20000;
}
reloadAsrConfig();

/* 上限可从环境变量注入，供测试用小值验证「超限必须拒绝」这条分支
 * （真去造一个 25 MB 的 WAV 只会让测试变慢，不会多验证任何逻辑）。 */
function asrLimits() {
  const mb = Number(process.env.ASR_MAX_BYTES);
  const ms = Number(process.env.ASR_MAX_MS);
  return {
    maxBytes: Number.isFinite(mb) && mb > 0 ? mb : ASR_MAX_BYTES,
    maxMs: Number.isFinite(ms) && ms > 0 ? ms : ASR_MAX_MS,
  };
}

/* 拼接转写地址。与 nlChatCompletionsUrl 同一套版本段处理，避免 /v4/v1 这类重复：
 *   ① 已是完整端点 .../audio/transcriptions → 原样
 *   ② 已带版本段（/api/paas/v4、/v1、/v1beta）→ 只补 /audio/transcriptions
 *   ③ 纯域名 → 补 /v1/audio/transcriptions */
function asrTranscriptionsUrl(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/i.test(base)) return base;
  if (/\/openai$/i.test(base)) return base + '/audio/transcriptions';
  if (/\/v\d+[a-z0-9]*$/i.test(base)) return base + '/audio/transcriptions';
  return base + '/v1/audio/transcriptions';
}

/* 给前端看的转写配置（脱敏）。configured=false 时前端应改走文字入口，而不是硬试。 */
function asrConfigView() {
  const configured = !!(ASR.endpoint && ASR.apiKey);
  let host = null;
  try { host = ASR.endpoint ? new URL(ASR.endpoint).host : null; } catch (_) { /* 非法 URL */ }
  return {
    enabled: ASR.enabled,
    configured,
    endpoint: ASR.endpoint || null,
    model: ASR.model,
    timeoutMs: ASR.timeoutMs,
    apiKey_masked: maskKey(ASR.apiKey),
    asr_host: host,
    max_bytes: asrLimits().maxBytes,
    max_ms: asrLimits().maxMs,
    source: (process.env.ASR_ENDPOINT || process.env.ASR_API_KEY) ? 'env' : (configured ? 'file' : 'none'),
  };
}

/* 把一段已落盘的 WAV 送去转写。
 * 返回 { http, body }：http 是给前端的 HTTP 状态码，body 是响应体（ok 字段区分成败）。
 * 任何失败都必须如实分类，绝不把「没转出来」当成功 —— 这是本项目一以贯之的判据。 */
async function voiceTranscribe(audioId) {
  const file = voiceAudioFile(audioId);
  if (!file || !fs.existsSync(file)) {
    return { http: 404, body: { ok: false, error: 'audio_not_found', audio_id: audioId, message: `找不到录音 ${audioId}。` } };
  }
  const lim = asrLimits();
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) {
    return { http: 500, body: { ok: false, error: 'read_failed', audio_id: audioId, message: '读取录音失败：' + e.message } };
  }
  // 先做输入侧校验（体积/时长/配置），任何一项不过都不上传——省掉无谓的外发
  if (size > lim.maxBytes) {
    return { http: 413, body: {
      ok: false, error: 'asr_audio_too_large', audio_id: audioId, bytes: size, max_bytes: lim.maxBytes,
      message: `录音 ${size} 字节超过转写上限 ${lim.maxBytes} 字节（${Math.round(lim.maxBytes / 1024 / 1024 * 10) / 10} MB），未上传。请缩短录音时长。`,
    } };
  }
  // 时长优先用板端自报（更准），缺失时退回 WAV 头计算值
  let durMs = VOICE_DUR.get(audioId);
  if (!Number.isFinite(durMs)) {
    const meta = readVoiceAudioMeta(audioId);
    durMs = meta && Number.isFinite(meta.duration_ms) ? meta.duration_ms : null;
  }
  if (Number.isFinite(durMs) && durMs > lim.maxMs) {
    return { http: 400, body: {
      ok: false, error: 'asr_audio_too_long', audio_id: audioId, duration_ms: durMs, max_ms: lim.maxMs,
      message: `录音 ${durMs} ms 超过转写上限 ${lim.maxMs} ms（${Math.round(lim.maxMs / 1000)} 秒），未上传。`,
    } };
  }
  if (!ASR.enabled) {
    // 关闭状态下绝不外发：连一次请求都不发，录音不出本机
    return { http: 503, body: {
      ok: false, error: 'asr_disabled', audio_id: audioId,
      message: '服务端转写默认关闭（启用会把这段录音发到厂商）。确认账号与费用后，'
        + '在 config.local.json 里设 "asrEnabled": true（或用环境变量 ASR_ENABLED=1）再重启服务。'
        + '在此之前请改用文字输入。',
    } };
  }
  if (!ASR.endpoint || !ASR.apiKey) {
    return { http: 503, body: {
      ok: false, error: 'asr_not_configured', audio_id: audioId,
      message: '服务端转写未配置：请在 config.local.json 里配 asrEndpoint/asrApiKey（或复用 NL 的 endpoint/key），'
        + '也可用环境变量 ASR_ENDPOINT / ASR_API_KEY 注入。未配置时请改用文字输入。',
    } };
  }

  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ASR.timeoutMs);
  let resp, text, upstreamStatus = null;
  try {
    const buf = fs.readFileSync(file);
    const form = new FormData();
    form.append('model', ASR.model);
    form.append('file', new Blob([buf], { type: 'audio/wav' }), path.basename(file));
    resp = await fetch(asrTranscriptionsUrl(ASR.endpoint), {
      method: 'POST',
      headers: { Authorization: `Bearer ${ASR.apiKey}` },
      body: form,
      signal: ac.signal,
    });
    upstreamStatus = resp.status;
    text = await resp.text();
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
    const providerMs = Date.now() - started;
    const code = aborted ? 'asr_timeout' : 'asr_failed';
    const reason = aborted
      ? `转写请求超时（${ASR.timeoutMs} ms 内未返回）：请检查网络，或调大 ASR_TIMEOUT_MS。`
      : `转写请求失败：${e && e.message ? e.message : '未知网络错误'}`;
    voiceApply('asr_failed', { audio_id: audioId, reason, error: code });
    return { http: aborted ? 504 : 502, body: { ok: false, error: code, audio_id: audioId, provider_ms: providerMs, reason, message: reason } };
  } finally {
    clearTimeout(timer);
  }

  const providerMs = Date.now() - started;
  let parsed = null;
  let parseOk = false;
  try { parsed = JSON.parse(text || '{}'); parseOk = true; } catch (_) { /* 上游不是 JSON */ }

  if (!resp.ok) {
    // 上游 401/402 这类最常见于「key 不对 / 余额不足」，把状态码带出来便于定位，但绝不回显 key
    const detail = parsed && parsed.error && (parsed.error.message || parsed.error.code);
    const reason = `转写服务返回 HTTP ${upstreamStatus}${detail ? '：' + String(detail).slice(0, 200) : ''}`;
    voiceApply('asr_failed', { audio_id: audioId, reason, error: 'asr_failed' });
    console.warn(`[asr] ${audioId} 转写失败 HTTP ${upstreamStatus}（provider ${providerMs}ms）`);
    return { http: 502, body: {
      ok: false, error: 'asr_failed', audio_id: audioId, upstream_status: upstreamStatus,
      provider_ms: providerMs, reason, message: reason,
    } };
  }

  const transcribed = parsed && typeof parsed.text === 'string' ? parsed.text.trim() : '';
  // HTTP 200 但响应体不是 JSON：协议层面就不对（多半是打到了错误地址、拿回一张 HTML 错误页），
  // 与「模型没识别出内容」是两回事，必须分开报，否则排查方向会被带偏。
  if (!parseOk) {
    const reason = `转写服务返回的不是 JSON（HTTP ${upstreamStatus}），可能是地址不对或网关拦截：${String(text).slice(0, 120)}`;
    voiceApply('asr_failed', { audio_id: audioId, reason, error: 'asr_failed' });
    return { http: 502, body: {
      ok: false, error: 'asr_failed', audio_id: audioId, provider_ms: providerMs,
      upstream_status: upstreamStatus, reason, message: reason,
    } };
  }
  if (!transcribed) {
    const reason = '转写服务返回了空文本（可能录音无声、过短，或模型没识别出内容）。';
    voiceApply('asr_failed', { audio_id: audioId, reason, error: 'asr_empty_text' });
    return { http: 502, body: {
      ok: false, error: 'asr_empty_text', audio_id: audioId, provider_ms: providerMs,
      upstream_status: upstreamStatus, reason, message: reason,
    } };
  }

  voiceApply('transcribed', { audio_id: audioId, transcript: transcribed });
  console.log(`[asr] ${audioId} 转写完成（provider ${providerMs}ms）：${transcribed}`);
  return { http: 200, body: {
    ok: true, audio_id: audioId, text: transcribed,
    model: (parsed && parsed.model) || ASR.model,
    provider_ms: providerMs, upstream_status: upstreamStatus,
  } };
}

/* 连通性测试：用给定参数发一次最小 chat 请求（不落盘） */
async function nlTestConnection({ endpoint, apiKey, model, timeoutMs }) {
  const started = Date.now();
  const url = nlChatCompletionsUrl(endpoint);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        // 推理型模型可能拒绝过小的 max_tokens，给一点余量（只校验连通性，不看内容）
        max_tokens: 32, temperature: 0,
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      let hint = 'HTTP ' + r.status;
      if (r.status === 401 || r.status === 403) hint += '（认证失败：API Key 无效、过期或无该模型权限）';
      else if (r.status === 404) hint += '（地址或模型不存在：检查 API 地址与模型名称）';
      else if (r.status === 429) hint += '（额度/速率超限）';
      else if (r.status === 400) hint += '（请求参数被服务端拒绝：多为模型名称不对）';
      const snippet = body.slice(0, 160).replace(/\s+/g, ' ');
      // 404 额外回传实际请求地址，便于一眼看出路径拼接问题（不含密钥）
      const extra = r.status === 404 ? ` 实际请求地址：${url}` : null;
      return { ok: false, latencyMs: Date.now() - started, httpStatus: r.status, error: hint + (extra || ''), url, detail: snippet || null };
    }
    return { ok: true, latencyMs: Date.now() - started, model, url };
  } catch (e) {
    const msg = e.name === 'AbortError' ? `连接超时（>${timeoutMs}ms）：地址不可达或服务无响应`
      : (e.cause && e.cause.code === 'ENOTFOUND' ? '域名解析失败：检查 API 地址'
      : (e.cause && e.cause.code === 'ECONNREFUSED' ? '连接被拒绝：检查地址与端口'
      : '请求失败：' + e.message));
    return { ok: false, latencyMs: Date.now() - started, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 任务注册表（NL 模块的扩展点核心）                                      */
/*                                                                     */
/* 新增任务只需在 NL_TASKS 里加一条定义：                                */
/*   promptDesc —— 写进 system prompt 的任务描述（LLM 据此理解该意图）     */
/*   apiDesc    —— /api/nl 能力说明里展示的一句话                         */
/*   short/hint —— 「模糊澄清」回复里的自然语言任务名与说明                 */
/*   run(ctx)   —— 执行体（ctx = { device }），返回 { reply, evidence }  */
/* 加完后：system prompt、能力说明、ambiguous/out_of_scope/other 的回复    */
/* 全部自动跟随，无需再改其他代码。                                        */
/* 不执行任务的元意图（澄清/拒绝/说明）在 NL_META_INTENTS 声明。           */
/* ------------------------------------------------------------------ */
const NL_TASKS = {
  query_last: {
    promptDesc: '查看/询问最近一次或历史数据（"上次数据""最新记录""现在数据多少"）',
    apiDesc: '查看设备最近一次（历史）记录，保留旧时间，不触发采集',
    short: '查看上次数据',
    hint: '只读历史记录，时间是旧的',
    run: () => nlRunQueryLast(),
  },
  collect_once: {
    promptDesc: '要求立即重新采集/再采一次（"重新采集""再采一帧""采新的"）',
    apiDesc: '请求设备立即采集一帧新数据，等待真实完成证据',
    short: '重新采集一次',
    hint: '让设备立刻采一帧新的，并等待新结果',
    run: () => nlRunCollectOnce(),
  },
};

/* 元意图：不执行任务，只做澄清 / 拒绝 / 如实说明 */
const NL_META_INTENTS = {
  ambiguous: '只说"数据""采集"等，无法判断是查询还是发起',
  out_of_scope: '要求操作其他设备、删除/修改/清空数据、打电话、发短信等越界或危险请求',
  location_query: '询问设备位置/坐标/经纬度/在哪',
  other: '以上都不是',
};

const NL_INTENTS = new Set([...Object.keys(NL_TASKS), ...Object.keys(NL_META_INTENTS)]);

/* system prompt 由注册表生成 —— 新增任务无需改这里 */
const NL_SYSTEM_PROMPT = [
  '你是嵌入式监测平台的任务路由器。把用户的话映射为结构化任务，只能输出 JSON。',
  '允许的 intent：',
  ...Object.entries(NL_TASKS).map(([name, t]) => `- ${name}：${t.promptDesc}`),
  ...Object.entries(NL_META_INTENTS).map(([name, d]) => `- ${name}：${d}`),
  '参数：device（用户明确点名的设备号，未点名则为 null）',
  '输出格式（严格 JSON，不要任何多余文字）：{"intent":"...","device":null,"reason":"一句话"}',
].join('\n');

/* 单次意图解析的输出额度。推理型（reasoning）模型会先把 token 花在思考上，
   给小了会返回 HTTP 200 但 content 为空（实测 Agents-A1 思考约 550~640 token），故给足。 */
const NL_MAX_TOKENS = 1200;
/* 回复改写（compose)的输出额度：只需 1~3 句，留点余量给推理型模型的思考。 */
const NL_REPLY_MAX_TOKENS = 800;

/* ------------------------------------------------------------------ */
/* 回复文案生成（可选）：模型把「服务端已核实的结论」改写成更自然的话        */
/*                                                                     */
/* 诚实性护栏（本项目红线，不能靠模型自觉）：                              */
/*   ① 事实全部由服务端提供：模板结论 + 证据 JSON，模型只做改写不做推断；    */
/*   ② 改写结果做「数字核对」：回复里出现的每个数字都必须在证据里找得到      */
/*      （允许四舍五入级近似、毫秒→秒换算），对不上一律作废回落模板；        */
/*   ③ 立场核对：模板没说"成功/失败/超时"时，改写文里也不许出现这些字眼。    */
/* 任何一条不过 → 用服务端模板原文，功能不受影响。                          */
/* ------------------------------------------------------------------ */

/* 递归收集证据里的数字（含字符串中的数字片段，如 ISO 时间） */
function collectEvidenceNumbers(node, out, keyHint) {
  if (node == null) return;
  if (typeof node === 'number' && Number.isFinite(node)) { out.push({ v: node, key: keyHint }); return; }
  if (typeof node === 'string') {
    const ms = node.match(/-?\d+(?:\.\d+)?/g);
    if (ms) for (const m of ms.slice(0, 20)) out.push({ v: Number(m), key: keyHint });
    return;
  }
  if (Array.isArray(node)) { for (const x of node) collectEvidenceNumbers(x, out, keyHint); return; }
  if (typeof node === 'object') for (const k of Object.keys(node)) collectEvidenceNumbers(node[k], out, k);
}

/* 生成"允许出现的数字"白名单：证据里的数字 + extraTexts（服务端模板等可信文本）里的数字，
 * 各取原值/四舍五入写法，毫秒字段再加秒写法。
 * 注意：query_last 的 evidence 只带元数据（时间、seq），传感器数值只出现在服务端模板里，
 * 所以模板必须一并纳入白名单，否则模型正当地引用真实读数会被误判为"编造"。 */
function buildAllowedNumbers(evidence, extraTexts) {
  const raw = [];
  collectEvidenceNumbers(evidence, raw, null);
  for (const t of (extraTexts || [])) {
    const ms = String(t).match(/-?\d+(?:\.\d+)?/g);
    if (ms) for (const m of ms) raw.push({ v: Number(m), key: null });
  }
  const allowed = [];
  for (const { v, key } of raw) {
    if (!Number.isFinite(v)) continue;
    allowed.push(v, Math.round(v));
    for (let d = 0; d <= 4; d++) allowed.push(Number(v.toFixed(d)));
    if (key && /(^|_)ms$/.test(key)) {          // age_ms 等：模板话术里的"秒"由它换算而来
      allowed.push(Math.round(v / 1000));
      allowed.push(Number((v / 1000).toFixed(1)));
    }
  }
  return allowed;
}

const nearlyEq = (a, b) => {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  return diff <= Math.max(1e-9, Math.max(Math.abs(a), Math.abs(b)) * 0.01);
};

/* 数字核对：回复里的每个数字都要能在证据白名单里找到近似值 */
function verifyReplyNumbers(text, allowed) {
  const found = String(text).match(/-?\d+(?:\.\d+)?/g) || [];
  const bad = [];
  for (const s of found) {
    const n = Number(s);
    if (!Number.isFinite(n)) continue;
    if (allowed.some((a) => nearlyEq(a, n))) continue;
    bad.push(s);
  }
  return { ok: bad.length === 0, bad: bad.slice(0, 5) };
}

/* 立场核对：关键结论词不得凭空出现（模板没说的，改写文里也不能有） */
const NL_CLAIM_WORDS = ['成功', '失败', '超时', '已回执', '越界', '不支持'];
function verifyReplyStance(reply, template) {
  for (const w of NL_CLAIM_WORDS) {
    if (reply.includes(w) && !template.includes(w)) return { ok: false, word: w };
  }
  return { ok: true };
}

async function composeReplyByLlm({ taskName, userText, evidence, templateReply }) {
  if (NL.replyMode !== 'llm') return null;
  if (!NL.endpoint || !NL.apiKey) return null;
  if (nlBreakerOpen()) return null;     // 熔断中：不额外消耗一次远程调用
  const sys = [
    '你是嵌入式监测平台的助手，负责把「服务端已核实的事实」改写成更自然、口语化的中文回复。',
    '硬性要求（违反即作废）：',
    '1) 只能使用【已核实结论】和【事实】里给出的信息，不得添加、推测、补全任何未给出的数据；',
    '2) 数字必须原样引用，不要换算、不要重算、不要改变位数含义；时间原样引用 ISO 字符串，不做时区换算；',
    '3) 不得出现【已核实结论】里没有的结论性字眼（如"成功""失败""超时"）；',
    '4) 只输出回复正文（1~3 句），不要 JSON、markdown、引号、前缀或解释。',
  ].join('\n');
  const user = `用户说：${userText}\n\n任务：${taskName}\n\n【已核实结论】\n${templateReply}\n\n【事实】\n${JSON.stringify(evidence || {})}`;
  const ac = new AbortController();
  /* 改写是"锦上添花"：模板本身已是完整正确的答案，因此给它独立的、更紧的上限，
   * 不让"润色"把整体等待时间再拉长一截（模型慢就直接用模板）。 */
  const composeTimeoutMs = Math.min(NL.timeoutMs, 8000);
  const timer = setTimeout(() => ac.abort(), composeTimeoutMs);
  try {
    const r = await fetch(nlChatCompletionsUrl(NL.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + NL.apiKey },
      body: JSON.stringify({
        model: NL.model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.3,
        max_tokens: NL_REPLY_MAX_TOKENS,
        ...(nlThinkDisabledOk ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      if (r.status === 429 || r.status >= 500) console.warn('[nl] 回复改写失败，保留模板文案：HTTP ' + r.status);
      return null;
    }
    const j = await r.json();
    const text = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    if (!text) return null;
    if (text.length > 400) { console.warn('[nl] 改写文过长，已作废回落模板'); return null; }
    const stance = verifyReplyStance(text, templateReply);
    if (!stance.ok) { console.warn(`[nl] 改写文出现结论里没有的字眼「${stance.word}」，已作废回落模板`); return null; }
    /* 白名单只取「服务端生成」的两处：证据 + 模板文案。
     * 故意不含用户原话 —— 否则用户随口说的数字会被模型当作事实回述，
     * 反而制造出"看起来有依据"的编造。 */
    const chk = verifyReplyNumbers(text, buildAllowedNumbers(evidence, [templateReply]));
    if (!chk.ok) { console.warn('[nl] 改写文含证据外的数字 ' + chk.bad.join('/') + '，已作废回落模板'); return null; }
    return text;
  } catch (_) {
    return null;   // 超时/网络问题：静默保留模板文案
  } finally {
    clearTimeout(timer);
  }
}

/* ---- 调用侧的两项开销控制（不改动调用语义，只减少无效远程调用） ----
 * ① 结果复用：同一模型 + 同一句话在 TTL 内直接复用上一次的意图，
 *    避免重复问同一句话时反复付一次网络往返（典型 0.8~3s）。
 * ② 失败熔断：连续失败后短时间内不再调用，直接走规则解析。
 *    否则模型不可用/超时时，用户每发一句话都要干等到超时才降级。 */
const NL_CACHE = new Map();          // key -> { result, ts }
const NL_CACHE_TTL_MS = 10 * 60 * 1000;
const NL_CACHE_MAX = 100;
const NL_CB = { fails: 0, openUntil: 0 };   // 连续失败计数 / 熔断截止时间戳
const NL_CB_FAILS = 2;
const NL_CB_COOLDOWN_MS = 60 * 1000;

function nlCacheKey(text) {
  return NL.model + '|' + String(text).trim().replace(/\s+/g, '');
}
function nlCacheGet(key) {
  const hit = NL_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > NL_CACHE_TTL_MS) { NL_CACHE.delete(key); return null; }
  return hit.result;
}
function nlCacheSet(key, result) {
  if (NL_CACHE.size >= NL_CACHE_MAX) NL_CACHE.delete(NL_CACHE.keys().next().value);
  NL_CACHE.set(key, { result, ts: Date.now() });
}
/* 熔断状态：true = 正在熔断（跳过远程调用，直接用规则兜底） */
function nlBreakerOpen() {
  return Date.now() < NL_CB.openUntil;
}
function nlBreakerOk() { NL_CB.fails = 0; NL_CB.openUntil = 0; }
function nlBreakerFail() {
  NL_CB.fails++;
  if (NL_CB.fails >= NL_CB_FAILS) {
    NL_CB.openUntil = Date.now() + NL_CB_COOLDOWN_MS;
    console.warn(`[nl] LLM 连续失败 ${NL_CB.fails} 次，熔断 ${NL_CB_COOLDOWN_MS / 1000}s（期间直接用规则解析）`);
  }
}
/* 该模型是否支持「关闭思考」参数。首次调用若被服务端明确拒绝（如智谱 1210
 * "该模型始终思考，不支持关闭思考"）就记为 false，之后直接跳过这一档，
 * 避免每次解析都先白打一次必然失败的请求。换模型/地址时重置。 */
let nlThinkDisabledOk = true;
function nlInvalidateLlmCaches() { NL_CACHE.clear(); NL_CB.fails = 0; NL_CB.openUntil = 0; nlThinkDisabledOk = true; }

async function parseIntentByLlm(text) {
  if (!NL.endpoint || !NL.apiKey) return null;
  // 熔断中：不再发起远程调用，避免每句话都干等到超时（直接规则兜底，功能不受影响）
  if (nlBreakerOpen()) return null;
  const ck = nlCacheKey(text);
  const cached = nlCacheGet(ck);
  if (cached) return cached;
  const url = nlChatCompletionsUrl(NL.endpoint);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), NL.timeoutMs);
  /* 单次调用。
   * useJson=false → 去掉 response_format（部分服务不支持会返回空内容）。
   * noThink=true  → 关闭"思考过程"（意图路由是简单分类，不需要长思考）：
   *   实测 Agents-A1 关闭后 思考 token 640→0、延迟 9s→2.2s，且正文不再为空。
   *   若服务端不认这个参数会报错，外层会回退到不开该参数的调用。 */
  const callOnce = async (useJson, noThink) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + NL.apiKey },
      body: JSON.stringify({
        model: NL.model,
        messages: [
          { role: 'system', content: NL_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        temperature: 0,
        // 推理型模型会把 token 先花在思考上（实测 Agents-A1 一次思考约 550~640 token），
        // max_tokens 给小了会出现 HTTP 200 但 content 为空 —— 因此给足额度。
        max_tokens: NL_MAX_TOKENS,
        ...(useJson ? { response_format: { type: 'json_object' } } : {}),
        ...(noThink ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const bodyText = await r.text().catch(() => '');
      const err = new Error('HTTP ' + r.status);
      // 429（限流/模型拥塞）与 5xx（服务端故障）：立刻放弃本次解析，
      // 换参数重试同一个服务没有意义，只会让用户多等好几秒、多打几次请求。
      if (r.status === 429 || r.status >= 500) err.nlBail = true;
      // 记录服务端错误码与消息，便于定位（如智谱 1305=模型拥塞、1113=余额不足）
      try {
        const ej = JSON.parse(bodyText);
        if (ej && ej.error && ej.error.code) err.nlCode = ej.error.code;
        err.nlMsg = (ej && ej.error && ej.error.message) || bodyText.slice(0, 120);
        // 模型明确表示"不支持关闭思考"（如智谱 1210）→ 记住，下次不再白试关思考
        if (/不支持关闭思考|thinking/i.test(err.nlMsg) && r.status === 400) nlThinkDisabledOk = false;
      } catch (_) {}
      throw err;
    }
    const j = await r.json();
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    // 推理型模型可能把正文放在 content，思考放在 reasoning_content —— 只认 content
    const content = msg.content;
    if (!content) {
      const why = msg.reasoning_content ? '内容为空（模型仅返回了思考过程 reasoning_content，可能是 max_tokens 不足或不支持 JSON 模式）' : '空响应';
      throw new Error(why);
    }
    const parsed = JSON.parse(content);
    if (!NL_INTENTS.has(parsed.intent)) throw new Error('非法 intent: ' + parsed.intent);
    return { intent: parsed.intent, device: parsed.device || null, reason: parsed.reason || null };
  };

  const isAbort = (e) => e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)));
  try {
    /* 尝试顺序（越靠前越快，失败才降级到下一档）：
     *   ① 关思考 + JSON 模式  —— 最快（实测 ~2.2s），适合意图分类这种简单任务
     *   ② 带思考 + JSON 模式  —— 服务端不认 thinking 参数时
     *   ③ 带思考 + 普通模式    —— 服务端不支持 response_format 时
     * 超时（共用同一 deadline）时不再重试：继续等只会更慢，直接降级规则解析。 */
    let out;
    const detail = (e) => e.message + (e.nlCode ? ` [code=${e.nlCode}]` : '') + (e.nlMsg ? ` ${e.nlMsg}` : '');
    try {
      // ① 关思考 + JSON（最快）。若该模型已知不支持关思考，直接跳过这一档。
      out = nlThinkDisabledOk ? await callOnce(true, true) : await callOnce(true, false);
    } catch (e1) {
      if (isAbort(e1) || e1.nlBail) throw e1;   // 超时/限流/服务端故障：不再换参数重试
      console.warn('[nl] 关思考调用失败，回退带思考（JSON 模式）：', detail(e1));
      try {
        out = await callOnce(true, false);
      } catch (e2) {
        if (isAbort(e2) || e2.nlBail) throw e2;
        console.warn('[nl] LLM 首次解析失败（JSON 模式），重试普通模式：', detail(e2));
        out = await callOnce(false, false);
      }
    }
    nlBreakerOk();
    nlCacheSet(ck, out);   // 成功才入缓存（失败不缓存，便于恢复后立即重试）
    return out;
  } catch (e) {
    const extra = (e.nlCode ? ` [code=${e.nlCode}]` : '') + (e.nlMsg ? ` ${e.nlMsg}` : '');
    console.warn(`[nl] LLM 解析失败（${url}），降级规则解析：`, e.message + extra);
    nlBreakerFail();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---- 意图解析器 B：规则兜底（无 LLM 时也能通过当堂验证 —— 备用路径） ---- */
function nlPickDevice(t) { const m = t.match(/S3EYE[-\w]*/i); return m ? m[0] : null; }

function parseIntentByRule(text) {
  const t = text.replace(/\s+/g, '');
  // 位置类单独识别（防止"在哪采集"之类句子被误判为采集）
  if (/(在哪|位置|坐标|经纬|定位)/.test(t)) return { intent: 'location_query', device: nlPickDevice(t), reason: '规则：含位置关键词' };
  // 点名白名单外设备 → 越界
  const dev = nlPickDevice(t);
  const allowed = config.expectedDeviceId || null;
  if (dev && allowed && dev.toUpperCase() !== String(allowed).toUpperCase()) {
    return { intent: 'out_of_scope', device: dev, reason: '规则：点名了白名单外设备' };
  }
  // 危险/越界动作
  if (/(删除|清空|删掉|修改|打电话|发短信|报警|拨号|呼叫)/.test(t)) return { intent: 'out_of_scope', device: dev, reason: '规则：含越界/危险动作' };
  // 发起采集（动作词优先于查询词）
  if (/(重新|再|重采|新采)/.test(t) && /采/.test(t)) return { intent: 'collect_once', device: dev, reason: '规则：重新+采集' };
  if (/(采一帧|采集一次|采一次|发起采集|立即采集|马上采集|现在采|开始采集)/.test(t)) return { intent: 'collect_once', device: dev, reason: '规则：发起采集' };
  // 查询
  if (/(查看|查询|看一下|看看|上次|最近|最新|历史|多少|数据呢|数据显示)/.test(t)) return { intent: 'query_last', device: dev, reason: '规则：查询类' };
  // 含糊
  if (/(数据|采集)/.test(t)) return { intent: 'ambiguous', device: dev, reason: '规则：只提到数据/采集，无法判断' };
  return { intent: 'other', device: null, reason: '规则：未识别' };
}

/* ---- 设备范围校验（工具执行前的统一闸门） ---- */
function nlValidateDevice(parsed) {
  const allowed = config.expectedDeviceId || null;
  if (parsed.device && allowed && String(parsed.device).toUpperCase() !== String(allowed).toUpperCase()) {
    return { ok: false, reason: `设备 ${parsed.device} 不在允许范围。本助手只服务 ${allowed}，不会代你操作其他设备。` };
  }
  return { ok: true, device: allowed || parsed.device || null };
}

/* ---- 受限工具 1：query_last —— 只读历史记录，保留旧时间，绝不触发新采集 ---- */
function nlRunQueryLast() {
  const dev = config.expectedDeviceId || null;
  const recs = readRecords({ device: dev, limit: 1, order: 'desc' });
  const rec = recs[0] || null;
  if (!rec) {
    return { reply: '还没有任何历史记录（设备从未上报过数据），无法回答"上次数据"。', evidence: { found: false } };
  }
  const ageMs = Date.now() - (rec.recv_ts || 0);
  const f = rec.fields || {};
  const fmt = (v) => (typeof v === 'number' ? Number(v.toFixed(4)) : (v ?? '无'));
  const reply = '上次记录（历史数据，不是新采集）：'
    + `接收于 ${rec.recv_iso || new Date(rec.recv_ts).toISOString()}，距今约 ${Math.round(ageMs / 1000)} 秒。`
    + ` 三轴 acc_g=(${fmt(f.acc_x_g)}, ${fmt(f.acc_y_g)}, ${fmt(f.acc_z_g)})，温度 ${fmt(f.temp_c)}°C。`
    + ' 这是存储里的旧记录，时间也是旧的；需要当前数据请说"重新采集一次"。';
  return {
    reply,
    evidence: {
      found: true, recv_iso: rec.recv_iso || null, recv_ts: rec.recv_ts || null,
      board_ts: rec.board_ts || null, record_seq: rec.seq ?? null, age_ms: ageMs,
      stale: !state.live,
    },
  };
}

/* ---- 受限工具 2：collect_once —— 发起采集并等待真实完成证据 ---- */
function nlRunCollectOnce() {
  return new Promise((resolve) => {
    const active = findActiveCollectRequest();
    const r = active || createCollectRequest();   // 幂等：已有进行中的采集则等待它，不重复下发
    const deduped = !!active;
    const deadline = Date.now() + collectTimeoutMs() + 2000;
    const iv = setInterval(() => {
      const cur = REQUESTS.get(r.request_id);
      if (!cur) { clearInterval(iv); return resolve({ reply: '采集请求状态丢失（内部错误），没有完成证据。', evidence: { status: 'lost', request_id: r.request_id, deduped } }); }
      if (cur.status === 'completed') {
        clearInterval(iv);
        const o = cur.observation || {};
        return resolve({
          reply: `采集成功：设备已回执（${cur.ack_status || 'received'}），新观测 seq=${o.seq} 于 ${new Date(cur.completed_at).toISOString()} 到达。`
            + (cur.simulated ? '（注意：当前为模拟模式，未走真实设备）' : ' 回执与新观测携带同一 request_id，证据链完整。'),
          evidence: {
            status: 'completed', request_id: r.request_id, ack_status: cur.ack_status || null,
            seq_before: cur.seq_before ?? null, seq_observed: o.seq ?? null,
            completed_iso: new Date(cur.completed_at).toISOString(),
            checks: o.checks || null, simulated: !!cur.simulated, fields: o.fields || null,
            deduped,
          },
        });
      }
      if (cur.status === 'timeout' || cur.status === 'failed') {
        clearInterval(iv);
        return resolve({
          reply: '未能确认采集完成：' + (cur.error || '等待期间没有收到设备的新观测') + '。我不会把旧值当作本次采集的结果。'
            + (cur.note ? ' 说明：' + cur.note : ''),
          evidence: {
            status: cur.status, request_id: r.request_id, error: cur.error || null,
            note: cur.note || null, ack_status: cur.ack_status || null, deduped,
          },
        });
      }
      if (Date.now() > deadline) {
        clearInterval(iv);
        return resolve({ reply: '等待超时（内部兜底），没有完成证据。', evidence: { status: 'watchdog_timeout', request_id: r.request_id, deduped } });
      }
    }, 200);
  });
}

/* ---- 主入口：意图 → 校验 → 工具/澄清/拒绝 ---- */
async function nlHandle(text) {
  let engine = 'rule';
  let parsed = await parseIntentByLlm(text);
  if (parsed) engine = 'llm';
  else parsed = parseIntentByRule(text);

  const allowed = config.expectedDeviceId || null;
  // reply_by 如实标注文案来源：模板（服务端生成）/ llm（模型改写且通过核对）
  const base = { engine, intent: parsed.intent, tool: null, params: {}, parser_note: parsed.reason || null, reply_by: 'template' };

  /* 设备白名单统一闸门：任何意图只要点名了白名单外设备，一律拒绝（在解析之后、任务之前） */
  const v = nlValidateDevice(parsed);
  if (!v.ok) {
    return { ...base, intent: 'out_of_scope', error: 'device_out_of_scope', reply: v.reason };
  }

  /* 任务分发：注册表命中 → 执行对应 run()；元意图 → 澄清 / 拒绝 / 如实说明。
   * 所有回复里的"能力清单"都由注册表生成，新增任务自动出现在话术里。 */
  const task = NL_TASKS[parsed.intent];
  if (task) {
    const out = await task.run({ device: v.device });
    /* 可选：让模型把已核实的结论改写成更自然的话（数字/立场核对不过则回落模板）。
     * reply_by 如实标注文案来源，前端会显示，便于一眼看出这次是不是模型写的。 */
    const composed = await composeReplyByLlm({
      taskName: task.short, userText: text, evidence: out.evidence, templateReply: out.reply,
    });
    return {
      ...base, tool: parsed.intent, params: { device: v.device }, ...out,
      reply: composed || out.reply,
      reply_by: composed ? 'llm' : 'template',
    };
  }

  const taskNames = Object.values(NL_TASKS).map((t) => `【${t.short}】`).join('、');
  switch (parsed.intent) {
    case 'ambiguous': {
      const opts = Object.values(NL_TASKS).map((t) => `【${t.short}】（${t.hint}）`).join('，');
      return {
        ...base, error: 'ambiguous',
        reply: `这句话我无法确定任务。你是想${opts}？请明确一个。`,
      };
    }
    case 'location_query':
      return {
        ...base, error: 'no_location_data',
        reply: '设备只上报三轴加速度、温度等传感数据，不包含位置信息。没有位置数据时我不会生成或推测坐标。'
          + '如需定位，需要额外的定位硬件与数据源。',
      };
    case 'out_of_scope': {
      const d = parsed.device ? `（涉及设备 ${parsed.device}）` : '';
      return {
        ...base, error: 'out_of_scope',
        reply: `这个请求超出我的允许范围${d}。我只能对 ${allowed || '当前设备'} 做：${taskNames}。`
          + '删除/修改数据、控制其他设备、外呼等操作一律不执行。',
      };
    }
    default:
      return {
        ...base, intent: 'other', error: 'unknown_intent',
        reply: `我只能帮你：${taskNames}。请换一种说法。`,
      };
  }
}

/* ------------------------------------------------------------------ */
/* 数据处理                                                            */
/* ------------------------------------------------------------------ */

/* 原始日志的 WS 广播做批量合并。
 *
 * 性能要点：每收到一帧都会有一条原始日志，若逐条广播，10Hz 下就是每秒 10 条
 * WS 消息（内容还与 sample 消息重复）。合并成每 250ms 一批后，消息数降到约 1/4，
 * 客户端也能一次性批量写 DOM，避免逐条 append 造成的重排。 */
let rawBatch = [];
let rawBatchTimer = null;
const RAW_BATCH_MS = 250;

function pushRaw(text, ok) {
  if (!ok) stats.lastError = text;
  rawLog.push({ ts: Date.now(), text, ok: !!ok });
  if (rawLog.length > RAW_LOG_MAX) rawLog.shift();

  rawBatch.push({ ts: Date.now(), text, ok: !!ok });
  if (!rawBatchTimer) {
    rawBatchTimer = setTimeout(() => {
      rawBatchTimer = null;
      const items = rawBatch;
      rawBatch = [];
      if (items.length) broadcast({ type: 'raw-batch', items });
    }, RAW_BATCH_MS);
  }
}

/**
 * 以指定波特率打开串口监听一小段时间，返回收到的字节数与前几行文本。
 * 只读探测，用于排查"板子插着但没数据"。
 */
function probeOnce(target, baudRate, ms) {
  return new Promise((resolve) => {
    let p;
    try {
      p = new SerialPort({ path: target, baudRate, autoOpen: false });
    } catch (e) {
      return resolve({ baudRate, error: e.message, bytes: 0, sample: [] });
    }
    let bytes = 0, buf = '', finished = false;
    const done = (extra) => {
      if (finished) return;
      finished = true;
      try { p.removeAllListeners(); } catch (_) {}
      try { if (p.isOpen) p.close(() => {}); } catch (_) {}
      resolve(Object.assign({
        baudRate, bytes,
        sample: buf.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean).slice(0, 5),
      }, extra || {}));
    };
    p.on('data', (c) => { bytes += c.length; if (buf.length < 2000) buf += c.toString('utf8'); });
    p.on('error', (e) => done({ error: e.message }));
    p.open((err) => {
      if (err) return done({ error: err.message });
      setTimeout(() => done(), ms);
    });
  });
}

/**
 * 处理一行来自设备的文本，尝试解析为 JSON 传感器数据。
 * 只有解析成功且至少包含一个数值字段，才算"真实数据"。
 */
/**
 * 从 "键=值" / "键: 值" 形式的文本中提取数值。
 * 适配已经烧好的、输出非 JSON 格式的固件，例如：
 *   Temp=25.3,Hum=60.1
 *   Temp: 25.3 C  Hum: 60.1 %
 *   temperature:26.5 humidity:58.2
 * 只提取设备真实发来的数字，不做任何补值或换算。
 */
function tryKeyValue(line) {
  // 两个排除条件，缺一不可：
  //   (?![\d.])   —— 数字必须完整匹配，防止 "12:34:56" 回溯成只吃到一个 "1"
  //   (?!\s*:\d)  —— 后面紧跟 ":数字" 的是时间戳，不是传感器值
  const re = /([A-Za-z_一-龥][\w.一-龥]*)\s*[:=]\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\d.])(?!\s*:\d)/g;
  const out = {};
  let m;
  while ((m = re.exec(line)) !== null) {
    const v = Number(m[2]);
    if (Number.isFinite(v)) out[m[1]] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** 纯数字序列（CSV），按 ch1..chN 命名。仅在 parseMode 显式设为 csv 时启用。 */
function tryCsv(line) {
  const nums = [];
  for (const tok of line.split(/[,;\t]+/)) {
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*[A-Za-z%℃µ°]*$/.exec(tok.trim());
    if (m) nums.push(Number(m[1]));
  }
  if (!nums.length) return null;
  const out = {};
  nums.forEach((v, i) => { out['ch' + (i + 1)] = v; });
  return out;
}

/**
 * 处理一行来自设备的文本，尝试解析为传感器数据。
 * 只有解析成功且至少包含一个数值字段，才算"真实数据"。
 *
 * @param {string} line   一行原始文本
 * @param {object} [source] 来源上下文：{ transport:'serial'|'wifi', ip?:string }
 */
/* ------------------------------------------------------------------ */
/* 摄像头（OV2640）：板端把 JPEG 以 base64 内联在 JSON 里上报            */
/*                                                                     */
/*   {"type":"frame","device":"...","seq":N,"size":"320x240",           */
/*    "len":6076,"jpeg":"<base64>"}                                    */
/*                                                                     */
/* 服务端只保留最近一帧，并向所有 MJPEG 订阅者推送。                     */
/* 之所以用 MJPEG 而不是 WebSocket：浏览器 <img src="/api/cam.mjpg">    */
/* 原生支持 multipart/x-mixed-replace，零 JS 即可显示实时画面。          */
/* ------------------------------------------------------------------ */
const cam = {
  latest: null,      // Buffer：最近一帧 JPEG（直播流）
  latestAt: 0,
  latestSeq: 0,
  size: null,
  frames: 0,
  clients: new Set(),// MJPEG 订阅者
  // 手动抓拍的单张快照（与直播流分开存，页面上单独展示、可下载）
  snapshot: null,
  snapshotAt: 0,
  snapshotSize: null,
  snapshotBytes: 0,
};

/* 从 JPEG 字节流里解析真实宽高（SOF0/1/2 段）。
 * 为什么要这么做：实测板端 set_framesize(QVGA) 后 sensor->status 仍报 320x240，
 * 而实际输出是 240x240 —— 与其信上报值，不如直接读字节，永远不会谎报。 */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xC0 || m === 0xC1 || m === 0xC2) {
      return { h: (buf[i + 5] << 8) | buf[i + 6], w: (buf[i + 7] << 8) | buf[i + 8] };
    }
    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len <= 0) break;
    i += 2 + len;
  }
  return null;
}

function onCameraFrame(obj) {
  if (typeof obj.jpeg !== 'string' || !obj.jpeg.length) return;
  let buf;
  try { buf = Buffer.from(obj.jpeg, 'base64'); } catch (_) { return; }
  if (!buf.length) return;

  const sz = jpegSize(buf);
  cam.latest    = buf;
  cam.latestAt  = Date.now();
  cam.latestSeq = obj.seq || 0;
  cam.size      = sz ? `${sz.w}x${sz.h}` : (obj.size || null);
  cam.bytes     = buf.length;
  cam.frames++;

  // 手动抓拍：单独存一份快照，页面上与直播流分开展示（可下载）
  if (obj.shot === 1 || obj.shot === true) {
    cam.snapshot      = buf;
    cam.snapshotAt    = Date.now();
    cam.snapshotSize  = cam.size;
    cam.snapshotBytes = buf.length;
  }

  // 推给所有正在观看的浏览器（直播流不含快照帧，避免抓拍瞬间画面尺寸突变）
  for (const res of cam.clients) {
    try {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write('\r\n');
    } catch (_) { cam.clients.delete(res); }
  }
}

/* ------------------------------------------------------------------
 * 双通道去重（安全网）
 *
 * 背景：板端每一帧同时走两条路上报 —— printf → USB 串口，http_post → WiFi。
 * 两路都连着时，服务端本可能收到同一帧两次，破坏「一帧观测 = 一条记录」。
 *
 * 现状（2026-09-28 实测）：/api/data 里已有一条「串口优先」规则
 * （串口在线时忽略 WiFi 上报），受控 A/B 测试显示它已经足够：
 *     纯 WiFi 95 条/12 秒  vs  双通道 92 条/12 秒（比值 0.97）
 * 因此本去重当前不会触发，属于**额外保险**，而非必需项。
 *
 * 那为什么还留着：那条规则依赖 state.transport 这个共享可变标志 ——
 * 串口刚重连的一瞬间，transport 还停留在 'wifi'，此时到达的 WiFi 帧会被
 * 放行；等串口帧把它改回 'serial' 之后才恢复拦截。这个竞态窗口内就可能
 * 产生重复。本函数以不可变的 (device, seq) 为键，与标志位无关，能兜住它。
 *
 * 窗口取 5 秒：足以覆盖两路之间的到达间隔，又能在板子重启后 seq 归零重来
 * 时不被误判为重复。
 * ------------------------------------------------------------------ */
const DEDUP_WINDOW_MS = 5000;
const dedupSeen = new Map();     // "device#seq" -> 首次到达时间戳
let dedupSweptAt = 0;            // 上次过期清理时刻（限频用）

function isDuplicateFrame(device, seq) {
  if (typeof seq !== 'number' || !device) return false;
  const key = `${device}#${seq}`;
  const now = Date.now();
  const seenAt = dedupSeen.get(key);
  if (seenAt != null && now - seenAt < DEDUP_WINDOW_MS) return true;
  dedupSeen.set(key, now);
  /* 过期清理限频到 1 秒一次：此前每个新帧只要表长超过 500 就全表扫描，
   * 高帧率时等于每个样本都多花一次 O(n) 遍历。 */
  if (dedupSeen.size > 500 && now - dedupSweptAt > 1000) {
    dedupSweptAt = now;
    for (const [k, t] of dedupSeen) if (now - t > DEDUP_WINDOW_MS) dedupSeen.delete(k);
  }
  return false;
}

function handleLine(line, source) {
  if (!line) return;
  const trimmed = line.trim();
  if (!trimmed) return;
  stats.linesTotal++;

  // 0) 过滤 ESP-IDF 日志行（形如 "I (1234) TAG: ..." / "W (1234) wifi:..."）。
  //    这类日志常含 "SDA=4"、"成功=12" 等片段，若不拦截会被键值解析器
  //    误当成传感器字段，污染展示字段与趋势曲线。日志只进原始日志，不算数据。
  if (/^[IWEDV] \(\d+\)/.test(trimmed)) {
    stats.linesInvalid++;
    pushRaw(trimmed, false);
    return;
  }

  let numbers = null;
  const others = {};     // 非数值字段（字符串/布尔），如 device、mac、iso
  const meta = {};       // 设备身份与板端时间等元数据

  // 1) 优先按 JSON 解析
  if (trimmed[0] === '{') {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        // 板端回执（远程采集）：单独处理，不当作传感数据，直接返回
        if (obj.type === 'ack') {
          stats.linesValid++;
          pushRaw(trimmed, true);
          onDeviceAck(obj.request_id, obj.status, obj.seq);
          /* 第 5 周收尾：唤醒正在等这条回执的下发方。
           * 必须在 onDeviceAck 之后 —— 采集请求表的状态更新与命令通道的
           * 等待槽是两套语义，互不干扰（同一 rid 可能两处都不存在）。
           * 第 4 个参数带上行通道：固件自 2026-10-28 起 ack 走串口 + WiFi
           * 双通道，取证时需要知道这一条是从哪条路回来的。
           * 注意不能引用下面的 const transport —— 它在 ack 分支之后才声明，
           * 在这里读会踩 TDZ（ReferenceError）。故就地取值。 */
          settlePendingAck(obj.request_id, obj.status, obj.seq,
            (source && source.transport) || state.transport || 'serial');
          return;
        }
        // 教学求助事件（第 3 周）：板端按键/取消，单独处理，不当作传感数据
        if (obj.type === 'help') {
          stats.linesValid++;
          pushRaw(trimmed, true);
          onHelpEvent(obj);
          return;
        }
        /* 语音上传摘要（第 5 周）：固件录音完成后 printf 的一行 JSON。
         * 必须在此早退 —— 否则 bytes / duration_ms / sample_rate / peak 会被
         * 通用分支当成传感器字段写进 state.fields 并落盘，网页仪表盘会凭空
         * 多出几个假字段（这条流的语义是「上传回执」，不是一次采样观测）。
         * 只记原始日志、不产生任何传感数据。audio_id 若存在则回填到链路状态，
         * 便于串口与 HTTP 两条证据链对上同一段录音。 */
        if (obj.type === 'voice') {
          stats.linesValid++;
          pushRaw(trimmed, true);
          onVoiceUploadSummary(obj);
          return;
        }
        // 摄像头帧：JPEG 以 base64 内联，单独处理。
        // 不 pushRaw 整帧（8KB 会把原始日志刷爆），只记一条摘要。
        if (obj.type === 'frame') {
          stats.linesValid++;
          onCameraFrame(obj);
          return;
        }
        const n = {};
        for (const [k, v] of Object.entries(obj)) {
          if (META_KEYS.has(k) || META_NUMERIC_KEYS.has(k)) meta[k] = v;
          else if (typeof v === 'number' && Number.isFinite(v)) n[k] = v;
          else if (typeof v === 'boolean' || typeof v === 'string') others[k] = v;
        }
        if (Object.keys(n).length) numbers = n;
      }
    } catch (_) { /* 不是合法 JSON，继续尝试其他格式 */ }
  }

  // 2) 键=值 / 键: 值（兼容已烧好、非 JSON 的固件；元数据键不在此路径提取，仅 WiFi/JSON 固件带身份）
  if (!numbers && (config.parseMode === 'auto' || config.parseMode === 'kv')) {
    numbers = tryKeyValue(trimmed);
  }

  // 3) 纯 CSV（需显式开启，避免把日志里的数字误当成传感器值）
  if (!numbers && config.parseMode === 'csv') numbers = tryCsv(trimmed);

  if (!numbers || Object.keys(numbers).length === 0) {
    stats.linesInvalid++;
    pushRaw(trimmed, false); // 没有可用数值 -> 只进原始日志，不算数据
    return;
  }

  // 展示字段：去掉元数据（ts/seq/device/mac/iso 不画成传感器卡片）
  const disp = Object.assign({}, numbers, others);
  for (const k of [...META_KEYS, ...META_NUMERIC_KEYS]) delete disp[k];

  /* 空帧守卫（第 5 周回归修复，缺陷早于 t2 就存在）：
   * numbers 里可能只装着「元数据数值键」（ts / seq / uptime_ms / boot_ms）。
   *   · JSON 路径在读帧时就把这些键分流进 meta，numbers 因此为空 —— 上面的守卫已返回；
   *   · key=value 路径（tryKeyValue）不做元数据分流，于是 "seq=12 ts=..." 这类行
   *     能通过上面的守卫。删掉元数据后 disp 变成 {}，旧代码仍继续落盘，
   *     于是产生一条 fields:{} 的空记录（历史 158 条脏记录即由此而来）。
   * 空观测不是观测：只进原始日志、计入无效行，不落盘 / 不改 state.fields /
   * 不广播 sample / 不写入录制缓冲。
   * 关于 request_id：它只可能出现在 JSON 帧里，而 JSON 帧若没有任何传感值，
   * 上面的 numbers 守卫已经返回（既有语义）。因此这里的守卫不会改变远程采集
   * 判定 —— 「没有观测证据就不算采集完成」由采集侧如实超时，绝不误报成功。 */
  if (Object.keys(disp).length === 0) {
    stats.linesInvalid++;
    pushRaw(trimmed, false);
    return;
  }

  stats.linesValid++;

  // 更新设备身份与板端时间（来自固件上报的元数据）
  const transport = (source && source.transport) || state.transport || 'serial';
  if (meta.device) state.deviceId = String(meta.device);
  if (meta.mac) state.deviceMac = String(meta.mac);
  // 本组身份校验：未配置期望标识 -> 视为通过；配置后必须与上报 device 完全一致
  state.deviceVerified = !config.expectedDeviceId || state.deviceId === config.expectedDeviceId;
  if (typeof meta.ts === 'number') { state.boardTs = meta.ts; state.boardIso = meta.iso || null; }
  if (typeof meta.seq === 'number') state.seq = meta.seq;

  // 双通道去重：同一帧的串口副本与 WiFi 副本 (device, seq) 相同，只认第一份。
  // 必须在任何副作用（状态更新 / 原始日志 / 落盘 / WebSocket 推送）之前返回。
  if (isDuplicateFrame(meta.device || state.deviceId, meta.seq)) {
    stats.linesDuplicate = (stats.linesDuplicate || 0) + 1;
    return;
  }

  const recvTs = Date.now();
  state.connected = true;
  state.live = true;
  state.transport = transport;
  state.lastDataAt = recvTs;
  state.fields = disp;          // disp 已在上方算好并做过空帧守卫
  pushRaw(trimmed, true);

  // 远程采集：帧里带 request_id 即本次请求的「新观测」（数据本身照常落盘）
  if (typeof others.request_id === 'string' && others.request_id) {
    onObservation(others.request_id, disp, recvTs, state.seq);
  }

  // 持久化：一帧真实观测 -> 一条记录（含板端时间与服务端接收时间，用于时间核对）
  storageSeq++;
  const skew = (state.boardTs != null) ? (state.boardTs - recvTs) : null;
  const record = {
    seq: storageSeq,
    recv_ts: recvTs,
    recv_iso: new Date(recvTs).toISOString(),
    device_id: state.deviceId,
    device_mac: state.deviceMac,
    transport,
    src_ip: (source && source.ip) || (state.wifiSource && state.wifiSource.ip) || null,
    board_ts: state.boardTs,
    board_iso: state.boardIso,
    skew_ms: skew,
    fields: disp,
  };
  appendRecord(record);

  broadcast({
    type: 'sample',
    ts: recvTs,
    device_id: state.deviceId,
    device_mac: state.deviceMac,
    device_verified: state.deviceVerified,
    board_ts: state.boardTs,
    board_iso: state.boardIso,
    seq: state.seq,
    reportPaused: !!state.reportPaused,
    skew_ms: skew,
    fields: disp,
  });
  if (recording.active) {
    recording.rows.push({ ts: recvTs, f: disp });
    /* 到上限后一次性裁掉一批，而不是每帧 shift 一次：
     * shift 在 20 万行数组上是 O(n) 搬移，10Hz 下每秒要搬 200 万次；
     * 批量裁剪把开销摊薄成每帧 O(1)（滚动窗口语义不变，始终 ≤ maxRows）。 */
    if (recording.rows.length > recording.maxRows) {
      recording.rows.splice(0, recording.rows.length - recording.maxRows + REC_TRIM_MARGIN);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 串口管理                                                            */
/* ------------------------------------------------------------------ */

// 常见 USB-UART 芯片厂商 ID：Espressif / CP210x / CH34x / FTDI
const VID_SCORE = {
  '303a': 100, // Espressif Systems
  '10c4': 60,  // Silicon Labs CP210x
  '1a86': 55,  // QinHeng CH34x
  '0403': 40,  // FTDI
};

function scorePort(p) {
  const vid = (p.vendorId || '').toLowerCase();
  let score = VID_SCORE[vid] || 0;
  const text = `${p.manufacturer || ''} ${p.path || ''}`.toLowerCase();
  if (/espressif|esp32|esp8266/.test(text)) score += 50;
  else if (/silicon labs|cp210/.test(text)) score += 20;
  else if (/wch|ch34|usb-serial/.test(text)) score += 10;
  return score;
}

/* 串口对象 → 前端展示字段（此前在扫描广播、/api/ports、/api/diag 三处重复手写） */
function serializePort(p) {
  return {
    path: p.path,
    manufacturer: p.manufacturer || '',
    vendorId: p.vendorId || '',
    productId: p.productId || '',
    score: scorePort(p),
  };
}

function pickBestPort(ports) {
  const scored = ports.map((p) => ({ p, s: scorePort(p) })).filter((x) => x.s > 0);
  if (!scored.length) return null;
  scored.sort((a, b) => b.s - a.s);
  return scored[0].p;
}

function attachPortHandlers() {
  port.on('data', (chunk) => {
    stats.bytesReceived += chunk.length;
    lineBuffer += chunk.toString('utf8');
    let idx;
    while ((idx = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, idx);
      lineBuffer = lineBuffer.slice(idx + 1);
      // ★ 必须显式声明来源是串口。
      // 否则 handleLine 会退化成 `state.transport`，而 /api/data 的 WiFi 处理器
      // 会先把它设成 'wifi' —— 结果是：串口数据被标成 wifi，且
      // 「串口优先」规则的判断条件 state.transport === 'serial' 永远不成立，
      // WiFi 副本从此再也不会被忽略，同一帧被记录两次。
      handleLine(line.replace(/\r$/, ''), { transport: 'serial' });
    }
    if (lineBuffer.length > 65536) lineBuffer = ''; // 防御性截断
  });

  port.on('error', (err) => {
    console.error('[serial] 错误：', err.message);
    pushRaw(`[串口错误] ${err.message}`, false);
    cleanupPort('error');
  });

  // 拔出开发板 -> 这里会触发
  port.on('close', (err) => {
    const msg = err && err.disconnected ? '设备已拔出' : '串口已关闭';
    console.log(`[serial] ${msg}`);
    cleanupPort(msg);
  });
}

function cleanupPort(reason) {
  if (port) {
    try { port.removeAllListeners(); } catch (_) {}
    port = null;
  }
  lineBuffer = '';
  openingPath = null;
  portOpenedAt = null;
  goOffline(reason || 'closed');
  if (config.autoReconnect && !manualClose) rescanNow();
}

function openSerial(target, baudRate, portInfo) {
  if (!target) return Promise.resolve(false);
  if (port && port.isOpen) return Promise.resolve(true);
  if (openingPath === target) return Promise.resolve(false);
  openingPath = target;

  return new Promise((resolve) => {
    let p;
    let settled = false;
    let guard = null;
    /* 统一的收尾口：无论成功、失败还是看门狗超时，都保证 openingPath 被释放、
     * 定时器被清理、resolve 只发生一次。 */
    const done = (ok, msg) => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      openingPath = null;
      if (!ok) {
        stats.lastOpenError = msg;
        pushRaw(`[串口] ${msg}`, false);
      }
      resolve(ok);
    };

    try {
      p = new SerialPort({ path: target, baudRate: baudRate || config.baudRate, autoOpen: false });
    } catch (e) {
      return done(false, `[串口打开失败] ${e.message}`);
    }

    /* 看门狗：某些 USB 转串口驱动/被占用端口下 open 回调可能永不返回。
     * 没有兜底时 openingPath 会永久留在该端口上（第 1716 行的重入判断），
     * 该端口在进程生命周期内再也没法打开。 */
    guard = setTimeout(() => {
      try { p.removeAllListeners(); } catch (_) {}
      done(false, `打开 ${target} 超时（${OPEN_TIMEOUT_MS / 1000}s 无响应），已释放重入锁`);
    }, OPEN_TIMEOUT_MS);

    p.open((err) => {
      if (err) {
        try { p.removeAllListeners(); } catch (_) {}
        return done(false, `无法打开 ${target}：${err.message}`);
      }
      try {
        port = p;
        lineBuffer = '';
        portOpenedAt = Date.now();
        stats.bytesReceived = 0;
        stats.lastOpenError = null;
        attachPortHandlers();
        state.transport = 'serial';
        state.connected = false; // 收到第一条真实数据后才置为 true
        state.live = false;
        state.deviceId = null;
        state.deviceMac = null;
        state.seq = null;
        state.device = {
          path: target,
          baudRate: baudRate || config.baudRate,
          vendorId: (portInfo && portInfo.vendorId) || '',
          productId: (portInfo && portInfo.productId) || '',
          manufacturer: (portInfo && portInfo.manufacturer) || '',
        };
        console.log(`[serial] 已打开 ${target} @ ${baudRate || config.baudRate}`);
        pushRaw(`[串口] 已连接 ${target}，等待设备数据…`, false);
        pushStatus('opened');
        done(true);
      } catch (e) {
        // 初始化阶段抛错也当作打开失败处理（否则锁不释放、状态半开）
        try { p.removeAllListeners(); } catch (_) {}
        done(false, `初始化串口 ${target} 失败：${e.message}`);
      }
    });
  });
}

async function scanAndConnect() {
  if (port && port.isOpen) return;
  if (manualClose) return;
  try {
    const ports = await SerialPort.list();
    broadcast({ type: 'ports', ports: ports.map(serializePort) });

    let target = null;
    if (config.portPath) {
      target = ports.find((p) => p.path === config.portPath) || null;
    } else if (config.autoDetect) {
      const best = pickBestPort(ports);
      target = best || null;
    }
    if (target) await openSerial(target.path, config.baudRate, target);
  } catch (e) {
    console.warn('[scan] 扫描失败：', e.message);
  }
}

function startScanning() {
  if (scanTimer) return;
  scanAndConnect();
  scanTimer = setInterval(scanAndConnect, Math.max(800, config.scanIntervalMs));
}

/** 立即重扫一次：若轮询已在跑就直接触发，避免等待轮询间隔造成"设备消失"的闪烁 */
function rescanNow() {
  if (scanTimer) scanAndConnect();
  else startScanning();
}

function stopScanning() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

async function disconnectSerial(manual = true) {
  manualClose = manual;
  stopScanning();
  if (port && port.isOpen) {
    await new Promise((resolve) => port.close(() => resolve()));
  } else {
    cleanupPort(manual ? '用户断开' : 'closed');
  }
  if (manual) {
    // 用户手动断开后停止自动重连，直到再次点击连接
    state.connected = false;
    goOffline('用户断开');
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) { req.destroy(); reject(new Error('payload too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/* 解析 POST JSON body（解析失败/空 body 一律返回 {}，不抛错）。
 * 替代此前散落 11 处的 `let body={}; try{...JSON.parse...}catch{}` 样板。 */
async function readJsonBody(req) {
  try { return JSON.parse((await readBody(req)) || '{}'); } catch (_) { return {}; }
}

/* 二进制 body 读取（第 5 周语音）：readBody 用字符串拼接，会把 WAV 字节毁掉，
 * 这里单独按 Buffer 累积。超过 maxBytes 立刻停止累积并标记 tooLarge，
 * 但【不】destroy 请求 —— 让调用方还能正常回 400 说明原因（固件要看到原因）。 */
function readBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    req.on('data', (c) => {
      if (tooLarge) return;                 // 已超限：丢弃余下数据，继续等 end
      size += c.length;
      if (size > maxBytes) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => finish({ buf: Buffer.concat(chunks), size: tooLarge ? size : chunks.reduce((a, c) => a + c.length, 0), tooLarge }));
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    req.on('aborted', () => finish({ buf: Buffer.alloc(0), size, tooLarge: false, aborted: true }));
  });
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

/* 统一错误边界：异步处理器里任何未捕获异常（fetch 失败、JSON 解析、串口库异常…）
 * 都在这里兜住并返回 500，避免请求挂死或演变成 unhandled rejection。
 * 之前 handler 是裸 async 回调，抛错时客户端只会一直等到超时。 */
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.error('[http] 请求处理异常：', req.method, req.url, e && e.stack ? e.stack.split('\n')[0] : e);
    try {
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal_error', message: (e && e.message) || '未知错误' });
      else res.end();
    } catch (_) { /* 响应已不可写，忽略 */ }
  });
});

process.on('unhandledRejection', (e) => {
  console.error('[process] 未处理的 Promise 拒绝：', (e && e.stack) ? e.stack.split('\n')[0] : e);
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/ws' || p === '/ws/') { res.writeHead(426); return res.end(); }

  // ---- 静态资源（必须放在 /api 路由之后）----
  if (req.method === 'GET' && !p.startsWith('/api/') && (p === '/' || /^\/[A-Za-z0-9._\-/]*$/.test(p))) {
    let rel = p === '/' ? '/index.html' : p;
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // ---- 当前状态 ----
  if (p === '/api/state') {
    return json(res, 200, {
      connected: state.connected,
      live: state.live,
      transport: state.transport,
      device: state.device,
      deviceId: state.deviceId,
      deviceMac: state.deviceMac,
      deviceVerified: state.deviceVerified,
      expectedDeviceId: config.expectedDeviceId,
      lastDataAt: state.lastDataAt,
      boardTs: state.boardTs,
      boardIso: state.boardIso,
      seq: state.seq,
      reportPaused: !!state.reportPaused,
      fields: state.fields,
      stale: isStale(),
      stalePolicy: config.stalePolicy,
      storageEnabled: config.storageEnabled,
      raw: rawLog.slice(-60),
      /* 命令回执取证（第 5 周收尾）：raw 里能看到板端 ack 原文，
       * 这里给出最近一次下发的结局与当前等待数，便于核对
       * 「命令写出去了」与「板端真的接受了」不是一回事。
       * 2026-10-28 补：固件改为 ack 双通道（串口 + WiFi）后，
       * lastCommandChannel / lastAckChannel 才能分别取证下行与上行路径。 */
      commandAck: {
        timeoutMs: commandAckTimeoutMs(),
        pendingAcks: PENDING_ACKS.size,
        lastOutcome: stats.lastAckOutcome || null,
        lastAckAt: stats.lastAckAt || null,
        lastCommandChannel: stats.lastCommandChannel || null,
        lastAckChannel: stats.lastAckChannel || null,
      },
      meta: { units: config.fieldUnits, labels: config.fieldLabels, historyMax: config.historyMax },
    });
  }

  // ---- VPS 原始记录查询（作业要求：采集值、VPS 原始记录、页面变化可对照）----
  if (p === '/api/records') {
    const device = url.searchParams.get('device') || null;
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const since = Number(url.searchParams.get('since')) || null;
    const until = Number(url.searchParams.get('until')) || null;
    const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
    try {
      const rows = readRecords({ device, limit, since, until, order });
      return json(res, 200, { ok: true, count: rows.length, device, rows });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- 设备列表（核对数据来自本组 / 各组独立项目空间）----
  if (p === '/api/devices') {
    try {
      return json(res, 200, { ok: true, devices: listDevices(), storageEnabled: config.storageEnabled });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- 原始记录导出为 CSV（BOM，Excel 友好）----
  if (p === '/api/records.csv') {
    const device = url.searchParams.get('device') || null;
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 1000));
    const since = Number(url.searchParams.get('since')) || null;
    const until = Number(url.searchParams.get('until')) || null;
    try {
      const rows = readRecords({ device, limit, since, until, order: 'asc' });
      if (!rows.length) { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' }); return res.end('\uFEFF' + '无记录'); }
      const keys = new Set();
      for (const r of rows) for (const k of Object.keys(r.fields)) keys.add(k);
      const fieldKeys = Array.from(keys);
      const esc = csvEsc;
      const header = ['seq', 'recv_iso', 'device_id', 'device_mac', 'transport', 'src_ip', 'board_iso', 'board_ts', 'recv_ts', 'skew_ms', ...fieldKeys].join(',');
      const lines = rows.map((r) => [
        r.seq, r.recv_iso, r.device_id || '', r.device_mac || '', r.transport || '', r.src_ip || '',
        r.board_iso || '', r.board_ts || '', r.recv_ts || '', r.skew_ms == null ? '' : r.skew_ms,
        ...fieldKeys.map((k) => (r.fields && r.fields[k] !== undefined ? esc(r.fields[k]) : '')),
      ].join(','));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="records_${Date.now()}.csv"`,
      });
      return res.end('\uFEFF' + [header, ...lines].join('\n'));
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- 端口列表 ----
  if (p === '/api/ports') {
    try {
      const ports = await SerialPort.list();
      return json(res, 200, { ports: ports.map(serializePort) });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- 诊断信息（帮助排查"插上板子却没数据"）----
  if (p === '/api/diag') {
    let ports = [];
    try {
      ports = (await SerialPort.list()).map(serializePort);
    } catch (e) { ports = [{ error: e.message }]; }

    const hints = [];
    const usb = ports.filter((x) => (x.score || 0) > 0);
    if (!usb.length) hints.push('未发现 USB 转串口设备，请检查数据线是否是"数据线"而非纯充电线');
    if (!(port && port.isOpen)) hints.push('串口当前未打开');
    else if (stats.bytesReceived === 0) hints.push('串口已打开但一个字节都没收到：检查波特率是否与固件一致（默认 115200），或开发板程序是否在运行');
    else if (stats.linesValid === 0) hints.push(`已收到 ${stats.bytesReceived} 字节但没有一行合法 JSON 数据：确认固件用的是 Serial.println()（必须换行），且输出以 { 开头的 JSON`);
    if (stats.lastOpenError) hints.push(`最近一次打开失败：${stats.lastOpenError}`);

    // 针对 Espressif 原生 USB 串口（VID 303A）的专项提示
    const curPort = ports.find((x) => x.path === (state.device && state.device.path));
    const vid = ((curPort && curPort.vendorId) || (state.device && state.device.vendorId) || '').toLowerCase();
    if (vid === '303a' && stats.bytesReceived === 0) {
      hints.push('检测到 Espressif 原生 USB 串口（VID 303A / USB Serial/JTAG）。这类接口不受波特率影响，收不到数据说明固件没有输出到这个端口。请在 Arduino IDE 把 "USB CDC On Boot" 设为 Enabled 后重新烧录，烧录完按一下开发板上的 RESET 键。');
    } else if (vid && stats.bytesReceived === 0) {
      hints.push('串口已打开但没收到数据。请确认固件已烧录、开发板在运行、且输出用的是 Serial.println()（必须换行）。');
    }

    // 下行通道检查：串口不在线时，只能靠板端经 WiFi 轮询来取命令
    if (!(port && port.isOpen) && !wifiDownlinkActive()) {
      hints.push(`串口未打开，且开发板尚未通过 WiFi 来取命令（GET /api/cmd）。此时远程采集/求助回应只会排队等待。请确认固件已填 WiFi 凭据（app_config.h），且能访问本机 ${config.httpPort} 端口（注意放行防火墙）。`);
    }

    return json(res, 200, {
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      serialportVersion: (() => { try { return require('serialport/package.json').version; } catch (_) { return 'unknown'; } })(),
      serviceUptime: Math.round((Date.now() - stats.startedAt) / 1000),
      ports,
      currentPort: state.device && state.device.path ? state.device.path : null,
      portOpen: serialOpen(),
      baudRate: config.baudRate,
      connected: state.connected,
      transport: state.transport,
      bytesReceived: stats.bytesReceived,
      lines: {
        total: stats.linesTotal,
        valid: stats.linesValid,
        invalid: stats.linesInvalid,
        // 双通道（串口 + WiFi 同时在线）时被丢弃的重复帧数。
        // 正常值：只连一路时为 0；两路都连时约等于其中一路的帧数。
        duplicate: stats.linesDuplicate || 0,
      },
      lastError: stats.lastError,
      lastOpenError: stats.lastOpenError,
      recording: { active: recording.active, rows: recording.rows.length },
      downlink: {
        serial: serialOpen(),
        wifiPolling: wifiDownlinkActive(),
        lastPollAt: stats.lastCmdPollAt || null,
        pollCount: stats.cmdPollCount || 0,
        pollDevice: stats.cmdPollDevice || null,
        queued: cmdQueue.length,
        sentViaSerial: stats.cmdViaSerial || 0,
        sentViaWifi: stats.cmdViaWifi || 0,
      },
      /* 命令回执（第 5 周收尾）：便于取证「下发」与「板端接受」的区别。
       * pendingAcks = 当前还在等回执的命令数；lastAckOutcome = 最近一次的结局。
       * lastChannel = 最近一条命令实际走的下行通道；lastAckChannel = 它的回执
       * 实际从哪条上行回来（2026-10-28 固件改为 ack 双通道后才可能非空）。
       * 两者都是"实际发生"的记录，不是用 serialOpen() 反推的推断值。 */
      commandAck: {
        timeoutMs: commandAckTimeoutMs(),
        pendingAcks: PENDING_ACKS.size,
        lastOutcome: stats.lastAckOutcome || null,
        lastAckAt: stats.lastAckAt || null,
        lastCommandChannel: stats.lastCommandChannel || null,
        lastAckChannel: stats.lastAckChannel || null,
      },
      hints,
    });
  }

  // ---- 远程采集：创建一次请求并下发（幂等：有进行中的请求则复用，不产生并发命令）----
  if (p === '/api/collect' && req.method === 'POST') {
    const active = findActiveCollectRequest();
    if (active) return json(res, 200, { ok: true, request: publicRequest(active), deduped: true });
    const r = createCollectRequest();
    return json(res, 200, { ok: r.status !== 'failed', request: publicRequest(r) });
  }

  // ---- 远程采集：最近请求列表（页面刷新后恢复显示）----
  if (p === '/api/collect' && req.method === 'GET') {
    return json(res, 200, {
      mockDevice: !!config.mockDevice,
      channel: {
        portOpen: serialOpen(),
        wifiDownlink: wifiDownlinkActive(),   // 板端正通过 WiFi 来取命令
        kind: currentChannelKind(),
        cmdSent: stats.cmdSent || 0,
        pending: cmdQueue.length,
      },
      timeoutMs: collectTimeoutMs(),
      requests: recentRequests(20),
    });
  }

  // ---- 远程采集：查询单个请求 ----
  if (p.startsWith('/api/collect/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/collect/'.length));
    const r = REQUESTS.get(id);
    if (!r) return json(res, 404, { error: 'request not found' });
    return json(res, 200, { request: publicRequest(r) });
  }

  // ---- 周期上报开关（暂停 / 恢复；命令通道保持）----
  if (p === '/api/report' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const action = body.action === 'resume' ? 'resume' : 'pause';
    const ok = sendCommand({ cmd: action }, state.deviceId || null);
    if (ok) state.reportPaused = (action === 'pause');
    pushStatus('report');
    return json(res, 200, {
      ok,
      action,
      reportPaused: !!state.reportPaused,
      channel: ok ? ((port && port.isOpen) ? 'serial' : 'wifi') : null,
      note: ok ? null : (config.mockDevice ? '模拟模式：未走真实串口' : '命令通道不可用（串口未打开）'),
    });
  }

  // ---- 下行命令轮询（WiFi 通道，第 3 周补充）----
  // 板端是纯 HTTP 客户端，服务端连不上它，因此由板端定期来取：
  //   GET /api/cmd?device=S3EYE-GROUP01  →  有命令则返回该命令对象，没有则返回 {}
  if (p === '/api/cmd' && req.method === 'GET') {
    const device = (url.searchParams.get('device') || '').trim() || null;
    stats.lastCmdPollAt = Date.now();
    stats.cmdPollCount = (stats.cmdPollCount || 0) + 1;
    stats.cmdPollDevice = device;
    const item = takeCommand(device);
    return json(res, 200, item ? item.obj : {});
  }

  // ---- 摄像头（OV2640）：状态 / 开关 ----
  if (p === '/api/cam' && req.method === 'GET') {
    return json(res, 200, {
      hasFrame: cam.latest != null,
      frames: cam.frames,
      lastAt: cam.latestAt || null,
      seq: cam.latestSeq,
      size: cam.size,
      bytes: cam.latest ? cam.latest.length : 0,
      viewers: cam.clients.size,
      streaming: !!state.camStreaming,
      // 手动抓拍快照
      hasSnapshot: cam.snapshot != null,
      snapshotAt: cam.snapshotAt || null,
      snapshotSize: cam.snapshotSize || null,
      snapshotBytes: cam.snapshotBytes || 0,
    });
  }

  // 手动抓拍的那一张（与直播流分开）
  if (p === '/api/cam/snapshot.jpg') {
    if (!cam.snapshot) return json(res, 404, { error: '还没有抓拍过' });
    const fn = `snapshot-${new Date(cam.snapshotAt).toISOString().replace(/[:.]/g, '-')}.jpg`;
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': cam.snapshot.length,
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="${fn}"`,
    });
    return res.end(cam.snapshot);
  }

  if (p === '/api/cam' && req.method === 'POST') {
    const body = await readJsonBody(req);

    const action = (body.action === 'stop' || body.action === 'set' || body.action === 'shot')
      ? body.action : 'start';
    let cmdObj;
    if (action === 'set' || action === 'shot') {
      cmdObj = { cmd: action === 'set' ? 'cam_set' : 'cam_shot' };
      if (body.framesize != null) cmdObj.framesize = Number(body.framesize);
      if (body.quality   != null) cmdObj.quality   = Number(body.quality);
      if (action === 'set' && body.fps != null) cmdObj.fps = Number(body.fps);
    } else {
      cmdObj = { cmd: action === 'start' ? 'cam_on' : 'cam_off' };
    }

    const ok = sendCommand(cmdObj, state.deviceId || null);
    if (ok && (action === 'start' || action === 'stop')) state.camStreaming = (action === 'start');
    pushStatus('cam');
    return json(res, 200, {
      ok,
      action,
      streaming: !!state.camStreaming,
      sent: cmdObj,
      note: ok ? null : (config.mockDevice ? '模拟模式：未走真实通道' : '命令通道不可用（串口未打开、板端也未在轮询）'),
    });
  }

  // 最近一帧（单张 JPEG）
  if (p === '/api/cam.jpg') {
    if (!cam.latest) return json(res, 404, { error: '还没有收到任何帧' });
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': cam.latest.length,
      'Cache-Control': 'no-store',
    });
    return res.end(cam.latest);
  }

  // MJPEG 实时流：浏览器 <img src="/api/cam.mjpg"> 直接可显示，无需 JS 解码
  if (p === '/api/cam.mjpg') {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      'Connection': 'close',
    });
    cam.clients.add(res);
    req.on('close', () => cam.clients.delete(res));
    return;
  }

  // ---- 语音链路（第 5 周）：① 板端上传 WAV ----
  //   POST /api/voice/audio
  //   headers: device: <DEVICE_ID>（或 x-device-id / ?device=）、duration_ms: <整数>
  //   body:    完整 WAV 二进制（RIFF 头 + PCM）
  //   注意：本入口与 /api/data 的「串口优先」无关，语音只走 HTTP，不受串口在线影响。
  if (p === '/api/voice/audio' && req.method === 'POST') {
    let got;
    try {
      got = await readBinaryBody(req, VOICE_MAX_BYTES);
    } catch (e) {
      return json(res, 400, { ok: false, error: 'read_failed', message: '读取请求体失败：' + e.message });
    }
    if (got.aborted) {
      return json(res, 400, { ok: false, error: 'aborted', message: '上传中断（连接提前关闭），未保存任何文件。' });
    }
    if (got.tooLarge) {
      // 契约要求「非法格式或超限一律 400」，因此不用 413（前端/固件只判 200 与 400）
      return json(res, 400, {
        ok: false, error: 'payload_too_large', max_bytes: VOICE_MAX_BYTES,
        message: `WAV 超过上限 ${VOICE_MAX_BYTES} 字节（1 MB），未保存。请缩短录音时长或降低采样率。`,
      });
    }
    const buf = got.buf;
    if (!buf.length) return json(res, 400, { ok: false, error: 'empty_body', message: '请求体为空，没有可保存的 WAV。' });
    const wav = parseWavHeader(buf);
    if (!wav.ok) {
      const msg = wav.error === 'not_riff'
        ? `不是合法 WAV：前 4 字节应为 "RIFF"，实际是 "${String(wav.riff)}"。`
        : (wav.error === 'not_wave'
          ? `不是合法 WAV：第 8-11 字节应为 "WAVE"，实际是 "${String(wav.wave)}"。`
          : '请求体不足 12 字节，连 WAV 头都不完整。');
      return json(res, 400, { ok: false, error: 'not_wav', detail: wav.error, riff: wav.riff, wave: wav.wave, message: msg });
    }

    const devHeader = (req.headers['device'] || req.headers['x-device-id'] || url.searchParams.get('device') || '').toString().trim();
    const deviceId = devHeader || state.deviceId || null;
    /* duration_ms 优先取固件自报（板端实测更准），缺失/非法时退回由 WAV 头计算的值。
     * 注意：Number(undefined) 是 NaN，但 Number(null) 是 0 —— 必须显式判空，
     * 否则缺头时会写进 duration_ms=0，前端会误报「录音过短」。 */
    const durRaw = req.headers['duration_ms'] != null ? req.headers['duration_ms'] : url.searchParams.get('duration_ms');
    const durNum = durRaw == null || String(durRaw).trim() === '' ? NaN : Number(durRaw);
    const durationMs = Number.isFinite(durNum) && durNum > 0 ? Math.round(durNum) : wav.duration_ms;

    try {
      ensureVoiceDir();
    } catch (e) {
      return json(res, 500, { ok: false, error: 'storage_unavailable', message: '无法创建 data/voice 目录：' + e.message });
    }
    const audioId = newVoiceId();
    const file = voiceAudioFile(audioId);
    try {
      // 先写临时文件再原子改名：中途失败不会留下半截 WAV 冒充合法录音
      const tmp = file + '.part';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error('[voice] WAV 落盘失败：', e.message);
      return json(res, 500, { ok: false, error: 'write_failed', message: 'WAV 落盘失败：' + e.message });
    }

    const lv = wavLevelStats(buf, wav);
    const r = voiceApply('recorded', {
      audio_id: audioId,
      device_id: deviceId,
      bytes: buf.length,
      duration_ms: durationMs,
      received_at: Date.now(),
    });
    console.log(`[voice] 收到 WAV ${audioId} ← ${deviceId || '(未标注设备)'} ${buf.length} 字节 / ${durationMs == null ? '?' : durationMs}ms（${wav.sample_rate || '?'}Hz ${wav.channels || '?'}ch ${wav.bits || '?'}bit，峰值 ${lv.peak_dbfs == null ? '?' : lv.peak_dbfs} dBFS）`);
    return json(res, 200, {
      ok: true,
      audio_id: audioId,
      file: path.basename(file),
      path: path.relative(ROOT, file).split(path.sep).join('/'),
      bytes: buf.length,
      duration_ms: durationMs,
      riff: 'RIFF',
      wave: 'WAVE',
      sample_rate: wav.sample_rate,
      channels: wav.channels,
      bits: wav.bits,
      peak_dbfs: lv.peak_dbfs != null ? lv.peak_dbfs : null,
      rms_dbfs: lv.rms_dbfs != null ? lv.rms_dbfs : null,
      silent_hint: lv.silent_hint,
      device_id: deviceId,
      audio_url: `/api/voice/audio/${audioId}`,
      download_url: `/api/voice/audio/${audioId}/download`,
      event_persisted: r.persisted,
      state: r.state,
    });
  }

  // ---- 语音链路：② 最近一条录音的元信息 + 全链路状态（固件实测取证入口）----
  if (p === '/api/voice' && req.method === 'GET') {
    const latestId = voice.audio_id;
    const latest = latestId ? readVoiceAudioMeta(latestId) : null;
    const recent = listVoiceAudios(Number(url.searchParams.get('limit')) || 10);
    return json(res, 200, {
      ok: true,
      latest: latest ? Object.assign({}, latest, {
        device_id: voice.device_id,
        duration_ms: voice.duration_ms != null ? voice.duration_ms : latest.duration_ms,
        received_at: voice.received_at,
        stage: voice.stage,
      }) : null,
      recent: recent.rows,
      audio_total: recent.total,
      events_total: voiceEventsTotal(),
      state: publicVoice(),
    });
  }

  // ---- 语音链路：③ 四段状态 + 事件历史（前端轮询入口）----
  if (p === '/api/voice/state' && req.method === 'GET') {
    return json(res, 200, publicVoice());
  }

  // ---- 语音链路：④ 前端上报阶段推进 ----
  //   body: { audio_id?, stage, transcript?, intent?, reply?, reason?, error?, duration_ms? }
  //   stage 枚举见 VOICE_STAGES；不在枚举内 → 400（绝不悄悄接受未知阶段）
  if (p === '/api/voice/state' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const stage = String(body.stage || '').trim();
    if (!stage) return json(res, 400, { ok: false, error: 'missing_stage', message: '缺少 stage 字段。', stages: VOICE_STAGES });
    if (!VOICE_STAGE_SET.has(stage)) {
      return json(res, 400, { ok: false, error: 'invalid_stage', message: `未知阶段 "${stage}"。`, stages: VOICE_STAGES });
    }
    const patch = {};
    if (body.audio_id != null) {
      const aid = String(body.audio_id).trim();
      if (!VOICE_ID_RE.test(aid)) return json(res, 400, { ok: false, error: 'invalid_audio_id', message: `audio_id 格式非法：${aid}` });
      patch.audio_id = aid;
    }
    for (const k of ['transcript', 'intent', 'reply', 'reason', 'error']) {
      if (body[k] !== undefined) patch[k] = body[k] == null ? null : String(body[k]);
    }
    // duration_ms 只在真给了有效正数时才覆盖（Number(null) === 0，必须显式判空）
    if (body.duration_ms != null && String(body.duration_ms).trim() !== '') {
      const d = Number(body.duration_ms);
      if (Number.isFinite(d) && d > 0) patch.duration_ms = Math.round(d);
    }
    // 失败分支必须能看懂原因：前端只给 stage 时由服务端补一句默认中文原因
    if (!patch.reason && (stage === 'asr_failed' || stage === 'silent' || stage === 'timeout')) {
      patch.reason = stage === 'asr_failed' ? '浏览器未能识别出语音内容'
        : (stage === 'silent' ? '没有检测到语音（无声或录音过短）' : '链路等待超时');
    }
    const r = voiceApply(stage, patch);
    console.log(`[voice] 阶段推进 → ${stage}${patch.transcript ? '：' + patch.transcript : ''}${patch.reason ? '（' + patch.reason + '）' : ''}`);
    return json(res, 200, { ok: true, persisted: r.persisted, voice: r.state });
  }

  // ---- 语音链路：④b 服务端转写（无麦克风机器的识别路径）----
  //   body: { audio_id }
  //   把盘上这段 WAV 直接交给识别接口（智谱 GLM-ASR），不依赖本机声卡。
  //   有麦克风的机器前端仍走 Web Speech；本接口是「没有麦克风」时的降级路径。
  //   失败一律分类返回（未配置 / 超限 / 上游错 / 超时 / 空文本），绝不假装成功。
  if (p === '/api/voice/transcribe' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const aid = String(body.audio_id || '').trim();
    if (!aid) {
      return json(res, 400, { ok: false, error: 'missing_audio_id', message: '缺少 audio_id 字段。' });
    }
    if (!VOICE_ID_RE.test(aid)) {
      return json(res, 400, { ok: false, error: 'invalid_audio_id', message: `audio_id 格式非法：${aid}` });
    }
    const r = await voiceTranscribe(aid);
    return json(res, r.http, r.body);
  }

  // ---- 语音链路：⑦ 远程触发一次录音（等价于按板端 BOOT 键）----
  //   板端是纯 HTTP 客户端，服务端无法主动连它；命令走串口直写或 WiFi 轮询队列。
  //   用途：① 自动化取证脚本触发录音；② BOOT 键 GPIO 异常时的兜底入口。
  //   第 5 周收尾：本接口改为【等板端 ack】后再回答 —— 此前只把"写进串口"当成功，
  //   板端忙时 voice_record_toggle() 直接 return false、固件回 ack("busy")，
  //   命令其实被丢弃，服务端却报 accepted=true（已实测复现）。
  //   返回体字段：
  //     ok            —— 兼容旧前端/旧脚本：等价于 accepted（板端真的接受了）
  //     accepted      —— 板端 ack 且 status 非 busy/error
  //     dispatched    —— 命令确实写进了通道（串口写出 / WiFi 队列且板端在轮询）
  //     outcome       —— accepted | busy | error | timeout | channel_unavailable | mock | no_request_id
  //     ack_status / ack_seq / waited_ms / timeout_ms / channel / request_id / note
  if (p === '/api/voice/record' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const action = body.action === 'stop' ? 'stop' : (body.action === 'start' ? 'start' : 'toggle');
    /* request_id 必须强唯一（审查 blocker F1）。
     * 原写法 `voice-rec-${Date.now()}` 在同一毫秒内的多个请求会拿到同一个 id，
     * 叠加等待槽「后登记覆盖先登记」的旧实现 → 先登记的那个请求永久挂死。
     * 现在用「时间戳 + 单调递增序号」，同毫秒内也不会重复。 */
    const rid = `voice-rec-${Date.now()}-${++ackRequestSeq}`;
    const r = await sendCommandAndWaitAck({ cmd: 'voice_record', request_id: rid }, state.deviceId || null);
    console.log(`[voice] 远程录音命令（${action}）→ outcome=${r.outcome}`
      + ` dispatched=${r.dispatched} accepted=${r.accepted}`
      + ` channel=${r.channel || 'none'} ack=${r.ack_status || '-'} waited=${r.waited_ms ?? '-'}ms`);
    return json(res, 200, {
      ok: r.accepted,                 // 向后兼容：ok 不再等于"写出成功"，而是"板端已接受"
      accepted: r.accepted,
      dispatched: r.dispatched,       // 与 accepted 分开：写出成功但板端未确认时 dispatched=true
      outcome: r.outcome,
      action,
      request_id: rid,
      channel: r.channel,             // 命令实际走的下行通道（serial / wifi / null）
      queued: r.queued,               // 是否进了 WiFi 待取队列（channel=wifi 且 queued=true）
      withdrawn: r.withdrawn,         // 通道不可用时命令是否已撤回（true=板端不会再执行它）
      ack_status: r.ack_status,
      ack_seq: r.ack_seq,
      ack_channel: r.ack_channel,     // 回执实际从哪条上行回来（serial / wifi / null）
      waited_ms: r.waited_ms,
      timeout_ms: r.timeout_ms,
      simulated: r.simulated,
      note: r.accepted ? null : r.message,
    });
  }

  // ---- 语音链路：⑤ WAV 回放 / 取证下载（:id 必须通过格式校验，杜绝路径穿越）----
  if (p.startsWith('/api/voice/audio/') && req.method === 'GET') {
    const rest = p.slice('/api/voice/audio/'.length);
    const asDownload = rest.endsWith('/download');
    const audioId = asDownload ? rest.slice(0, -'/download'.length) : rest;
    const file = voiceAudioFile(audioId);
    if (!file) return json(res, 400, { ok: false, error: 'invalid_audio_id', message: 'audio_id 格式非法。' });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        return json(res, 404, { ok: false, error: 'not_found', message: `没有 audio_id=${audioId} 的录音。` });
      }
      const name = path.basename(file);
      const disposition = asDownload ? `attachment; filename="${name}"` : `inline; filename="${name}"`;
      /* <audio> 在 Chrome/Safari 上会先发 Range 请求探测可播性；
       * 处理 206 能让进度条可拖动，也让某些浏览器不再因 200+全量 而反复重取。 */
      const range = req.headers.range;
      let start = 0;
      let end = st.size - 1;
      let partial = false;
      if (range && /^bytes=\d*-\d*$/.test(String(range).trim())) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (m[1]) { start = Number(m[1]); if (m[2]) end = Number(m[2]); }
        else if (m[2]) { start = Math.max(0, st.size - Number(m[2])); }
        if (!Number.isFinite(start) || start < 0 || start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Content-Type': 'audio/wav' });
          return res.end();
        }
        if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
        if (end < start) end = st.size - 1;
        partial = true;
      }
      const headers = {
        'Content-Type': 'audio/wav',
        'Content-Length': partial ? (end - start + 1) : st.size,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': disposition,
      };
      if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      res.writeHead(partial ? 206 : 200, headers);
      const rs = fs.createReadStream(file, partial ? { start, end } : undefined);
      rs.on('error', (e) => {
        console.error('[voice] 发送 WAV 失败：', e.message);
        try { res.destroy(); } catch (_) {}
      });
      rs.pipe(res);
    });
    return;
  }

  // ---- 教学求助（第 3 周）：查询当前状态 ----
  if (p === '/api/help' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      help: publicHelp(),
      channel: { portOpen: serialOpen(), cmdSent: stats.cmdSent || 0 },
    });
  }

  // ---- 教学求助：查看者回应 / 取消 / 复位 ----
  if (p === '/api/help' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.action === 'ack') {
      const r = createHelpAck();
      return json(res, 200, { ok: r.ok, note: r.note, help: publicHelp() });
    }
    if (body.action === 'cancel') {
      const r = createHelpCancel();
      return json(res, 200, { ok: r.ok, note: r.note, help: publicHelp() });
    }
    if (body.action === 'reset') {
      resetHelp();
      return json(res, 200, { ok: true, help: publicHelp() });
    }
    return json(res, 400, { error: 'unknown action' });
  }

  // ---- 自然语言助手（第 4 周）：自然语言 → 受限工具 ----
  if (p === '/api/nl' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const text = String(body.text || '').trim();
    if (!text) return json(res, 400, { error: 'empty text' });
    if (text.length > 200) return json(res, 400, { error: 'text too long (max 200)' });
    const out = await nlHandle(text);
    out.ok = true;
    out.text = text;
    return json(res, 200, out);
  }

  // ---- 自然语言助手：能力说明（不暴露密钥，只报是否已配置 LLM） ----
  if (p === '/api/nl' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      llm_configured: !!(NL.endpoint && NL.apiKey),
      engine: (NL.endpoint && NL.apiKey) ? 'llm (降级兜底: rule)' : 'rule',
      llm_host: NL.endpoint ? (new URL(NL.endpoint)).host : null,
      allowed_device: config.expectedDeviceId || null,
      tools: Object.fromEntries(Object.entries(NL_TASKS).map(([k, t]) => [k, t.apiDesc])),
    });
  }

  // ---- LLM 自定义配置：查看（脱敏） ----
  if (p === '/api/nl/config' && req.method === 'GET') {
    return json(res, 200, nlConfigView());
  }

  // ---- LLM 自定义配置：保存（校验 → 写 config.local.json → 重载） ----
  if (p === '/api/nl/config' && req.method === 'PUT') {
    if (NL_ENV_ACTIVE) {
      return json(res, 409, { ok: false, error: 'env_override', message: '当前已通过环境变量 NL_ENDPOINT/NL_API_KEY/NL_MODEL 配置，优先级高于文件。请改用环境变量管理，或取消环境变量后再通过界面保存。' });
    }
    const body = await readJsonBody(req);
    let v;
    try { v = validateNlParams(body, { requireKey: true }); }
    catch (e) { return json(res, 400, { ok: false, error: 'invalid_config', message: e.message }); }
    try {
      const patch = { nlEndpoint: v.endpoint, nlApiKey: v.apiKey, nlModel: v.model, nlTimeoutMs: v.timeoutMs };
      if (v.replyMode !== undefined) patch.nlReplyMode = v.replyMode;
      writeNlFileCfg(patch);
    } catch (e) {
      return json(res, 500, { ok: false, error: 'write_failed', message: 'config.local.json 写入失败：' + e.message });
    }
    reloadNlConfig();
    nlInvalidateLlmCaches();   // 换模型/地址/Key 后，旧意图结果与熔断状态都不该沿用
    console.log('[nl] LLM 配置已更新：', v.endpoint, v.model);
    return json(res, 200, nlConfigView());
  }

  // ---- LLM 自定义配置：删除（只清 nl* 键，保留文件其它内容） ----
  if (p === '/api/nl/config' && req.method === 'DELETE') {
    if (NL_ENV_ACTIVE) {
      return json(res, 409, { ok: false, error: 'env_override', message: '当前配置来自环境变量，界面删除无效。请取消环境变量 NL_ENDPOINT/NL_API_KEY。' });
    }
    try { writeNlFileCfg({ nlEndpoint: null, nlApiKey: null, nlModel: null, nlTimeoutMs: null }); }
    catch (e) {
      return json(res, 500, { ok: false, error: 'write_failed', message: 'config.local.json 写入失败：' + e.message });
    }
    reloadNlConfig();
    nlInvalidateLlmCaches();
    console.log('[nl] LLM 配置已删除（config.local.json 中 nl* 键已清空）');
    return json(res, 200, nlConfigView());
  }

  // ---- LLM 自定义配置：测试连接（用请求体里的参数，不落盘；为空则用已保存配置） ----
  if (p === '/api/nl/config/test' && req.method === 'POST') {
    const body = await readJsonBody(req);
    let params;
    if (body.endpoint || body.apiKey || body.model) {
      let v;
      try { v = validateNlParams(body, { requireKey: true }); }
      catch (e) { return json(res, 400, { ok: false, error: 'invalid_config', message: e.message }); }
      params = v;
    } else {
      if (!NL.endpoint || !NL.apiKey) {
        return json(res, 400, { ok: false, error: 'not_configured', message: '尚未保存任何 LLM 配置，请先在表单填写并保存，或在测试请求中带上完整参数。' });
      }
      params = { endpoint: NL.endpoint, apiKey: NL.apiKey, model: NL.model, timeoutMs: NL.timeoutMs };
    }
    const result = await nlTestConnection(params);
    return json(res, 200, { ok: true, ...result });
  }

  // ---- LLM 自定义配置：拉取可用模型列表（用表单参数，不落盘；模型名常是 404 的真凶） ----
  if (p === '/api/nl/config/models' && req.method === 'POST') {
    const body = await readJsonBody(req);
    let endpoint, apiKey, timeoutMs;
    if (body.endpoint || body.apiKey) {
      const ep = body.endpoint || NL.endpoint;
      if (!ep) return json(res, 400, { ok: false, error: 'invalid_config', message: '缺少 API 地址' });
      let v;
      try { v = validateNlParams({ endpoint: ep, apiKey: body.apiKey, model: body.model || '_', timeoutMs: body.timeoutMs }, { requireKey: true }); }
      catch (e) { return json(res, 400, { ok: false, error: 'invalid_config', message: e.message }); }
      endpoint = v.endpoint; apiKey = v.apiKey; timeoutMs = v.timeoutMs;
    } else {
      if (!NL.endpoint || !NL.apiKey) return json(res, 400, { ok: false, error: 'not_configured', message: '尚未保存配置，请先在表单填写地址与 Key。' });
      endpoint = NL.endpoint; apiKey = NL.apiKey; timeoutMs = NL.timeoutMs;
    }
    const url = nlModelsUrl(endpoint);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + apiKey }, signal: ac.signal });
      const text = await r.text().catch(() => '');
      if (!r.ok) {
        let hint = 'HTTP ' + r.status;
        if (r.status === 401 || r.status === 403) hint += '（API Key 无效或无列表权限——不影响对话，可直接填已知模型名测试）';
        else if (r.status === 404) hint += '（该服务未开放 /models 列表接口）';
        return json(res, 200, { ok: false, url, error: hint, detail: text.slice(0, 200).replace(/\s+/g, ' ') || null });
      }
      let ids = [];
      try {
        const j = JSON.parse(text);
        ids = (j.data || j.models || []).map((m) => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
      } catch (_) {}
      return json(res, 200, { ok: true, url, models: ids });
    } catch (e) {
      const msg = e.name === 'AbortError' ? `请求超时（>${timeoutMs}ms）` : '请求失败：' + e.message;
      return json(res, 200, { ok: false, url, error: msg });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 波特率探测 ----
  if (p === '/api/probe' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const bauds = Array.isArray(body.baudRates) && body.baudRates.length
      ? body.baudRates : [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];
    const ms = Math.min(5000, Math.max(300, Number(body.ms) || 1500));
    const target = body.portPath || (state.device && state.device.path) || config.portPath || null;
    if (!target) return json(res, 400, { error: '未指定要探测的串口' });

    // 先释放当前端口，避免占用冲突
    stopScanning();
    if (port && port.isOpen) {
      const pp = port; port = null; portOpenedAt = null;
      try { pp.removeAllListeners(); } catch (_) {}
      await new Promise((r) => pp.close(() => r()));
    }

    const results = [];
    for (const b of bauds) {
      results.push(await probeOnce(target, b, ms));
      // 连续开关串口必须留间隔，否则 Windows 上会 Access denied 造成假阴性
      await new Promise((r) => setTimeout(r, 350));
    }

    if (config.autoDetect || config.portPath) startScanning();
    const best = results.filter((r) => r.bytes > 0).sort((a, b2) => b2.bytes - a.bytes)[0] || null;
    // 原生 USB CDC（VID 303A）是虚拟串口，波特率无意义，扫描结果只用于判断"有没有在发数据"
    let nativeUsb = false;
    try {
      const l = await SerialPort.list();
      const hit = l.find((x) => x.path === target);
      nativeUsb = !!hit && (hit.vendorId || '').toLowerCase() === '303a';
    } catch (_) {}
    return json(res, 200, { port: target, ms, nativeUsb, results, suggestedBaudRate: best ? best.baudRate : null });
  }

  // ---- 真实数据录制（仅记录设备实际上报的数据）----
  if (p === '/api/record' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.action === 'start') {
      recording.active = true;
      recording.rows = [];
      recording.startedAt = Date.now();
      return json(res, 200, { ok: true, active: true });
    }
    if (body.action === 'stop') {
      recording.active = false;
      const file = writeRecording();
      const rows = recording.rows.length;
      recording.rows = [];
      return json(res, 200, { ok: true, active: false, rows, file });
    }
    return json(res, 200, { ok: true, active: recording.active, rows: recording.rows.length });
  }

  if (p === '/api/record/download') {
    const f = url.searchParams.get('file') || '';
    const file = path.join(RECORD_DIR, path.basename(f));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
      });
      res.end(data);
    });
    return;
  }

  // ---- 连接 / 断开 ----
  if (p === '/api/connect' && req.method === 'POST') {
    const body = await readJsonBody(req);
    manualClose = false;
    if (body.portPath !== undefined) config.portPath = body.portPath || null;
    if (body.baudRate) config.baudRate = Number(body.baudRate) || config.baudRate;
    if (body.autoDetect !== undefined) config.autoDetect = !!body.autoDetect;
    config.autoReconnect = true;
    saveConfig();
    stopScanning();
    const list = await SerialPort.list().catch(() => []);
    let portObj = null;
    if (config.portPath) portObj = list.find((x) => x.path === config.portPath) || null;
    if (!portObj && config.autoDetect) portObj = pickBestPort(list);
    const targetPath = portObj ? portObj.path : config.portPath;
    const ok = await openSerial(targetPath, config.baudRate, portObj);
    // 打开失败才启动轮询重试；成功后若设备掉线，由 cleanupPort 负责重新扫描
    if (!ok) startScanning();
    return json(res, 200, { ok, target: targetPath });
  }

  if (p === '/api/disconnect' && req.method === 'POST') {
    await disconnectSerial(true);
    return json(res, 200, { ok: true });
  }

  // ---- 配置 ----
  if (p === '/api/config') {
    if (req.method === 'GET') return json(res, 200, config);
    const body = await readJsonBody(req);
    for (const k of ['baudRate', 'portPath', 'autoDetect', 'autoReconnect', 'staleAfterMs', 'wifiTimeoutMs', 'expectedDeviceId', 'storageEnabled', 'stalePolicy', 'collectTimeoutMs', 'commandAckTimeoutMs', 'commandAckWifiExtraMs', 'mockDevice']) {
      if (body[k] !== undefined) config[k] = body[k];
    }
    saveConfig();
    pushStatus('config');
    return json(res, 200, { ok: true, config });
  }

  // ---- WiFi 上报入口（可选传输方式）----
  // ESP32:  HTTP POST http://<host>:8080/api/data   body: {"temp_c":26.5,...}
  if (p === '/api/data' && req.method === 'POST') {
    let body = '';
    try {
      body = await readBody(req);
    } catch (e) {
      // 超限时 readBody 已 req.destroy()，socket 不可写 —— 再写响应只会抛错，直接结束
      console.warn('[http] /api/data 载荷超过 1MB，连接已丢弃');
      return;
    }
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
    // 串口优先：串口在线时忽略 WiFi 上报，避免数据源混乱
    if (state.transport === 'serial' && state.connected) {
      return json(res, 200, { ok: true, ignored: 'serial-active' });
    }
    state.transport = 'wifi';
    state.wifiSource = { ip };
    state.device = { path: `WiFi(${ip})`, ip };
    /* 支持 JSON 或 key=value 两种上报；WiFi 固件走 JSON，提取 device/mac/ts 等元数据。
     * 分帧规则：整体是合法 JSON（允许跨行美化格式）→ 当作一帧；
     * 否则含多行（NDJSON / 多行 key=value 批量上报）→ 逐行当一帧。
     * 之前把整个 body 当一行，多行 payload 会 JSON 解析失败并落进键值解析器，
     * 可能从日志/错误文本里误提取出假的传感器字段。 */
    const whole = body.trim();
    let isSingleJson = false;
    if (whole[0] === '{') { try { JSON.parse(whole); isSingleJson = true; } catch (_) { /* 落到按行 */ } }
    const src = { transport: 'wifi', ip };
    if (isSingleJson) {
      handleLine(whole, src);
    } else {
      const lines = whole.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const l of (lines.length ? lines : [whole])) handleLine(l, src);
    }
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  启动失败：端口 ${config.httpPort} 已被占用。`);
    console.error('  可能已经有一个平台在运行；请关闭它，或修改 config.json 里的 httpPort 后重试。');
    console.error('');
    process.exit(1);
  }
  console.error('[http] 服务错误：', err);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'hello',
    connected: state.connected,
    live: state.live,
    portOpen: serialOpen(),
    wifiDownlink: wifiDownlinkActive(),
    downlinkKind: currentChannelKind(),
    transport: state.transport,
    device: state.device,
    deviceId: state.deviceId,
    deviceMac: state.deviceMac,
    deviceVerified: state.deviceVerified,
    expectedDeviceId: config.expectedDeviceId,
    lastDataAt: state.lastDataAt,
    boardTs: state.boardTs,
    boardIso: state.boardIso,
    seq: state.seq,
    reportPaused: !!state.reportPaused,
    fields: state.fields,
    raw: rawLog.slice(-60),
    meta: { units: config.fieldUnits, labels: config.fieldLabels, historyMax: config.historyMax },
    // 远程采集：刷新页面后恢复请求列表与模拟模式标记
    requests: recentRequests(10),
    mockDevice: !!config.mockDevice,
    collectTimeoutMs: collectTimeoutMs(),
    // 教学求助：刷新页面后恢复当前求助状态
    help: publicHelp(),
    // 语音链路：刷新页面后恢复四段状态与事件历史
    voice: publicVoice(),
  }));
  pushStatus('client');
});

/* ------------------------------------------------------------------ */
/* 心跳 / 超时检测                                                     */
/* ------------------------------------------------------------------ */

/* 下行通道变化时主动推送：板端开始 / 停止经 WiFi 轮询取命令 */
let lastDownlinkKind = null;
setInterval(() => {
  const kind = currentChannelKind();
  if (kind !== lastDownlinkKind) {
    lastDownlinkKind = kind;
    pushStatus('downlink');
  }
}, 2000);

/* 摄像头「无观众自动停流」看门狗
 *
 * 实测（2026-09-30）：板端推 MJPEG 会抢占 CPU 与串口带宽，把传感上报帧率
 * 从 5.25 帧/秒压到 1.00 帧/秒，实时监控页表现为明显的「一帧一帧」卡顿。
 * 而推流一旦开启就会一直推 —— 即使所有观众都已断开（关掉页面 / 切走摄像头页），
 * /api/cam 里 viewers=0 也照推不误。此前没有任何兜底，只能靠人记得点「停止」。
 * 这里加看门狗：连续 CAM_IDLE_STOP_MS 无观众，自动下发 cam_off 收流。
 * 观众回来时前端重新挂 <img src="/api/cam.mjpg">，需重新点「开启画面」。
 * 阈值可用环境变量 CAM_IDLE_STOP_MS 覆盖（便于测试与调参）。 */
const CAM_IDLE_STOP_MS = Number(process.env.CAM_IDLE_STOP_MS || 60000);  // 60s：切页瞬间不误停
let camIdleSince = 0;
setInterval(() => {
  if (!state.camStreaming) { camIdleSince = 0; return; }
  if (cam.clients.size > 0) { camIdleSince = 0; return; }
  const now = Date.now();
  if (!camIdleSince) { camIdleSince = now; return; }   // 第一拍只记起点，不判断
  if (now - camIdleSince < CAM_IDLE_STOP_MS) return;
  camIdleSince = 0;
  const ok = sendCommand({ cmd: 'cam_off' }, state.deviceId || null);
  if (ok) state.camStreaming = false;
  const msg = `连续 ${Math.round(CAM_IDLE_STOP_MS / 1000)}s 无观众，已自动停止推流（命令下发${ok ? '成功' : '失败'}）`;
  console.log(`[cam] ${msg}`);
  pushRaw(`[摄像头] ${msg}`, ok);
  pushStatus('cam');
}, 5000);

setInterval(() => {
  const now = Date.now();
  if (!state.connected || !state.lastDataAt) return;

  const silentMs = now - state.lastDataAt;
  const staleLimit = config.staleAfterMs; // 停采阈值：两种传输方式一致，便于演示"停采后提示未更新"

  // 1) 刚超过"静默阈值"：仍在连接，但已停采 -> 进入"停采保留"状态
  if (state.live && silentMs > staleLimit) {
    if (config.stalePolicy === 'keep') {
      goStale('停采超时（保留旧值，提示未更新）');
    } else {
      // clear 模式：先标记 stale，随后在离线阈值处再清空
      state.live = false;
      broadcast({ type: 'status', connected: true, live: false, stale: true, reason: 'no-data-timeout', lastDataAt: state.lastDataAt });
    }
  }

  // 2) 超过"离线阈值"：依据策略决定清空或继续保留
  if (!state.live && silentMs > config.offlineAfterMs) {
    if (config.stalePolicy === 'keep') {
      // keep 模式：停采只保留，不自动清空（除非物理拔线或手动释放串口）
      return;
    }
    if (state.transport === 'wifi') {
      goOffline('WiFi 设备超时无响应');
      if (config.autoReconnect && !manualClose) rescanNow();
      return;
    }
  }

  // 3) 串口：长时间没有任何数据 => 兜底判定开发板已被拔掉（物理移除必清空）
  if (state.transport === 'serial' && port && port.isOpen && !manualClose) {
    const ref = state.lastDataAt || portOpenedAt;
    if (ref && now - ref > config.offlineAfterMs) {
      console.log('[serial] 长时间无数据，判定开发板已移除');
      pushRaw('[串口] 长时间未收到数据，判定开发板已移除', false);
      const p = port;
      port = null;
      try { p.removeAllListeners(); p.close(() => {}); } catch (_) {}
      cleanupPort('设备无响应，已判定为已移除');
    }
  }
}, 1000);

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

server.listen(config.httpPort, config.host, () => {
  const lanIps = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) lanIps.push(`${a.address} (${name})`);
    }
  }
  console.log('==========================================================');
  console.log('  ESP32-S3-EYE 三轴传感器监控平台（本机即服务器）');
  console.log(`  本机访问: http://localhost:${config.httpPort}`);
  if (lanIps.length) {
    console.log('  局域网访问（开发板固件 app_config.h 填这里）:');
    for (const ip of lanIps) console.log(`      http://${ip.split(' ')[0]}:${config.httpPort}`);
  } else {
    console.log('  局域网访问: 未发现可用的局域网 IPv4 网卡');
  }
  console.log(`  监听: ${config.host}:${config.httpPort}   串口波特率: ${config.baudRate}   自动识别: ${config.autoDetect}`);
  console.log('  说明: 未连接真实开发板时不显示任何数据（无模拟数据）');
  console.log('==========================================================');
  loadHelpHistory();   // 回读历史求助事件（重启不丢证据）
  loadVoiceHistory();  // 回读历史语音事件（重启不丢语音链路证据）
  if (config.autoDetect || config.portPath) startScanning();
});

process.on('SIGINT', async () => {
  stopScanning();
  if (port && port.isOpen) await new Promise((r) => port.close(() => r()));
  process.exit(0);
});
