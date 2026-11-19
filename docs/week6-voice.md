# 第 6 周：让语音任务可以澄清与停止

> 本文记录本周四件事的落地：**有限多轮上下文（澄清）**、**任务取消**、**迟到结果隔离**、**时序测量**。
> 所有数字都来自本机实跑，取证命令附在每节末尾，可复现。

---

## 一、本周问题的答案

| 课程问的问题 | 本项目的答案 | 依据 |
|---|---|---|
| 一句话被听错/说得太含糊时，助手怎么继续问？ | 只对「有多个合法解释」的情况反问一次，给出**两个候选**（来自 `NL_TASKS` 注册表，唯一真源），用户回「第一个/第二个/1/2/第二个」即可接上 | `server.js` `CLARIFY` + `takeClarify()`；`test/voice-cancel-test.js` ① 组 |
| 上下文能记多久？ | **30 秒**（`VOICE_CLARIFY_TTL_MS`，可用环境变量覆盖），且**用一次即清** —— 不会无限追问 | 同上，含过期用例 |
| 用户中途说「停」怎么办？ | 三条路都能停：① 页面上的**停止按钮**；② 说「停止 / 取消 / 别播了 / 不用了」等口令；③ 直接开始下一段录音 | `public/app.js` `voiceCancel()` + `VOICE_STOP_WORDS` |
| 已经发出去的请求还在路上，回来后会不会照样播报？ | **不会**。取消时把 `request_id` 登记进 `CANCELLED_RIDS`（60 秒），之后同 rid 的 `/api/nl` 一律丢弃并落事件 `late_result_dropped` | `server.js` `markCancelled()` / `isCancelled()` |
| 上一条任务的慢结果会不会盖掉新任务？ | **不会**。新链路用自己的 `request_id`；旧 rid 的状态推进被拒（`ignored:true, reason:'stale_request_id'`） | `server.js` `/api/voice/state` |
| 怎么量「输入结束 → 首次反馈」与「→ 任务完成」？ | 前端在链路起点记 `t0`、首次渲染记 `firstFeedbackMs`、任务完成记 `taskDone`，随状态推进上报 `timings`；服务端汇总成 `GET /api/voice/timings`（含 p50） | `voiceTimingsView()`；`test/voice-cancel-test.js` ④ 组 |
| 慢响应怎么稳定复现？ | **延迟注入**：只认 `VOICE_LATENCY_MS` 环境变量或 `config.voiceLatencyMs`，默认 0 —— 生产误碰不了 | `server.js:151-154`；`/api/diag.voice.latency_ms` 可查 |
| 日志怎么串起来？ | 全链路 `request_id`：状态推进、NL 请求、事件流水三处都带；`/api/voice/timings` 也按 rid 分组 | `VOICE_EVENT_FIELDS` 含 `request_id` |

---

## 二、状态机（8 → 9 个阶段）

```
idle
 └─ recorded ──► transcribed ──► task_running ──► task_done ──► spoken
      │              │                 │
      │              └─► asr_failed    └─► timeout
      ├─► silent
      └──────────────► cancelled ◄──────（任何阶段都可进入，且是终点）
```

- `cancelled` 是**终点**：进入之后同一条链路（同 `request_id`）的任何后续阶段都会被拒（`reason:'cancelled_request_id'`）。
  这条是本周线上实测抓出来的 —— 原实现只登记取消，仍接受同 rid 的 `task_done`，状态从 `cancelled` 变回 `task_done`，迟到的播报就跟着来了。
- `VOICE_IN_FLIGHT = {recorded, transcribed, task_running}`：只有这三个阶段算「在跑」，此时别的 rid 不许覆盖。
  其余（`cancelled / timeout / spoken / task_done / asr_failed / silent`）都已终结，新链路可直接接管。
  这条同样是实测抓出来的 —— 原判据是「rid 不同就拒」，把已终结的链路也当成在跑，于是**新任务必须先补一条 `recorded` 才解得开锁**，页面卡在 `cancelled` 不动。

---

## 三、接口清单（本周新增/改动）

| 接口 | 方法 | 作用 | 关键字段 |
|---|---|---|---|
| `/api/voice/state` | POST | 推进阶段（新增 `cancelled`；新增 `request_id` / `timings` 入参） | 被拒时回 `{ok:true, ignored:true, reason:'stale_request_id'|'cancelled_request_id', current_request_id}` |
| `/api/voice/timings` | GET | 时序汇总（`?limit=N`，默认 20） | `{ok, count, recent[], p50:{to_first_feedback_ms,to_task_done_ms}, inject_ms, cancelled_rids, clarify_sessions}` |
| `/api/nl` | POST | 新增 `request_id` / `session_id` 入参；`clarify` 回复；取消后丢弃 | 迟到 → `{ok:false, cancelled:true, intent:'cancelled', reply:null, note}`；模糊 → `clarify:{options:[{idx,intent,text}], ttl_ms, session_bound}`；澄清后 → `clarify_used:true, clarify_from` |
| `/api/diag` | GET | 新增 `voice:{latency_ms, cancelled_rids, clarify_sessions, clarify_ttl_ms}` | 用于当堂核对注入是否关闭 |

### 失败分支（全部有测试覆盖）

| 场景 | 行为 | 证据 |
|---|---|---|
| 取消后同 rid 打 `/api/nl` | 丢弃 + 落 `late_result_dropped`，不执行不播报 | ② 组 |
| 取消后同 rid 推进阶段 | 拒（`cancelled_request_id`），状态保持 `cancelled` | ③b 组 |
| 旧 rid 覆盖在飞的新链路 | 拒（`stale_request_id`） | ③ 组 |
| 上一条已终结，新 rid 直接推 `task_running` | 接受（不要求先补 `recorded`） | ③c 组 |
| 没有上下文却回「第一个」 | 仍判 `ambiguous`（不当成 unknown_intent） | ① 组 |
| 澄清上下文过期 | 判 `ambiguous`（重新问） | ① 组 |
| 澄清上下文跨 session | 接不上（按 session 隔离） | ① 组 |
| 非法 timings（负数/字符串） | 丢弃不落库，不夹紧成 0 | ④ 组 |
| 延迟注入未配置 | 请求是快的（`< LATENCY_MS`） | ⑤ 组 |

---

## 四、当堂验证（逐条实测）

### 验证 1：取消后迟到结果不得重新播放或触发动作

```powershell
cd D:\workBUDDY\esp32\imu-monitor
node .git-work\live-check-week6.js     # 仓库外的临时脚本，逻辑等价于下面三步
```

手动三步等价（服务端在 8080 跑着）：

```powershell
$rid = 'vr-20261118-090000-000-aaaa'
# ① 进入 task_running
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/voice/state -ContentType 'application/json' `
  -Body (@{ stage='task_running'; request_id=$rid } | ConvertTo-Json)
# ② 取消
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/voice/state -ContentType 'application/json' `
  -Body (@{ stage='cancelled'; request_id=$rid; reason='点停止' } | ConvertTo-Json)
# ③ 迟到的任务请求
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/nl -ContentType 'application/json' `
  -Body (@{ text='查看上次数据'; request_id=$rid; session_id='sess-1' } | ConvertTo-Json)
```

实测输出（2026-11-18）：

```
cancelled → 200 {"stage":"cancelled","reason":"线上验收：点停止"}
/api/nl → 200 {"ok":false,"cancelled":true,"request_id":"vr-20261118-090000-000-aaaa",
               "intent":"cancelled","reply":null,
               "note":"这次链路已被取消，结果按规则丢弃（不播报、不执行）"}
```

**判据**：`reply` 必须为 `null`（页面拿不到可播报的文本），且 `data/voice/events.ndjson` 多一条 `late_result_dropped`。

### 验证 2：新任务不被旧任务结果覆盖

```
新 rid task_running → 200 {"stage":"task_running","rid":"vr-20261118-090001-001-bbbb"}
旧 rid 推 task_done → 200 {"ok":true,"ignored":true,"reason":"cancelled_request_id",
                           "current_request_id":"vr-20261118-090001-001-bbbb"}
```

**判据**：状态仍是新 rid 的 `task_running`，旧 rid 的 `reply` 没有写进去。

### 验证 3：澄清上下文

```
「数据」        → intent=ambiguous, clarify.options=[{1,query_last,查看上次数据},{2,collect_once,重新采集一次}], ttl_ms=30000
「第一个」(同 session) → intent=query_last, clarify_used=true, clarify_from=第一个
「第一个」(别的 session) → intent=ambiguous
```

### 验证 4：慢响应（延迟注入）

```powershell
$env:VOICE_LATENCY_MS = '3000'
node server.js
# 另开一个窗口
Measure-Command { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/nl `
  -ContentType 'application/json' -Body (@{text='查看上次数据'} | ConvertTo-Json) }
```

`/api/diag.voice.latency_ms` 应显示 `3000`。**验证完务必去掉环境变量并重启**，否则生产每次问答都会多等 3 秒。

### 验证 5：时序读回

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/voice/timings?limit=5' | ConvertTo-Json -Depth 5
```

有真实链路跑过之后，`recent[]` 会带 `{request_id, audio_id, stage, at, timings}`，`p50` 给出两个时长的中位数。

---

### 验证 6：连续两次查询（第二句不被第一句顶掉）

课程要求测「连续两次查询」。关键窗口不是「两次都成功」，而是**第二句还在跑、第一句的结果刚回来**。

```
node test/voice-cancel-test.js        # ③d 组即这条
```

实测输出（2026-11-19）：

```
第一句查询走通                    -> query_last
第二句查询走通（不用等第一句结束）  -> collect_once
第二句在跑时，第一句的迟到结果被拒  -> stale_request_id
状态保留第二句的结果               -> vr-20260101-000007-0007 / 第二次的回复
```

**判据**：`/api/voice/state` 的 `request_id` 与 `reply` 必须是第二句的；第一句的 `task_done` 回 `ignored:true` 且理由为 `stale_request_id`。

### 验证 7：回到待机

点「停止」之后页面停在「已停止」是必要的（要让人看见结果被丢弃），但**不能停在那儿出不来**。
「回到待机」按钮调用 `voiceToIdle()`：清掉横幅、四段状态、取消标记与旧 request_id，页面回到
「待机 · 等你按键」。它**不改服务端阶段** —— 服务端那条 `cancelled` 是真发生过的事实。

清 `VOICE.rid` 是关键：不清的话，旧链路之后回来的任何东西都还有可能被当成当前链路；
清掉之后 `voiceStale()` 会把它们一律判成过期。

---

## 五、★ 真机/线上暴露的两个缺陷与修复（2026-11-18）

### 现象

线上验收（`live-check-week6.js`）第一次跑出两处不对：

```
③ 新 rid task_running → 200 {"stage":"cancelled","rid":"vr-...aaaa"}     ← 被旧链路挡住
   旧 rid 推 task_done → 200 {"stage":"task_done"}                        ← 取消了还往前走
```

### 根因

1. **旧 rid 守卫判据过宽**：`if (ridNow && voice.request_id && ridNow !== voice.request_id && stage !== 'cancelled' && stage !== 'recorded')` —— 只要 rid 不同就拒，**不看当前链路是否还在跑**。上一条已经 `cancelled`（终结），新链路仍被当成「旧 rid」拒绝，页面卡在 `cancelled` 不动。
2. **取消只是登记，没有封住同一条链路**：`markCancelled(rid)` 只影响 `/api/nl`，`/api/voice/state` 仍接受同 rid 的后续阶段，`cancelled` 被 `task_done` 覆盖。

### 修复

```js
// ① 新增「在飞」集合
const VOICE_IN_FLIGHT = new Set(['recorded', 'transcribed', 'task_running']);

// ② 已取消的链路不许再往前走（取消是终点）
if (ridNow && stage !== 'cancelled' && isCancelled(ridNow)) {
  return json(res, 200, { ok: true, ignored: true, reason: 'cancelled_request_id', ... });
}

// ③ 旧 rid 只不许覆盖「还在跑」的链路
if (ridNow && voice.request_id && ridNow !== voice.request_id
    && stage !== 'cancelled' && stage !== 'recorded'
    && VOICE_IN_FLIGHT.has(voice.stage)) {
  return json(res, 200, { ok: true, ignored: true, reason: 'stale_request_id', ... });
}
```

### 修复后实测

```
新 rid task_running → 200 {"stage":"task_running","rid":"vr-...bbbb"}      ✓ 接管成功
旧 rid 推 task_done → 200 {"ok":true,"ignored":true,"reason":"cancelled_request_id"}  ✓ 被拒
```

### 防回归

`test/voice-cancel-test.js` 新增 ③b（取消是终点，3 项）与 ③c（已终结时新链路直接接管，3 项）两组，共 **49 项**。

---

## 六、文件改动清单

| 文件 | 改动 |
|---|---|
| `server.js` | `VOICE_STAGES` +`cancelled`；`VOICE_IN_FLIGHT`；`CANCELLED_RIDS` / `markCancelled` / `isCancelled` / `pruneCancelled`；`CLARIFY` / `rememberClarify` / `takeClarify` / `CLARIFY_PICK_RE` / `CLARIFY_WORDS`；`TIMING_FIELDS` / `sanitizeTimings` / `p50` / `voiceTimingsView`；`VOICE_LATENCY_MS`；`/api/voice/state` 加 rid/timings 与两道守卫；`/api/voice/timings` 新路由；`/api/nl` 加 rid/session/澄清/迟到丢弃/延迟注入；`/api/diag` 加 `voice` 段 |
| `public/app.js` | `voiceToIdle()`（回到待机：清横幅/四段/取消标记与旧 rid，不动服务端阶段）；`VOICE_STOP_WORDS` / `voiceNewRequestId` / `voiceSessionId` / `voiceStale` / `voiceCancel`；`VOICE` 加 `rid/t0/firstFeedbackMs/cancelled`；`voicePostState` 自动补 rid 且取消后不再推进；`voiceTaskAndSpeak` 全链 `voiceStale` 守卫 + 澄清候选渲染 + `timings` 上报；`VOICE_EVENT_TEXT` 补 `cancelled` / `late_result_dropped` / `clarify_used` |
| `public/index.html` | 新增 `<button id="btnVoiceStop">停止</button>` 与 `<button id="btnVoiceIdle">回到待机</button>`；`app.js?v=45 → 47` |
| `test/voice-cancel-test.js` | 新增，**59 项** |
| `test/voice-test.js` | 五处「8 个阶段」→「9 个阶段」 |
| `test/run-all.js` | SUITES 加 `voice-cancel` |
| `docs/week6-voice.md` | 本文 |

---

## 七、备用路径与边界

### 没有硬件时怎么验证

- 全部 49 项都不需要板子：自建隔离实例（独立 `PORT` + `DATA_DIR`），用合成 WAV 与直接 HTTP 调用。
- 时序与延迟注入也能在无板子时验证（`VOICE_LATENCY_MS=3000` 即可稳定复现「任务还在路上」）。
- **文字停止按钮**就是课程要求的备用路径：不依赖麦克风、不依赖识别，点一下就走 `voiceCancel()`。

### 边界（如实写清，不夸大）

1. **停止不能中断已发出的 HTTP 请求**。服务端仍在跑那次 `/api/nl`，只是结果被丢弃。真要省算力得在服务端做可中断执行，本轮没做。
2. **`CANCELLED_RIDS` 只在内存**，60 秒 TTL。进程重启后登记表清空 —— 重启前发出的迟到请求不会再被认出。这是有意的取舍（不为 60 秒的登记表引入持久化）。
3. **澄清只支持「二选一」**。候选超过两个时不反问（直接判 `ambiguous` 让用户重说），因为「第三个」这类指代在语音里太容易听错。
4. **延迟注入是全局的**，不是按请求。它只用于课堂复现，生产必须保持 0（`/api/diag.voice.latency_ms` 可核对）。
5. **时序只覆盖前端能观测的三段**（到站 → 首次反馈 → 任务完成）。识别与播报各自的内部耗时只有总时长。
6. **「回到待机」只清页面**，服务端阶段仍是 `cancelled`。取消发生过就是发生过，不因为用户点了「回到待机」而被抹掉 —— 页面显示与服务端记录不能互相矛盾。

---

## 八、迁移：一条「用户反悔后安全恢复」的处理规则

课程要求「迁移一条『用户反悔后安全恢复』的处理规则」。以下是本项目的做法，可以原样搬到别的语音项目。

### 规则正文

> **用户说停、或点了停止，旧链路的一切结果一律作废；页面必须提供一步「回到待机」；
> 新任务用新的 request_id 直接接管，不必等旧链路收尾。**

### 三个必须同时成立的不变量

| 不变量 | 落地方式 | 少做会怎样 |
|---|---|---|
| 一次发起 = 一个 request_id | 前端 `voiceNewRequestId()` 生成，随每次状态上报与 `/api/nl` 一起带 | 没有 rid 就无法区分「这次的结果」和「上一次迟到的结果」，只能靠时间猜 |
| 取消 = 登记 + 清态 + 停本机 | 服务端 `markCancelled(rid)`；前端 `VOICE.cancelled`、暂停播放、`speechSynthesis.cancel()` | 只停播放不停登记：迟到的 `/api/nl` 照样执行并写 reply，播报跟着来 |
| 渲染前判 rid，而不是判「有没有结果」 | 每个 `await` 之后 `if (voiceStale(rid)) return;` | 判「有结果就渲染」时，晚到的旧结果会直接盖掉新任务 |

### 迁移到别的项目时的最小改动

1. 给每次用户发起生成 rid，并在**每一条**上报里带上它（前端 → 服务端）。
2. 服务端维护一个内存 Map：`rid → 取消时刻`，TTL 取「HTTP 超时 + 余量」（这里是 60 秒）；写入路径入口先查这张表。
3. 前端维护 `cancelled` 与「当前 rid」，任何异步回调回来先比对 rid。
4. 页面必须有一步「回到待机」—— 取消是终点，但不该是死路。

### 为什么登记表可以只放内存

本项目的 `/api/nl` 客户端超时是 30 秒，`CANCELLED_RIDS` 的 TTL 是 60 秒：超过 60 秒的迟到结果
在客户端那一侧已经不可能再回来（请求早被放弃）。**用「上游超时」反推 TTL**，就不需要为一张临时表引入持久化。

---

## 九、向端侧课反馈：取消语义与反馈时序需求

课程要求「向端侧课反馈取消语义与反馈时序需求」。以下是这一侧真实需要、但端侧目前给不了的两件事。

### 需求 1：端侧需要能收到「本次请求已作废」

现状：取消只发生在服务端与浏览器之间。服务端把 `/api/nl` 的结果丢掉，但**板子那边仍在继续上传**（录音 WAV 已经发完、帧也照发）。
真要做到「省算力、省流量」，需要一条下行指令 `cancel(request_id)`，端侧收到后停止后续回传。

本轮没做（见边界第 1 条）：停止不能中断已经发出的 HTTP 请求。

### 需求 2：反馈时序需要一个共同时基

课程要测「输入结束 → 首次反馈」与「→ 任务完成」。现在只能拿到三段：

- 服务端**到站时刻**（`recorded` 事件）
- 浏览器**首次反馈**（`to_first_feedback_ms`）
- 浏览器**任务完成**（`to_task_done_ms`）

缺的是「用户**说完话**的那一刻」—— 板端不知道，服务端只能拿「WAV 传完的时刻」近似。串口通道实测约 4~6 秒一帧，
这个近似的误差就是上传耗时本身，量级和被测时长相当，结论不可用。

**建议端侧上报两个字段**：

```json
{ "capture_end_ms": 1234567, "boot_id": "3f9a2c81" }
```

- `capture_end_ms`：板端单调时钟（`esp_timer_get_time()/1000`）在「停止采集」那一刻的读数；
- `boot_id`：每次启动随机生成，用来把单调时钟换算到墙钟（服务端用收到首帧时的 `Date.now()` 反推）。

有了这两个字段，「输入结束」就能精确到毫秒，与「首次反馈」在同一时基上相减。
在没有 NTP 的部署里（本板 `iso` 为空的那种情况）这一步是必须的 —— 只靠墙钟会差出几十秒。
