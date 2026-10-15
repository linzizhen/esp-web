/* =====================================================================
   ESP32-S3-EYE 三轴传感器监控 —— 前端
   只渲染后端推送的【真实】数据：
     · 实时     → 正常显示
     · 停采     → 保留旧值/旧时间，提示「未更新」
     · 拔出/释放 → 立即清空，不显示任何数值
   页面不写死任何传感器值。
   ===================================================================== */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  statusPill: $('statusPill'), statusText: $('statusText'),
  staleBadge: $('staleBadge'),
  deviceId: $('deviceId'), deviceCheck: $('deviceCheck'),
  offlineBanner: $('offlineBanner'), offlineTitle: $('offlineTitle'), offlineHint: $('offlineHint'),

  imuPanel: $('imuPanel'), imuTag: $('imuTag'), levelDot: $('levelDot'),
  levelCap: $('levelCap'), btnLevelZero: $('btnLevelZero'),

  mDeviceId: $('mDeviceId'), mMac: $('mMac'), mTransport: $('mTransport'),
  boardTime: $('boardTime'), recvTime: $('recvTime'), skew: $('skew'), lastUpdate: $('lastUpdate'),

  chartUnit: $('chartUnit'), chartRange: $('chartRange'), mainChart: $('mainChart'), chartHint: $('chartHint'),
  btnChartAC: $('btnChartAC'), btnChartPause: $('btnChartPause'), btnChartSmooth: $('btnChartSmooth'),

  portSelect: $('portSelect'), baudSelect: $('baudSelect'),
  btnConnect: $('btnConnect'), btnDisconnect: $('btnDisconnect'), btnRefresh: $('btnRefresh'),
  chkAuto: $('chkAuto'),
  rawLog: $('rawLog'), btnClearLog: $('btnClearLog'),
  btnDiag: $('btnDiag'), diagOut: $('diagOut'),
  btnProbe: $('btnProbe'), btnRecord: $('btnRecord'),

  deviceSelect: $('deviceSelect'), limitSelect: $('limitSelect'),
  btnQuery: $('btnQuery'), btnCsv: $('btnCsv'), recordsTable: $('recordsTable'),

  // 远程采集（第 2 周）
  collectMode: $('collectMode'), collectChannel: $('collectChannel'),
  collectReqId: $('collectReqId'), collectSteps: $('collectSteps'),
  collectNote: $('collectNote'), collectObs: $('collectObs'), collectSim: $('collectSim'),
  btnCollect: $('btnCollect'), btnReportToggle: $('btnReportToggle'),

  // 教学求助（第 3 周）
  helpBadge: $('helpBadge'), helpTag: $('helpTag'), helpAlert: $('helpAlert'),
  helpTitle: $('helpTitle'), helpDesc: $('helpDesc'),
  btnHelpAck: $('btnHelpAck'), btnHelpCancel: $('btnHelpCancel'), btnHelpReset: $('btnHelpReset'),
  camView: $('camView'), camPlaceholder: $('camPlaceholder'), camTag: $('camTag'),
  camStats: $('camStats'), camNote: $('camNote'),
  btnCamStart: $('btnCamStart'), btnCamStop: $('btnCamStop'), btnCamShot: $('btnCamShot'),
  camShot: $('camShot'), camShotTag: $('camShotTag'), camShotPlaceholder: $('camShotPlaceholder'),
  camShotDownload: $('camShotDownload'), camShotInfo: $('camShotInfo'),
  helpChannel: $('helpChannel'), helpId: $('helpId'), helpSteps: $('helpSteps'),
  helpNote: $('helpNote'), helpEvidence: $('helpEvidence'),
  helpHistory: $('helpHistory'), helpHistoryCount: $('helpHistoryCount'),

  // 自然语言助手（第 4 周）
  nlEngine: $('nlEngine'), nlCap: $('nlCap'), nlChat: $('nlChat'),
  nlForm: $('nlForm'), nlInput: $('nlInput'), nlSend: $('nlSend'),

  // 云端大模型自定义配置
  llmStatusTag: $('llmStatusTag'), llmSavedInfo: $('llmSavedInfo'),
  llmForm: $('llmForm'), llmEndpoint: $('llmEndpoint'), llmApiKey: $('llmApiKey'),
  llmModel: $('llmModel'), llmTimeout: $('llmTimeout'), llmReplyMode: $('llmReplyMode'),
  btnLlmTest: $('btnLlmTest'), btnLlmSave: $('btnLlmSave'), btnLlmDelete: $('btnLlmDelete'),
  btnLlmModels: $('btnLlmModels'), llmModels: $('llmModels'),
  llmMsg: $('llmMsg'),

  // 主题切换（浅色 / 深色）
  btnTheme: $('btnTheme'),
};

// ---------------------------------------------------------------- 状态
const S = {
  page: 'live',
  connected: false,
  live: false,
  stale: false,
  portOpen: false,
  wifiDownlink: false,   // 板端正通过 WiFi 轮询取命令（拔掉 USB 也能下发）
  downlinkKind: null,    // 'serial' | 'wifi' | null
  transport: null,
  device: null,
  deviceId: null,
  deviceMac: null,
  deviceVerified: null,
  expectedDeviceId: null,
  lastDataAt: null,
  boardTs: null,
  boardIso: null,
  seq: null,
  meta: { units: {}, labels: {}, historyMax: 600 },
  history: new Map(),   // field -> [{t, v}]
  order: [],            // 字段出现顺序
};

let ws = null;
let needDraw = true;
let recording = false;

// ---------------------------------------------------------------- 工具
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const pad = (n, w) => String(n).padStart(w, '0');
function fmtFull(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}
function fmtNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 100000)) return v.toExponential(2);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(a < 10 ? 2 : a < 100 ? 1 : 0);
}

/* 坐标轴刻度格式化：按量程选小数位，避免出现 1.76e-3 / 1.13e-5 这类
 * 科学计数法（刻度看着像坏了），同时把 -0.00 归一成 0.00 */
function fmtAxis(v, span) {
  if (!Number.isFinite(v)) return '';
  const s = Math.abs(span);
  const d = s >= 10 ? 0 : s >= 1 ? 1 : s >= 0.1 ? 2 : s >= 0.01 ? 3 : 4;
  let out = v.toFixed(d);
  if (/^-0(\.0+)?$/.test(out)) out = out.slice(1);
  return out;
}
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 注意：服务端仍在每次推送里下发 meta.units / meta.labels（来自 config.json 的
// fieldUnits / fieldLabels，见 server.js 的 /api/state 与 WS hello），但本前端目前
// 没有消费它们 —— 传感器名走下面的 IMU_RE + AXIS_LABEL 静态映射，CSV 列名走
// config.sensorFields。原先的 labelOf() / unitOf() 两个辅助函数已删除（审计发现从未
// 被调用）。这里留注释说明协议字段仍然存在，以免误以为可以连服务端一起删。

// ---------------------------------------------------------------- 三轴加速度面板
const IMU_RE = /^acc_([xyz])_(raw|g|ms2)$/;
const AXIS_LABEL = { x: 'X 轴', y: 'Y 轴', z: 'Z 轴' };

// 水平归零基准：记录"板子平放"时的 X/Y 读数，之后圆点按相对值绘制。
// 传感器零偏或摆放倾斜都能靠一次归零校正，不影响上报的原始数值。
let LEVEL_ZERO = (() => {
  try {
    const v = JSON.parse(localStorage.getItem('levelZero') || 'null');
    return (v && Number.isFinite(v.x) && Number.isFinite(v.y)) ? v : null;
  } catch { return null; }
})();

function updateLevelCap() {
  if (els.levelCap) {
    els.levelCap.textContent = LEVEL_ZERO
      ? `相对水平面（已归零 X₀=${LEVEL_ZERO.x.toFixed(2)} Y₀=${LEVEL_ZERO.y.toFixed(2)}）`
      : '重力方向（水平放置时居中）';
  }
  if (els.btnLevelZero) els.btnLevelZero.textContent = LEVEL_ZERO ? '清除归零' : '水平归零';
}

function setLevelZero(z) {
  LEVEL_ZERO = z;
  try {
    if (z) localStorage.setItem('levelZero', JSON.stringify(z));
    else localStorage.removeItem('levelZero');
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  updateLevelCap();
  needDraw = true;
}

/* 三轴面板的 DOM 节点缓存。
 *
 * 性能要点：原实现每收到一帧就 `els.imuPanel.innerHTML = col('x')+col('y')+col('z')`，
 * 即每秒重建约 10 次、每次 ~15 个节点 —— 浏览器必须重新解析 HTML 并重排整块面板。
 * 在 10Hz 上报下这会持续抢占主线程，表现为页面"卡顿"。
 * 改为：结构只建一次，之后仅更新文本与进度条宽度（不触发重排）。 */
let imuNodes = null;

function buildImuPanel() {
  els.imuPanel.innerHTML = '';
  const mk = (axis) => {
    const d = document.createElement('div');
    d.className = 'axis ' + axis;
    d.innerHTML =
      '<div class="axis-top">' +
        '<span class="axis-name ' + axis + '">' + AXIS_LABEL[axis] + '</span>' +
        '<span class="axis-ms2">— m/s²</span>' +
      '</div>' +
      '<div class="axis-g"><b>—</b><span class="u">g</span></div>' +
      '<div class="axis-bar"><i></i></div>';
    els.imuPanel.appendChild(d);
    return {
      ms2: d.querySelector('.axis-ms2'),
      g:   d.querySelector('.axis-g b'),
      bar: d.querySelector('.axis-bar i'),
    };
  };
  imuNodes = { x: mk('x'), y: mk('y'), z: mk('z') };
}

function imuEmpty(msg) {
  els.imuPanel.classList.remove('stale');
  imuNodes = null;                       // 结构已被替换，缓存失效
  els.imuPanel.innerHTML = `<div class="imu-empty">${escHtml(msg)}</div>`;
}

function renderImu(fields) {
  const axes = { x: {}, y: {}, z: {} };
  let has = false;
  for (const [k, v] of Object.entries(fields)) {
    const m = IMU_RE.exec(k);
    if (!m) continue;
    has = true;
    axes[m[1]][m[2]] = v;
  }
  if (!has) {
    imuEmpty('等待设备上报 acc_*_g / acc_*_ms2 真实数据…');
    els.imuTag.textContent = '等待板端上报';
    els.imuTag.className = 'tag';
    els.levelDot.style.left = '50%';
    els.levelDot.style.top = '50%';
    return;
  }

  if (!imuNodes) buildImuPanel();        // 首次有数据时建结构

  for (const axis of ['x', 'y', 'z']) {
    const a = axes[axis];
    const g = a.g != null ? a.g : null;
    const ms2 = a.ms2 != null ? a.ms2 : null;
    const n = imuNodes[axis];
    // 只在文本真的变了才写 DOM（避免无意义的重排）
    const ms2Text = ms2 != null ? fmtNum(ms2) + ' m/s²' : '— m/s²';
    if (n.ms2.textContent !== ms2Text) n.ms2.textContent = ms2Text;
    const gText = g != null ? fmtNum(g) : '—';
    if (n.g.textContent !== gText) n.g.textContent = gText;
    // 进度条：以 ±2g 为满量程，中心线为 0
    let barStyle = 'left:50%;width:0';
    if (g != null) {
      const w = clamp(Math.abs(g) / 2, 0, 1) * 50;
      barStyle = g >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
    }
    if (n.bar.style.cssText !== barStyle) n.bar.style.cssText = barStyle;
  }

  els.imuPanel.classList.toggle('stale', !S.live);
  const tagText = S.live ? '实时' : '停采保留';
  if (els.imuTag.textContent !== tagText) els.imuTag.textContent = tagText;
  const tagCls = 'tag' + (S.live ? ' tag-ok' : ' tag-warn');
  if (els.imuTag.className !== tagCls) els.imuTag.className = tagCls;

  // 重力方向指示：静止水平时居中；倾斜时圆点偏向重力在 XY 平面的投影方向。
  // 若已「水平归零」，则按相对基准的差值绘制。
  const ax = axes.x.g, ay = axes.y.g;
  if (ax != null && ay != null && Number.isFinite(ax) && Number.isFinite(ay)) {
    S.lastAx = ax; S.lastAy = ay;
    const zx = LEVEL_ZERO ? LEVEL_ZERO.x : 0;
    const zy = LEVEL_ZERO ? LEVEL_ZERO.y : 0;
    const R = 38;
    els.levelDot.style.left = clamp(50 - (ax - zx) * R, 10, 90) + '%';
    els.levelDot.style.top = clamp(50 - (ay - zy) * R, 10, 90) + '%';
  }
}

// ---------------------------------------------------------------- 状态渲染
function renderStatus() {
  const pill = els.statusPill;
  pill.classList.remove('pill-on', 'pill-off', 'pill-warn');

  if (!S.connected && !S.portOpen) {
    pill.classList.add('pill-off');
    els.statusText.textContent = '未检测到开发板';
    els.staleBadge.classList.add('hidden');
    els.offlineBanner.classList.remove('hidden');
    els.offlineTitle.textContent = '未检测到 ESP32 开发板';
    els.offlineHint.textContent = '设备拔出或离线时，此处不会显示任何数值。请连接开发板（USB 供电/调试），并确保已烧录上报程序。';
  } else if (!S.live && !S.lastDataAt) {
    pill.classList.add('pill-warn');
    els.statusText.textContent = '已连接 · 等待数据';
    els.staleBadge.classList.add('hidden');
    els.offlineBanner.classList.remove('hidden');
    els.offlineTitle.textContent = '已连接，但尚未收到数据';
    els.offlineHint.textContent = '开发板已连接但还没有上报任何一帧数据。请确认固件正在运行，且 WiFi 能访问本机服务地址。';
  } else if (!S.live) {
    // 停采保留：旧值与旧时间保留，提示「未更新」
    pill.classList.add('pill-warn');
    els.statusText.textContent = '已停采 · 保留末次数据';
    els.staleBadge.classList.remove('hidden');
    els.offlineBanner.classList.add('hidden');
  } else {
    pill.classList.add('pill-on');
    els.statusText.textContent = S.transport === 'wifi' ? '已连接 · WiFi 上报' : '已连接 · 串口';
    els.staleBadge.classList.add('hidden');
    els.offlineBanner.classList.add('hidden');
  }

  els.deviceId.textContent = S.deviceId || '—';
  renderDeviceCheck();

  els.mDeviceId.textContent = S.deviceId || '—';
  els.mMac.textContent = S.deviceMac || '—';
  els.mTransport.textContent = S.transport === 'wifi' ? 'WiFi（独立网络上传）'
    : S.transport === 'serial' ? 'USB 串口（调试通道）' : '—';

  els.boardTime.textContent = S.boardIso
    ? S.boardIso.replace('T', ' ').replace('Z', ' UTC')
    : (S.boardTs ? fmtFull(S.boardTs) : '—');
  els.recvTime.textContent = S.lastDataAt ? fmtFull(S.lastDataAt) : '—';

  if (S.lastDataAt && S.boardTs) {
    const sk = Math.round(S.lastDataAt - S.boardTs);
    els.skew.textContent = `${sk >= 0 ? '+' : ''}${sk} ms`;
    els.skew.style.color = Math.abs(sk) < 2000 ? 'var(--ok)' : 'var(--warn)';
  } else {
    els.skew.textContent = '—';
    els.skew.style.color = '';
  }

  if (S.lastDataAt) {
    const ago = ((Date.now() - S.lastDataAt) / 1000).toFixed(1);
    els.lastUpdate.textContent = `${fmtFull(S.lastDataAt)}（${ago}s 前）`;
  } else {
    els.lastUpdate.textContent = '—';
  }

  els.btnDisconnect.disabled = !S.connected && !S.portOpen;
}

// 每秒刷新「XX 秒前」
setInterval(() => { if (S.lastDataAt) renderStatus(); }, 1000);

// 本组设备身份校验徽章
function renderDeviceCheck() {
  const el = els.deviceCheck;
  if (!el) return;
  if (!S.expectedDeviceId) {
    el.className = 'badge-dev neutral';
    el.textContent = '未设本组标识';
    return;
  }
  if (S.deviceVerified === true) {
    el.className = 'badge-dev ok';
    el.textContent = '✓ 本组设备';
  } else if (S.deviceVerified === false) {
    el.className = 'badge-dev bad';
    el.textContent = '⚠ 非本组';
  } else {
    el.className = 'badge-dev neutral';
    el.textContent = '—';
  }
}

// ---------------------------------------------------------------- 清空
function clearAllData() {
  S.history.clear();
  S.order = [];
  imuEmpty('等待设备上报 acc_*_g / acc_*_ms2 真实数据…');
  els.imuTag.textContent = '等待板端上报';
  els.imuTag.className = 'tag';
  els.levelDot.style.left = '50%';
  els.levelDot.style.top = '50%';
  els.chartHint.textContent = '三轴加速度实时曲线（X 红 / Y 绿 / Z 蓝），窗口 10 秒。点「去直流」可把三条曲线叠到同一水平线，便于对比波形。数据由本组设备实时上报，页面未写死任何值。';
  needDraw = true;
}

// ---------------------------------------------------------------- 采样入库 + 渲染
function renderSample(fields, ts) {
  renderImu(fields);

  // 暂停时冻结波形：不再往历史缓冲追加，曲线停在当前画面（其他面板照常实时）
  if (CHART_PAUSED) return;

  // 用服务端采样时刻作横轴（比浏览器接收时刻稳），无则退回本地时间
  const t = Number.isFinite(ts) ? ts : Date.now();
  noteArrival();   // 记录到达节奏（用于"等待设备上报"提示与平滑播放说明）
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (!S.history.has(k)) S.history.set(k, []);
    const arr = S.history.get(k);
    arr.push({ t, v });
    const max = S.meta.historyMax || 600;
    if (arr.length > max) arr.splice(0, arr.length - max);
    if (!S.order.includes(k)) S.order.push(k);
  }

  needDraw = true;
}

// ---------------------------------------------------------------- 绘图
/* 画布尺寸缓存。
 *
 * 性能要点：getBoundingClientRect() 会强制浏览器立即完成一次同步布局
 * （forced synchronous layout）。图表每重绘一次就调用一次，8~10Hz 下等于
 * 每秒额外触发十几次全页重排 —— 这是实时页卡顿的第三个来源。
 * 画布尺寸只在「窗口缩放」和「页面切换」（隐藏时尺寸为 0）时才会变，
 * 因此缓存测量结果，仅在这两个时机失效重测。 */
const _rectCache = new WeakMap();
let _rectEpoch = 0;
function invalidateCanvasRects() { _rectEpoch++; }

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  let c = _rectCache.get(canvas);
  if (!c || c.epoch !== _rectEpoch) {
    const rect = canvas.getBoundingClientRect();
    c = { epoch: _rectEpoch, w: rect.width, h: rect.height };
    _rectCache.set(canvas, c);
  }
  const w = Math.max(1, Math.round(c.w || canvas.clientWidth || 300));
  const h = Math.max(1, Math.round(c.h || canvas.clientHeight || 200));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// 三轴曲线颜色（红/绿/蓝，与卡片图例一致）——仅作兜底，实际取 CSS 变量（见 chartTheme）
const AXIS_COLOR = { x: '#e24b4a', y: '#639922', z: '#378add' };

// ---------------------------------------------------------------- 主题（浅色 / 深色）
/* 主题由 <html data-theme="light|dark"> 控制；没设置时跟随系统 prefers-color-scheme
 * （CSS 侧用 :root:not([data-theme]) + prefers-color-scheme 实现，见 style.css）。
 *
 * canvas 是 JS 画出来的，拿不到 CSS 变量，所以这里把图表配色从 CSS 变量里读出来缓存；
 * 主题一变就清缓存 + 置 needDraw，下一帧立即用新配色重画。
 */
const THEME_KEY = 'imu-theme';
let _chartTheme = null;

function chartTheme() {
  if (_chartTheme) return _chartTheme;
  const cs = getComputedStyle(document.documentElement);
  const g = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  _chartTheme = {
    grid: g('--chart-grid', '#eef1f6'),
    gridStrong: g('--chart-grid-strong', '#d8dfe9'),
    gridV: g('--chart-grid-v', '#f4f7fb'),
    label: g('--chart-label', '#8a94a6'),
    muted: g('--chart-muted', '#9aa5b5'),
    dotRing: g('--chart-dot-ring', '#ffffff'),
    waitBand: g('--chart-wait-band', 'rgba(255,176,32,0.07)'),
    waitText: g('--chart-wait-text', '#b8860b'),
    axis: {
      x: g('--chart-axis-x', AXIS_COLOR.x),
      y: g('--chart-axis-y', AXIS_COLOR.y),
      z: g('--chart-axis-z', AXIS_COLOR.z),
    },
  };
  return _chartTheme;
}

function currentTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

function applyTheme(theme, persist) {
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch { /* 隐私模式下写不进，忽略 */ } }
  _chartTheme = null;   // 配色缓存失效，下一帧按新主题重取
  needDraw = true;      // 立即用新配色重画曲线
  if (els.btnTheme) els.btnTheme.setAttribute('aria-pressed', String(theme === 'dark'));
}

if (els.btnTheme) {
  els.btnTheme.onclick = () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
}
// 用户没手动选过时，系统主题一变要跟着走（选过就以选择为准）
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSysChange = () => {
    try { if (!localStorage.getItem(THEME_KEY)) { _chartTheme = null; needDraw = true; } } catch { /* noop */ }
  };
  if (mq.addEventListener) mq.addEventListener('change', onSysChange);
  else if (mq.addListener) mq.addListener(onSysChange);
}

// 「去直流」模式：减去各轴窗口均值，三条曲线叠在同一水平线上，
// 便于像示波器那样对比三轴波形（绝对值仍在卡片左上角照常显示）。默认开启。
let CHART_AC = true;
// 波形暂停：冻结曲线（停止往历史缓冲里追加），其他面板继续实时刷新
let CHART_PAUSED = false;

/* 平滑播放（抗抖动缓冲）。
 *
 * 成因：板端每帧「同步 HTTP POST + printf」，偶发上传失败会重试，导致数据到达间隔
 * 从中位 ~0.5s 抖动到 1.5~4s（实测 p95=1.5s、最大 4.2s）。曲线右端只能在"有数据的时刻"
 * 前进，于是表现为「匀速流动 → 停住几秒 → 突然跳一段」，主观上像帧率下降。
 * 渲染本身没问题（受控长跑 60fps、0 长任务），所以修法不是"画得更快"，而是把不规则到达
 * 变成匀速播放：整幅曲线统一延后 CHART_DELAY_MS 绘制，落在缓冲里的点按时间轴匀速出场，
 * 空档 ≤ 延时即被完全吸收。
 * 取舍：曲线比真实时刻晚约 2 秒 —— 因此右端刻度不再写"现在"而是"-2s"如实标注；
 * 数据点位置、坐标刻度、时间轴同步关系都不变。默认关闭，用户可自行开启。 */
const CHART_DELAY_KEY = 'imu-smooth-delay';
const CHART_DELAY_MAX_MS = 2000;
let CHART_DELAY_MS = 0;

/* 数据到达节奏（用于判断"是不是在等设备上报"，只做展示用统计，不参与数据计算） */
const ARRIVAL_KEEP = 24;
const arrivalIntervals = [];
let lastArrivalAt = 0;
let newestPointAt = 0;      // 最新一个数据点入库的时刻（用于新点淡入）
function noteArrival() {
  const now = Date.now();
  if (lastArrivalAt) {
    arrivalIntervals.push(now - lastArrivalAt);
    if (arrivalIntervals.length > ARRIVAL_KEEP) arrivalIntervals.shift();
  }
  lastArrivalAt = now;
  newestPointAt = now;
}
/* 中位到达间隔：比均值更抗偶发空档的影响，用来定"多久没数据算异常" */
function medianArrivalMs() {
  if (!arrivalIntervals.length) return 0;
  const s = [...arrivalIntervals].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
// 去直流基准 / 量程的平滑跟随状态。窗口每滑动一帧，中位数与分位数都会小幅跳变，
// 直接拿来定标会让整幅画面抖动，这里做慢速跟随（指数平滑）。
const DC_REF = {};
const RANGE_SMOOTH = {};
/* 每帧复用的临时缓冲：量程分位计算不再每帧新建数组（避免 60 次/秒的分配与 GC 压力） */
const RANGE_BUF = [];

/* 图表数据缓存：三轴平滑序列（滑动平均 + 去直流基准）只在「有新数据 / 切开关」时重算；
 * 绘制本身每帧都做（60fps）。
 * 拆分原因：老实现"数据来一帧才画一帧"（≈1.75 次/秒），每次还按数据点整窗重映射，
 * 曲线是"一帧一帧跳"；改成"连续时间窗口 + 每帧重绘"后平滑滚动。 */
let _chartCache = { key: null, series: null };
let _chartBuildTs = 0;                 // 上次重建序列的时刻（批量更新限速用）
const CHART_REBUILD_MS = 100;          // 序列重建最小间隔

function _chartKey() {
  const suffix = els.chartUnit && els.chartUnit.value === 'ms2' ? 'ms2' : 'g';
  const arr = S.history.get('acc_x_' + suffix) || [];
  const lastT = arr.length ? arr[arr.length - 1].t : 0;
  return [lastT, suffix, CHART_AC ? 1 : 0].join('|');
}

/* 构建三轴平滑序列（滑动平均 + 去直流基准慢速跟随）。
 * 先对「整段历史」做 9 点滑动平均再截取窗口 —— 若只对窗口内数据做因果滑动平均，
 * 窗口最左侧（最旧）的点会因为之前的样本已移出窗口而平滑不足，噪声裸露、幅度看着变大。
 * 600 点滑动平均 + 排序相对贵，不能每帧做，只在有新数据时重算。 */
function buildChartCache() {
  const unit = els.chartUnit ? els.chartUnit.value : 'g';
  const suffix = unit === 'ms2' ? 'ms2' : 'g';
  const series = ['x', 'y', 'z'].map((ax) => {
    const full = S.history.get('acc_' + ax + '_' + suffix) || [];
    const smFull = smooth(full.map((p) => p.v), 9);
    if (CHART_AC && smFull.length) {
      // 用中位数作直流基准（比均值稳）；再做慢速跟随，
      // 否则窗口滑动时中位数跳变会让整条曲线上下抖
      const sorted = [...smFull].sort((a, b) => a - b);
      const raw = sorted[Math.floor(sorted.length / 2)];
      const key = ax + '_' + suffix;
      const prev = DC_REF[key];
      const ref = prev == null ? raw : prev + 0.12 * (raw - prev);
      DC_REF[key] = ref;
      for (let i = 0; i < smFull.length; i++) smFull[i] -= ref;
    }
    const start = Math.max(0, full.length - 300);
    const pts = [];
    for (let i = start; i < full.length; i++) pts.push({ t: full[i].t, v: smFull[i] });
    return { ax, n: full.length, lastAbs: full.length ? full[full.length - 1].v : 0, pts };
  }).filter((s) => s.pts.length >= 2);
  _chartCache = { key: _chartKey(), series };
}

const CHART_WINDOW_MS = 10000;   // 显示窗口固定为最近 10 秒（与老师示波器 -9s~0s 一致）

/* 二分查找：首个 t >= target 的索引（O(log n)），替代每帧 filter 全量扫描 + 新数组分配 */
function lowerBoundByTime(pts, target) {
  let lo = 0, hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* 抽稀缓冲（复用，避免每帧分配）。仅在点数远多于像素列时启用。 */
const DEC_BUF = [];

/* 按像素列抽稀：每列保留该列的最小值与最大值（按时间先后输出），
   既减少绘制点数，又不会丢掉尖峰与包络。返回索引数组（复用缓冲）。 */
function decimateIdx(pts, lo, cnt, cw, X) {
  DEC_BUF.length = 0;
  let col = -1, iMin = -1, iMax = -1;
  const flush = () => {
    if (iMin < 0) return;
    if (iMax === iMin) DEC_BUF.push(iMin);
    else if (iMin < iMax) { DEC_BUF.push(iMin); DEC_BUF.push(iMax); }
    else { DEC_BUF.push(iMax); DEC_BUF.push(iMin); }
  };
  for (let k = 0; k < cnt; k++) {
    const i = lo + k;
    const cc = Math.round(X(pts[i].t));
    if (cc !== col) {
      flush();
      col = cc; iMin = i; iMax = i;
    } else {
      if (pts[i].v < pts[iMin].v) iMin = i;
      if (pts[i].v > pts[iMax].v) iMax = i;
    }
  }
  flush();
  return DEC_BUF;
}

function drawMainChart() {
  const unit = els.chartUnit ? els.chartUnit.value : 'g';
  const suffix = unit === 'ms2' ? 'ms2' : 'g';
  /* 批量更新：序列重建（600 点滑动平均 + 去直流中位数）最多每 100ms 一次。
     数据突发（如回放/高帧率上报）时不再每个样本都重建一遍；限速期间沿用上一帧序列，
     窗口仍在连续滚动，视觉无差异（最多滞后 100ms 的新点）。 */
  if (!_chartCache.series || _chartCache.key !== _chartKey()) {
    const tn = Date.now();
    if (!_chartCache.series || tn - _chartBuildTs >= CHART_REBUILD_MS) {
      buildChartCache();
      _chartBuildTs = tn;
    }
  }
  const { series } = _chartCache;
  const C = chartTheme();   // 画布配色：跟随当前主题（浅色 / 深色）
  const { ctx, w, h } = fitCanvas(els.mainChart);
  ctx.clearRect(0, 0, w, h);

  if (!series.length) {
    ctx.fillStyle = C.muted;
    ctx.font = '13px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(S.connected ? '等待设备数据…' : '设备未连接，无曲线', w / 2, h / 2);
    return;
  }

  const padL = 58, padR = 14, padT = 18, padB = 26;
  const cw = w - padL - padR, ch = h - padT - padB;

  /* X 轴：固定为「最近 10 秒」连续时间窗口，不随数据点重映射。
   * 数据点按自身采样时刻落到对应横坐标，窗口随时间平滑左移 → 曲线连续滚动。
   * 开启平滑播放时整幅曲线统一延后 CHART_DELAY_MS：落在缓冲里的点按时间轴匀速出场，
   * 从而吸收设备偶发的上报空档（位置仍是真实时刻，只是"播放进度"稍晚）。 */
  const latestT = series[0].pts.length ? series[0].pts[series[0].pts.length - 1].t : 0;
  const nowReal = Date.now();
  const now = CHART_PAUSED ? latestT : (nowReal - CHART_DELAY_MS);   // 暂停时窗口冻结在最新数据时刻
  const tStart = now - CHART_WINDOW_MS;

  // Y 轴量程：默认「自动」（2%~98% 分位定标 + 慢速跟随）；可锁定固定档位。
  // 只用窗口内的点定标，每帧重算（~50 点排序很便宜），指数平滑保证量程不抖。
  const rangeSel = els.chartRange ? els.chartRange.value : 'auto';
  let min, max;
  if (rangeSel !== 'auto') {
    const half = Number(rangeSel) * (unit === 'ms2' ? 9.80665 : 1);
    min = -half; max = half;
  } else {
    // 复用同一个缓冲数组（每帧 new Array 会产生 60 次/秒的垃圾）
    const vals = RANGE_BUF;
    vals.length = 0;
    for (const s of series) for (const p of s.pts) if (p.t >= tStart) vals.push(p.v);
    vals.sort((a, b) => a - b);
    const pick = (f) => vals.length ? vals[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * f)))] : 0;
    min = pick(0.02); max = pick(0.98);
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = -1; max = 1; }
    if (min === max) { const d = Math.abs(min) * 0.05 || 1; min -= d; max += d; }
    const pd = (max - min) * 0.15;
    min -= pd; max += pd;
    // 最小跨度 0.8g：静止时噪声只占约 2.5%（画面很稳），
    // 轻微晃动约 25%（可见但不过度），剧烈晃动仍会自动扩量程撑满。
    const minSpan = unit === 'ms2' ? 8 : 0.8;
    if (max - min < minSpan) { const mid = (min + max) / 2; min = mid - minSpan / 2; max = mid + minSpan / 2; }
    // 量程慢速跟随：窗口滑动时 2%~98% 分位会小幅跳变，
    // 直接定标会让整幅画面抖动，这里做指数平滑跟随。
    const rk = 'r_' + suffix + (CHART_AC ? '_ac' : '');
    const pr = RANGE_SMOOTH[rk];
    if (pr) { min = pr.min + 0.2 * (min - pr.min); max = pr.max + 0.2 * (max - pr.max); }
    RANGE_SMOOTH[rk] = { min, max };
  }

  const X = (t) => padL + ((t - tStart) / CHART_WINDOW_MS) * cw;
  const Y = (v) => padT + ch - ((v - min) / (max - min)) * ch;

  ctx.font = '11px Consolas, monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    const y = Y(v);
    ctx.strokeStyle = i === 0 ? C.gridStrong : C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = C.label;
    ctx.fillText(fmtAxis(v, max - min), padL - 8, y);
  }

  // X 轴：-10s … 现在（绝对时间，随窗口滚动），与老师示波器的 -9s~0s 一致
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i = 0; i <= 5; i++) {
    const t = tStart + (CHART_WINDOW_MS * i) / 5;
    const x = X(t);
    if (i > 0 && i < 5) {
      ctx.strokeStyle = C.gridV; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
    }
    const secs = Math.round((nowReal - t) / 1000);
    ctx.fillStyle = C.label;
    ctx.fillText(secs <= 0 ? '现在' : `-${secs}s`, x, padT + ch + 7);
  }

  // 三条曲线（各自颜色）——用二次贝塞尔画平滑曲线（穿过相邻点中点），
  // 比直线段折线视觉上更柔顺，接近示波器观感。
  // 只画窗口内的点；左边缘多留 300ms，让曲线出画时不生硬截断。
  //
  // 性能：不再每帧对三轴各做一次 filter（3 个新数组/帧 → 每秒约 180 次分配），
  // 改用「二分定位窗口起点 + 按索引遍历」；点数远多于像素列时才按列抽稀。
  const tMin = tStart - 300;
  for (const s of series) {
    const c = C.axis[s.ax];
    const pts = s.pts;
    const lo = lowerBoundByTime(pts, tMin);      // 窗口起点索引（O(log n)）
    const cnt = pts.length - lo;
    if (cnt < 2) continue;
    // 抽稀：每个像素列最多保留 2 个点（该列的最小/最大值，按时间顺序），
    // 保证视觉包络与峰值不丢。当前数据率（约 2 帧/秒、窗口约 25 点）远低于阈值，不会触发。
    const list = (cnt > cw * 2) ? decimateIdx(pts, lo, cnt, cw, X) : null;
    const n = list ? list.length : cnt;
    const at = (k) => (list ? pts[list[k]] : pts[lo + k]);
    ctx.beginPath();
    ctx.moveTo(X(at(0).t), Y(at(0).v));
    if (n === 2) {
      ctx.lineTo(X(at(1).t), Y(at(1).v));
    } else {
      for (let i = 1; i < n - 1; i++) {
        const cx = X(at(i).t), cy = Y(at(i).v);
        const nx = X(at(i + 1).t), ny = Y(at(i + 1).v);
        ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
      }
      ctx.lineTo(X(at(n - 1).t), Y(at(n - 1).v));
    }
    ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
    const last = at(n - 1);
    ctx.beginPath(); ctx.arc(X(last.t), Y(last.v), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = c; ctx.fill();
    ctx.strokeStyle = C.dotRing; ctx.lineWidth = 1.5; ctx.stroke();
  }

  /* 「等待设备上报」可视化。
   * 实测：板端每帧同步上传，偶发重试让数据到达间隔从中位 ~0.5s 抖到 1.5~4s。
   * 空档期曲线右端必然停住 —— 这是"数据还没到"，不是"画面卡了"。
   * 把它如实画出来（淡色等待带 + 虚线 + 真实等待秒数），既解释停顿也便于判断板端状态。
   * 等待带只覆盖"确实没有任何数据到达"的区间，不绘制任何推测值。 */
  if (!CHART_PAUSED && latestT) {
    const waitMs = nowReal - latestT;
    const waitThresh = Math.max(1500, medianArrivalMs() * 2.5);
    const xLast = X(latestT);
    if (waitMs > waitThresh && xLast < w - padR - 20) {
      const bandW = (w - padR) - xLast;
      ctx.fillStyle = C.waitBand;
      ctx.fillRect(xLast, padT, bandW, ch);
      ctx.strokeStyle = C.waitText; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xLast, padT); ctx.lineTo(xLast, padT + ch); ctx.stroke();
      ctx.setLineDash([]);
      if (bandW > 104) {
        ctx.fillStyle = C.waitText;
        ctx.font = '12px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`等待设备上报 ${(waitMs / 1000).toFixed(1)}s`, xLast + bandW / 2, padT + ch / 2);
      }
    }
  }

  // 左上角：三轴当前绝对值读数（去直流模式下仍显示绝对值）+ 采样点数
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = '12px "Microsoft YaHei", sans-serif';
  let lx = padL + 2;
  for (const s of series) {
    const txt = `${s.ax.toUpperCase()} ${fmtNum(s.lastAbs)}`;
    ctx.fillStyle = AXIS_COLOR[s.ax];
    ctx.fillText(txt, lx, 2);
    lx += ctx.measureText(txt).width + 14;
  }
  ctx.fillStyle = CHART_PAUSED ? C.axis.x : C.muted;
  const smoothTag = CHART_DELAY_MS > 0 ? ` · 平滑播放 -${Math.round(CHART_DELAY_MS / 1000)}s` : '';
  ctx.fillText(`· 最近 ${series[0].pts.length} 点${CHART_AC ? ' · 去直流' : ''}${CHART_PAUSED ? ' · 已暂停' : ''}${smoothTag}`, lx, 2);
}

/* 滑动平均：仅用历史值（因果滤波），窗口=n 点时噪声幅度降低约 √n 倍 */
function smooth(data, n) {
  const out = new Array(data.length);
  let sum = 0, cnt = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i]; cnt++;
    if (i >= n) { sum -= data[i - n]; cnt--; }
    out[i] = sum / cnt;
  }
  return out;
}

function frame() {
  // 实时页：每帧重绘（X 轴按当前时间连续滚动，曲线平滑左移）—— 流畅的关键。
  // 暂停时冻结波形：只在需要时（主题切换/窗口缩放）重画，窗口冻结在最新数据时刻。
  // 其他页面画布不可见（尺寸为 0），不绘制。
  if (S.page === 'live') {
    if (CHART_PAUSED) {
      if (needDraw) { needDraw = false; drawMainChart(); }
    } else {
      needDraw = false;
      drawMainChart();
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.addEventListener('resize', () => { needDraw = true; invalidateCanvasRects(); });

// ---------------------------------------------------------------- 远程采集（第 2 周）
// 核心原则：只展示带 request_id 的新观测，绝不拿数据库里的旧值冒充本次结果。
let COLLECT = { current: null, mockDevice: false, reportPaused: false, timeoutMs: 8000 };

const pad2 = (n) => String(n).padStart(2, '0');
function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/* 当前可用的下行通道：串口优先，其次 WiFi 轮询（拔掉 USB 也能下发） */
function downlinkLabel() {
  if (S.portOpen) return 'USB 串口';
  if (S.wifiDownlink) return 'WiFi 轮询';
  return null;
}

function renderCollectMode() {
  if (!els.collectMode) return;
  const kind = downlinkLabel();
  if (COLLECT.mockDevice) {
    els.collectMode.textContent = '模拟模式';
    els.collectMode.className = 'tag tag-sim';
  } else if (kind) {
    els.collectMode.textContent = '命令通道就绪 · ' + kind;
    els.collectMode.className = 'tag tag-ok';
  } else {
    els.collectMode.textContent = '命令通道不可用';
    els.collectMode.className = 'tag tag-warn';
  }
  if (els.btnReportToggle) {
    els.btnReportToggle.textContent = COLLECT.reportPaused ? '恢复周期上报' : '暂停周期上报';
  }
  if (els.collectChannel) {
    if (COLLECT.mockDevice) {
      els.collectChannel.textContent = '⚠ 模拟模式已开启：命令不经过真实串口，回执与观测由服务端自答（仅供联调，不代表实物执行）。';
    } else if (S.portOpen) {
      els.collectChannel.textContent = `命令通道：USB 串口 · 超时阈值 ${COLLECT.timeoutMs} ms`;
    } else if (S.wifiDownlink) {
      els.collectChannel.textContent = `命令通道：WiFi 轮询（板端定期来取命令）· 超时阈值 ${COLLECT.timeoutMs} ms —— 已拔掉 USB 也能下发。`;
    } else {
      els.collectChannel.textContent = '命令通道不可用：串口未打开，且开发板未通过 WiFi 来取命令。请连接设备，或检查固件的 WiFi 凭据。';
    }
  }
}

function renderCollect(req) {
  if (!els.collectSteps) return;
  if (!req) {
    els.collectReqId.textContent = '—';
    els.collectSteps.innerHTML = '';
    els.collectNote.textContent = '';
    els.collectObs.innerHTML = '<div class="obs-empty">尚未发起采集请求。</div>';
    els.collectSim.classList.add('hidden');
    return;
  }
  COLLECT.current = req;
  els.collectReqId.textContent = req.request_id;
  els.collectSim.classList.toggle('hidden', !req.simulated);

  const row = (label, ts, cls, extra) =>
    `<li class="${cls}"><span class="st-time">${ts ? fmtClock(ts) : ''}</span>${escHtml(label)}${extra ? ' · ' + escHtml(extra) : ''}</li>`;

  const rows = [];
  rows.push(row('已提交请求', req.created_at, 'done'));
  rows.push(row('已下发到设备', req.dispatched_at, req.dispatched_at ? 'done' : (req.status === 'failed' ? 'fail' : ''), req.error || ''));
  rows.push(row('设备已接收（回执）', req.acked_at, req.acked_at ? 'done' : '', req.ack_status ? 'ack=' + req.ack_status : ''));
  if (req.status === 'completed') rows.push(row('完成 · 收到本次新观测', req.completed_at, 'done'));
  else if (req.status === 'timeout') rows.push(row('超时 · 未收到新观测', req.timeout_at, 'fail'));
  else if (req.status === 'failed') rows.push(row('失败', req.created_at, 'fail'));
  else rows.push(row('等待本次新观测…', null, 'active'));

  els.collectSteps.innerHTML = rows.join('');
  els.collectNote.textContent = req.note || '';

  const o = req.observation;
  if (!o) {
    els.collectObs.innerHTML = (req.status === 'timeout' || req.status === 'failed')
      ? '<div class="obs-empty">本次<b>没有</b>收到新观测 —— 不会用数据库里的旧值代替。</div>'
      : '<div class="obs-empty">尚未收到本次新观测…</div>';
    return;
  }
  const f = o.fields || {};
  const num = (v) => (typeof v === 'number' ? v.toFixed(3) : (v == null ? '—' : v));
  const ck = o.checks || {};
  const mk = (label, key) => ck[key] === true
    ? `<span class="obs-check ok">✓ ${label}</span>`
    : ck[key] === false ? `<span class="obs-check no">✗ ${label}</span>` : '';
  els.collectObs.innerHTML = `
    <div class="obs-grid">
      <div class="obs-item"><div class="k">X 轴</div><div class="v">${num(f.acc_x_g)} g</div></div>
      <div class="obs-item"><div class="k">Y 轴</div><div class="v">${num(f.acc_y_g)} g</div></div>
      <div class="obs-item"><div class="k">Z 轴</div><div class="v">${num(f.acc_z_g)} g</div></div>
    </div>
    <div class="obs-meta">
      观测到达：<code>${fmtClock(o.recv_ts)}</code>　板端序号：<code>${o.seq == null ? '—' : o.seq}</code>　request_id：<code>${escHtml(req.request_id)}</code><br>
      ${mk('到达晚于下发', 'arrived_after_dispatch')}
      ${mk('序号递增（确为新采样）', 'seq_increased')}
      ${req.simulated ? '<span class="obs-check no">⚠ 模拟数据，非实物执行</span>' : ''}
    </div>`;
}

async function doCollect() {
  if (!els.btnCollect) return;
  els.btnCollect.disabled = true;
  els.btnCollect.textContent = '下发中…';
  try {
    const j = await (await fetch('/api/collect', { method: 'POST' })).json();
    if (j && j.request) renderCollect(j.request);
  } catch (_) { /* 交给 WS 推送 */ }
  setTimeout(() => {
    els.btnCollect.disabled = false;
    els.btnCollect.textContent = '采集一次最新数据';
  }, 600);
}

async function loadCollect() {
  try {
    const j = await (await fetch('/api/collect')).json();
    COLLECT.mockDevice = !!j.mockDevice;
    COLLECT.timeoutMs = j.timeoutMs || 8000;
    if (j.requests && j.requests.length) renderCollect(j.requests[0]);
    renderCollectMode();
  } catch (_) { /* 忽略 */ }
}

if (els.btnCollect) els.btnCollect.onclick = doCollect;
if (els.btnReportToggle) els.btnReportToggle.onclick = async () => {
  const action = COLLECT.reportPaused ? 'resume' : 'pause';
  els.btnReportToggle.disabled = true;
  try {
    const j = await (await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })).json();
    if (j.ok) COLLECT.reportPaused = !!j.reportPaused;
    else if (j.note) els.collectChannel.textContent = j.note;
  } catch (_) { /* 忽略 */ }
  els.btnReportToggle.disabled = false;
  renderCollectMode();
};

// ---------------------------------------------------------------- 教学求助（第 3 周）
// 原则：网页只显示「服务端确认过」的事实。
//   · 没收到服务端的求助事件 → 一律显示「暂无求助」，绝不凭空显示"对方已收到"
//   · 点「我已收到」后若命令通道不可用 → 明确提示"未送达"，不谎称对方已收到
let HELP = { data: null, channelReady: false };

const HELP_STATUS_TEXT = {
  idle: '暂无求助',
  received: '收到求助 · 等待回应',
  acknowledged: '已回应',
  cancelled: '已取消',
};

function renderHelpChannel() {
  if (!els.helpChannel) return;
  const d = HELP.data || {};
  const kind = HELP.channelReady ? (d.channelKind || (S.portOpen ? 'serial' : null)) : null;
  if (kind === 'serial') {
    els.helpChannel.textContent = '命令通道：USB 串口就绪 —— 回应会真实下发到开发板，板端会回执确认。';
  } else if (kind === 'wifi') {
    els.helpChannel.textContent = '命令通道：WiFi 轮询就绪 —— 回应会被开发板取走并回执确认（无需 USB 线）。';
  } else {
    els.helpChannel.textContent = '⚠ 命令通道不可用（串口未打开，开发板也未通过 WiFi 来取命令）：此时点「我已收到」不会送达开发板，板端不会显示「对方已收到」。';
  }
}

function renderHelp(h) {
  if (!els.helpTag) return;
  HELP.data = h || null;
  const d = h || {};
  const st = d.status || 'idle';

  els.helpTag.textContent = HELP_STATUS_TEXT[st] || '暂无求助';
  els.helpTag.className = 'tag' + (st === 'received' ? ' tag-warn' : st === 'acknowledged' ? ' tag-ok' : '');

  // 导航上的红点：有待回应的求助时提示
  if (els.helpBadge) els.helpBadge.classList.toggle('hidden', st !== 'received');

  // 告警区
  let cls = 'help-alert', icon = '·', title = '当前没有求助';
  let desc = '佩戴者按下开发板上的功能键后，这里会显示求助，并提示你回应。';
  if (st === 'received') {
    cls += ' warn'; icon = '!';
    title = '收到求助 · 请回应';
    desc = '佩戴者已在板端按键，板端 LED 快闪、屏幕显示「求助已发送」。点「我已收到」把回应送回开发板。';
  } else if (st === 'acknowledged') {
    cls += ' ok'; icon = '✓';
    if (d.ack_delivered === true) {
      title = '已回应 · 板端已确认';
      desc = '板端已回执：屏幕已显示「对方已收到」。';
    } else if (d.ack_delivered === false) {
      cls = 'help-alert warn'; icon = '!';
      title = '回应未被板端接受';
      desc = '板端回执：当前没有进行中的求助，未显示「对方已收到」。';
    } else {
      title = '回应已下发 · 等待板端回执';
      desc = '回应命令已写出串口，等待板端回执确认显示。';
    }
  } else if (st === 'cancelled') {
    icon = '×';
    title = '求助已取消';
    desc = '求助已结束（佩戴者按键取消，或查看者取消）。';
  }
  if (els.helpAlert) {
    els.helpAlert.className = cls;
    const ic = els.helpAlert.querySelector('.ha-icon');
    if (ic) ic.textContent = icon;
  }
  if (els.helpTitle) els.helpTitle.textContent = title;
  if (els.helpDesc) els.helpDesc.textContent = desc;

  // 按钮可用性
  if (els.btnHelpAck) els.btnHelpAck.disabled = (st !== 'received');
  if (els.btnHelpCancel) els.btnHelpCancel.disabled = !(st === 'received' || st === 'acknowledged');
  if (els.helpId) els.helpId.textContent = d.help_id || '—';
  if (els.helpNote) els.helpNote.textContent = d.note || '';

  // 状态时间线
  if (els.helpSteps) {
    if (st === 'idle') {
      els.helpSteps.innerHTML = '<li>尚无求助事件</li>';
    } else {
      const row = (label, ts, c, extra) =>
        `<li class="${c}"><span class="st-time">${ts ? fmtClock(ts) : ''}</span>${escHtml(label)}${extra ? ' · ' + escHtml(extra) : ''}</li>`;
      const rows = [];
      rows.push(row('板端按键 · 本地 LED/屏幕立即反馈（不依赖网络）', d.received_at, 'done'));
      rows.push(row('服务端收到求助（远端接收证据）', d.received_at, 'done'));
      if (d.ack_sent_at) rows.push(row('查看者回应 · 命令已下发', d.ack_sent_at, 'done'));
      else if (st === 'received') rows.push(row('等待查看者回应…', null, 'active'));
      if (d.ack_delivered === true) rows.push(row('板端回执 · 屏幕已显示「对方已收到」', d.ack_sent_at, 'done'));
      else if (d.ack_sent_at && d.ack_delivered == null) rows.push(row('等待板端回执…', null, 'active'));
      if (d.cancelled_at) rows.push(row('求助已取消', d.cancelled_at, 'done'));
      els.helpSteps.innerHTML = rows.join('');
    }
  }

  // 证据链
  if (els.helpEvidence) {
    if (st === 'idle') {
      els.helpEvidence.innerHTML = '<div class="obs-empty">尚无求助记录。</div>';
    } else {
      const skew = (d.board_ts && d.received_at) ? Math.round(d.received_at - d.board_ts) : null;
      const yes = (b) => b === true ? '<span class="obs-check ok">✓ 是</span>'
        : b === false ? '<span class="obs-check no">✗ 否</span>'
        : '<span class="obs-check">· 等待</span>';
      els.helpEvidence.innerHTML = `
        <div class="obs-grid">
          <div class="obs-item"><div class="k">本地反馈</div><div class="v">LED+屏幕</div></div>
          <div class="obs-item"><div class="k">服务端接收</div><div class="v">${d.received_at ? fmtClock(d.received_at) : '—'}</div></div>
          <div class="obs-item"><div class="k">板端时间偏差</div><div class="v">${skew == null ? '—' : (skew >= 0 ? '+' : '') + skew + 'ms'}</div></div>
        </div>
        <div class="obs-meta">
          help_id：<code>${escHtml(d.help_id || '—')}</code>　板端序号：<code>${d.seq == null ? '—' : d.seq}</code><br>
          回应命令已写出串口：${yes(d.ack_channel_ok)}　板端回执已显示「对方已收到」：${yes(d.ack_delivered)}
          ${d.mockDevice ? '<br><span class="obs-check no">⚠ 当前为模拟模式，未走真实串口</span>' : ''}
        </div>`;
    }
  }

  // 历史求助事件（来自服务端落盘文件，重启不丢）
  if (els.helpHistory) {
    const hist = Array.isArray(d.history) ? d.history : [];
    if (els.helpHistoryCount) {
      els.helpHistoryCount.textContent = hist.length ? `${hist.length} 条` : '—';
    }
    if (!hist.length) {
      els.helpHistory.innerHTML = '<div class="obs-empty">尚无历史事件。</div>';
    } else {
      // 事件名 → 中文说明（与 server.js helpLog 的 ev 取值一一对应）
      const EV_TEXT = {
        received: '板端上报求助 · 服务端已接收',
        cancelled: '板端取消求助',
        ack_sent: '查看者回应已下发',
        ack_mock: '模拟模式回应（未走真实通道）',
        ack_failed: '回应未送达设备',
        cancel_sent: '查看者取消已下发',
        ack_delivered: '板端回执 · 屏幕已显示「对方已收到」',
        ack_rejected: '板端拒绝回应（无进行中求助）',
        cancel_delivered: '板端确认取消',
        reset: '手动复位',
      };
      // 倒序：最新的在最上面，便于一眼看到最近发生了什么
      const rows = hist.slice().reverse().map((e) => {
        const t = e.at ? fmtClock(e.at) : '—';
        const label = EV_TEXT[e.ev] || e.ev || '未知事件';
        const id = e.help_id ? ` · <code>${escHtml(e.help_id)}</code>` : '';
        const dev = e.device_id ? ` · ${escHtml(e.device_id)}` : '';
        return `<li><span class="st-time">${t}</span>${escHtml(label)}${id}${dev}</li>`;
      });
      els.helpHistory.innerHTML = `<ol class="steps">${rows.join('')}</ol>`;
    }
  }

  renderHelpChannel();
}

async function helpAction(action) {
  try {
    const j = await (await fetch('/api/help', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })).json();
    if (j && j.help) renderHelp(j.help);
    else if (j && j.note && els.helpNote) els.helpNote.textContent = j.note;
  } catch (_) { /* 交给 WS 推送 */ }
}

// ---------------------------------------------------------------- 摄像头（OV2640）
const CAM = { streaming: false, hasFrame: false, frames: 0, seq: 0, size: null, bytes: 0, viewers: 0,
              hasSnapshot: false, snapshotAt: 0, snapshotSize: null, snapshotBytes: 0, timer: null };

async function camControl(action) {
  if (!els.camNote) return;
  els.camNote.textContent = action === 'start' ? '正在下发「开启画面」命令…' : '正在下发「停止」命令…';
  try {
    /* 参数由固件默认值决定，前端不传 —— 用户点一次即可，无需理解取舍。 */
    const d = await (await fetch('/api/cam', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })).json();
    els.camNote.textContent = d.ok
      ? (action === 'start'
          ? `命令已送达板端，等待第一帧…（320x240 · 画质 ${CAM_LIVE_QUALITY} · 目标 ${CAM_LIVE_FPS} 帧/秒）`
          : '已下发停止命令。')
      : '⚠ ' + (d.note || '命令通道不可用，板端不会开始推流。');
    await loadCam();
  } catch (e) {
    els.camNote.textContent = '下发失败：' + e.message;
  }
}

async function loadCam() {
  try {
    const d = await (await fetch('/api/cam', { cache: 'no-store' })).json();
    CAM.streaming = !!d.streaming;
    CAM.hasFrame  = !!d.hasFrame;
    CAM.frames    = d.frames || 0;
    CAM.seq       = d.seq || 0;
    CAM.size      = d.size || null;
    CAM.bytes     = d.bytes || 0;
    CAM.viewers   = d.viewers || 0;
    CAM.hasSnapshot   = !!d.hasSnapshot;
    CAM.snapshotAt    = d.snapshotAt || 0;
    CAM.snapshotSize  = d.snapshotSize || null;
    CAM.snapshotBytes = d.snapshotBytes || 0;
    renderCam();
    resolveShotPending();
  } catch (_) { /* 网络抖动忽略 */ }
}

/* 摄像头参数固定为实测最优点（2026-10-15 实测，WiFi 上行）：
 *   分辨率/画质/帧率争夺同一条链路带宽（实测上限约 500 kbps），无法同时最大化：
 *     240x240 → 6.3 帧/秒（单帧 7.4KB）
 *     320x240 → 6.7 帧/秒（单帧 9.3KB）  ★ 最优点
 *     400x296 → 1.7 帧/秒（单帧 13.9KB，带宽崩溃）
 *     640x480 → 0   帧/秒（帧缓冲不足，彻底卡死）
 *   帧率档位原本也不生效：选 15fps 实测仅 3.9 帧/秒（由链路带宽决定）。
 * 因此不再让用户配置，固定为最优点；抓拍仍用高分辨率（单张，慢一点可接受）。 */
const CAM_LIVE_QUALITY   = 12;   // 实测清晰度/带宽平衡点（直播档）
const CAM_LIVE_FPS       = 10;   // 实测上限约 6.7，设 10 交由链路决定
const CAM_SHOT_FRAMESIZE = 10;   // 640x480 VGA（抓拍单张，慢一点可接受）

/* 抓拍是异步的：下发命令后要等板端抓完、编码、经链路回传。
 * 这里用「snapshotAt 是否变化」作为唯一判据 —— 变化了才算真拿到新帧，
 * 否则一律如实报超时，绝不显示成功。 */
let camShotPending = false;
let camShotTimer = null;
let camShotBaseline = 0;

function resolveShotPending() {
  if (!camShotPending) return;
  if (CAM.snapshotAt && CAM.snapshotAt !== camShotBaseline) {
    camShotPending = false;
    clearTimeout(camShotTimer);
    if (els.camNote) {
      els.camNote.textContent =
        `✅ 已抓到一张：${CAM.snapshotSize || '?'} · ${(CAM.snapshotBytes / 1024).toFixed(1)} KB`;
    }
  }
}

function renderCam() {
  if (!els.camTag) return;
  const live = CAM.streaming && CAM.hasFrame;

  els.camTag.textContent = live ? '实时' : (CAM.streaming ? '等待首帧' : '未开启');
  els.camTag.className   = 'tag' + (live ? ' tag-ok' : (CAM.streaming ? ' tag-warn' : ''));

  if (els.camView) {
    if (live) {
      // MJPEG：浏览器原生支持 multipart/x-mixed-replace，一个 <img> 就能看直播
      if (els.camView.getAttribute('src') !== '/api/cam.mjpg') els.camView.setAttribute('src', '/api/cam.mjpg');
      els.camView.classList.remove('hidden');
      if (els.camPlaceholder) els.camPlaceholder.classList.add('hidden');
    } else {
      if (els.camView.getAttribute('src')) els.camView.removeAttribute('src');  // 断开 MJPEG 连接
      els.camView.classList.add('hidden');
      if (els.camPlaceholder) els.camPlaceholder.classList.remove('hidden');
    }
  }

  if (els.btnCamStart) els.btnCamStart.disabled = CAM.streaming;
  if (els.btnCamStop)  els.btnCamStop.disabled  = !CAM.streaming;

  // 抓拍快照：与直播流分开展示（带时间戳参数，避免浏览器缓存旧图）
  if (els.camShot) {
    if (CAM.hasSnapshot) {
      const url = '/api/cam/snapshot.jpg?t=' + CAM.snapshotAt;
      if (els.camShot.getAttribute('src') !== url) els.camShot.setAttribute('src', url);
      els.camShot.classList.remove('hidden');
      if (els.camShotPlaceholder) els.camShotPlaceholder.classList.add('hidden');
      if (els.camShotTag) { els.camShotTag.textContent = CAM.snapshotSize || '已抓拍'; els.camShotTag.className = 'tag tag-ok'; }
      if (els.camShotDownload) { els.camShotDownload.setAttribute('href', url); els.camShotDownload.classList.remove('hidden'); }
      if (els.camShotInfo) {
        els.camShotInfo.textContent =
          `${CAM.snapshotSize || '?'} · ${(CAM.snapshotBytes / 1024).toFixed(1)} KB · ${fmtTime(CAM.snapshotAt)}`;
      }
    } else {
      els.camShot.classList.add('hidden');
      if (els.camShotPlaceholder) els.camShotPlaceholder.classList.remove('hidden');
      if (els.camShotTag) { els.camShotTag.textContent = '还没有抓拍'; els.camShotTag.className = 'tag'; }
      if (els.camShotDownload) els.camShotDownload.classList.add('hidden');
      if (els.camShotInfo) els.camShotInfo.textContent = '';
    }
  }

  if (els.camStats) {
    const rows = [
      ['状态',     live ? '实时画面' : (CAM.streaming ? '等待首帧' : '未开启')],
      ['已收帧数', CAM.frames],
      ['最新帧号', CAM.seq],
      ['分辨率',   CAM.size || '—'],
      ['单帧大小', CAM.bytes ? (CAM.bytes / 1024).toFixed(1) + ' KB' : '—'],
      ['观看者',   CAM.viewers],
    ];
    els.camStats.innerHTML = rows.map(([k, v]) =>
      `<div class="obs-cell"><span class="k">${escHtml(k)}</span><span class="v">${escHtml(String(v))}</span></div>`).join('');
  }
}

if (els.btnCamStart) els.btnCamStart.onclick = () => camControl('start');
if (els.btnCamStop)  els.btnCamStop.onclick  = () => camControl('stop');
if (els.btnCamShot) els.btnCamShot.onclick = async () => {
  if (camShotPending) return;                 // 防重复点击
  camShotBaseline = CAM.snapshotAt || 0;
  camShotPending  = true;
  if (els.camNote) {
    els.camNote.textContent = '抓拍中…板端会临时切到所选分辨率，拍完自动切回直播分辨率。';
  }
  try {
    const d = await (await fetch('/api/cam', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'shot',
        framesize: CAM_SHOT_FRAMESIZE,
      }),
    })).json();
    if (!d.ok) {
      camShotPending = false;
      if (els.camNote) els.camNote.textContent = '⚠ ' + (d.note || '命令通道不可用，抓拍未送达板端。');
      return;
    }
    if (els.camNote) els.camNote.textContent = '已下发抓拍命令，等板端回传…';
    // 高分辨率帧（VGA 约 13KB、UXGA 更大）经链路回传需要时间，轮询等它
    camShotTimer = setTimeout(() => {
      if (!camShotPending) return;
      camShotPending = false;
      if (els.camNote) {
        els.camNote.textContent = '⚠ 超时：板端未回传新帧。请确认命令通道可用、板子在线。';
      }
    }, 15000);
    // 主动多查几次，比等 3 秒定时器更及时
    for (let i = 0; i < 8 && camShotPending; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      await loadCam();
    }
  } catch (e) {
    camShotPending = false;
    if (els.camNote) els.camNote.textContent = '抓拍失败：' + e.message;
  }
};

/* 固定参数不再需要前端下发：固件默认值（cam_stream.c 的 CAM_DEF_FRAMESIZE /
 * CAM_DEF_QUALITY 与 main.c 的 s_cam_fps）就是实测最优配置，是唯一真源。
 * 前端只发 start/stop/shot，不再传任何参数 —— 避免两处配置漂移。
 * 需要临时试别的档位时用 curl 调 /api/cam 的 set（服务端保留该调试路径）。 */

// 停在摄像头页时定时刷新状态（画面本身由 MJPEG 推送，无需轮询）
setInterval(() => { if (S.page === 'cam') loadCam(); }, 3000);

if (els.btnHelpAck) els.btnHelpAck.onclick = () => helpAction('ack');
if (els.btnHelpCancel) els.btnHelpCancel.onclick = () => helpAction('cancel');
if (els.btnHelpReset) els.btnHelpReset.onclick = () => helpAction('reset');

async function loadHelp() {
  try {
    const j = await (await fetch('/api/help')).json();
    HELP.channelReady = !!(j.channel && j.channel.portOpen);
    renderHelp(j.help);
  } catch (_) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 自然语言助手（第 4 周）
/* 受限助手：只调用 POST /api/nl；界面只展示服务端返回的意图/工具/证据，
 * 不自行推断、不造数据。采集类请求服务端会等待设备真实结果，回复可能慢几秒。 */
let nlBusy = false;

async function loadNlCap() {
  try {
    const j = await (await fetch('/api/nl')).json();
    els.nlEngine.textContent = j.llm_configured ? 'LLM + 规则兜底' : '规则解析（LLM 未配置）';
    els.nlCap.innerHTML =
      `只对 <b>${escHtml(j.allowed_device || '当前设备')}</b> 开放两个受限工具：` +
      `<b>查看上次数据</b>（只读历史记录，保留旧时间）、<b>重新采集一次</b>（发起采集并等待真实完成证据）。` +
      ` 意图引擎：${escHtml(j.engine)}。`;
  } catch (_) {
    els.nlEngine.textContent = '服务端未连接';
  }
}

function nlBubble(cls, html) {
  const empty = els.nlChat.querySelector('.nl-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'nl-msg ' + cls;
  div.innerHTML = html;
  els.nlChat.appendChild(div);
  els.nlChat.scrollTop = els.nlChat.scrollHeight;
  return div;
}

function nlEvidenceHtml(ev) {
  if (!ev) return '';
  const rows = [];
  const put = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push(`<div><span>${k}</span><b>${escHtml(String(v))}</b></div>`); };
  put('状态', ev.status);
  put('request_id', ev.request_id);
  put('回执', ev.ack_status);
  put('seq（下发前）', ev.seq_before);
  put('seq（新观测）', ev.seq_observed);
  put('记录接收时间', ev.recv_iso);
  put('完成时间', ev.completed_iso);
  if (typeof ev.age_ms === 'number') put('距今', Math.round(ev.age_ms / 1000) + ' 秒');
  if (ev.simulated) put('模拟模式', '是（未走真实设备）');
  if (ev.stale) put('数据时效', '设备当前未在上报（旧值）');
  if (ev.checks) put('校验', `到达晚于下发=${ev.checks.arrived_after_dispatch}，seq 递增=${ev.checks.seq_increased}`);
  if (!rows.length) return '';
  return `<div class="nl-ev">${rows.join('')}</div>`;
}

async function nlSend(text) {
  nlBusy = true;
  nlBubble('me', escHtml(text));
  const waiting = nlBubble('bot', '<span class="nl-thinking">处理中（采集类请求会等待设备真实结果，可能需要几秒）…</span>');
  try {
    const r = await (await fetch('/api/nl', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })).json();
    const chips = [`<span class="chip chip-intent">${escHtml(r.intent || '?')}</span>`];
    if (r.tool) chips.push(`<span class="chip chip-tool">${escHtml(r.tool)}</span>`);
    chips.push(`<span class="chip chip-engine">${escHtml(r.engine === 'llm' ? 'LLM' : '规则')}</span>`);
    // 文案来源如实标注：模型改写通过数字核对才会显示 LLM，否则是服务端模板
    if (r.tool) chips.push(`<span class="chip chip-engine">文案 ${r.reply_by === 'llm' ? 'LLM' : '模板'}</span>`);
    waiting.innerHTML =
      `<div class="nl-chips">${chips.join('')}</div>` +
      `<div class="nl-reply">${escHtml(r.reply || '(无回复)')}</div>` +
      nlEvidenceHtml(r.evidence);
  } catch (_) {
    waiting.innerHTML = '<div class="nl-reply">请求失败：服务端未响应。</div>';
  }
  els.nlChat.scrollTop = els.nlChat.scrollHeight;
  nlBusy = false;
}

if (els.nlForm) {
  els.nlForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const t = els.nlInput.value.trim();
    if (!t || nlBusy) return;
    els.nlInput.value = '';
    nlSend(t);
  });
}

// ---------------------------------------------------------------- 云端大模型自定义配置
/* 密钥只留服务端：前端只拿到脱敏值；保存/删除/测试均走 /api/nl/config。
 * 测试连接用表单当前值（不落盘），方便"先测后存"；表单留空 key 时测试要求补全。 */
function llmMsg(kind, html) {
  els.llmMsg.className = 'llm-msg ' + kind;
  els.llmMsg.innerHTML = html;
  els.llmMsg.classList.remove('hidden');
}

function llmFormParams() {
  return {
    endpoint: els.llmEndpoint.value.trim(),
    apiKey: els.llmApiKey.value.trim(),
    model: els.llmModel.value.trim(),
    timeoutMs: Number(els.llmTimeout.value) || 8000,
    replyMode: els.llmReplyMode ? els.llmReplyMode.value : 'llm',
  };
}

async function loadLlmConfig() {
  try {
    const j = await (await fetch('/api/nl/config')).json();
    if (!j.ok) throw new Error('bad response');
    els.llmStatusTag.textContent = j.configured
      ? (j.source === 'env' ? '已配置（环境变量）' : '已配置')
      : '未配置（规则解析兜底）';
    if (j.configured) {
      els.llmSavedInfo.innerHTML =
        `<span>当前：<b>${escHtml(j.model || '—')}</b></span>` +
        `<span>地址：<b>${escHtml(j.llm_host || j.endpoint || '—')}</b></span>` +
        `<span>Key：<b>${escHtml(j.apiKey_masked || '—')}</b></span>` +
        `<span>超时：<b>${escHtml(String(j.timeoutMs || 8000))} ms</b></span>` +
        `<span>文案：<b>${j.replyMode === 'template' ? '服务端模板' : '模型润色'}</b></span>`;
      els.llmSavedInfo.classList.remove('hidden');
      els.llmEndpoint.value = j.endpoint || '';
      els.llmModel.value = j.model || '';
      els.llmTimeout.value = j.timeoutMs || 8000;
      if (els.llmReplyMode) els.llmReplyMode.value = j.replyMode === 'template' ? 'template' : 'llm';
      els.llmApiKey.value = '';
      els.llmApiKey.placeholder = j.env_locked ? '由环境变量提供（界面只读）' : `已保存（${j.apiKey_masked}），修改时重新填写`;
    } else {
      els.llmSavedInfo.classList.add('hidden');
      els.llmApiKey.placeholder = 'sk-...';
    }
    const ro = !!j.env_locked;
    for (const el of [els.llmEndpoint, els.llmApiKey, els.llmModel, els.llmTimeout, els.llmReplyMode]) { if (el) el.disabled = ro; }
    els.btnLlmSave.disabled = ro;
    els.btnLlmDelete.disabled = ro;
    els.btnLlmTest.disabled = false;   // 测试允许用表单值验证环境变量是否可用
  } catch (_) {
    els.llmStatusTag.textContent = '服务端未连接';
  }
}

if (els.llmForm) {
  els.llmForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const p = llmFormParams();
    if (!p.apiKey) { llmMsg('err', '保存前请填写 <b>API Key</b>（服务端不会回显完整密钥，只存脱敏展示）。'); return; }
    els.btnLlmSave.disabled = true;
    try {
      const r = await fetch('/api/nl/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      const j = await r.json();
      if (j.ok) { llmMsg('ok', `已保存。模型 <b>${escHtml(j.model)}</b> @ ${escHtml(j.llm_host || '')}，Key <b>${escHtml(j.apiKey_masked)}</b>。`); await loadLlmConfig(); loadNlCap(); }
      else llmMsg('err', `保存失败（HTTP ${r.status}）：${escHtml(j.message || j.error || '未知错误')}`);
    } catch (e) { llmMsg('err', '保存失败：服务端未响应。'); }
    els.btnLlmSave.disabled = false;
  });

  els.btnLlmDelete.addEventListener('click', async () => {
    if (!confirm('确定删除已保存的模型配置？删除后将降级为规则解析（可用环境变量重新配置）。')) return;
    try {
      const r = await fetch('/api/nl/config', { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) { llmMsg('ok', '配置已删除。' + (j.configured ? '' : '当前使用规则解析兜底。')); els.llmEndpoint.value = ''; els.llmApiKey.value = ''; els.llmModel.value = ''; els.llmTimeout.value = 8000; await loadLlmConfig(); loadNlCap(); }
      else llmMsg('err', `删除失败（HTTP ${r.status}）：${escHtml(j.message || j.error || '未知错误')}`);
    } catch (e) { llmMsg('err', '删除失败：服务端未响应。'); }
  });

  /* 拉取该 Key 实际可用的模型 id：模型名不匹配是 404 的常见真凶，
     直接点列表里的名字填进表单，避免手抄出错（区分大小写、带版本后缀/部署名）。 */
  els.btnLlmModels.addEventListener('click', async () => {
    const p = llmFormParams();
    els.btnLlmModels.disabled = true;
    els.llmModels.classList.add('hidden');
    llmMsg('ok', '正在拉取可用模型列表…');
    try {
      const r = await fetch('/api/nl/config/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      const j = await r.json();
      if (j.ok && Array.isArray(j.models) && j.models.length) {
        els.llmModels.innerHTML = `<div class="llm-models-hint">${j.models.length} 个可用模型（点击填入）：</div>`
          + j.models.map((m, i) => `<button type="button" class="llm-chip" data-m="${escHtml(String(m))}">${escHtml(String(m))}${i === 0 ? ' <span class="llm-chip-tag">推荐</span>' : ''}</button>`).join('');
        els.llmModels.classList.remove('hidden');
        els.llmModels.querySelectorAll('.llm-chip').forEach((b) => {
          b.addEventListener('click', () => { els.llmModel.value = b.getAttribute('data-m'); llmMsg('ok', `已填入模型：<b>${escHtml(els.llmModel.value)}</b>，再点“测试连接”验证。`); });
        });
        llmMsg('ok', `拉取成功：<b>${j.models.length}</b> 个模型。点列表中的名字即可填入模型名。`);
      } else {
        llmMsg('err', `拉取失败：${escHtml(j.error || j.message || '未知错误')}${j.detail ? '<br><small>' + escHtml(j.detail) + '</small>' : ''}<br><small>列表接口不可用时，请到厂商控制台复制准确的模型名。</small>`);
      }
    } catch (e) { llmMsg('err', '拉取失败：服务端未响应。'); }
    els.btnLlmModels.disabled = false;
  });

  els.btnLlmTest.addEventListener('click', async () => {
    const p = llmFormParams();
    els.btnLlmTest.disabled = true;
    llmMsg('ok', '正在测试连接…');
    try {
      const r = await fetch('/api/nl/config/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      const j = await r.json();
      if (j.ok === true && j.latencyMs !== undefined && !j.error) {
        llmMsg('ok', `连接成功：模型 <b>${escHtml(j.model || '')}</b> 响应 <b>${j.latencyMs} ms</b>。保存配置后即可用于对话推理。`);
      } else {        const urlLine = j.url ? `<br><small>实际请求：<code>${escHtml(j.url)}</code></small>` : '';
        llmMsg('err', `连接失败：${escHtml(j.error || j.message || '未知错误')}${j.detail ? '<br><small>' + escHtml(j.detail) + '</small>' : ''}${urlLine}`);
      }
    } catch (e) { llmMsg('err', '测试失败：服务端未响应。'); }
    els.btnLlmTest.disabled = false;
  });

  loadLlmConfig();
}

// ---------------------------------------------------------------- 分页路由
// 单页应用 + hash 路由：地址栏 #live / #collect / #records，刷新不丢页面。
const PAGES = ['live', 'collect', 'help', 'cam', 'records', 'ask'];
function showPage(name) {
  if (!PAGES.includes(name)) name = 'live';
  S.page = name;
  document.querySelectorAll('.page').forEach((el) => el.classList.toggle('on', el.dataset.page === name));
  document.querySelectorAll('.pagetab').forEach((el) => el.classList.toggle('on', el.dataset.page === name));

  // 离开摄像头页时主动断开 MJPEG。
  // 否则 <img src="/api/cam.mjpg"> 会一直保持连接，浏览器在后台以推流帧率
  // 持续解码（板端也在白推流），占用主线程 —— 在实时监控页上就表现为卡顿。
  // 回到摄像头页时 loadCam() → renderCam() 会重新挂上 src，自动恢复画面。
  if (name !== 'cam' && els.camView && els.camView.getAttribute('src')) {
    els.camView.removeAttribute('src');
  }

  needDraw = true;   // 回到实时页时立即重画（隐藏期间画布尺寸为 0）
  invalidateCanvasRects();   // 页面切换会改变画布可见尺寸，缓存的 rect 需重测
  if (name === 'cam') loadCam();   // 进入摄像头页立即刷新一次状态
  if (name === 'ask') loadNlCap(); // 进入自然语言页刷新能力说明（引擎/白名单）
}
window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
showPage(location.hash.slice(1) || 'live');

// ---------------------------------------------------------------- 原始日志
/* 原始日志。
 *
 * 性能要点：每收到一帧就会有一条原始日志。若每次直接 appendChild 并给
 * scrollTop 赋值，浏览器必须为每次赋值做一次同步布局（forced reflow）——
 * 10Hz 下就是每秒十几次整页重排，这是实时页卡顿的第二个来源。
 * 改为：先入队，用 requestAnimationFrame 合并成一次批量写入（DocumentFragment），
 * 并且只在用户本来就贴着底部时才自动滚动（否则会打断向上翻阅历史）。 */
let rawPending = [];
let rawRaf = 0;
const RAW_DOM_MAX = 300;

function flushRaw() {
  rawRaf = 0;
  if (!rawPending.length) return;
  const el = els.rawLog;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  const frag = document.createDocumentFragment();
  for (const it of rawPending) {
    const div = document.createElement('div');
    div.className = 'line' + (it.ok ? ' ok' : ' err');
    div.innerHTML = `<span class="ts">${fmtTime(it.ts)}</span>${escHtml(it.text)}`;
    frag.appendChild(div);
  }
  rawPending = [];
  el.appendChild(frag);
  while (el.childElementCount > RAW_DOM_MAX) el.removeChild(el.firstChild);
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

function appendRaw(ts, text, ok) {
  rawPending.push({ ts, text, ok });
  if (!rawRaf) rawRaf = requestAnimationFrame(flushRaw);
}
els.btnClearLog.onclick = () => { rawPending = []; els.rawLog.innerHTML = ''; };

// ---------------------------------------------------------------- 端口
async function loadPorts() {
  try {
    const d = await (await fetch('/api/ports')).json();
    const cur = els.portSelect.value;
    const list = d.ports || [];
    els.portSelect.innerHTML =
      '<option value="">自动识别…</option>' +
      list.map((p) => {
        const tag = p.score >= 100 ? ' ★ESP32' : p.score > 0 ? ' ·USB' : '';
        return `<option value="${escHtml(p.path)}">${escHtml(p.path)}${p.manufacturer ? ' — ' + escHtml(p.manufacturer) : ''}${tag}</option>`;
      }).join('');
    if (cur && list.some((p) => p.path === cur)) els.portSelect.value = cur;
  } catch (_) { /* 忽略 */ }
}
els.btnRefresh.onclick = loadPorts;

els.btnConnect.onclick = async () => {
  els.btnConnect.disabled = true;
  const old = els.btnConnect.textContent;
  els.btnConnect.textContent = '连接中…';
  try {
    await fetch('/api/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portPath: els.portSelect.value || null,
        baudRate: Number(els.baudSelect.value),
        autoDetect: !els.portSelect.value,
      }),
    });
  } finally {
    els.btnConnect.disabled = false;
    els.btnConnect.textContent = old;
  }
};

els.btnDisconnect.onclick = () => fetch('/api/disconnect', { method: 'POST' });
els.chkAuto.onchange = () => fetch('/api/config', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ autoReconnect: els.chkAuto.checked }),
});
els.chartUnit.onchange = () => { needDraw = true; };
els.chartRange.onchange = () => { needDraw = true; };
// 去直流开关：三轴叠到同一水平线，便于对比波形（默认开）
els.btnChartAC.classList.toggle('on', CHART_AC);
els.btnChartAC.textContent = CHART_AC ? '去直流 · 开' : '去直流';
els.btnChartAC.onclick = () => {
  CHART_AC = !CHART_AC;
  els.btnChartAC.classList.toggle('on', CHART_AC);
  els.btnChartAC.textContent = CHART_AC ? '去直流 · 开' : '去直流';
  needDraw = true;
};
// 波形暂停/继续
els.btnChartPause.onclick = () => {
  CHART_PAUSED = !CHART_PAUSED;
  els.btnChartPause.classList.toggle('on', CHART_PAUSED);
  els.btnChartPause.textContent = CHART_PAUSED ? '继续' : '暂停';
  needDraw = true;
};

// 平滑播放（抗抖动缓冲）：整幅曲线延后约 2s 绘制，吸收设备偶发上报空档
function applySmoothUI() {
  const on = CHART_DELAY_MS > 0;
  els.btnChartSmooth.classList.toggle('on', on);
  els.btnChartSmooth.textContent = on ? '平滑播放 · 开' : '平滑播放';
  els.btnChartSmooth.title = on
    ? '平滑播放已开启：曲线整体延后约 2 秒绘制（右端刻度显示 -2s，不是"现在"）。用于吸收设备偶发上报空档，画面更匀速。'
    : '平滑播放：把曲线整体延后约 2 秒绘制，用于吸收设备上报的偶发空档（设备每帧同步上传，偶发重试会造成 1~4 秒间隔，表现为曲线走走停停）。开启后画面更匀速，代价是曲线比真实时刻晚约 2 秒，右端刻度会从「现在」变为「-2s」如实标注。';
  needDraw = true;
}
try { if (localStorage.getItem(CHART_DELAY_KEY) === '1') CHART_DELAY_MS = CHART_DELAY_MAX_MS; } catch (_) {}
applySmoothUI();
els.btnChartSmooth.onclick = () => {
  CHART_DELAY_MS = CHART_DELAY_MS > 0 ? 0 : CHART_DELAY_MAX_MS;
  try { localStorage.setItem(CHART_DELAY_KEY, CHART_DELAY_MS > 0 ? '1' : '0'); } catch (_) {}
  applySmoothUI();
};

// 水平归零：把当前 X/Y 记为水平基准；再点一次清除
els.btnLevelZero.onclick = () => {
  if (LEVEL_ZERO) { setLevelZero(null); return; }
  if (Number.isFinite(S.lastAx) && Number.isFinite(S.lastAy)) {
    setLevelZero({ x: S.lastAx, y: S.lastAy });
  } else if (els.levelCap) {
    els.levelCap.textContent = '尚未收到三轴数据，无法归零';
  }
};
updateLevelCap();

// ---------------------------------------------------------------- 诊断
els.btnDiag.onclick = async () => {
  els.diagOut.classList.remove('hidden');
  els.diagOut.textContent = '诊断中…';
  try {
    const d = await (await fetch('/api/diag')).json();
    const ports = (d.ports || []).map((p) =>
      p.error ? `    ${p.error}` : `    ${p.path}  ${p.manufacturer || ''}  vid=${p.vendorId || '-'}  score=${p.score}`
    ).join('\n') || '    （无）';
    els.diagOut.textContent = [
      `运行环境     ${d.runtime.node} / ${d.runtime.platform} / serialport ${d.serialportVersion}`,
      `当前串口     ${d.currentPort || '（未连接）'}   已打开=${d.portOpen ? '是' : '否'}   波特率=${d.baudRate}`,
      `已接收字节   ${d.bytesReceived}`,
      `报文统计     共 ${d.lines.total} 行 / 有效 ${d.lines.valid} / 无效 ${d.lines.invalid}`,
      d.lastOpenError ? `打开失败原因 ${d.lastOpenError}` : '',
      d.lastError ? `最近错误     ${d.lastError}` : '',
      '',
      '可用串口：',
      ports,
      '',
      '排查建议：',
      ...(d.hints && d.hints.length ? d.hints.map((h) => '    · ' + h) : ['    · 未发现明显问题']),
    ].filter((x) => x !== undefined && x !== '').join('\n');
  } catch (e) {
    els.diagOut.textContent = '诊断失败：' + e.message;
  }
};

// ---------------------------------------------------------------- 波特率探测
els.btnProbe.onclick = async () => {
  const portPath = els.portSelect.value || (S.device && S.device.path) || null;
  els.diagOut.classList.remove('hidden');
  if (!portPath) { els.diagOut.textContent = '请先选择一个串口（或让平台自动识别到设备）。'; return; }
  els.btnProbe.disabled = true;
  const old = els.btnProbe.textContent;
  els.btnProbe.textContent = '探测中…';
  try {
    const r = await (await fetch('/api/probe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portPath, ms: 1500 }),
    })).json();
    if (r.error) { els.diagOut.textContent = '探测失败：' + r.error; return; }
    const rows = r.results.map((x) => {
      const tail = x.error ? `打开失败: ${x.error}`
        : x.bytes > 0 ? `收到 ${x.bytes} 字节  ${(x.sample[0] || '').slice(0, 60)}`
        : '无数据';
      return `    ${String(x.baudRate).padStart(7)}  ${tail}`;
    }).join('\n');
    els.diagOut.textContent = [
      `串口 ${r.port} 波特率探测（每个波特率监听 ${r.ms}ms）：`,
      '',
      rows,
      '',
      r.nativeUsb
        ? '这是 Espressif 原生 USB 串口（VID 303A），波特率对它没有意义。各档「无数据」= 开发板当前没往该口发送内容。'
        : (r.suggestedBaudRate
          ? `建议波特率：${r.suggestedBaudRate} —— 已探测到数据。`
          : '所有波特率均无任何数据输出：可能未烧录程序、或程序未向串口输出。'),
    ].join('\n');
    if (r.suggestedBaudRate) els.baudSelect.value = String(r.suggestedBaudRate);
  } catch (e) {
    els.diagOut.textContent = '探测失败：' + e.message;
  } finally {
    els.btnProbe.disabled = false;
    els.btnProbe.textContent = old;
  }
};

// ---------------------------------------------------------------- 录制
els.btnRecord.onclick = async () => {
  if (!recording) {
    await fetch('/api/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
    recording = true;
    els.btnRecord.textContent = '停止并下载';
    els.btnRecord.classList.add('btn-primary');
    return;
  }
  const r = await (await fetch('/api/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  })).json();
  recording = false;
  els.btnRecord.textContent = '开始记录';
  els.btnRecord.classList.remove('btn-primary');
  if (r.rows > 0 && r.file) {
    const a = document.createElement('a');
    a.href = `/api/record/download?file=${encodeURIComponent(r.file)}`;
    a.download = r.file;
    document.body.appendChild(a); a.click(); a.remove();
    els.chartHint.textContent = `已保存 ${r.rows} 条真实采样：${r.file}`;
  } else {
    els.chartHint.textContent = '录制期间没有收到任何设备数据，未生成文件。';
  }
};

// ---------------------------------------------------------------- 原始记录查询
async function loadDevices() {
  try {
    const d = await (await fetch('/api/devices')).json();
    const cur = els.deviceSelect.value;
    const list = (d.devices || []).filter((x) => x.count > 0);
    els.deviceSelect.innerHTML =
      '<option value="">本组设备</option>' +
      list.map((x) => `<option value="${escHtml(x.device_id)}">${escHtml(x.device_id)}（${x.count}）</option>`).join('');
    if (cur) els.deviceSelect.value = cur;
  } catch (_) { /* 忽略 */ }
}

async function queryRecords() {
  const dev = els.deviceSelect.value;
  const limit = Number(els.limitSelect.value) || 50;
  els.btnQuery.disabled = true;
  els.btnQuery.textContent = '查询中…';
  els.recordsTable.innerHTML = '<div class="empty">查询中…</div>';
  try {
    const url = `/api/records?limit=${limit}` + (dev ? `&device=${encodeURIComponent(dev)}` : '');
    const d = await (await fetch(url)).json();
    const rows = d.rows || [];
    if (!rows.length) {
      els.recordsTable.innerHTML = '<div class="empty">暂无真实记录（先让板端上报，或确认 WiFi 已推送到此服务）。</div>';
    } else {
      const keys = new Set();
      for (const r of rows) for (const k of Object.keys(r.fields || {})) keys.add(k);
      const fk = Array.from(keys).slice(0, 8);
      const head = `<tr><th>#</th><th>服务端接收时间</th><th>板端时间</th><th>偏差ms</th>${fk.map((k) => `<th>${escHtml(k)}</th>`).join('')}</tr>`;
      const body = rows.map((r) => {
        const f = r.fields || {};
        const skCls = r.skew_ms == null ? '' : (Math.abs(r.skew_ms) < 2000 ? 'ok' : 'warn');
        return `<tr><td>${r.seq}</td><td class="mono">${escHtml(r.recv_iso || '')}</td><td class="mono">${escHtml(r.board_iso || '—')}</td>` +
          `<td class="${skCls}">${r.skew_ms == null ? '—' : r.skew_ms}</td>` +
          fk.map((k) => `<td class="mono">${f[k] != null ? escHtml(String(f[k])) : ''}</td>`).join('') + '</tr>';
      }).join('');
      els.recordsTable.innerHTML = `<table class="rtable"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }
    els.btnCsv.href = `/api/records.csv?limit=${limit}` + (dev ? `&device=${encodeURIComponent(dev)}` : '');
  } catch (e) {
    els.recordsTable.innerHTML = '<div class="empty">查询失败：' + escHtml(e.message) + '</div>';
  } finally {
    els.btnQuery.disabled = false;
    els.btnQuery.textContent = '查询';
  }
}

els.btnQuery.onclick = queryRecords;
els.deviceSelect.onchange = queryRecords;
els.limitSelect.onchange = queryRecords;
loadDevices();
setInterval(loadDevices, 10000);

// ---------------------------------------------------------------- WebSocket
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }

    if (m.type === 'hello') {
      S.meta = Object.assign(S.meta, m.meta || {});
      clearAllData();
      S.connected = !!m.connected; S.live = !!m.live; S.transport = m.transport || null;
      S.portOpen = !!m.portOpen;
      S.wifiDownlink = !!m.wifiDownlink;
      S.downlinkKind = m.downlinkKind || null;
      S.device = m.device || null; S.deviceId = m.deviceId || null; S.deviceMac = m.deviceMac || null;
      S.deviceVerified = m.deviceVerified ?? null; S.expectedDeviceId = m.expectedDeviceId || null;
      S.lastDataAt = m.lastDataAt || null; S.boardTs = m.boardTs || null;
      S.boardIso = m.boardIso || null; S.seq = m.seq ?? null;
      if (m.config) {
        els.chkAuto.checked = !!m.config.autoReconnect;
        els.baudSelect.value = String(m.config.baudRate || 115200);
      }
      (m.raw || []).forEach((r) => appendRaw(r.ts, r.text, r.ok));
      if (m.fields && Object.keys(m.fields).length) renderSample(m.fields, m.lastDataAt);
      // 远程采集：恢复请求列表 / 模拟模式标记
      COLLECT.mockDevice = !!m.mockDevice;
      COLLECT.timeoutMs = m.collectTimeoutMs || 8000;
      COLLECT.reportPaused = !!m.reportPaused;
      if (m.requests && m.requests.length) renderCollect(m.requests[0]);
      renderCollectMode();
      // 教学求助：刷新页面后恢复当前状态
      HELP.channelReady = !!(m.help && m.help.channelReady);
      if (m.help) renderHelp(m.help);
      renderStatus();
      return;
    }

    if (m.type === 'status') {
      S.connected = !!m.connected; S.live = !!m.live; S.transport = m.transport || S.transport;
      S.portOpen = m.portOpen !== undefined ? !!m.portOpen : S.portOpen;
      S.wifiDownlink = m.wifiDownlink !== undefined ? !!m.wifiDownlink : S.wifiDownlink;
      S.downlinkKind = m.downlinkKind !== undefined ? m.downlinkKind : S.downlinkKind;
      S.device = m.device !== undefined ? m.device : S.device;
      S.deviceId = m.deviceId || S.deviceId; S.deviceMac = m.deviceMac || S.deviceMac;
      S.deviceVerified = m.deviceVerified ?? S.deviceVerified;
      S.expectedDeviceId = m.expectedDeviceId || S.expectedDeviceId;
      S.lastDataAt = m.lastDataAt !== undefined ? m.lastDataAt : S.lastDataAt;
      S.boardTs = m.boardTs || S.boardTs; S.boardIso = m.boardIso || S.boardIso;
      S.seq = m.seq ?? S.seq;
      S.stale = !!m.stale;
      S.reportPaused = !!m.reportPaused;
      COLLECT.reportPaused = !!m.reportPaused;
      // 串口状态变化会直接影响「回应能否送达」
      HELP.channelReady = !!m.portOpen;
      renderHelpChannel();
      if (m.config) {
        els.chkAuto.checked = !!m.config.autoReconnect;
        els.baudSelect.value = String(m.config.baudRate || 115200);
      }
      renderStatus();
      renderCollectMode();
      return;
    }

    if (m.type === 'sample') {
      S.stale = false; S.live = true;
      S.deviceId = m.device_id || S.deviceId; S.deviceMac = m.device_mac || S.deviceMac;
      S.deviceVerified = m.device_verified ?? S.deviceVerified;
      S.expectedDeviceId = m.expectedDeviceId || S.expectedDeviceId;
      S.boardTs = m.board_ts != null ? m.board_ts : S.boardTs;
      S.boardIso = m.board_iso || S.boardIso; S.seq = m.seq ?? S.seq;
      S.lastDataAt = m.ts || Date.now();
      renderSample(m.fields || {}, m.ts);
      renderStatus();
      return;
    }

    // 远程采集：请求状态变化（创建/下发/回执/完成/超时）
    if (m.type === 'collect') {
      renderCollect(m.request);
      return;
    }

    // 教学求助：状态变化（收到求助 / 回应下发 / 板端回执 / 取消）
    if (m.type === 'help') {
      HELP.channelReady = !!(m.help && m.help.channelReady);
      renderHelp(m.help);
      return;
    }

    if (m.type === 'stale') {
      S.live = false; S.stale = true;
      S.lastDataAt = m.lastDataAt || S.lastDataAt;
      S.boardTs = m.boardTs != null ? m.boardTs : S.boardTs;
      renderStatus();
      return;
    }

    if (m.type === 'cleared') {
      S.connected = false; S.live = false; S.stale = false; S.transport = null; S.device = null;
      S.deviceId = null; S.deviceMac = null; S.deviceVerified = null; S.expectedDeviceId = null;
      S.lastDataAt = null; S.boardTs = null; S.boardIso = null; S.seq = null; S.portOpen = false;
      clearAllData();
      renderStatus();
      return;
    }

    if (m.type === 'raw') { appendRaw(m.ts, m.text, m.ok); return; }
    // 服务端把原始日志按 250ms 合并成批，这里一次性入队（appendRaw 内部还会再合并到一帧）
    if (m.type === 'raw-batch') {
      for (const it of (m.items || [])) appendRaw(it.ts, it.text, it.ok);
      return;
    }
  };

  ws.onclose = () => {
    S.connected = false; S.live = false; S.device = null; S.lastDataAt = null; S.portOpen = false;
    clearAllData(); renderStatus();
    setTimeout(connect, 1500);
  };

  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

loadPorts();
setInterval(loadPorts, 4000);
renderStatus();
loadCollect();
renderCollectMode();
loadHelp();
connect();

})();
