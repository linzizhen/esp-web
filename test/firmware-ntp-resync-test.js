/* 固件「NTP 对时补做」契约（静态检查，不需要开发板）
 *
 * 存在理由：2026-11-27 实测发现 data/records.ndjson 全部 6036 条记录的
 * board_ts / board_iso / skew_ms 都是 null。根因是 time_sync() 只在
 * app_main 里 wifi_wait(15000) 成功之后调用一次 —— 本次开机 WiFi 没连上，
 * 于是永远不对时，build_frame 里 `if (t > 1700000000)` 那道闸门一直不成立，
 * 帧里就一直没有 ts/iso 字段。
 *
 * 后果正好打在第 1 周与第 7 周的验收项上：
 *   - 第 1 周「核对单位与时间」失去板端时刻，只剩服务端接收时刻；
 *   - 第 7 周「带采集时间的输入样例」只剩 captured_at（JPEG 到站时刻）。
 *
 * 本测试锁住四条约定：
 *   ① 拿到 IP（IP_EVENT_STA_GOT_IP）时，如果板端时间仍然无效，要补做一次对时；
 *   ② 补做不能直接在事件处理函数里同步调用 time_sync() —— 它最多阻塞 15 秒
 *      （30 × 500ms 轮询），会堵住 esp_event 事件循环，连带拖死重连与下行命令；
 *   ③ 只补做一次（一次性标志），避免每次重连都拉起新任务；
 *   ④ 时间已经有效时不重复对时（省掉 15 秒空等）。
 *
 * 用法：node test/firmware-ntp-resync-test.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'firmware', 's3eye_imu_idf', 'main', 'main.c'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* 按花括号配平抽函数体（跨过字符串里的括号：代码里没有 '{' 字面量） */
function fnBody(src, name) {
  const at = src.indexOf(name);
  if (at < 0) return '';
  const start = src.indexOf('{', src.indexOf(')', at) >= 0 ? src.indexOf(')', at) : at);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const handler = fnBody(SRC, 'static void wifi_event_handler(');
const appMain = fnBody(SRC, 'void app_main(');

/* ★ time_sync 现在有前置声明（`static void time_sync(void);`），
 * 直接用 fnBody 会命中声明、把后面第一个函数体当它的，断言就假绿了。
 * 这里按「声明+换行+{」精确定位定义体。 */
function timeSyncDefBody(src) {
  const m = /static\s+void\s+time_sync\s*\(\s*void\s*\)\s*\r?\n\s*\{/.exec(src);
  if (!m) return '';
  const start = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}
const timeSync = timeSyncDefBody(SRC);

console.log('=== 固件「NTP 对时补做」契约 ===\n');

/* ---------- ① GOT_IP 时补做对时 ---------- */
const gotIpAt = SRC.indexOf('IP_EVENT_STA_GOT_IP');
const gotIpBranch = gotIpAt >= 0
  ? SRC.slice(gotIpAt, SRC.indexOf('}\n}', gotIpAt) >= 0 ? SRC.indexOf('}\n}', gotIpAt) : gotIpAt + 2000)
  : '';

check('GOT_IP 分支存在', gotIpAt >= 0);
check('GOT_IP 分支里安排了补做对时',
  /ntp_resync|time_sync|NTP 补做|补做对时/.test(gotIpBranch),
  gotIpBranch ? (gotIpBranch.match(/.*(?:ntp_resync|time_sync|补做对时).*/) || [''])[0].trim().slice(0, 80) : '');

/* ---------- ② 不得在事件处理里同步阻塞 ---------- */
check('事件处理函数里没有直接调用 time_sync()（会阻塞事件循环）',
  !/time_sync\s*\(\s*\)/.test(handler),
  /time_sync\s*\(\s*\)/.test(handler) ? '发现直接调用' : '');

check('改为拉起一次性任务做对时',
  /xTaskCreate\s*\(\s*ntp_resync_task/.test(SRC),
  (SRC.match(/xTaskCreate\s*\(\s*ntp_resync_task[^;]*;/) || [''])[0].slice(0, 100));

check('存在 ntp_resync_task 任务函数',
  /static\s+void\s+ntp_resync_task\s*\(\s*void\s*\*/.test(SRC));

/* ---------- ③ 只补做一次 ---------- */
check('有一次性的「已补做」标志',
  /static\s+(?:volatile\s+)?(?:bool|int)\s+s_ntp_resynced/.test(SRC),
  (SRC.match(/static\s+(?:volatile\s+)?(?:bool|int)\s+s_ntp_resynced[^;]*;/) || [''])[0]);

const resyncTask = fnBody(SRC, 'static void ntp_resync_task(');
check('补做任务里先置位标志再对时（防止重复拉起）',
  /s_ntp_resynced\s*=\s*true/.test(resyncTask),
  resyncTask ? '' : '(未找到任务函数体)');

/* ---------- ④ 时间已有效就不重复对时 ---------- */
check('补做前先检查板端时间是否仍然无效',
  /time\s*\(\s*(?:&|NULL)/.test(resyncTask) || /now\s*<\s*1700000000/.test(resyncTask),
  (resyncTask.match(/.*1700000000.*/) || [''])[0].trim().slice(0, 80));

/* ---------- ⑤ 回归保护：原有一次性对时仍在 ---------- */
check('app_main 里仍然保留开机对时（WiFi 一开始就连上的正常路径）',
  /time_sync\s*\(\s*\)/.test(appMain),
  /time_sync\s*\(\s*\)/.test(appMain) ? '' : '开机对时被误删');

check('time_sync() 仍然按 1700000000 判有效期',
  /1700000000/.test(timeSync),
  (timeSync.match(/.*1700000000.*/) || [''])[0].trim().slice(0, 80));

check('time_sync() 可被重复调用（esp_sntp_init 不包 ESP_ERROR_CHECK）',
  !/ESP_ERROR_CHECK\s*\(\s*esp_sntp_init\s*\(/.test(timeSync),
  /ESP_ERROR_CHECK\s*\(\s*esp_sntp_init/.test(timeSync)
    ? '重复初始化会 abort'
    : 'esp_sntp_init 返回值未强校验，重复调用安全');

/* ---------- ⑥ ★ 任务函数绝不能 return（2026-11-27 真机烧出来的回归） ----------
 * 第一版 ntp_resync_task 里写了 `if (now >= 1700000000) return;`，末尾也自然结束。
 * 真机现象：板子拿到 IP 后立刻 `E FreeRTOS: FreeRTOS Task "ntp" should not return,
 * Aborting now!` → abort() → rst:0xc，90 秒内重启 10 次，一个 JSON 帧都没发出来。
 * FreeRTOS 的任务函数返回即视为致命错误，必须 vTaskDelete(NULL) 自我删除。
 * ★ 统计前必须剥掉注释 —— 注释里为了解释这条坑本身就会写 "return"，否则测试自己把自己判红。 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const resyncCode = stripComments(resyncTask);
const bareReturns = (resyncCode.match(/\breturn\b/g) || []).length;
check('补做任务里没有裸 return（FreeRTOS 任务返回会 abort）',
  bareReturns === 0,
  bareReturns ? `发现 ${bareReturns} 处 return —— 板子会无限重启` : '');

check('补做任务用 vTaskDelete(NULL) 结束自己',
  /vTaskDelete\s*\(\s*NULL\s*\)/.test(resyncCode),
  (resyncCode.match(/vTaskDelete[^;]*;/) || [''])[0].trim());

check('补做任务的每条退出路径都删除了自己（vTaskDelete 出现 ≥2 次或为末句）',
  (resyncCode.match(/vTaskDelete\s*\(\s*NULL\s*\)/g) || []).length >= 1
  && /\}\s*$/.test(resyncCode.trim()),
  (resyncCode.match(/vTaskDelete\s*\(\s*NULL\s*\)/g) || []).length + ' 处');

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
