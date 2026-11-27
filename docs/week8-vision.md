# 第 8 周：把视觉推理结果变成可理解反馈

> 对应课程：第 8 周「把视觉推理结果变成可理解反馈（理论 1 + 实践 3 学时）」
> 设计规格：[week8-vision-design.md](week8-vision-design.md)（先设计后实现）
> 完成日期：2026-11-27

## 一、本周问题与答案

**问题：模型返回一个标签和分数，系统应该如何表达「看到了什么」和「还有什么不能确定」？**

答案（也是本实现的骨架）：**把「能不能用」和「看到什么」分成两层，分别用可信的手段回答**：

- **能不能用（可用性 / 遮挡）** —— 用**本地可解释指标**判定（亮度 / 对比度 / 拉普拉斯方差 / 灰度级 / 字节熵）。它确定性、可解释、不联网，不会幻觉。
- **看到什么（场景粗分类）** —— 用**真实视觉模型 `glm-4v-flash`**，但它的分数只作「模型自报把握」，**永远标注未校准**。
- **还不确定什么** —— 低分、无法判断、解析失败、超时、云端关闭、画面不可用，每一档都有**明确的人话反馈**，绝不把「没看清」说成「看到了」。

## 二、为什么不用模型判可用性（决定性实测）

2026-11-27 用同一批样本对照（本地指标 vs `glm-4v-flash`）：

| 样本 | 本地指标判定 | `glm-4v-flash` 判断 | 结论 |
|---|---|---|---|
| 清晰场景图 | 可用（拉普拉斯方差 307） | usable=true，标签合理 | 一致 |
| 高斯模糊 | 不可用（方差 0.51） | usable=true，score=1 | 模型漏判模糊 |
| 纯黑（镜头遮挡） | 不可用（亮度 0、灰度级 1、熵 1.73） | 幻觉成「穿黑衣服的人 / 白色杯子」，score=1 | **严重误判** |
| 纯白（过曝） | 不可用（亮度 255、灰度级 1） | usable=false，score=0 | 这次判对 |

**所以**：可用性交本地指标，模型只做场景分类。`score` 恒为 1 或 0.5，不能当把握度，更不能当正确率。

## 三、真实模型受控验证（人工脚本 `test/manual/vision-live-check.js`）

用真实板载快照 + 真实云端模型跑一次（输出原文摘录）：

| 样本 | 启用云端 | 本地可用性 | 结果 outcome | 场景 | 标签 | 分数 | 分数已校准 |
|---|---|---|---|---|---|---|---|
| 清晰真机图（shot-20261125-103823） | 是 | usable（方差 25.53） | ok | 无法判断 | 模糊的灰色表面 | 0.5 | false |
| 清晰真机图 | 否 | usable | cloud_disabled | 无法判断 | —（未调用模型） | — | false |
| 偏软真机图（shot-20261119-161441） | 是 | usable（方差 8.67） | ok | 室内 | 天花板上的黑色小点 | 0.5 | false |
| 纯黑图 | 是 | blocked（方差 0） | blocked | 无法判断 | —（未调用模型） | — | false |

另：直接拿纯黑图问模型，返回「图片中有一个白色的杯子，score=1」——**复现了幻觉 + 分数恒为 1**，与本地判定「blocked」并列，正是本周要暴露的「高分误判」样例。注意：整条链路里模型分数从不写正确率。

## 四、需求逐条落地

| 课程要求 | 实现 | 证据 |
|---|---|---|
| 预测标签、分数、拒识、模型版本 | 记录含 `model_label / scene / score / score_calibrated(=false) / model_version` | `lib/vision-infer.js`；单测断言 |
| 保底：画面可用性 / 遮挡 | 本地指标四态（usable / blocked / overexposed / blurred） | `classifyMetrics` 单测 5 例 |
| 拓展：场景粗分类 | `glm-4v-flash` 返回 `scene` 四枚举 | live-check 真机图 → 室内 |
| 接入真实模型推理 | 真调智谱免费视觉模型 | live-check `outcome=ok`，标签非空 |
| 结构化结果解析 | 容忍 ```json 围栏、字段白名单裁剪 | `parseModelOutput` 单测（含越界字段丢弃） |
| 低分 / 未知反馈 | `low_score / unknown / parse_failed / model_unavailable / timeout` 各有文案 | 单测 6 例 + 前端 `VIS_OUTCOME_TEXT` |
| 重新采集 | 「重新采集」触发第 7 周 shot | 前端 `btnVisionRecapture` |
| 人工纠正 | `POST /api/vision/correct` 写 `human_label`，不覆盖 `model_*` | 单测 + 集成测试 |
| 保留输入/结果/反馈三者对应 | `inference_id` 绑定 `shot_id`，纠正指向同一条 | 单测 + 集成测试断言 `shot_id` 一致 |
| 当堂验证①：未校准分数不写正确率 | `score_calibrated` 恒 false；页面明写「未校准」且禁「准确率」 | `vision-ui-contract-test` 断言 |
| 当堂验证②：场景不转坐标 / 人身安全 | 前端无 latitude/longitude；scene 仅四枚举；接口裁越界字段 | UI 契约 + 解析单测 |
| 备用路径：模型未就绪时 | 云端关闭/失败时明确「仅本地可用性判定」；历史图像可「回放推理」标 `replay` | `cloud_disabled` 分支 + 前端提示 |

## 五、隐私与默认关闭

- `config.visionEnabled` 默认 **false**；为 false 时 `/api/vision/infer` 返回 `cloud_disabled`，**一个字节都不发往云端**（单测断言「模型调用次数=0」）。
- 开启方式（用户批准「允许上传、默认关闭、需要时开启」）：
  - `config.local.json` 加 `"visionEnabled": true`（或 `"visionApiKey"/"visionEndpoint"` 覆盖），或
  - 环境变量 `VISION_ENABLED=1`。
- 开启后抓拍帧会发往智谱；`data/vision/` 已加入 `.gitignore`（推理记录引用环境图像，属用户资产）。

## 六、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/vision/infer` | `{shot_id, trigger?}`，对已 captured 的 shot 推理 |
| GET | `/api/vision/records` | 最近推理记录（含 `human_label`） |
| GET | `/api/vision/record?inference_id=` | 单条 |
| POST | `/api/vision/correct` | `{inference_id, human_label, human_scene?, note?}` |
| GET | `/api/vision/config` | `{enabled, model, low_score, thresholds}` |

错误：`400 shot_id_required` / `404 shot_not_found` / `409 shot_not_captured` / `502 model_error`。

## 七、怎么验证

1. 刷新页面 `http://127.0.0.1:8080/#cam`（`app.js?v=51`），先点「抓拍一帧」拿到一张 captured。
2. 点「对这张图做识别」：默认（云端关闭）显示「云端模型未启用，仅显示本地可用性判定」+ 可用性 + 未校准提示。
3. 若要验真实模型：在 `config.local.json` 设 `visionEnabled:true` 后重启服务端，再点识别，会看到场景与模型标签（分数标「模型自报 · 未校准」）。
4. 人工纠正：在输入框填「这张图其实是什么」→「提交纠正」，记录里并列显示人工与模型结果。
5. 受控真实验证：`node test/manual/vision-live-check.js`（需联网 + Key + `.asr-venv`）。

## 八、测试与文件

- 新增测试：`test/vision-infer-test.js`（46）、`test/vision-api-test.js`（28，隔离实例）、`test/vision-ui-contract-test.js`（28）。
- 全套：**43 个测试文件 / 1284 项断言全通过**。
- 新增/改动文件：`lib/vision-infer.js`、`server.js`（5 个 `/api/vision/*` 路由 + 指标适配 + 模型客户端）、`public/{app.js,index.html,style.css}`（识别卡）、`config.json`（vision 配置，默认关闭）、`.gitignore`（`data/vision/`）、`scripts/vision/image-metrics.py`（既有）、`test/manual/vision-live-check.js`。

## 九、未覆盖与残余风险（不掩盖）

1. **本地指标判不了「有纹理的遮挡」**（纸巾、贴脸的手）——只认全黑 / 纯色 / 严重模糊。
2. **模型会幻觉、分数不可校准**——故只做场景分类，标未校准；不能据此判断「拍到了什么就一定对」。
3. **样本少**：真实图个位数，无法统计准确率；全程不输出正确率。
4. **云端模型版本会漂移**：记录固定写 `glm-4v-flash`，便于回溯。
5. **上传隐私**：开启后画面出本机，默认关闭需显式开启。
