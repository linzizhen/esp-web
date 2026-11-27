# 第 8 周设计规格：把视觉推理结果变成可理解反馈

> 状态：待用户审阅（架构级路径的书面规格）
> 作者：lead｜日期：2026-11-27
> 上游需求：第 8 周课程「把视觉推理结果变成可理解反馈（理论 1 + 实践 3 学时）」逐条拆解，见第 2 节。

---

## 1. 本周问题与目标

课程问题：**模型返回一个标签和分数，系统应该如何表达「看到了什么」和「还有什么不能确定」？**

一句话目标：在已有「按需采集（第 7 周）」之上，接一次**真实模型推理**，把它变成**人能看懂、并且不夸大把握**的反馈；同时保留「输入图像 — 推理结果 — 人工反馈」三者的对应关系，并提供重采与纠错入口。

## 2. 需求拆解（课程逐条 → 本设计的判定口径）

| 课程要求 | 本设计的落地 |
|---|---|
| 讲解预测标签、分数、拒识及模型版本 | 结果结构含 `label / scene / score / score_calibrated=false / model_version`；明确「拒识」= 模型无法判断 / 解析失败 / 置信低 |
| 保底任务：画面可用性 / 遮挡识别 | 由**本地可解释指标**判定（第 5.1 节），确定性、可解释 |
| 拓展：场景粗分类 | 由真实模型 `glm-4v-flash` 给出 `scene`（室内 / 桌面 / 户外 / 无法判断） |
| 接入真实模型推理 | 真调智谱免费视觉模型 `glm-4v-flash`；默认关闭，开启才上传（第 5.6 节） |
| 结构化结果解析 | 严格 JSON 解析，非法 JSON / 越界字段按「无法判断」处理，不猜 |
| 低分 / 未知反馈 | 低分、未知、解析失败、超时各有一档明确文案（第 5.4 节） |
| 重新采集 | 页面「重新采集」走第 7 周 `shot`，旧结果保留为历史、不冒充新结果 |
| 人工纠正 | `POST /api/vision/correct` 写 `human_label`，与 `model_label` 并列留证 |
| 保留输入 / 结果 / 反馈三者对应 | `inference_id` 绑定 `shot_id` + 模型版本；纠正记录指向同一 `inference_id` |
| 比较高分误判与正常样例 | 页面展示「模型自报 score」与「本地可用性」两列，误判样例可对照（第 4 节实测已有一例） |
| 当堂验证①：未校准分数不写成正确率 | `score_calibrated` 恒 `false`，页面标签写「模型自报 · 未校准」，任何地方不出现「准确率 / 正确率」 |
| 当堂验证②：场景类别不转成精确位置或人身安全判断 | 代码层白名单输出字段；`scene` 只允许四个枚举；不含坐标、不含安全结论；服务端对模型输出做字段裁剪与越界过滤 |
| 备用路径：模型未就绪时先调教师真实基线 / 静态标签只测界面 | 云端关闭或调用失败时，页面明确「仅本地可用性判定 / 模型不可用」，历史图像可「回放推理」并标注 `replay=true`，绝不把静态标签当真实推理证据 |

## 3. 现状核对（第 7 周已有什么）

- 已有按需采集子系统：每次采集一条 `shot_id` 记录，`data/snapshots/<shot_id>.jpg` 落盘，`data/snapshots/events.ndjson` 记状态迁移；`GET /api/cam/shots` 可列。
- 已有 `GET /api/cam/snapshot.jpg?shot_id=`（强制带 id，非 captured 返 409）。
- **缺**：任何推理；任何「标签 + 分数 + 未校准」的表达；任何纠错与三对应记录。
- 已就位：`scripts/vision/image-metrics.py`（本地可解释指标）。

## 4. 关键实测证据（2026-11-27，决定架构分工）

用同一批样本分别跑本地指标与 `glm-4v-flash`：

| 样本 | 本地指标判定 | glm-4v-flash 判断 | 结论 |
|---|---|---|---|
| 清晰场景图 | 可用（拉普拉斯方差 307） | usable=true，标签合理 | 两者一致 |
| 高斯模糊 | 不可用（方差 0.51） | usable=true，score=1 | 模型漏判模糊 |
| 纯黑（镜头遮挡） | 不可用（亮度 0、灰度级 1、熵 1.73） | 幻觉成「穿黑衣服的人」，usable=true，score=1 | **模型严重误判** |
| 纯白（过曝） | 不可用（亮度 255、灰度级 1） | usable=false，score=0 | 模型这次判对 |

**由此定架构**：
1. **画面可用性 / 遮挡（保底任务）不做在模型上**——真实模型对纯黑图会幻觉，且 `score` 恒为 1，不可当把握度。改为本地可解释指标判定，阈值可解释、可校准、不依赖网络。
2. **模型负责它真正擅长的：场景粗分类**（描述看到了什么），并**如实标注未校准**。
3. `glm-4.5v` / `glm-4v` 均 429（无资源包），故只用免费档 `glm-4v-flash`。

## 5. 设计

### 5.1 双层判定

**保底层（本地可解释指标，`scripts/vision/image-metrics.py`）**
输出 `brightness_mean / contrast_std / laplacian_var / gray_levels / byte_entropy`，按阈值给出 `usability` 四类之一与原因：

| 判定 | 规则（默认值，配置可改） | 原因文案 |
|---|---|---|
| `blocked`（遮挡 / 全黑） | `brightness_mean < 8` 或 `gray_levels <= 3` 或 `byte_entropy < 2.0` | 画面接近全黑 / 纯色，可能镜头被遮挡 |
| `overexposed`（过曝） | `brightness_mean > 247` | 画面接近全白，可能过曝或镜头贴墙 |
| `blurred`（模糊） | `laplacian_var < 3.0` | 画面边缘极弱，可能失焦或抖动 |
| `usable`（可用） | 其余；`3.0 <= laplacian_var < 15` 额外附「偏软」提示 | 画面可用（可能偏软） |

说明：本地指标是**启发式**，能判「全黑 / 纯色 / 严重模糊」，**判不出「被有纹理的纸巾挡住」**——此边界写进页面与文档，不夸大。

**拓展层（真实模型 `glm-4v-flash`）**
仅在 `visionEnabled=true` 时调用；返回 `label`（一句话看到什么）+ `scene`（枚举之一）。`score` 只作「模型自报把握」，`score_calibrated` 恒 `false`。

### 5.2 推理实体与三者对应

每次推理生成 `inference_id`（`vis-YYYYMMDD-HHMMSS-mmm-<4hex>`），记录：

```
{
  inference_id, shot_id, trigger(ui/voice/help/replay),
  model_version("glm-4v-flash" | "local_metrics_only" | "unavailable"),
  model_label, scene, score, score_calibrated:false,
  usability, usability_reason, metrics:{...},
  outcome: "ok" | "low_score" | "unknown" | "parse_failed" | "model_unavailable" | "cloud_disabled" | "timeout" | "blocked",
  requested_at, completed_at, latency_ms,
  replay: false,
  human_label: null | {...}   // 由纠错写入
}
```

落盘：`data/vision/records.ndjson`（不进库）；保留最近 `VISION_KEEP=50` 条，超出淘汰。

### 5.3 分数语义（当堂验证①）

- `score` 一律伴随 `score_calibrated=false`；页面与接口**禁止**出现「准确率 / 正确率 / 概率为真」等表述。
- 本地 `usability` 是**规则判定**，文档与页面都称「可用 / 不可用」，不称概率。

### 5.4 反馈分支（`outcome` → 页面文案）

| outcome | 触发条件 | 页面表达 |
|---|---|---|
| `ok` | 可用 + 模型正常返回 | 「已识别：<label>（场景：<scene>）」+ 未校准提示 |
| `low_score` | 模型可用但自报 score < `VISION_LOW_SCORE=0.4` | 「模型把握较低，建议重新采集」 |
| `unknown` | 模型返回「无法判断」或字段缺失 | 「模型无法判断这张画面」 |
| `parse_failed` | 模型返回非法 JSON | 「模型输出无法解析，未采用」 |
| `model_unavailable` | 云端调用失败（超时 / 4xx / 5xx） | 「视觉模型不可用，仅显示本地可用性判定」 |
| `cloud_disabled` | `visionEnabled=false` | 「云端模型未启用，仅显示本地可用性判定」 |
| `timeout` | 超过 `VISION_TIMEOUT_MS=8000` | 同 model_unavailable，附超时 |
| `blocked` | 本地判 `blocked/overexposed/blurred` | 直接给不可用原因，**不调用模型**（省流量且避免幻觉） |

### 5.5 重新采集与人工纠正

- 「重新采集」：调用第 7 周 `POST /api/cam {action:'shot'}`；成功与否由采集记录决定，新推理是新 `inference_id`，旧记录保留。
- 「纠正」：`POST /api/vision/correct {inference_id, human_label, human_scene?, note?}`；只允许纠正已存在记录，写 `human_*` 与 `corrected_at`；不覆盖 `model_*`（保留对照）。

### 5.6 触发与隐私闸门

- 触发：仅在**按需采集**产生 captured 帧后，或对**历史 shot** 手动「回放推理」时。
- 隐私：`config.visionEnabled` 默认 `false`。为 `false` 时**绝不**把任何画面发往云端，`outcome=cloud_disabled`，只给本地可用性。
- 用户已批准：允许上传，但**默认关闭、需要时开启**（`config.local.json` 或环境变量 `VISION_ENABLED=1`）。

### 5.7 越界防护（当堂验证②）

- 输出字段白名单：仅 `label / scene / score / usability / metrics / outcome` 等；模型若返回坐标、person/safety 结论等，一律裁掉。
- `scene` 仅允许 `室内 / 桌面 / 户外 / 无法判断`；其它值归 `无法判断`。
- 代码中不提供任何「位置 / 坐标 / 人身安全」字段与推断。

### 5.8 保留策略

`data/vision/records.ndjson` 保留最近 `VISION_KEEP=50` 条；`data/vision/` 加入 `.gitignore`（画面与推理属用户资产，绝不入库）。

## 6. 接口契约

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/vision/infer` | body `{shot_id, trigger?}`；对已 captured 的 shot 推理；返回推理记录 |
| GET | `/api/vision/records` | 列出最近推理记录（含 `human_label`） |
| GET | `/api/vision/record?inference_id=` | 单条 |
| POST | `/api/vision/correct` | body `{inference_id, human_label, human_scene?, note?}` |
| GET | `/api/vision/config` | `{enabled, model, thresholds, low_score}` 只读 |

错误码：`400 shot_id_required` / `404 shot_not_found` / `409 shot_not_captured` / `502 model_error`（仅在 `visionEnabled` 且模型失败时，`outcome` 仍如实落库）。

## 7. 配置项

`config.json` 增：
```json
{ "visionEnabled": false, "visionModel": "glm-4v-flash",
  "visionLowScore": 0.4, "visionTimeoutMs": 8000, "visionKeep": 50,
  "visionThresholds": { "darkLuma": 8, "brightLuma": 247, "maxGrayLevels": 3,
                        "minEntropy": 2.0, "blurLaplacian": 3.0, "softLaplacian": 15.0 } }
```
`config.local.json` 可覆盖；环境变量 `VISION_ENABLED=1` 优先。

## 8. 当堂验证与备用路径

- **正常样例**：清晰图 → `usable` + 模型 `scene` 合理 + 未校准提示。
- **高分误判样例**：纯黑图 → 本地判 `blocked`（不调模型）；若强制看模型，页面明示「模型自报 score=1（未校准）」与本地「不可用」并列，暴露模型误判。
- **低分 / 未知 / 失败**：分别有明确文案（5.4）。
- **备用路径（回放）**：选取历史 `shot_id` 做「回放推理」，记录 `replay=true`，页面标「[回放]」；同时保留一次真实按需采集的推理作为真实证据。

## 9. 未覆盖与残余风险（不掩盖）

1. **本地指标判不了有纹理的遮挡**（如纸巾、贴脸的手）——只能判全黑 / 纯色 / 严重模糊。
2. **模型会幻觉**（纯黑判成有人物），故不用它判可用性；场景分类也可能错，标未校准。
3. **隐私**：开启后画面会发往智谱云端；默认关闭，需用户显式开启。
4. **样本少**：现有真实图个位数，无法做「准确率」统计；故全程不输出正确率。
5. **模型版本漂移**：`glm-4v-flash` 属云端，厂商升级会改变行为；记录里固定写版本名，便于回溯。

## 10. 文件改动清单与测试计划

| 文件 | 动作 |
|---|---|
| `lib/vision-infer.js` | 新增：解析模型输出、字段白名单、阈值判定调用、记录管理（纯逻辑，注入式 fetcher 便于 stub） |
| `server.js` | 新增 `/api/vision/*` 路由；接入 `lib/vision-infer.js`；不对既有 cam 路由做破坏性改动 |
| `scripts/vision/image-metrics.py` | 已就位，按需扩展阈值输入 |
| `public/app.js` `index.html` `style.css` | 摄像头页「识别结果」卡：标签 / 场景 / 未校准 / 低分未知 / 重采 / 纠正 / 历史 |
| `config.json` | 新增 vision 配置（默认关闭） |
| `.gitignore` | 新增 `data/vision/` |
| `test/vision-infer-test.js`（新） | 阈值分类、JSON 解析与裁剪、outcome 分支、三对应、纠正不改 model_* |
| `test/vision-api-test.js`（新，隔离实例） | 接口契约、shot 校验、cloud_disabled、stub 模型成功/失败/超时 |
| `test/vision-ui-contract-test.js`（新） | 前端静态契约：未校准提示、禁正确率字样、重采/纠正按钮、越界字段过滤 |
| `test/run-all.js` / `README.md` / `ASSIGNMENT.md` | 登记新测试与数字 |

测试纪律：先红后绿；stub 模型不出网；全套必须持续全绿。真实模型只在一次受控的真机/真图验证里调用，并如实记录。

## 11. 规格自检记录

- 占位符扫描：无 TODO / 待定 / 未完成章节。
- 章节一致性：第 2 节需求 ↔ 第 5 节设计 ↔ 第 8 节验证逐条对应。
- 范围：一个实现计划可覆盖（lib + 3 路由 + 前端卡 + 3 测试）。
- 歧义消解：`score` 语义统一为「模型自报、不校准」；可用性统一由本地规则判；`outcome` 枚举封闭。
