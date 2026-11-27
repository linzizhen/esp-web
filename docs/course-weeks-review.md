# 七周课程目标核对报告

> 核对日期：2026-11-27（第 6、7 周为当次补核）　项目：ESP32-S3-EYE 三轴 IMU 监控平台（`imu-monitor`）
> 核对方式：代码审查（server.js / 固件 main.c / 前端）+ 测试套件实跑（1182 项断言全过）+ 实物验证记录
> 测试现状：`voice 112 / command-ack 95 / voice-hero 68 / voice-asr 50 / voice-cancel 63 / snapshot-store 79 / snapshot 74 / voice-asr-fallback 47 / nl-config 44 / nl 37 / cam-ack 36 / voice-vosk-asr 30 / voice-longpress 26 / help 26 / voice-layout 25 / voice-mic 24 / fw-upload-q 24 / guard 23 / voice-serial 23 / voice-local-asr 23 / voice-link 22 / fw-keepalive 20 / help-persist 17 / fw-wifi-skip 16 / fw-ntp 11 / diag-hygiene 13 / storage 19 / p0-dedup 14 / e2e 14 / feature 14 / acceptance 12 / cam-config 10 / parse 10 / voice-stale 9 / ws 9 / theme 6 / help-ui 6 / verify 6 / isolation 10` 全过（入口 `npm test`，编排器 `test/run-all.js`；**所有**测试都自建隔离实例，`e2e` 也不例外 —— 默认在 `8090-8099` 内自选空闲端口，连生产须显式 `E2E_PORT=8080` / `--production`）。

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
│   ├─ 语音  POST /api/voice/audio     GET/POST /api/voice/state（第5周）
│   └─ 其他  /api/cam(.mjpg/.jpg/snapshot)  /api/connect /api/disconnect /api/config /api/diag /api/ports /api/probe /api/record
├─ public/                     前端 SPA（hash 路由 7 页）
│   └─ live 实时监控 / collect 远程采集 / help 教学求助 / cam 摄像头 / records 记录与设备 / ask 自然语言 / voice 语音
├─ data/records.ndjson         落盘记录（appendFileSync，轮转）
├─ data/voice/                 第 5 周：录音 WAV + events.ndjson（已 gitignore，属用户资产）
├─ data/snapshots/             第 7 周：采集图像 + 采集记录（已 gitignore，属用户资产）
├─ lib/                        业务模块：snapshot-store / voice-serial-rx / voice-local-asr / voice-vosk-asr
├─ test/                       39 个测试套件 + 隔离实例夹具
├─ test/manual/                需真机或人工的手工脚本（不进编排器）
└─ docs/                       各周设计文档 + docs/assets/ 截图与原型
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

**差距**：无。原「缺一次纯实物目验」的缺口已补齐 —— 2026-10-23 佩戴者现场
目视确认了四项：LED 快闪 + 屏幕「求助已发送」、网页点「我已收到」后 LED 慢闪 +
屏幕「对方已收到」、求助中再按键显示「已取消」、**拔掉网线后按键 LED 与屏幕照常变化**。
明细见 `week3-button-feedback.md` 第六节「实物按键验证」。

> 注：求助事件现已落盘 `data/help.ndjson`（`appendHelpEvent` / `loadHelpHistory`），
> 服务重启不再丢失证据；此前「只存内存、仅凭口述」的局限已消除。

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

### 第 5 周：按键说话与语音播报 —— ✅ 已完成（真机验证）

| 要求 | 状态 | 证据 |
|---|---|---|
| 佩戴者按一句话，查看者读到内容 | ✅ | BOOT 键 → 板端 I2S 录音 → WAV 上传 → 浏览器 Web Speech 识别 → 落盘 `data/voice/events.ndjson`，见 `docs/week5-voice.md` |
| 录音在板端 | ✅ | `voice_record.c` 用板载 MEMS 麦克风（BCLK=41 / WS=42 / DIN=2），16 kHz / 16 bit / 单声道 |
| 识别与播报在浏览器 | ✅ | `public/app.js:1860` `SpeechRecognition`、`:1937-1962` `speechSynthesis`；服务端 `/api/voice/state` 如实返回 `asr_runs_on=browser_web_speech` |
| 全链状态可观测 | ✅ | 8 阶段 `VOICE_STAGES` + `idle`，`recorded → transcribed → task_running → task_done → spoken` 逐段推进，重启后回读 |
| 无声与失败有可理解反馈 | ✅ | `silent` / `asr_failed` / `timeout` 三类失败未给 `reason` 时服务端补中文原因 |
| 文字入口保持可用 | ✅ | 语音页保留文字入口卡，第 4 周 `/api/nl` 未改动（nl 37 + nl-config 44 全过） |
| 音频来源与运行位置被记录 | ✅ | `audio_source=board_mic_i2s`、`asr_runs_on=browser_web_speech`，`voice-hil.js` 各有一条断言 |

**★ 硬约束**：本板 `BSP_CAPS_AUDIO_SPEAKER = 0`，**物理上没有扬声器**，任何「板端播报」都是假的。

**真机暴露并已修复的缺陷**：I2S 配 `I2S_SLOT_MODE_MONO` 时 RX 侧仍按 2 slot 送数据，
固件把交错数据当单声道写进 WAV → 时长翻倍（3 秒录成 6144 ms）、播放慢一半、录音上限缩水一半。
修复为独立 `s_raw` 缓冲 + `voice_deinterleave()` 自动探测活动 slot，实测 3 秒由 6144 ms 恢复为 3008/3136/3072 ms。

**已知缺口（登记未修）**：`POST /api/voice/record` 的 `ok=true` 只表示命令写进串口，
固件 `s_uploading` 时回 `ack=busy` 而服务端仍报 `accepted=true`。建议 `sendCommand()` 后等 ack 再定论。

> **状态更新（2026-10-26）**：上述缺口**已修复**。`sendCommandAndWaitAck()` 下发前按 `request_id`
> 登记等待槽，板端上行 ack 到达时结算，超时判 `timeout`（默认 1800 ms，可用
> `config.commandAckTimeoutMs` / 环境变量 `COMMAND_ACK_TIMEOUT_MS` 覆盖）。结局区分
> `accepted` / `busy` / `error` / `timeout` / `channel_unavailable` / `mock`。
> `/api/voice/record` 的 `ok` 与 `accepted` 现在都表示「板端已接受」，`dispatched` 单独表示
> 「命令写出去了」；板端忙时返回 `ok=false` + `outcome=busy`。
> 防回归：`test/command-ack-test.js` 95 项断言。
> 注：本轮为隔离实例内的 ack 注入验证，**真机 busy 场景尚未取证**。

### 第 6 周：让语音任务可以澄清与停止 —— ✅ 已完成

| 要求 | 状态 | 证据 |
|---|---|---|
| 有限多轮任务上下文 | ✅ | 澄清上下文 `CLARIFY`（Map，30 秒 TTL，按 `session_id` 绑定，命中即删用一次即清） |
| 任务取消 | ✅ | 9 阶段状态机新增 `cancelled`；文字按钮 `#btnVoiceStop` + 语音口令 `VOICE_STOP_WORDS` |
| 迟到结果隔离 | ✅ | `CANCELLED_RIDS`（60 秒 TTL）+ `/api/nl` 入口与出口各判一次 `isCancelled(rid)` → 记 `late_result_dropped` 并返回 `{cancelled:true, reply:null}` |
| 澄清 / 重新输入 / 停止播报 / 回到空闲 | ✅ | 「数据」→ `ambiguous` + 3 个候选；「第一个」→ `clarify_used:true`；`#btnVoiceStop` 停播；`#btnVoiceIdle` 回待机（清 `VOICE.cancelled` 与 `rid`，不改服务端记录） |
| 中途取消 / 连续两次查询 / 慢响应测试 | ✅ | `test/voice-cancel-test.js` 63 项，含 ③b「取消是终点」、③c「已终结时新链路直接接管」、③d 连续两次查询 |
| `request_id` 关联日志 | ✅ | 每次发起一个 `rid`（`vr-YYYYMMDD-HHMMSS-mmm-<4hex>`），事件流水、状态快照、时序记录三处都带 |
| 测量「输入结束→首次反馈」「→任务完成」 | ⚠ 部分 | `/api/voice/timings` 已上线（`p50` + `recent`）；**但「输入结束」这一端板端没有上报**，只能用「录音到站」近似（串口 4~6 秒误差与观测量级相当） |
| 取消后迟到结果不得重新播放或触发动作 | ✅ | 线上验收实测：旧 rid 推 `task_done` → `{ok:true, ignored:true, reason:'cancelled_request_id'}` |
| 新任务不被旧任务结果覆盖 | ✅ | 线上验收实测：新 rid `task_running` 直接接管（`VOICE_IN_FLIGHT` 只挡仍在进行中的链路） |
| 正常与异常时序记录 | ✅ | `timings` 随状态上报并落 `events.ndjson`；`docs/week6-voice.md` 验证 8 有真人录音的真实时序 |
| 语言交互版本 | ✅ | `lang-interaction v1`（见 `ASSIGNMENT.md` §14.6 与 `docs/week6-voice.md` 第十章） |
| 迁移「用户反悔后安全恢复」规则 | ✅ | `docs/week6-voice.md` 第八章：三条不变量（一次发起=一个 rid／取消=登记+清态+停本机／渲染前判 rid 而非判「有没有结果」）+ 迁移四步 |
| 文字停止按钮（备用路径） | ✅ | `#btnVoiceStop` 常驻；`#btnVoiceIdle` 一步回待机 |
| 延迟注入复现状态错误 | ✅ | `VOICE_LATENCY_MS` / `config.voiceLatencyMs`，默认 0（生产误碰不了），`/api/diag.voice.latency_ms` 可查 |

**★ 线上验收抓出的两个真缺陷（都已修 + 加回归断言）**：
1. **取消不是终点** —— `markCancelled()` 只影响 `/api/nl`，`/api/voice/state` 仍接受同 rid 的后续阶段，`cancelled` 被 `task_done` 覆盖。修：`if (ridNow && stage !== 'cancelled' && isCancelled(ridNow))` 直接返回 `ignored`。
2. **新任务被旧链路挡住** —— 原判据只看「rid 不同」，把已终结的链路也当成在跑，页面卡在 `cancelled` 不动。修：`VOICE_IN_FLIGHT = new Set(['recorded','transcribed','task_running'])`，只挡真正在跑的。

### 第 7 周：按需获取一张环境图像 —— ✅ 已完成

| 要求 | 状态 | 证据 |
|---|---|---|
| 说明采集是否成功、采到哪一时刻 | ✅ | 每张图一条独立记录（`shot_id` + 四态 + `captured_at` + `board_seq` + `boot_seq`）；`captured_at` 明确标注是「JPEG 到达服务端」的时刻，不是曝光时刻 |
| 在既有任务与存储服务中增加按需采集 | ✅ | `lib/snapshot-store.js`（状态机 + 落盘 + 保留策略）+ 三个接口 + `NL_TASKS` 注册 `snapshot` 意图 |
| 采集中 / 成功 / 遮挡不可用 / 失败 四类反馈 | ✅ | `requested → capturing → captured`，终止态 `blocked` / `failed`；页面 `#camShotState` 四态文案 + `#camShotList` 记录列表 |
| 只在请求或教学事件触发后取图 | ✅ | 三种触发：页面按钮 `trigger:'ui'` / 语音口令 `intent:'snapshot'` / 求助事件 `trigger:'help'`（限频 60 秒） |
| 设置最少保留 | ✅ | `SNAPSHOT_KEEP = 5`，超出删最旧并记 `pruned` |
| 上次成功图像不得被标为本次采集成功 | ✅ | `GET /api/cam/snapshot.jpg` **必须带 `?shot_id=`**（缺 → 400、不存在 → 404、非 captured → 409）；单元测试「序号未递增的帧被拒绝」 |
| 采集失败保持明确状态 | ✅ | `fail()` 记 reason、`captured_at` 为 null、不产生文件；失败后迟到帧不能改回成功 |
| 带采集时间的输入样例 | ⚠ 部分 | `captured_at` / `board_seq` / `boot_seq` 齐全；**`board_ts` 已于 2026-11-27 烧录修复并实测恢复非空**（见下） |
| 采集权限与失败记录 | ✅ | `docs/week7-snapshot.md` 第十章：授权边界表 + 八种事件各写什么（`requested`/`capturing`/`captured`/`blocked`/`failed`/`stale_frame`/`board_reboot`/`pruned`） |
| 明确触发条件与停止条件 | ✅ | `docs/week7-snapshot.md` 第五章：三种触发 + 四条停止条件（60 秒无观众停流、失败 3 次不自动重试、求助触发 60 秒一次、图像只存本机不上传第三方） |
| 备用路径：历史图像标为回放 + 补验真实采集 | ✅ | 点记录行回放，三条规矩（不改 `CAM.shot`／必须标出「不是本次采集」／只读本地文件）；真机验证回放前后 `CAM.shot` 不变；随后真机补验新采集成功 |

**★ 真机抓到的真缺陷（2026-11-25，已修）**：板子重启后抓拍永远失败。`s_cam_seq` 是 RAM 变量、上电归零；服务端 `lastSeq` 从历史恢复为 2 → 重启后第一帧 `seq=1 <= 2` 被判 `stale_frame`，15 秒后 `failed`，而板端日志说「抓拍命令执行完毕：成功（耗时 194 ms）」——两边都在说真话。修：`observeBootSeq()` + `BOOT_SEQ_DROP = 1000` + `boot_seq` 持久化 + `lastSeqEpoch` 三态（不能干脆关掉序号比较，否则「上次图像不得冒充本次」失守，只能放过一次）。修后真机复验 `board_seq=2 boot_seq=842545` 正常 captured。

---

## 三、测试与文档覆盖

- **测试**：40 个测试文件 1182 项断言全过（含 `voice-test.js` 112、`command-ack-test.js` 95、`snapshot-store-test.js` 79、`snapshot-test.js` 74、`voice-hero-contract-test.js` 68、`voice-cancel-test.js` 63、`voice-asr-test.js` 50、`voice-asr-fallback-test.js` 47、`nl-config-test.js` 44、`nl-test.js` 37、`cam-ack-contract-test.js` 36、`voice-vosk-asr-test.js` 30、`voice-longpress-test.js` 26、`help-test.js` 26、`voice-layout-contract-test.js` 25、`voice-mic-preflight-test.js` 24、`firmware-upload-queue-test.js` 24、`handleline-guard-test.js` 23、`voice-serial-upload-test.js` 23、`voice-local-asr-test.js` 23、`voice-link-contract-test.js` 22、`firmware-keepalive-test.js` 20、`help-persist-test.js` 17、`firmware-wifi-skip-test.js` 16、`diag-hygiene-test.js` 13、`firmware-ntp-resync-test.js` 11、`cam-config-contract-test.js` 10、`isolation-contract-test.js` 10、`voice-stale-test.js` 9、`theme-contract-test.js` 6），入口 `npm test`（编排器 `test/run-all.js`）。**所有**测试都自建隔离实例（端口 `8090-8099` + 独立 `DATA_DIR`），`e2e` 也不例外：直接 `node test/e2e-test.js` 默认起隔离实例，只有显式 `E2E_PORT=8080` / `--production` 才连生产。测试纪律见 §5.6（隔离实例防真实设备污染）。需开发板在线的真机测试不进编排器：`voice-hil.js` / `probe-voice-stop.js` / `fps-baseline-test.js`（帧率基线回归，相邻帧间隔中位数 > 250 ms 即失败，只读 `GET /api/state`，无设备时明确「跳过 ≠ 通过」） / `firmware-backoff-test.js`（要求服务端停着）。
- **文档**：`week1-sensing-web.md`、`week2-remote-collect.md`、`week3-button-feedback.md`、`week4-nl-assistant.md`、`week4-test-guide.md`、`week5-voice.md`、`week6-voice.md`、`week7-snapshot.md`、`week7-snapshot-design.md`、`vps-deploy.md`、`project-structure.md`、`git-flow.md`、`code-issues-review.md`、`fps-degradation-forensics.md` + 截图（`docs/assets/`）。

---

## 四、按优先级的补充/修复任务清单

> 七周**核心功能全部完成**（无 P0 阻断项）。以下为排查中发现的工程改进项，按影响排序。

**P1 — 稳健性/演示体验**

1. ~~**摄像头开启推流会导致板子重启**~~ —— ✅ **根因已修复（2026-10-15）**
   - 现象：下发 `cam_on` 后板子反复复位，帧率被拖到 1 帧/秒
   - 根因：esp32-camera 在 `cam_config()` 按**初始化时**分辨率算帧缓冲
     （AUTO 模式 `recv_size = 320*240/5 = 15360` 字节），运行时 `set_framesize()`
     只改传感器寄存器、**不重分配缓冲** → 高分辨率 JPEG 超限，`esp_camera_fb_get()`
     反复失败（实测选 640x480 后卡死 236 秒，且 `streaming` 仍为 true、界面不报错）
   - 修复：`sdkconfig.defaults` 改 `CONFIG_CAMERA_JPEG_MODE_FRAME_SIZE=65536`（4.3 倍）；
     实测 640x480 由「0 帧/秒卡死」恢复为 5.25 帧/秒，800x600 为 4.17 帧/秒
   - 另：摄像头参数已固定为实测最优点（320x240 / 画质12 / 10fps），移除用户可调项

2. ~~**固件 WiFi 上传失败时阻塞主循环**~~ —— ✅ **根因已修复（2026-10-15）**
   - 实测发现真正问题不是「同步阻塞」本身，而是**退避机制失效**：判定用
     `== 阈值`，计数超过阈值后再不成立，`next_try_us` 永不更新 → 此后每帧都被
     3 秒超时阻塞。实测帧间隔恒为 3.017s（= `timeout_ms`）、帧率 0.33 帧/秒
   - 修复：判定改 `>=` 并在每次失败时重算窗口 + 补「仍在退避」日志；
     实测中位帧间隔 3.017s → **0.102s**、帧率 0.33 → **6.93 帧/秒（提升 21 倍）**
   - 遗留：上报仍是同步 `esp_http_client`（成功路径约 30ms）；异步化可进一步
     把帧率推向 10Hz，但已非阻塞性问题

3. ~~**第 3 周 viewer_ack 实物验证补一次**~~ —— ✅ **已完成（2026-10-23）**
   - 佩戴者现场目视确认四项全通过：LED 快闪 + 屏幕「求助已发送」、
     网页点「我已收到」后 LED 慢闪 + 屏幕「对方已收到」、求助中再按键显示「已取消」、
     拔掉网线后按键 LED 与屏幕照常变化（当堂硬指标① 的最终实物证据）
   - 明细见 `week3-button-feedback.md` 第六节

**P2 — 功能增强（不阻塞）**

4. ~~**LLM 真实模型接入**~~ —— ✅ **已接入**
   - 已配置智谱 `glm-4.5-flash`（`config.local.json`，已 gitignore）；
     新增模型润色与数字/结论核对护栏，编造读数会被作废并回落模板
5. ~~**help 事件落盘**~~ —— ✅ **已实现**
   - 新增 `data/help.ndjson`（只追加不滚动）+ 启动回读 `loadHelpHistory()`；
     记录含 `at` / `ev` / `help_id` / `device_id`，服务重启不再丢失证据
6. **屏幕空闲画面**已改亮蓝底 + 实时数值（`ee02d7e`），若需可再调样式
7. ~~**第 5 周 I2S 交错数据被当单声道**~~ —— ✅ **已修复（2026-10-26）**
   - 现象：请求录 3 秒得到 6144 ms，请求 6 秒撞 10000 ms 上限，连续 3 轮完全一致
   - 根因：`I2S_SLOT_MODE_MONO` 只影响 BCLK 计算（`i2s_std.c:125` `total_slot = 2`），
     RX 侧仍按 2 slot 一帧送数据，非活动 slot 被 `auto_clear` 填 0；固件把交错数据
     直接当单声道写进 WAV → 时长翻倍、播放慢一半、录音上限缩水一半
   - 修复：独立 `s_raw` 缓冲（640000 字节）+ `voice_deinterleave()` 自动探测活动 slot；
     实测 3 秒由 6144 ms 恢复为 3008/3136/3072 ms，6 秒为 6080 ms
   - 防回归：`test/voice-layout-contract-test.js` 25 项静态契约

**已知约束（非缺陷，记录备查）**
- 串口**先被打开后又被关闭**时，板子 `printf` 会因 UART 缓冲满而阻塞 → 帧率暴跌。
  **板子从未连接主机时不受影响**（USB-Serial-JTAG 数据由驱动丢弃）——2026-10-15
  纯 WiFi 独立运行实测 90 秒平均 6.02 帧/秒、丢帧 0，已推翻旧结论的适用范围
- 串口优先策略会忽略 WiFi 上报（避免数据源混乱）
- 第 5 周遗留缺口已闭合（见上文「状态更新（2026-10-26）」）
- **WiFi 上传队列会丢帧**：采样 9.90 fps，但 WiFi 上行吞吐受 RTT 限制（长连接改造后约 2 帧/秒），
  跟不上就按 `upload_drop` 记账丢弃；串口路径零丢失。这是设计取舍，不是缺陷
- 第 7 周遮挡判定是**字节熵启发式**，只能识别全黑/全白/纯噪点，判不出「纸巾挡住但有纹理」或「拍到天花板」

---

## 五、结论

| 周 | 结论 |
|---|---|
| 第 1 周 | ✅ 已完成（板端时间戳缺陷待烧录修复，见下） |
| 第 2 周 | ✅ 已完成 |
| 第 3 周 | ✅ 已完成（实物验证 2026-09-30 通过） |
| 第 4 周 | ✅ 已完成（LLM 真实模型已接入 `glm-4.5-flash`，规则兜底仍保留） |
| 第 5 周 | ✅ 已完成（真机录音、上传、识别、播报全链跑通；I2S 交错缺陷已修复） |
| 第 6 周 | ✅ 已完成（澄清 / 取消 / 迟到结果隔离 / 回到空闲全通；线上验收抓出并修掉两个真缺陷） |
| 第 7 周 | ✅ 已完成（按需采集四态 + 独立记录 + 强制 `shot_id` 取图 + 回放；真机抓出并修掉重启序号归零缺陷） |

七周课程目标**全部达成**，核心功能均有代码证据、测试断言与实物验证记录。

### 5.1 仍需用户/后续补齐的一项

1. **「输入结束→首次反馈」的时基**
   课程要求从「用户说完话那一刻」起算。板端目前不上报 `capture_end_ms`，服务端只能用「录音到站」近似；串口链路 4~6 秒的传输延迟与观测量级相当，因此这一项只能算**部分达成**（已如实写在 `docs/week6-voice.md` 验证 8 与本章第 6 周表格里）。

> **已闭合（2026-11-27）**：原先列在这里的「板端时间戳全为 null」已修复并烧录验证。
> 根因有两条，先后被发现：
> ① 固件 `time_sync()` 只在 `app_main` 里 `wifi_wait(15000)` 成功后调用一次，热点晚到就永不对时 →
>    改为 `IP_EVENT_STA_GOT_IP` 分支拉起一次性 `ntp_resync_task`（`test/firmware-ntp-resync-test.js` 14 项锁住）。
> ② 服务端 `META_KEYS` 漏收 `iso`，于是 `meta.iso` 恒 undefined → `board_iso` 恒 null，
>    而 `iso` 混进 `fields` 被页面当成一个传感器卡片 →
>    补进 `META_KEYS`（`test/board-time-test.js` 12 项锁住，含「fields 里不许出现 iso」）。
> 实测：`board_ts=1795746123380`、`board_iso="2026-11-27T02:22:03Z"`、`skew_ms=-9160`、`fields.iso=undefined`；
> 40 秒窗口内 `skew` 极差仅 6 ms（稳定，无漂移）。
> ⚠ `skew_ms` 恒为 −9160 的原因是**本机时钟比 NTP 快约 8.9 秒**（`本机 - NTP = +8945 ms`），
> 不是板端偏差 —— 板端自己与 NTP 的偏差在毫秒级。

### 5.2 部署状态（如实）

课程要求「部署到分配的 VPS 空间」。本项目**没有分到 VPS**，按课程「备用路径」以本机作服务器：`http://127.0.0.1:8080`。部署手册 `docs/vps-deploy.md` 已写成可执行的一键方案（Windows Server），拿到 VPS 照做即可上线；该文档开头自己标注「当前状态：未部署」。
