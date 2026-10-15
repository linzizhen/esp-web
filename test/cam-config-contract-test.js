'use strict';
/** 摄像头固定配置契约（静态检查，0.1s，不起服务、不碰硬件）
 *
 * 背景（2026-10-15 实测）：页面上原先让用户自选「直播分辨率 / 画质 / 帧率 /
 * 抓拍分辨率」四档，但实测证明这些选择多数是陷阱：
 *
 *   分辨率        实测帧率   单帧     带宽      结论
 *   240x240       6.3 帧/秒  7.4 KB   374 kbps  可用
 *   320x240       6.7 帧/秒  9.3 KB   497 kbps  ★ 最优点
 *   400x296       1.7 帧/秒  13.9 KB  188 kbps  带宽崩溃
 *   640x480       0   帧/秒  —        —         完全卡死
 *
 * 帧率档位更是形同虚设：选 15fps 实测仅 3.9 帧/秒（链路带宽决定实际上限，
 * 配置值不生效）。而选 640x480 会让摄像头彻底卡死（实测卡 236 秒无新帧，
 * 且 streaming 状态仍为 true，界面不报错）—— 根因是帧缓冲在 init 时按
 * QVGA 写死：cam_hal.c 的 recv_size = width*height/5 = 320*240/5 = 15360 字节，
 * 运行时 set_framesize() 只改传感器寄存器、不重分配缓冲。
 *
 * 因此改为固定最优配置，移除用户可调项。本测试守住这个契约，防止日后
 * 有人把下拉框加回来（或把默认值改到会崩的档位）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const camStream = fs.readFileSync(
  path.join(ROOT, 'firmware', 's3eye_imu_idf', 'main', 'cam_stream.c'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

console.log('\n— 摄像头固定配置契约 —\n');

/* ---------- 1) 页面不再提供需要用户选择的配置项 ---------- */
const removedSelects = ['camSize', 'camQuality', 'camFps', 'camShotSize'];
const stillThere = removedSelects.filter((id) => new RegExp(`id="${id}"`).test(html));
check('页面已移除四个配置下拉框', stillThere.length === 0,
  stillThere.length ? `仍在页面：${stillThere.join(', ')}` : 'camSize / camQuality / camFps / camShotSize 均已移除');

check('页面已移除「应用参数」按钮', !/id="btnCamApply"/.test(html),
  /id="btnCamApply"/.test(html) ? '按钮仍在' : 'btnCamApply 已移除');

/* ---------- 2) app.js 不再引用被移除的元素 ---------- */
const appRefs = removedSelects.filter((id) => new RegExp(`\\$\\(['"]${id}['"]\\)`).test(app));
check('app.js 不再引用被移除的元素', appRefs.length === 0,
  appRefs.length ? `仍引用：${appRefs.join(', ')}` : '无残留引用');

/* ---------- 3) 固件默认值必须是实测最优点（320x240 / 质量12 / 10fps）---------- */
/* 帧缓冲按 QVGA 分配，故 CAM_DEF_FRAMESIZE 必须是 6（QVGA 320x240），
 * 否则 init 时算出的 recv_size 与实际输出分辨率不匹配 → 高分辨率必崩。 */
const fsMatch = /#define\s+CAM_DEF_FRAMESIZE\s+\((\d+)\)/.exec(camStream);
check('固件默认分辨率 = QVGA(6)，与帧缓冲分配一致',
  !!fsMatch && fsMatch[1] === '6',
  fsMatch ? `CAM_DEF_FRAMESIZE = ${fsMatch[1]}` : '未找到 CAM_DEF_FRAMESIZE');

/* 质量 12 是实测在带宽与清晰度之间的平衡点 */
const qMatch = /#define\s+CAM_DEF_QUALITY\s+\((\d+)\)/.exec(camStream);
check('固件默认画质 = 12（实测平衡点）',
  !!qMatch && qMatch[1] === '12',
  qMatch ? `CAM_DEF_QUALITY = ${qMatch[1]}` : '未找到 CAM_DEF_QUALITY');

/* 帧率 10：实测上限约 6.7，设 10 让任务不被帧率人为限制，由链路决定 */
const fpsMatch = /static\s+int\s+s_cam_fps\s*=\s*(\d+)/.exec(
  fs.readFileSync(path.join(ROOT, 'firmware', 's3eye_imu_idf', 'main', 'main.c'), 'utf8'));
check('固件默认帧率 = 10', !!fpsMatch && fpsMatch[1] === '10',
  fpsMatch ? `s_cam_fps = ${fpsMatch[1]}` : '未找到 s_cam_fps');

/* ---------- 4) 前端不再下发直播参数（唯一真源是固件默认值）---------- */
/* 设计：固件默认值（cam_stream.c 的 CAM_DEF_FRAMESIZE / CAM_DEF_QUALITY 与
 * main.c 的 s_cam_fps）就是最优配置，前端只发 start/stop，不传任何参数 ——
 * 避免前端与固件两处配置漂移。
 * 例外：抓拍（action:'shot'）合法地携带 framesize —— 那是单张高清快照，
 * 与直播参数无关。服务端的 cam_set 路径也**保留**，它是排查问题的重要工具
 * （可用 curl 直接验证各档位行为），只是前端不再使用。 */
const usesSetAction = /action:\s*'set'/.test(app);
check('前端不再使用 action:set 下发直播参数', !usesSetAction,
  usesSetAction ? 'app.js 仍在下发 set' : '前端只发 start/stop/shot');

const sendsLiveQuality = /quality\s*:/.test(app);
check('前端不传直播画质', !sendsLiveQuality,
  sendsLiveQuality ? 'app.js 仍在传 quality' : '画质由固件默认值决定');

/* 服务端的调试路径应当保留（不因「移除用户配置」而一并删掉） */
check('服务端保留 cam_set 调试路径', /'cam_set'/.test(server),
  /'cam_set'/.test(server) ? 'cam_set 仍可用（便于 curl 排查）' : 'cam_set 被误删');

/* ---------- 5) 缓存版本号 ---------- */
check('index.html 带 app.js 缓存版本号', /app\.js\?v=\d+/.test(html),
  (/app\.js\?v=(\d+)/.exec(html) || [])[0] || '缺少');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
