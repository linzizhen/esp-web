# 第 7 周设计：按需获取一张环境图像

> 状态：待批准（批准后进入实现）
> 日期：2026-11-19
> 关联课程要求：按需采集 / 关联请求与采集时间 / 四态反馈 / 最少保留 / 上次图像不得冒充本次

## 一、要解决的真实缺陷（已实测，非推测）

2026-11-19 在 8080 生产实例上实测：

| 场景 | 现状行为 | 问题 |
|---|---|---|
| 正常抓拍 | `POST /api/cam {action:"shot"}` → `ok=true, ack_status="shot", outcome=accepted`，84 ms 后画面到 | `shot` 只表示「命令收到」，**不表示拍到了** |
| 抓拍失败（`framesize:99`） | `ok=false, ack=null, outcome=timeout` | `/api/cam/snapshot.jpg` 仍返回 **200 + 3525 字节旧图**，页面据此显示「已抓拍」 |
| 响应字段 | 只有 `hasSnapshot / snapshotAt / snapshotBytes` | 无「本次采集成功/失败」「采集时间」「采集记录」 |
| 存储 | `cam.snapshot` 单张驻留内存 | 重启即失，无记录、无保留策略 |

对应课程两条当堂验证：

1. **上次成功图像不得被标为本次采集成功** —— 现在会被标（旧图 200 返回）。
2. **采集失败保持明确状态** —— 现在失败后页面仍挂着旧图与绿色「已抓拍」标签。

## 二、核心设计

### 2.1 采集记录（shot）

每次采集一个 `shot_id`：`shot-YYYYMMDD-HHMMSS-mmm-<4hex>`。

服务端记录：

```js
{
  shot_id, request_id,          // request_id 是下发给板端的命令 id（板端 ack 会回显）
  trigger: 'ui'|'voice'|'help', // 触发来源
  requested_at,                 // 服务端发出命令的时刻
  captured_at,                  // 服务端收到 JPEG 的时刻（= 采集时间，见 2.4）
  board_ts, board_seq,          // 板端时间与帧序号（能对上就是同一帧的证据）
  state: 'requested'|'capturing'|'captured'|'blocked'|'failed',
  reason,                       // 失败/遮挡的具体原因，人可读
  bytes, size,                  // JPEG 字节数与 "WxH"
  file,                         // data/snapshots/<shot_id>.jpg（仅 captured）
}
```

落盘：`data/snapshots/events.ndjson`（每次状态变化一行），JPEG 存 `data/snapshots/<shot_id>.jpg`。

### 2.2 状态机（四态 + 两终止态）

```
requested ──(板端 ack=shot)──> capturing ──(收到匹配帧)──> captured
    │                              │
    │                              ├──(启发式判定画面不可用)──> blocked
    └──(ack 超时/板端 no_camera)────┴──(帧未到/解码失败)────> failed
```

- `requested`：命令已下发，等板端回执。
- `capturing`：板端回 `ack_status="shot"`，等帧。
- `captured`：收到**匹配本次**的帧且通过有效性检查。
- `blocked`：帧到了但画面不可用（见 2.5）。
- `failed`：命令超时 / 板端报 `no_camera` / 帧未到 / JPEG 解码失败。

**失败与遮挡必须清空画面**，前端不得保留上一次的图。

### 2.3 帧与采集的关联（不烧固件的前提下）

板端 `cam_send_frame_locked()` 的帧 JSON 只有 `"shot":1`，**没有 `shot_id` 字段**（固件不烧则无法回显）。因此关联靠三条同时成立：

1. **单飞**：同一时刻只允许一个 `capturing` 的采集，重复点击返回 `409 shot_in_progress`。
2. **序号单调**：记录全局已见的最大 `cam seq`，只接受 `seq > lastShotSeq` 的抓拍帧。
3. **时间窗**：只接受 `requested_at` 之后 15 秒内的帧。

> **残余风险（必须写进文档，不许假装没有）**：若上一张采集的帧在链路里滞留超过 15 秒且序号恰好大于当前值，会被误配给本次。串口路径实测延迟 84 ms～4 s，15 秒窗口下概率极低，但**不是零**。
> **彻底解决**：固件在帧 JSON 里回显 `shot_id`（`cam_shot` 命令已携带该字段，固件只需 `json_str(line,"shot_id",...)` 存下再拼进帧）。这是一行改动，但需重新烧录。本次**不做**，作为后续可选增强。

### 2.4 采集时间（captured_at 的语义）

- `requested_at`：服务端发出命令的时刻。
- `captured_at`：**服务端收到 JPEG 的时刻**。
- 两者都记录，差值即「采集往返耗时」。
- 板端帧里有 `ts`（SNTP 同步后的 epoch 毫秒，实测 `/api/state` 的 `iso` 字段为 `2026-11-19T07:34:22Z` 说明已同步），一并存为 `board_ts`。板端时间未同步（`ts` 为 0）时如实标 `board_ts: null`，不用服务端时间伪造。

> 口径说明：`captured_at` 严格说是「到达服务端的时刻」，不是传感器曝光的时刻。板端未上报曝光时间戳，这条误差（串口 84 ms～4 s）与第 6 周语音链路的「输入结束」是同一类问题，写进边界说明。

### 2.5 遮挡 / 画面不可用（服务端启发式，不烧固件）

按顺序判定，命中即 `blocked` 并给出具体原因：

| 判据 | 阈值 | 原因文案 |
|---|---|---|
| JPEG 字节数过小 | `< 1500 B`（实测正常 320×240 约 3.5 KB） | 画面几乎无细节（可能是纯色/全黑） |
| 平均亮度极低/极高 | 由 JPEG DC 系数估算，或退化为字节分布 | 画面过暗/过曝，可能被遮挡 |
| 尺寸异常 | 宽或高为 0 | 帧损坏 |

**实现取舍**：不解码 JPEG（不引入图像库），改用**压缩后字节熵 + 字节直方图**做启发式：

- 纯色/全黑图压缩后熵极低（约 < 2.0 bit/byte），正常场景约 6~7 bit/byte。
- 全黑图字节高度集中（`0xFF 0xD8 ... 0x00` 长游程），游程长度可判。

> **诚实边界**：这个启发式只能识别「全黑 / 全白 / 纯噪点 / 严重失焦」，**判不出「镜头被纸巾挡住但仍有纹理」或「拍到的是天花板」**。文档与页面文案都要写明「这是启发式，不是物体识别」。真正的亮度判定需要固件上报（用户已选择本次不做）。

### 2.6 触发条件与停止条件

**允许触发（三种）**：

| 触发 | 入口 | `trigger` |
|---|---|---|
| 页面按钮 | 「抓拍一帧」→ `POST /api/cam {action:"shot", trigger:"ui"}` | `ui` |
| 语音口令 | 说「看一眼」/「拍一张」→ `/api/nl` 新增 intent `snapshot` | `voice` |
| 教学求助 | 板端求助事件 `onHelpEvent()` 收到 `request` 时自动抓一张 | `help` |

**停止条件**（写进文档，作为个人项目的明确边界）：

1. 页面离开摄像头页 60 秒无观众 → 停流（现有 `CAM_IDLE_STOP_MS`，不变）。
2. 采集失败 3 次 → 不再自动重试，转为 `failed` 并提示检查排线/供电。
3. 教学求助事件触发每 60 秒最多一次（防连按刷图）。
4. 隐私：图像只存本机 `data/snapshots/`，不上传任何第三方；`data/snapshots/` 进 `.gitignore`。

### 2.7 最少保留

用户选择：**最近 5 张**。

- `SNAPSHOT_KEEP = 5`（`config.snapshotKeep` 可覆盖）。
- 超出时删除最旧的 JPEG，并在 `events.ndjson` 记一条 `{ev:'pruned', shot_id}`。
- 记录流水同样只保留最近 5 条在内存（盘上 events 全量）。

## 三、接口变更

| 接口 | 变更 |
|---|---|
| `POST /api/cam` `{action:"shot"}` | 返回体新增 `shot: {shot_id, state, requested_at, trigger}`；并发时 `409 shot_in_progress` |
| `GET /api/cam` | 新增 `shot`（最近一次采集记录）与 `shots`（最近 5 条） |
| `GET /api/cam/snapshot.jpg` | **必须带 `?shot_id=`**；缺失 → `400 shot_id_required`；不匹配 → `404 shot_not_found`；该 shot 非 `captured` → `409 shot_not_captured`。**不再无条件返回旧图** |
| `GET /api/cam/shots` | 新增：采集记录列表（含 state / reason / captured_at） |
| `POST /api/nl` | 新增 intent `snapshot`（口令「看一眼 / 拍一张 / 看看现在」），执行后返回采集结果与 `shot_id` |

## 四、改动文件

| 文件 | 内容 |
|---|---|
| `lib/snapshot-store.js`（新） | 采集记录、状态机、落盘、保留淘汰、有效性启发式（纯函数，可单测） |
| `server.js` | `/api/cam` 三个分支改造、`onCameraFrame` 关联、`onHelpEvent` 触发、`/api/cam/shots`、`NL_TASKS` 加 `snapshot` |
| `public/app.js` | 四态渲染、失败清空画面、采集记录列表、`snapshot.jpg?shot_id=` |
| `public/index.html` | 采集状态区 + 记录列表容器，版本号 +1 |
| `test/snapshot-test.js`（新） | 四态流转、旧图不得冒充、保留淘汰、启发式判遮挡、并发 409、触发来源 |
| `test/snapshot-store-test.js`（新） | store 纯函数单测（状态机非法迁移、淘汰、熵计算） |
| `docs/week7-snapshot.md`（新） | 本周文档 |
| `test/run-all.js` | 登记两个新测试 |

## 五、验证计划（对应课程当堂验证）

| 验证项 | 方法 | 期望 |
|---|---|---|
| 上次图像不得冒充本次 | 先成功抓一张 → 再发一个必然失败的抓拍（`framesize:99`）→ 轮询 `/api/cam` | 第二次 `state=failed`，`shot_id` 是新的，前端画面被清空，`snapshot.jpg?shot_id=<旧>` 仍可取旧图但 `?shot_id=<新>` 返回 409/404 |
| 采集失败保持明确状态 | 同上 | `state=failed` + `reason` 人可读，60 秒内不被任何轮询改写成 `captured` |
| 关联请求与采集时间 | `GET /api/cam/shots` | 每条都有 `requested_at` / `captured_at` / `board_seq` |
| 最少保留 | 连抓 7 张 | 磁盘只剩 5 个 JPEG，`events.ndjson` 有 2 条 `pruned` |
| 遮挡判定 | 用纯黑 JPEG 直接喂 `onCameraFrame`（合成帧） | `state=blocked` + 原因 |

## 六、边界与不做的事

1. **不做物体识别**：只判「画面是否可用」，不判「拍到了什么」。
2. **不烧固件**：`shot_id` 不回显，关联靠单飞 + 序号单调 + 时间窗，残余风险已在 2.3 写明。
3. **不做曝光控制**：摄像头参数仍是固件默认（320×240 / q12）。
4. **不上传云端**：图像不出本机。
5. **不替代直播流**：按需采集与推流是两条路径，采集不要求先开流（板端 `s_cam_ok` 在开机即初始化，抓拍不需要 `s_cam_on`）。
