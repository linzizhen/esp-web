# 四周课程目标核对报告

> 核对日期：2026-10-08　项目：ESP32-S3-EYE 三轴 IMU 监控平台（`imu-monitor`）
> 核对方式：代码审查（server.js / 固件 main.c / 前端）+ 测试套件实跑（238 项断言全过）+ 实物验证记录
> 测试现状：`nl-config 44 / nl 37 / help 26 / storage 19 / help-persist 17 / p0-dedup 14 / e2e 14 / feature 14 / acceptance 12 / parse 10 / ws 9 / theme 6 / help-ui 6 / verify 6 / isolation 4` 全过（入口 `npm test`，编排器 `test/run-all.js`；`e2e` 由编排器注入 `E2E_PORT=8099` 走隔离模式）。

---

## 一、项目部署结构（核对基础）

```
imu-monitor/
├─ firmware/s3eye_imu_idf/     固件（ESP-IDF）：IMU 采集 + 按键 + LCD/LED + 摄像头
│   └─ main/main.c             采集上报 / 按键状态机 / UI 任务 / 命令处理
├─ server.js                   服务端（Node）：接收→存储→各业务接口，串口/WiFi 双通道
│   ├─ 接收  POST /api/data            （串口优先，串口在线忽略 WiFi）
│   ├─ 查询  GET  /api/records(.csv)   /api/devices   /api/state
│   ├─ 采集  POST/GET /api/collect     （第2周状态机）
│   ├─ 求助  GET/POST /api/help        （第3周）
│   ├─ 自然语言 GET/POST /api/nl       （第4周）
│   └─ 其他  /api/cam(.mjpg/.jpg/snapshot)  /api/connect /api/disconnect /api/config /api/diag /api/ports /api/probe /api/record
├─ public/                     前端 SPA（hash 路由 6 页）
│   └─ live 实时监控 / collect 远程采集 / help 教学求助 / cam 摄像头 / records 记录与设备 / ask 自然语言
├─ data/records.ndjson         落盘记录（appendFileSync，轮转）
├─ test/                       9 个测试套件 + 隔离实例夹具
└─ docs/                       各周设计文档
```

---

## 二、逐项核对

### 第 1 周：真实传感数据采集工程 —— ✅ 已完成

| 要求 | 状态 | 证据 |
|---|---|---|
| 编译烧录 | ✅ | `package.json` 脚本 `firmware:build / firmware:flash`（走 `scripts/idfwrap.py`，前台执行） |
| 单位与时间核对 | ✅ | 「来源与时间核对」面板 `index.html:120-126`（板到时间 / 服务端收到 / **时间偏差** / 最近更新）；单位映射 `server.js:69 fieldUnits` |
| VPS 最小接收/存储/查询 | ✅ | 接收 `server.js:2025 /api/data`；存储 `data/records.ndjson`；查询 `server.js:1588 /api/records`、`1608 /api/records.csv`、`1601 /api/devices` |
| Web 展示页面 | ✅ | 实时监控页 `live`（三轴卡片 + 姿态球 + 趋势曲线 + 来源面板） |
| 无数据与失败状态显示 | ✅ | 停采保留 `goStale`（`server.js:732`）、离线清空 `goOffline`（`server.js:710`）、图表「等待设备数据」提示、`e2e` 测试覆盖（停采后 live=false/保留末次值） |
| 数据来自本组设备 | ✅ | `deviceVerified` 校验（`server.js:63-67`，`expectedDeviceId=S3EYE-GROUP01`，不匹配前端提示「⚠ 非本组设备」） |
| 页面未写死数值 | ✅ | `index.html:115、151` 明确声明；数据全部来自 `S.history`/`fields` 实时推送，无任何硬编码数值 |

**差距**：无。

### 第 2 周：「采集一次最新数据」功能 —— ✅ 已完成

| 要求 | 状态 | 证据 |
|---|---|---|
| 任务创建/下发 | ✅ | `POST /api/collect`（`server.js:1714`）→ `createCollectRequest` |
| request_id 关联 | ✅ | `req-YYYYMMDD-HHMMSS-NNNN`，回执与新观测同环 |
| 设备回执 + 新观测回传 | ✅ | 回执 `acked`（`server.js:464-466`）；新观测 `completed`（`server.js:488`）带 `seq_before→seq_observed`、`checks.arrived_after_dispatch` |
| 已提交/设备接收/完成/失败/超时显示 | ✅ | 状态机 `submitted→dispatched→acked→completed/failed/timeout`（`server.js:305` 注释），前端 `renderCollect`（`app.js:633`）逐步渲染 |
| 关机（无响应）测试 | ✅ | `collectTimeoutMs` 超时 → `timeout`（`server.js:499-501`），`acceptance`/`feature` 测试覆盖 |
| 重复点击防护 | ✅ | 下发中 `btnCollect.disabled = true`（`app.js:778-787`） |
| 旧值不得改标为本次完成 | ✅ | 只展示带 `request_id` 的新观测（`app.js:587` 注释「绝不拿数据库里的旧值冒充本次结果」） |

**差距**：无。

### 第 3 周：按键触发与物理反馈闭环 —— ✅ 已完成

| 要求 | 状态 | 证据 |
|---|---|---|
| 按键/触摸触发 | ✅ | `btn_task`（ADC 电阻分压 GPIO1，自适应校准 + 75ms 去抖，`main.c:746`） |
| 本地确认（屏幕/灯光） | ✅ | LED 快闪（开漏 GPIO3）+ LCD 屏幕「求助已发送」（`ui_task`，`main.c:791`） |
| VPS 接收 | ✅ | 板端 `send_help_event` → 服务端 `onHelpEvent`（`server.js:570`） |
| 查看者回应 | ✅ | 网页点「我已收到」→ `viewer_ack` → 板端显示「对方已收到」（`s_scr=2`） |
| 取消机制 | ✅ | 求助中再按键 → `cancel`（`main.c:713-717`） |
| 断网时本地仍可确认触发 | ✅ | `send_help_event` 双通道：`printf` 串口（无条件）+ `http_post` WiFi（失败不影响本地）。**2026-09-30 断网实物验证通过**（seq 连续无回退，修复了 btn 栈溢出 `70c1f00`） |
| 无远端证据不显示「对方已收到」 | ✅ | 仅当收到 `viewer_ack` 才置 `s_scr=2`（`main.c:1241-1247` 条件 `if s_help == HELP_SENT`） |

**差距**：第 2 项「网页点我已收到 → 板端显示对方已收到」已有测试断言（`help-test.js` 26 项）+ 服务端 4 组 `received→cancelled` 证据，但**尚未做过一次纯实物目验**（低成本可补）。

### 第 4 周：自然语言助手 —— ✅ 已完成

| 要求 | 状态 | 证据 |
|---|---|---|
| 区分「查看上次」vs「重新采集」 | ✅ | `query_last`（读历史，保留旧时间）vs `collect_once`（发指令等新结果），见 `docs/week4-nl-assistant.md` |
| 查询/采集封装为受限工具 | ✅ | 工具白名单 `query_last` / `collect_once` |
| 参数与设备范围校验 | ✅ | 设备白名单统一闸门 `nlValidateDevice`（白名单外一律拒绝） |
| 歧义处理 | ✅ | 只说「数据」→ `ambiguous`，澄清两个可选任务，不执行 |
| 无设备完成证据不回复「已采集成功」 | ✅ | `nlRunCollectOnce` 只有 `completed`（回执+新观测同 request_id）才说成功；`timeout/failed` 如实报「未能确认采集完成」 |
| 位置不生成坐标 | ✅ | `location_query` → 如实说明不提供，回复无经纬度（测试断言） |
| 备用路径（LLM 未配置） | ✅ | 两级解析：LLM（OpenAI 兼容，密钥留服务端 `config.local.json`）优先 → 规则兜底，`engine` 字段如实标注 |

**差距**：LLM 真实模型调用**待凭据**（当前 `engine: rule` 兜底已覆盖全部当堂验证；填 `config.local.json` 即启用，无需改代码）。

---

## 三、测试与文档覆盖

- **测试**：15 个测试文件 238 项断言全过（含 `nl-test.js` 37、`nl-config-test.js` 44、`help-test.js` 26、`help-persist-test.js` 17、`theme-contract-test.js` 6），入口 `npm test`（编排器 `test/run-all.js`）。`e2e` 由编排器注入 `E2E_PORT=8099` 走隔离模式。测试纪律见 §5.6（隔离实例防真实设备污染）。
- **文档**：`week2-remote-collect.md`、`week3-button-feedback.md`、`week4-nl-assistant.md`、`week4-test-guide.md` + 截图。

---

## 四、按优先级的补充/修复任务清单

> 四周**核心功能全部完成**（无 P0 阻断项）。以下为排查中发现的工程改进项，按影响排序。

**P1 — 稳健性/演示体验（建议处理）**

1. **摄像头开启推流会导致板子重启**（2026-09-30 实测 10 秒内重启 3 次）
   - 现象：下发 `cam_on` 后板子反复复位，并拖垮帧率至 1 帧/秒
   - 缓解：已加「无观众自动停流」看门狗（`42a2d90`，60s 无观众自动 `cam_off`）
   - 待办：根治（排查供电/PSRAM 帧缓冲/任务栈），或文档明确「演示时避免开摄像头」

2. **固件 WiFi 上传失败率约 34%**，且每次失败要 `select()` 超时（3-5s）阻塞主循环
   - 后果：帧率被拖到 1.3–1.75 帧/秒上限
   - 待办：把上报 HTTP POST **异步化**（独立任务 + 队列），主采集循环不阻塞

3. **第 3 周 viewer_ack 实物验证补一次**（网页点「我已收到」→ 板端显示「对方已收到」）
   - 现状：有测试断言 + 服务端证据，缺一次纯实物目验（约 1 分钟）

**P2 — 功能增强（不阻塞）**

4. **LLM 真实模型接入**：拿到授权 endpoint+key 填 `config.local.json` 即可（代码零改动）
5. **help 事件落盘**：当前只存服务端内存，服务重启即清空；建议落盘以便留证
6. **屏幕空闲画面**已改亮蓝底 + 实时数值（`ee02d7e`），若需可再调样式

**已知约束（非缺陷，记录备查）**
- 串口必须保持有人读（板子每帧 `printf`，主机断开串口会缓冲满阻塞 → 帧率暴跌）
- 串口优先策略会忽略 WiFi 上报（避免数据源混乱）

---

## 五、结论

| 周 | 结论 |
|---|---|
| 第 1 周 | ✅ 已完成 |
| 第 2 周 | ✅ 已完成 |
| 第 3 周 | ✅ 已完成（实物验证 2026-09-30 通过；viewer_ack 实物目验可补） |
| 第 4 周 | ✅ 已完成（LLM 真实模型待凭据，备用路径已如实实现） |

四周课程目标**全部达成**，核心功能均有代码证据、测试断言与实物验证记录。P1 三项为工程稳健性改进（摄像头重启、上传异步化、viewer_ack 实物验证），不影响当堂验证。
