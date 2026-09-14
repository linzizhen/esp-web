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

  chartField: $('chartField'), mainChart: $('mainChart'), chartHint: $('chartHint'),

  portSelect: $('portSelect'), baudSelect: $('baudSelect'),
  btnConnect: $('btnConnect'), btnDisconnect: $('btnDisconnect'), btnRefresh: $('btnRefresh'),
  chkAuto: $('chkAuto'),
  rawLog: $('rawLog'), btnClearLog: $('btnClearLog'),
  btnDiag: $('btnDiag'), diagOut: $('diagOut'),
  btnProbe: $('btnProbe'), btnRecord: $('btnRecord'),

  deviceSelect: $('deviceSelect'), limitSelect: $('limitSelect'),
  btnQuery: $('btnQuery'), btnCsv: $('btnCsv'), recordsTable: $('recordsTable'),
};

// ---------------------------------------------------------------- 状态
const S = {
  connected: false,
  live: false,
  stale: false,
  portOpen: false,
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
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const labelOf = (k) => (S.meta.labels && S.meta.labels[k]) || k;
const unitOf = (k) => (S.meta.units && S.meta.units[k]) || '';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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

function imuEmpty(msg) {
  els.imuPanel.classList.remove('stale');
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

  const col = (axis) => {
    const a = axes[axis];
    const g = a.g != null ? a.g : null;
    const ms2 = a.ms2 != null ? a.ms2 : null;
    // 进度条：以 ±2g 为满量程，中心线为 0
    let barStyle = 'left:50%;width:0';
    if (g != null) {
      const w = clamp(Math.abs(g) / 2, 0, 1) * 50;
      barStyle = g >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
    }
    return `
      <div class="axis ${axis}">
        <div class="axis-top">
          <span class="axis-name ${axis}">${AXIS_LABEL[axis]}</span>
          <span class="axis-ms2">${ms2 != null ? fmtNum(ms2) : '—'} m/s²</span>
        </div>
        <div class="axis-g"><b>${g != null ? fmtNum(g) : '—'}</b><span class="u">g</span></div>
        <div class="axis-bar"><i style="${barStyle}"></i></div>
      </div>`;
  };

  els.imuPanel.classList.toggle('stale', !S.live);
  els.imuPanel.innerHTML = col('x') + col('y') + col('z');
  els.imuTag.textContent = S.live ? '实时' : '停采保留';
  els.imuTag.className = 'tag' + (S.live ? ' tag-ok' : ' tag-warn');

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
  els.chartField.innerHTML = '<option value="">—</option>';
  els.chartField.dataset.sig = '';
  els.chartHint.textContent = '选择字段查看其真实历史曲线。';
  needDraw = true;
}

// ---------------------------------------------------------------- 采样入库 + 渲染
function renderSample(fields) {
  renderImu(fields);

  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (!S.history.has(k)) S.history.set(k, []);
    const arr = S.history.get(k);
    arr.push({ t: Date.now(), v });
    const max = S.meta.historyMax || 600;
    if (arr.length > max) arr.splice(0, arr.length - max);
    if (!S.order.includes(k)) S.order.push(k);
  }

  // 同步曲线下拉框（含三轴字段）
  const cur = els.chartField.value;
  const numeric = S.order.filter((k) => S.history.has(k));
  const sig = numeric.join(',');
  if (els.chartField.dataset.sig !== sig) {
    els.chartField.dataset.sig = sig;
    els.chartField.innerHTML = numeric
      .map((k) => `<option value="${k}">${escHtml(labelOf(k))}${unitOf(k) ? ' (' + unitOf(k) + ')' : ''}</option>`)
      .join('') || '<option value="">—</option>';
    if (cur && numeric.includes(cur)) els.chartField.value = cur;
    else if (numeric.length) {
      // 默认优先选加速度字段（acc_*_g 优先），避免被其他数值字段抢占
      const pref = numeric.find((k) => k === 'acc_z_g')
        || numeric.find((k) => k === 'acc_x_g')
        || numeric.find((k) => k.startsWith('acc_'))
        || numeric[0];
      els.chartField.value = pref;
    }
  }
  needDraw = true;
}

// ---------------------------------------------------------------- 绘图
function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 300));
  const h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 200));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawMainChart() {
  const field = els.chartField.value;
  const { ctx, w, h } = fitCanvas(els.mainChart);
  ctx.clearRect(0, 0, w, h);

  const arr = field ? S.history.get(field) : null;
  if (!arr || arr.length < 2) {
    ctx.fillStyle = '#9aa5b5';
    ctx.font = '13px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(S.connected ? '等待设备数据…' : '设备未连接，无曲线', w / 2, h / 2);
    return;
  }

  // 加速度数据做 3 点滑动平均，滤除传感器固有高频噪声（QMA7981 14-bit ±2g
  // 噪声约 ±0.015g），静止曲线更平滑，但不丢失真实运动趋势。
  const isAcc = field.startsWith('acc_');
  const raw = arr.map(p => p.v);
  const smoothed = isAcc ? smooth(raw, 3) : raw;
  const pts = arr.map((p, i) => ({ t: p.t, v: smoothed[i] }));

  const padL = 58, padR = 14, padT = 16, padB = 26;
  const cw = w - padL - padR, ch = h - padT - padB;

  let min = Infinity, max = -Infinity;
  for (const p of pts) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
  if (min === max) { const d = Math.abs(min) * 0.05 || 1; min -= d; max += d; }
  const pd = (max - min) * 0.12;
  min -= pd; max += pd;
  // 加速度字段加最小 Y 轴跨度 0.5g，避免自动缩放过度放大正常噪声
  if (isAcc && max - min < 0.5) {
    const mid = (min + max) / 2;
    min = mid - 0.25; max = mid + 0.25;
  }

  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || (t0 + 1);
  const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * cw;
  const Y = (v) => padT + ch - ((v - min) / (max - min)) * ch;

  ctx.font = '11px Consolas, monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    const y = Y(v);
    ctx.strokeStyle = i === 0 ? '#d8dfe9' : '#eef1f6';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = '#8a94a6';
    ctx.fillText(fmtNum(v), padL - 8, y);
  }

  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) {
    const t = t0 + ((t1 - t0) * i) / 4;
    ctx.fillStyle = '#8a94a6';
    ctx.fillText(fmtTime(t).slice(0, 8), X(t), padT + ch + 7);
  }

  const grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
  grad.addColorStop(0, 'rgba(79,70,229,.20)');
  grad.addColorStop(1, 'rgba(79,70,229,0)');
  ctx.beginPath();
  ctx.moveTo(X(pts[0].t), Y(pts[0].v));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i].t), Y(pts[i].v));
  ctx.save();
  ctx.lineTo(X(pts[pts.length - 1].t), padT + ch);
  ctx.lineTo(X(pts[0].t), padT + ch);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill(); ctx.restore();

  ctx.beginPath();
  ctx.moveTo(X(pts[0].t), Y(pts[0].v));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i].t), Y(pts[i].v));
  ctx.strokeStyle = '#4f46e5'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.stroke();

  const last = pts[pts.length - 1];
  ctx.beginPath(); ctx.arc(X(last.t), Y(last.v), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#4f46e5'; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.stroke();

  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = '12px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#4b5563';
  ctx.fillText(`${labelOf(field)}${unitOf(field) ? ' / ' + unitOf(field) : ''}  ·  ${arr.length} 个真实采样点${isAcc ? '（已平滑）' : ''}`, padL + 2, 1);
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
  if (needDraw) { needDraw = false; drawMainChart(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.addEventListener('resize', () => { needDraw = true; });

// ---------------------------------------------------------------- 原始日志
function appendRaw(ts, text, ok) {
  const div = document.createElement('div');
  div.className = 'line' + (ok ? ' ok' : ' err');
  div.innerHTML = `<span class="ts">${fmtTime(ts)}</span>${escHtml(text)}`;
  els.rawLog.appendChild(div);
  while (els.rawLog.childElementCount > 300) els.rawLog.removeChild(els.rawLog.firstChild);
  els.rawLog.scrollTop = els.rawLog.scrollHeight;
}
els.btnClearLog.onclick = () => { els.rawLog.innerHTML = ''; };

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
els.chartField.onchange = () => { needDraw = true; };

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
      S.device = m.device || null; S.deviceId = m.deviceId || null; S.deviceMac = m.deviceMac || null;
      S.deviceVerified = m.deviceVerified ?? null; S.expectedDeviceId = m.expectedDeviceId || null;
      S.lastDataAt = m.lastDataAt || null; S.boardTs = m.boardTs || null;
      S.boardIso = m.boardIso || null; S.seq = m.seq ?? null;
      if (m.config) {
        els.chkAuto.checked = !!m.config.autoReconnect;
        els.baudSelect.value = String(m.config.baudRate || 115200);
      }
      (m.raw || []).forEach((r) => appendRaw(r.ts, r.text, r.ok));
      if (m.fields && Object.keys(m.fields).length) renderSample(m.fields);
      renderStatus();
      return;
    }

    if (m.type === 'status') {
      S.connected = !!m.connected; S.live = !!m.live; S.transport = m.transport || S.transport;
      S.portOpen = m.portOpen !== undefined ? !!m.portOpen : S.portOpen;
      S.device = m.device !== undefined ? m.device : S.device;
      S.deviceId = m.deviceId || S.deviceId; S.deviceMac = m.deviceMac || S.deviceMac;
      S.deviceVerified = m.deviceVerified ?? S.deviceVerified;
      S.expectedDeviceId = m.expectedDeviceId || S.expectedDeviceId;
      S.lastDataAt = m.lastDataAt !== undefined ? m.lastDataAt : S.lastDataAt;
      S.boardTs = m.boardTs || S.boardTs; S.boardIso = m.boardIso || S.boardIso;
      S.seq = m.seq ?? S.seq;
      S.stale = !!m.stale;
      if (m.config) {
        els.chkAuto.checked = !!m.config.autoReconnect;
        els.baudSelect.value = String(m.config.baudRate || 115200);
      }
      renderStatus();
      return;
    }

    if (m.type === 'sample') {
      S.stale = false; S.live = true;
      S.deviceId = m.device_id || S.deviceId; S.deviceMac = m.device_mac || S.deviceMac;
      S.deviceVerified = m.device_verified ?? S.deviceVerified;
      S.expectedDeviceId = m.expectedDeviceId || S.expectedDeviceId;
      S.boardTs = m.board_ts != null ? m.board_ts : S.boardTs;
      S.boardIso = m.board_iso || S.boardIso; S.seq = m.seq ?? S.seq;
      S.lastDataAt = m.recv_ts || Date.now();
      renderSample(m.fields || {});
      renderStatus();
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
connect();

})();
