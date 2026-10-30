# 第 5 周：接通按键说话与语音播报

> 本周问题：**佩戴者按下按键说一句话，查看者能读到这句说了什么吗？**
> 板端只有麦克风、没有扬声器，所以「听」在板端、「说」和「听懂」在浏览器。

---

## 一、本周问题的答案

一句话概括：**按键 → 板端录音 → 上传 WAV → 浏览器识别成文字 → 落盘为求助事件 → 查看者读到；回复则用浏览器播报。**

| 环节 | 运行位置 | 技术 | 为什么不能换位置 |
|------|---------|------|-----------------|
| 录音 | **板端** | 板载 MEMS 麦克风 + I2S | 板子才有麦克风 |
| 语音识别 | **浏览器**（有麦克风时）<br>**服务端**（无麦克风时，可选降级） | Web Speech API<br>智谱 GLM-ASR（`glm-asr-2512`） | 板端没有算力跑 ASR，也没有联网 ASR 的授权额度 |
| 文字落盘 | **服务端** | `data/voice/events.ndjson`（只追加） | 服务端是唯一长期存储 |
| 语音播报 | **浏览器** | `speechSynthesis`；无扬声器时改用**屏幕大字 + 复制** | ★ 本板 `BSP_CAPS_AUDIO_SPEAKER = 0`，**物理上没有扬声器** |

★ 关键判据：**播报不可能在板端完成**。任何"板端播报"的实现都是假的，必须在文档和验收里写清楚。

★ 第二个判据（2026-10-30 补充）：Web Speech API **只接受麦克风实时拾音**，没有接口能把一段 WAV 直接喂给它。
所以它的前提是"这台电脑有麦克风、且能把扬声器的声音收进来"。电脑没有麦克风时，必须有第二条路 ——
本仓库实现为**服务端转写**（`POST /api/voice/transcribe`，默认**关闭**，见 §五「修复四」）。
这条降级路径**不是课程要求**，属于本机环境（零麦克风、零扬声器）驱动出的补充能力。

---

## 二、架构与数据流

```
┌──────────┐  BOOT 键(GPIO0)  ┌─────────────────┐
│  佩戴者  │ ───────────────► │ ESP32-S3-EYE    │
└──────────┘                  │  I2S MEMS 麦克风 │
                              │  ↓ 16kHz/16bit  │
                              │  ↓ 去交错       │
                              │  WAV(44+PCM)    │
                              └────────┬────────┘
                                       │ HTTP POST /api/voice/audio
                                       ▼
                              ┌─────────────────┐
                              │ 服务端 :8080    │
                              │  校验 RIFF/WAVE │
                              │  落盘 data/voice│
                              │  解析电平/时长  │
                              │  WS 广播 voice  │
                              └────────┬────────┘
                                       │ WebSocket
                                       ▼
                              ┌─────────────────┐
                              │ 浏览器          │
                              │ Web Speech →文字│
                              │ POST /voice/state│
                              │ speechSynthesis │
                              └─────────────────┘
```

### 链路阶段（服务端状态机）

```
idle → recorded → transcribed → task_running → task_done → spoken
          │            │              │             │
      silent      asr_failed      timeout       （可重来）
```

八个阶段（`VOICE_STAGES`）+ 一个初始态 `idle`：

| 阶段 | 中文说明（`stage_text`） |
|------|------------------------|
| `idle` | 尚无语音链路 |
| `recorded` | 已收到板端 WAV |
| `transcribed` | 浏览器已识别为文字 |
| `asr_failed` | 识别失败（可改用文字入口） |
| `task_running` | 正在执行第 4 周 NL 任务 |
| `task_done` | 任务已完成 |
| `spoken` | 已在浏览器播报 |
| `silent` | 没有检测到语音（无声或过短） |
| `timeout` | 链路超时（可改用文字入口） |

- 每个阶段都能通过 `GET /api/voice/state` 读到，`stage_text` 是给人看的中文说明
- **没有设备完成证据时，绝不显示"已采集成功"**：`recorded` 之前不许出现"已录到"
- 失败原因不跨阶段继承：`asr_failed` / `silent` / `timeout` 三类失败若前端没给
  `reason`，服务端补一条中文原因；进入新阶段时清掉上一轮的失败原因

---

## 三、接口清单

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/voice/audio` | 板端上传 WAV（校验 RIFF/WAVE，上限 1 MB） |
| GET | `/api/voice` | 全链状态快照 + 最近事件（刷新页面不丢状态） |
| GET | `/api/voice/state` | 链路当前阶段 |
| POST | `/api/voice/state` | 浏览器推进阶段（`transcribed` / `asr_failed` / …） |
| GET | `/api/voice/audio/:id` | 回放 WAV |
| GET | `/api/voice/audio/:id/download` | 下载取证 |
| POST | `/api/voice/record` | 远程触发一次录音（等价按 BOOT 键） |
| POST | `/api/voice/transcribe` | **可选降级**：把已落盘的 WAV 交给服务端转写（`{"audio_id":"voice-…"}`）。默认关闭，未开启时返回 503 `asr_disabled` 且**一条请求都不外发** |

### 失败分支（全部有测试覆盖）

| 输入 | 结果 | 断言 |
|------|------|------|
| 非 WAV（头不是 RIFF） | 400 | 不落盘 |
| > 1 MB | 400 | 不落盘 |
| 不存在的 audio_id | 404 | — |
| 非法 audio_id（`../../etc/passwd`） | 400 | 路径穿越被拦 |
| 非法 stage | 400 + `invalid_stage` | — |
| 缺 stage | 400 | — |
| `asr_failed` 未给 reason | 200 + 补中文原因 | 「浏览器未能识别出语音内容」 |
| 转写：非法/穿越 audio_id | 400 `invalid_audio_id` | 校验先于调用上游 |
| 转写：不存在的 audio_id | 404 `audio_not_found` | — |
| 转写：> 25 MB / > 30 秒 | 413 `asr_audio_too_large` / 400 `asr_audio_too_long` | 智谱接口自身的限制 |
| 转写：未启用 | 503 `asr_disabled` | **假 ASR 服务零命中**（录音没有离开本机） |
| 转写：启用但没配 endpoint/key | 503 `asr_not_configured` | 提示要配什么 |
| 转写：上游 401/500/非 JSON | 502 `asr_failed` | 带 `upstream_status` 与原文片段 |
| 转写：上游返回空白文本 | 502 `asr_empty_text` | 不假装识别成功 |
| 转写：上游超时 | 504 `asr_timeout` | 按 `ASR_TIMEOUT_MS` 生效 |

---

## 四、当堂验证（逐条实测）

### 验证 1：按键 → 录音 → 上传（真机）

```powershell
node test/voice-hil.js --speak
```

- `--speak` 会在录音前提示你对着板子说话（6 秒）
- 断言：`audio_id` 是本次新值、WAV 头合法、16 kHz / 单声道 / 16 bit、时长接近 6 秒
- **独立复核电平**：脚本自己重新下载 WAV 并解码算 RMS，不信服务端自报
- 静音时如实报「录到静音」而不是假通过

### 验证 2：连续多轮稳定性

```powershell
node test/probe-voice-stop.js 5 2
```

5 轮 `start → 2s → stop`，每轮时长应落在 2048–2112 ms。

### 验证 3：接口契约（无需硬件）

```powershell
node test/voice-test.js          # 104 项：隔离实例 + 合成 WAV
node test/voice-layout-contract-test.js   # 25 项：数据布局静态契约
node test/voice-mic-preflight-test.js     # 24 项：识别前麦克风自检契约
```

---

## 四之二、真机验证踩到的两个测试侧坑与一个产品侧缺口

这一节记录 `test/voice-hil.js` 第一版会**在链路完全正常时报失败**的两个原因，以及一个
**服务端能力缺口**。前两个已修，第三个只登记不修（超出本周范围）。

### 坑 1：等待预算 12 秒太短

写探针实测「`stop` 命令 → 服务端能看到新 WAV」的延迟，5 轮结果：

```
3177 / 3220 / 3460 / 4776 / 10369 ms
```

后续两轮更极端：`12403 ms`、`27196 ms`。**跨度接近 9 倍**，而 WiFi 上传本身有约 34% 的失败重传率。
第一版只等 12 秒，于是经常在录音其实成功时判失败。

修复：预算放宽到 **45 秒**（`WAIT_MS = 45000`），超过 15 秒单独提示「链路抖动」，
超时后区分「从未收到新录音」与「收到了但 `audio_id` 未变」——两者原因完全不同。

### 坑 2：只看服务端返回，不看板端回执

`POST /api/voice/record` 返回 `ok=true` **只表示命令写进了串口**，不代表板端接受：

- 服务端 `sendCommand()` 的 `port.write()` 回调只记错误，**不等待 ack**
- 固件 `voice_record_toggle()` 开头就是 `if (s_uploading) { ...; return false; }`，
  此时回 `cmd_ack(rid, "busy")`

实测证据（一次性探针，见下）：第 1 次 `start` → ack=`recording`；`stop` → ack=`uploading`；
**200 ms 后再 `start` → 板端 ack=`busy`，而服务端仍回 `ok=true / accepted=true`**。

修复：测试侧新增 `waitAck(rid, timeoutMs)` 读 `/api/state` 的 `raw` 环形缓冲核对 `request_id` 回执，
`sendRecordCommand()` 遇 `busy` 退避重试（6 次 × 1200 ms）。

> 这两个取证探针（`probe-upload-latency.js` / `probe-voice-busy.js`）是排查时的一次性脚本，
> **不入库**——它们的结论已经固化成本节的表格与 `voice-hil.js` 的断言，留着只会变成无人维护的死代码。
> 需要复现时按本节描述重写即可，核心逻辑就是「发命令 → 轮询 `/api/state` 的 `raw` 找 ack」。
>
> 写探针时踩了个坑：`/api/state` 的 `raw` 数组元素是 **`{ts, text, ok}` 对象**，不是字符串。
> 第一版直接对元素做 `String()` 比较，全部打印成 `[object Object]`，误判成「板端没回 ack」。
> 教训：**先打印一条样例行再写匹配逻辑**。

### 缺口：服务端无法区分「已写进串口」与「板端已接受」

上面坑 2 暴露的是产品侧能力缺口，测试侧只是绕过。当前行为：

| 场景 | 板端实际 | 服务端返回 |
|------|---------|-----------|
| 正常 | `recording` | `ok=true, accepted=true` |
| 正在上传上一段 | `busy`（命令被丢弃） | `ok=true, accepted=true` ← **谎报** |

建议后续在 `sendCommand()` 后等待 ack 再定论，把 `accepted` 改成「板端确认」而非「写出口成功」。
**本周不修**，已在 `test/voice-hil.js` 第 ⑥ 段登记为已知缺口，不判失败——登记不等于认可。

> **状态更新（2026-10-26）**：该缺口**服务端侧已修复**，详见下文「修复二：命令下发 ≠ 板端已接受」。
> ⚠ 但修复只在串口模式生效：固件侧回执双通道代码已就绪、**尚未烧录**，烧录前纯 WiFi 部署仍判 timeout
> （见「修复二之边界」）。

---

## 五、★ 真机暴露的缺陷与修复（2026-10-26）

### 现象

请求录音 3 秒，服务端显示时长 **6144 ms**；请求 6 秒，显示 **10000 ms**（正好撞上限）。
连续 3 轮结果完全一致 —— 不是偶发，是确定性缺陷。

### 取证过程

```
3 秒录音 → 196,608 字节 PCM → 98,304 采样
98,304 ÷ 3.072 s = 32,000 采样/秒   ← 但 WAV 头写的是 16,000
```

逐采样分析发现：

```
前 16 个采样值: -37, 0, -53, 0, -53, 0, -49, 0, -49, 0, -52, 0, -52, 0, -53, 0
                      ↑         ↑         ↑         ↑         ↑         ↑
                   奇数下标全部为 0
偶采样 RMS: 28.2 (非零 47840)   奇采样 RMS: 0.0 (非零 0)
```

### 根因

I2S 配成 `I2S_SLOT_MODE_MONO` 时，**RX 侧仍按 2 slot 一帧送数据**：

- 每帧 = 2 个 `int16`
- 只有活动 slot（`I2S_STD_SLOT_LEFT`）是麦克风真实采样
- 另一个 slot 被 `chan_cfg.auto_clear = true` 填成 0
- ESP-IDF 驱动里 `handle->total_slot = 2`（`i2s_std.c:125`），`active_slot = 1` 只影响 BCLK 计算，**不改变数据布局**

固件当时把这批交错数据直接当单声道写进 WAV，于是：

| 后果 | 具体表现 |
|------|---------|
| 时长翻倍 | 3 秒 → 6144 ms |
| 播放速度慢一半 | 16 kHz 头 + 32 kHz 数据 |
| 录音上限缩水 | 缓冲按单声道 320,000 字节算，10 秒上限实际只能录 5 秒 |

### 修复

```c
/* 原始缓冲按 2 倍开 */
#define VOICE_I2S_SLOTS        2
#define VOICE_RAW_BYTES_PER_MS (VOICE_BYTES_PER_MS * VOICE_I2S_SLOTS)   /* 64 */
#define VOICE_MAX_RAW_BYTES    (VOICE_MAX_RECORD_MS * VOICE_RAW_BYTES_PER_MS)  /* 640000 */

/* 采集读进 s_raw（交错），循环结束后去交错 */
static size_t voice_deinterleave(const int16_t *src, size_t raw_bytes, int16_t *dst)
{
    const size_t frames = raw_bytes / (2 * VOICE_I2S_SLOTS);
    /* 自动探测活动 slot：万一左右声道接反，取奇数下标而不是直接静音 */
    size_t lead_even = 0, lead_odd = 0;
    const size_t probe = frames < 2048 ? frames : 2048;
    for (size_t i = 0; i < probe; i++) {
        if (src[i * 2]     != 0) lead_even++;
        if (src[i * 2 + 1] != 0) lead_odd++;
    }
    const size_t slot = (lead_even >= lead_odd) ? 0 : 1;
    for (size_t i = 0; i < frames; i++) dst[i] = src[i * 2 + slot];
    return frames * 2;
}
```

采集循环里还必须按整帧读：

```c
want -= want % (2 * VOICE_I2S_SLOTS);   /* 防止一帧被劈成两半导致去交错错位 */
```

### 修复后实测

| 请求时长 | 修复前 | 修复后（连续 5 轮） |
|---------|-------|-------------------|
| 2 秒 | 4096 ms | 2048 / 2048 / 2048 / 2112 / 2048 ms |
| 3 秒 | 6144 ms | 3008 / 3136 / 3072 ms |
| 6 秒 | 10000 ms（撞上限） | 6080 ms |

### 防回归

- `test/voice-layout-contract-test.js`（25 项静态契约）：改固件时立刻发现"有人又把交错数据当单声道用了"
- 文件头写了「数据布局」段落，把坑记在原地

### 修复二：命令下发 ≠ 板端已接受（服务端等 ack）

上面「缺口」一节登记的问题，本轮一并修掉。

**缺陷表现**：`POST /api/voice/record` 返回 `ok=true accepted=true`，但命令其实被板端丢弃。
实测（2026-10-26）：板端正在上传上一段录音时请求录音，服务端报成功，串口上板端回的是
`{"type":"ack","device":"S3EYE-GROUP01","request_id":"voice-rec-1792981981759","seq":4434,"status":"recording"}`
之外的 `status:"busy"` —— 命令被明确拒绝，服务端却毫无察觉。

**根因**：`sendCommand(obj, device)` 里 `port.write(..., cb)` 的回调只记录写错误，**不等回执**。
串口 `write` 成功只证明字节进了驱动缓冲，与板端是否处理完全是两件事。板端固件
`voice_record.c:571` 的 `voice_record_toggle()` 首段是 `if (s_uploading) { ESP_LOGW(...); return false; }`，
`main.c:1377-1388` 据此回 `cmd_ack(rid, "busy")`。

**修复方式**：新增 `sendCommandAndWaitAck()`（`server.js`）——

1. 下发前按 `request_id` 在 `PENDING_ACKS` 里登记等待槽（必须早于 `sendCommand()`，否则极快的 ack 会漏）；
2. 板端上行 ack 到达 `handleLine()` 的 `type:"ack"` 分支时结算等待槽；
3. 超时未结算判 `timeout`，默认 1800 ms（`config.commandAckTimeoutMs`，环境变量 `COMMAND_ACK_TIMEOUT_MS` 可覆盖）。

结局区分六种：`accepted`（板端 ack 且 status 非 busy/error）、`busy`、`error`、`timeout`、
`channel_unavailable`（串口没开且板端未轮询）、`mock`（`config.mockDevice` 时不伪造回执）。

**`ok` 字段语义变化**：`/api/voice/record` 的 `ok` 现在等于 `accepted`，即**「板端已接受」**，
不再是「写进串口成功」。命令是否写出去了由新增的 `dispatched` 字段单独表达。
返回体另含 `outcome` / `ack_status` / `ack_seq` / `waited_ms` / `timeout_ms` / `simulated` / `note`。

| 场景 | 板端实际 | 修复前 | 修复后 |
|------|---------|--------|--------|
| 正常 | `recording` | `ok=true` | `ok=true, outcome=accepted` |
| 正在上传上一段 | `busy`（命令被丢弃） | `ok=true` ← **谎报** | `ok=false, outcome=busy, dispatched=true` |
| 取走命令但没回执 | 无 ack | `ok=true` | `ok=false, outcome=timeout` |
| 串口没开且板端未轮询 | — | `ok=false`（note 无细分） | `ok=false, outcome=channel_unavailable` |

**防回归**：`test/command-ack-test.js` 95 项断言，覆盖六种结局、`request_id` 匹配（不相关 rid 的 ack
不能冒充）、超时时长实测、mock 不伪造回执，以及「旧写法 `accepted: ok` 已移除」的静态契约。

> **取证边界**：本轮验证在隔离实例内完成 —— 用真实上行入口 `POST /api/data` 注入板端 ack
> （与固件同一路径），**未在真机上制造 busy 场景**。真机 busy 取证仍待补（预期
> `outcome=busy`、`ok=false`、`dispatched=true`）。

### 修复二之边界：固件侧回执双通道「代码就绪、未烧录」

服务端等 ack 只解决了一半问题 —— 它依赖**板端回执真的到达服务端**。而板端 `cmd_ack()`
原本只有一条上行路：`printf` 到 USB-Serial/JTAG console。

纯 WiFi 部署（板子插充电头、不连电脑）下没人在读串口，回执被驱动直接丢弃：

```
服务端下发命令 → 板端经 GET /api/cmd 取到并真的执行 → 回执进黑洞
             → 服务端等满超时 → outcome=timeout
```

即：**t1 把「谎报成功」翻成了「谎报失败」**。同一文件的摄像头帧早就是双通道
（`cam_send_frame_locked` 的 `printf` + `http_post`），回执只有一路属于既有缺口。

**固件侧改动（已落盘、已提交 `f76e0cd`，但未烧录）**：

| 项 | 内容 |
|---|---|
| `cmd_ack()` | 仍先 `printf`（串口通道任何情况下保留），再 `wifi_wait(0)` 判在线，然后非阻塞 `xQueueSend` |
| `ack_task` | 独立任务（栈 8192、优先级 4）：`xQueueReceive` → `http_post("/api/data", line)` |
| `s_ack_q` | 静态队列，深度 8、行 192 B；建在 `cmd_task` 之前，上电最初几秒的回执也能走 WiFi |
| `s_ack_fail` | 只统计「WiFi 在线但发不出去」（队列满 / http_post 失败），不统计 `wifi_wait(0)` 为假 |
| 编译验证 | `s3eye_imu.bin` = 0x10b2b0 字节，分区余量 29%，零警告 |

为什么用独立队列 + 独立任务而不是在 `cmd_ack()` 里同步 `http_post`：`cmd_task` 优先级 5（全板最高），
`http_post` 的客户端超时是 3000 ms，同步调等于「服务端不可达时每条命令把最高优先级任务钉住 3 秒」；
栈上也可沿用 `btn_task` 的既有结论给 8192（`main.c` 里记录过 3072 跑同路径被打穿、整板复位），
**`cmd_task` 保持 4096 不动**。

> ⚠ **在烧录这个固件之前，纯 WiFi 部署仍会判 timeout。** 当前 8080 生产实例是
> `transport=serial`，所以看不到这个问题 —— 不能据此认为已经全好。
>
> 真机补测（**尚未进行，不计入已验证**）：板子在场且获用户批准后，断开 USB、确认纯 WiFi 上报状态，
> `POST /api/voice/record`，预期 `outcome=accepted` + `ack_status` 非空 + `waited_ms < 1800`，
> 并观察串口日志出现「回执 WiFi 上行已恢复（此前失败/丢弃 N 条）」。
> 在此之前本条在文档里保持「**代码就绪、未经真机验证**」标注。

---

### 修复三：第②步把「本机没麦克风」说成「请到地址栏允许权限」（2026-10-30）

#### 现象

页面第②步报红，横幅写「浏览器拒绝了麦克风权限：…必须在地址栏重新允许麦克风后点「重新识别这段录音」」。
按这句话去操作永远不会成功。

#### 取证（一步步排除，而不是照着报错文案猜）

| 可能成因 | 实测结果 | 判定 |
|---|---|---|
| 站点权限被拒 | Chrome/Edge `Preferences` 里 `media_stream_mic` 例外**为空** | 用户从未做过允许/拒绝决定，排除 |
| 企业策略禁止 | `HKLM/HKCU\SOFTWARE\Policies\Google\Chrome` 均不存在 | 排除 |
| 系统隐私策略拦截 | `ConsentStore\microphone` 全局 `Allow`、`NonPackaged = Allow` | 排除 |
| 非安全上下文（http + 局域网 IP） | Edge 历史 `127.0.0.1:8080` 命中 88 次、`localhost` 63 次 | 走的是安全上下文，排除 |
| **本机没有录音设备** | `MMDevices\Audio\Capture` 下 12 个录音端点状态**全是 `NOTPRESENT`/`UNPLUGGED`，没有一个 `ACTIVE`**；输出侧才有 `ACTIVE` | **★ 根因** |

旁证：`data/voice/events.ndjson` 里 `recorded` 到 `asr_failed` 只隔 **87 ms** —— 根本没进拾音阶段就失败了，
符合「设备不存在时 Web Speech API 立刻回 `not-allowed`」的表现。板端录音（312.5 KB / 10 秒）与上传全都正常。

#### 为什么这是代码缺陷而不是硬件问题

硬件缺麦克风是客观限制，改不了；但**把「没有设备」解释成「请去允许权限」是一个永远走不通的指路**，
用户按提示折腾也解决不了。Web Speech API 对这两种情况报的是同一个 `not-allowed`，页面此前完全被动接收，
既没有预检设备，也无法区分成因 —— 这才是要修的东西。

#### 修复

1. 新增纯函数 `voiceMicVerdict(devices)`：按 `kind === 'audioinput'` 数录音设备（Chrome 未授权时隐藏 `label`，
   但 `kind` 一定会给，所以只能按 `kind` 判），零设备时返回 `error: 'no_input_device'` + 准确中文原因。
2. 新增 `voiceProbeMic()`：识别**之前**调 `navigator.mediaDevices.enumerateDevices()` 自检；
   拿不到设备列表（旧浏览器 / 抛错）时**不阻断**，交回 Web Speech API 自己报错 —— 宁可少一层判断，
   也不要在本来能用的机器上误拦。
3. `voiceStartChain()` 在第②步之前插入自检：零设备就**直接返回、不播放录音**，把
   `stage: 'asr_failed'` + 准确 reason 上报服务端，四段状态里第②段写明「未识别（本机没有录音设备）」。
4. 改文案：`VOICE_ASR_ERROR_TEXT['not-allowed']` 与 `VOICE_FAIL_KIND.asr_failed.desc` 都改为
   **两种成因并列**（没接设备 → 插耳麦；已接设备 → 允许权限），并都保留「文字输入」兜底。

#### 防回归

`test/voice-mic-preflight-test.js`（24 项）：静态契约 + 把 `voiceMicVerdict` 抠出来直接求值跑三组入参
（只有输出设备 / 有设备但 label 为空 / `null`·`undefined`·`[]` 不抛异常），再守「自检确实在识别之前」
「零设备分支确实上报 `stage: 'asr_failed'` 且带 reason」「两句文案都同时覆盖两种成因」。

#### 仍未解决的部分（如实标注）

**本机仍然没有麦克风。** 这次修复只让失败原因变准确、把用户导向可执行的动作，并没有让第②步在这台机器上跑通。
要走完整条链路，必须插一个麦克风/耳麦（或改用文字入口，任务照样能完成）。

---

### 修复四：第②步整条路都走不通时，给一条不经过电脑声卡的路（2026-10-30）

#### 现象

修完「修复三」后，文案准确了，但第②步仍然过不去 —— 因为这台电脑**既没有麦克风，也没有扬声器**：

| 环节 | 需要什么 | 本机实际情况 |
|------|---------|-------------|
| ② Web Speech 识别 | 麦克风（听扬声器播放出来的录音） | 12 个录音端点全 `NOTPRESENT` / `UNPLUGGED`，**零 ACTIVE** |
| ④ `speechSynthesis` 播报 | 扬声器 | 只有 `DS27NB`、`Senary Audio` 两个输出端点，实际不发声（笔记本无声卡输出） |

Web Speech API 的设计前提是"麦克风实时拾音"，**没有任何接口能把一段 WAV 直接喂给它** ——
所以"扬声器外放 → 麦克风听回"这一步在无麦/无声的机器上物理上不可能完成。这不是文案问题，是路径问题。

#### 修复：服务端转写作为降级路径（默认关闭）

1. 新增 `POST /api/voice/transcribe`：把**已经落盘的 WAV** 直接交给识别服务（智谱 `glm-asr-2512`，
   `POST https://open.bigmodel.cn/api/paas/v4/audio/transcriptions`，`multipart/form-data`），
   不再经过电脑声卡。复用第 4 周那份 API Key 与 base URL，不需要新账号。
2. 前端改成双路径：**有麦克风** → 先试 Web Speech（保持课程要求的形态）；**没有麦克风** → 走服务端转写。
   两条路的名字都会显示在页面上（`Web Speech` / `服务端转写`），不让人猜到底走了哪条。
3. ④ 播报改为**屏幕大字 + 复制按钮**；没有输出设备时明确标注「本机没有扬声器，未实际发声」，
   **绝不写"已播报"**。
4. ★ **默认关闭**：`asrEnabled` 缺省为 `false`。关闭时 `/api/voice/transcribe` 返回 503
   `asr_disabled`，**连一条请求都不发出去** —— 录音不出本机。要启用必须在
   `config.local.json` 里显式写 `"asrEnabled": true`（或环境变量 `ASR_ENABLED=1`）后重启服务。

为什么默认关闭而不是默认开启：启用意味着**把用户的录音发送到第三方服务器**，这是不可逆的外发。
在用户确认账号与费用之前，「代码就绪但默认不动」才是正确状态。

#### 配置

```jsonc
// config.local.json（不入库，含密钥）
{
  "asrEnabled": true,                       // ★ 显式开启，缺省 false
  "asrEndpoint": "https://open.bigmodel.cn/api/paas/v4",  // 可省略，默认复用 nlEndpoint
  "asrApiKey": "……",                        // 可省略，默认复用 nlApiKey
  "asrModel": "glm-asr-2512",               // 该接口文档里唯一枚举
  "asrTimeoutMs": 20000
}
```

也可用环境变量 `ASR_ENABLED` / `ASR_ENDPOINT` / `ASR_API_KEY` / `ASR_MODEL` / `ASR_TIMEOUT_MS` /
`ASR_MAX_BYTES` / `ASR_MAX_MS` 覆盖（测试就是用这几个变量把上限压到 1 KB、超时压到 700 ms）。

#### 防回归

`test/voice-asr-test.js`（50 项）：自带**假 ASR 服务**（`http.createServer` + 随机端口），
断言的不只是"成功路径"和"失败分类"，还包括隐私边界：

- 未开启 `asrEnabled` → 503 `asr_disabled`，且**假 ASR 服务的命中计数一次都不增加**
  —— 这条是"录音没有离开本机"的可执行证明，不是靠注释承诺。
- 上游 401 / 500 / 返回 HTML（非 JSON）/ 返回空白文本 / 永不响应（超时）→ 分别归到
  `asr_failed`（带 `upstream_status`）/ `asr_empty_text` / `asr_timeout`，都能让人看出"是上游的问题，不是识别出了空话"。
- 密钥不外泄：`/api/voice`、`/api/voice/state`、转写响应里都不出现完整 key（只有掩码）。
- 体积与时长上限（1 KB / 30 秒）在上游调用**之前**就拦住。

#### 与课程要求的偏差（如实记录）

课程第 5 周要求的识别形态是**浏览器 Web Speech API**。本仓库**保留**了这条路径（有麦克风时优先走它），
服务端转写是**补充的降级路径**，不是替换。偏差的原因是本机硬件缺失，不是图省事：
在本机这种"零麦克风、零扬声器"的环境里，只保留 Web Speech 等于整条链路永远停在②。

#### 仍未解决的部分

**本机仍然没有麦克风、没有扬声器。** 服务端转写路径本身可用（有 50 项测试），
但**真实转写尚未跑过** —— 用户要求先确认账号与费用再启用，因此至今没有任何录音被外发。
④ 播报在本机永远是"屏幕文字 + 明确说没发声"，不是真的出声。

---

## 六、文件改动清单

| 文件 | 改动 |
|------|------|
| `firmware/s3eye_imu_idf/main/voice_record.c` | 新增，录音 + 去交错 + 上传 + LED + BOOT 键 |
| `firmware/s3eye_imu_idf/main/voice_record.h` | 新增，对外接口 |
| `firmware/s3eye_imu_idf/main/main.c` | 接入 `voice_record` / `voice_status` 远程命令，启动 `voice_record_init()`；收尾新增 `cmd_ack()` 双通道（`printf` + `ack_task` 走 `http_post`）——**已提交 `f76e0cd` 但未烧录** |
| `server.js` | `/api/voice*` 七个接口 + 阶段状态机 + WAV 校验 + 事件落盘；收尾新增 `sendCommandAndWaitAck()` 等板端 ack；2026-10-30 新增 `POST /api/voice/transcribe`（服务端转写，**默认关闭**） |
| `public/app.js` | 语音页：录音回放、Web Speech 识别、`speechSynthesis` 播报 |
| `public/index.html` | 语音页 DOM（样式全部复用既有类，未新增 CSS） |
| `test/voice-test.js` | 新增，104 项接口契约 |
| `test/voice-hil.js` | 新增，真机端到端（需硬件），含板端回执核对与 45 秒等待预算 |
| `test/voice-layout-contract-test.js` | 新增，25 项数据布局静态契约 |
| `test/voice-mic-preflight-test.js` | 新增，24 项识别前麦克风自检契约（2026-10-30） |
| `test/voice-asr-test.js` | 新增，50 项服务端转写契约（URL 归一化 / 失败分类 / **未启用时零外发**）（2026-10-30） |
| `test/command-ack-test.js` | 收尾新增，95 项命令 ack 通道契约（accepted/busy/timeout/channel_unavailable/mock） |
| `test/probe-voice-stop.js` | 新增，真机稳定性探针（需硬件） |
| `test/run-all.js` | 登记 `voice` / `voice-layout` / `voice-mic` / `voice-asr` / `command-ack` 套件，并修正「N 项通过」格式的结果计数 |

---

## 七、备用路径与迁移

### 没有硬件时怎么验证

| 能验证 | 不能验证 |
|--------|---------|
| ✅ 接口契约（`voice-test.js`） | ❌ 板子真的能录到声音 |
| ✅ 数据布局（`voice-layout-contract-test.js`） | ❌ 麦克风接线是否正确 |
| ✅ 麦克风自检分支（`voice-mic-preflight-test.js`，无设备/有设备两路） | ❌ 真机麦克风是否真能拾到扬声器声音 |
| ✅ 命令 ack 通道（`command-ack-test.js`，注入真实上行 ack） | ❌ 真机 `busy` 场景（固件 `s_uploading` 期间请求录音） |
| ✅ 页面交互（浏览器打开就能点） | ❌ BOOT 键是否好使 |
| ✅ 服务端等 ack 的六种结局（隔离实例注入） | ❌ 纯 WiFi 下的回执上行（固件双通道已改代码但**未烧录**，烧录前纯 WiFi 仍判 timeout） |
| ✅ 转写接口的失败分类与「未启用零外发」（`voice-asr-test.js`） | ❌ 真实转写（需启用 `asrEnabled` 并产生费用，用户尚未确认；至今零外发） |

真机项必须补验，**不能拿"模拟通过"当实物通过**。

### 迁移到个人项目

| 本周能力 | 可迁移到 |
|---------|---------|
| 按键触发 + 本地确认 | 任何"一个动作 + 一个反馈"的交互 |
| 上传 + 落盘 + 回放 | 任何媒体取证链路 |
| 浏览器识别 + 播报 | 任何"板端采集、端侧理解"的场景 |
| 服务端转写降级 + 隐私默认关闭 | 任何"用户录音/照片外发"的功能：默认不发，显式开，关闭时测试要能证明零外发 |
| 阶段状态机 + 失败可见 | 任何多步骤异步流程 |

★ 迁移时保留的判据：**没有证据就不许报成功**。这条比代码本身更重要。
