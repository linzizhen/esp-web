# 第 5 周：接通按键说话与语音播报

> 本周问题：**佩戴者按下按键说一句话，查看者能读到这句说了什么吗？**
> 板端只有麦克风、没有扬声器，所以「听」在板端、「说」和「听懂」在浏览器。

---

## 一、本周问题的答案

一句话概括：**按键 → 板端录音 → 上传 WAV → 浏览器识别成文字 → 落盘为求助事件 → 查看者读到；回复则用浏览器播报。**

| 环节 | 运行位置 | 技术 | 为什么不能换位置 |
|------|---------|------|-----------------|
| 录音 | **板端** | 板载 MEMS 麦克风 + I2S | 板子才有麦克风 |
| 语音识别 | **浏览器** | Web Speech API | 板端没有算力跑 ASR，也没有联网 ASR 的授权额度 |
| 文字落盘 | **服务端** | `data/voice/events.ndjson`（只追加） | 服务端是唯一长期存储 |
| 语音播报 | **浏览器** | `speechSynthesis` | ★ 本板 `BSP_CAPS_AUDIO_SPEAKER = 0`，**物理上没有扬声器** |

★ 关键判据：**播报不可能在板端完成**。任何"板端播报"的实现都是假的，必须在文档和验收里写清楚。

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
node test/voice-test.js          # 84 项：隔离实例 + 合成 WAV
node test/voice-layout-contract-test.js   # 25 项：数据布局静态契约
```

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

---

## 六、文件改动清单

| 文件 | 改动 |
|------|------|
| `firmware/s3eye_imu_idf/main/voice_record.c` | 新增，录音 + 去交错 + 上传 + LED + BOOT 键 |
| `firmware/s3eye_imu_idf/main/voice_record.h` | 新增，对外接口 |
| `firmware/s3eye_imu_idf/main/main.c` | 接入 `voice_record` / `voice_status` 远程命令，启动 `voice_record_init()` |
| `server.js` | `/api/voice*` 七个接口 + 阶段状态机 + WAV 校验 + 事件落盘 |
| `public/app.js` | 语音页：录音回放、Web Speech 识别、`speechSynthesis` 播报 |
| `public/index.html` | 语音页 DOM（样式全部复用既有类，未新增 CSS） |
| `test/voice-test.js` | 新增，84 项接口契约 |
| `test/voice-hil.js` | 新增，真机端到端（需硬件） |
| `test/voice-layout-contract-test.js` | 新增，25 项数据布局静态契约 |
| `test/probe-voice-stop.js` | 新增，真机稳定性探针（需硬件） |

---

## 七、备用路径与迁移

### 没有硬件时怎么验证

| 能验证 | 不能验证 |
|--------|---------|
| ✅ 接口契约（`voice-test.js`） | ❌ 板子真的能录到声音 |
| ✅ 数据布局（`voice-layout-contract-test.js`） | ❌ 麦克风接线是否正确 |
| ✅ 页面交互（浏览器打开就能点） | ❌ BOOT 键是否好使 |

真机项必须补验，**不能拿"模拟通过"当实物通过**。

### 迁移到个人项目

| 本周能力 | 可迁移到 |
|---------|---------|
| 按键触发 + 本地确认 | 任何"一个动作 + 一个反馈"的交互 |
| 上传 + 落盘 + 回放 | 任何媒体取证链路 |
| 浏览器识别 + 播报 | 任何"板端采集、端侧理解"的场景 |
| 阶段状态机 + 失败可见 | 任何多步骤异步流程 |

★ 迁移时保留的判据：**没有证据就不许报成功**。这条比代码本身更重要。
