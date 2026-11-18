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
| `public/app.js` | `VOICE_STOP_WORDS` / `voiceNewRequestId` / `voiceSessionId` / `voiceStale` / `voiceCancel`；`VOICE` 加 `rid/t0/firstFeedbackMs/cancelled`；`voicePostState` 自动补 rid 且取消后不再推进；`voiceTaskAndSpeak` 全链 `voiceStale` 守卫 + 澄清候选渲染 + `timings` 上报；`VOICE_EVENT_TEXT` 补 `cancelled` / `late_result_dropped` / `clarify_used` |
| `public/index.html` | 新增 `<button id="btnVoiceStop">停止</button>`；`app.js?v=45 → 46` |
| `test/voice-cancel-test.js` | 新增，**49 项** |
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
