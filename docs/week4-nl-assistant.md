# 第 4 周：用自然语言查询与请求采集

> 本周问题：**"查看上次数据"和"重新采集一次"应怎样映射为不同任务，并使用前两周已验证的接口？**

---

## 一、本周问题的答案：一句话两种任务，接口完全不同

| | 「查看上次数据」 | 「重新采集一次」 |
|---|---|---|
| 本质 | **读历史**：查存储里已有的一条记录 | **发指令**：让设备立即采一帧新的，并等待结果 |
| 工具 | `query_last` | `collect_once` |
| 使用的接口 | 落盘记录查询（第 1 周 `readRecords`） | 远程采集状态机（第 2 周 `POST /api/collect` 全链路） |
| 时间语义 | **保留旧时间**，并明确告知"这是历史记录" | 等待**新结果到达**，时间 = 新观测到达时刻 |
| 完成判据 | 记录存在即回答 | 必须等到状态机 `completed`（回执 + 新观测同一 `request_id`） |
| 无证据时 | 如实说"还没有历史记录" | **绝不说"已采集成功"**，如实报超时/失败原因 |

两者**共用前两周已验证的接口**，NL 模块只是薄薄一层"意图 → 工具"的映射，不新造任何数据链路。

---

## 二、架构与数据流

```mermaid
flowchart LR
    U[浏览器 #ask 页] -->|POST /api/nl {text}| S[服务端 NL 模块]
    S --> P{意图解析}
    P -->|已配置| L[LLM 服务<br/>OpenAI 兼容协议<br/>密钥留服务端]
    P -->|未配置/失败| R[规则兜底解析器<br/>备用路径]
    L --> J{intent 结构化校验}
    R --> J
    J -->|query_last| Q[readRecords<br/>读最近一条历史记录]
    J -->|collect_once| C[createCollectRequest<br/>第2周采集状态机]
    J -->|ambiguous| A[澄清：列出两个可选任务]
    J -->|out_of_scope| X[拒绝：设备白名单/危险操作]
    J -->|location_query| L2[如实说明：不提供位置，不生成坐标]
    Q --> ANS[结构化回复<br/>reply + intent + tool + evidence]
    C --> ANS
    ANS --> U
```

**关键点**：

- 浏览器**只接触** `POST /api/nl`，永远拿不到 LLM 密钥（`密钥留服务端`）；
- 解析器输出必须通过**结构化校验**（intent 白名单），非法输出自动降级规则解析；
- 工具执行前有**统一设备闸门**：任何意图只要点名白名单外设备，一律拒绝。

---

## 三、意图映射表

| 用户输入（样例） | intent | 动作 |
|---|---|---|
| 查看上次数据 / 上次数据是多少 / 最近的数据怎么样 | `query_last` | 读历史记录，保留旧时间 |
| 重新采集一次 / 再采一帧 / 现在采一次 | `collect_once` | 发起采集并等待新结果 |
| 数据 / 采集（无法判断） | `ambiguous` | 澄清：列出两个可选任务，不执行 |
| 查看S3EYE-GROUP99的数据 | `out_of_scope` | 拒绝：不在设备白名单 |
| 删除所有记录 / 打个电话 | `out_of_scope` | 拒绝：越界/危险操作 |
| 设备在哪里 / 给我坐标 | `location_query` | 如实说明不提供位置，**绝不生成坐标** |
| 今天天气怎么样 | `other` | 引导：只提供两个能力 |

**解析引擎两级**：

1. **LLM（优先）**——OpenAI 兼容 `/v1/chat/completions`，`temperature=0` + `response_format: json_object`，
   system 提示词要求只输出 `{"intent","device","reason"}`；任何失败（未配置/超时 8s/非法 intent）→ 自动降级。
2. **规则兜底（备用路径）**——中文关键词匹配，无网络依赖，当堂验证全部用例可过。
   回复里的 `engine` 字段如实标注用的是哪一级（`llm` / `rule`）。

---

## 四、受限工具规约

### `query_last`

```jsonc
// 参数（执行前统一校验）
{ "device": "S3EYE-GROUP01" }        // 只允许白名单设备
// 返回 evidence
{ "found": true, "recv_iso": "2026-09-28T06:32:02.144Z", "recv_ts": 1790577122144,
  "board_ts": 1790577122209, "record_seq": 106, "age_ms": 82, "stale": false }
```

- 直接调用第 1 周的 `readRecords()`，**不触发任何采集请求**（自动化测试断言了这一点）；
- 回复固定声明"历史数据，不是新采集"，`age_ms` 让"旧"有数字可依。

### `collect_once`

```jsonc
// 返回 evidence（成功时）
{ "status": "completed", "request_id": "req-20260928-143216-0001",
  "ack_status": "received", "seq_before": 7993, "seq_observed": 7994,
  "completed_iso": "2026-09-28T06:32:16.172Z",
  "checks": { "arrived_after_dispatch": true, "seq_increased": true },
  "simulated": false, "fields": { "acc_x_g": 0.3056, "...": "..." } }
```

- 完全复用第 2 周状态机：`submitted → dispatched → acked → completed / timeout`；
- 只有 `completed` 才允许回复"采集成功"——即**设备回执 + 新观测（seq 严格 +1、到达晚于下发、同一 request_id）**；
- `timeout / failed` 时如实回复"未能确认采集完成 + 原因"，绝不拿旧值充数；
- `mockDevice` 模式的结果一律带 `simulated: true` 标注，界面不把它当真实送达。

---

## 五、LLM 服务接入（密钥留服务端）

```bash
# 方式一：config.local.json（已被 .gitignore 忽略，模板见 config.local.json.example）
{ "nlEndpoint": "https://api.deepseek.com", "nlApiKey": "sk-...", "nlModel": "deepseek-chat" }

# 方式二：环境变量
NL_ENDPOINT=... NL_API_KEY=... NL_MODEL=... node server.js
```

- 未配置时服务端如实向浏览器声明 `llm_configured: false, engine: "rule"`（能力自证）；
- `GET /api/nl` 只暴露"是否已配置 + 服务域名"，**不暴露路径、密钥、模型名以外的任何凭据**；
- 本课**不训练语言模型**——只做授权服务调用 + 结构化输出校验。

---

## 六、当堂验证（逐条实测）

| # | 验证项 | 操作 | 预期 | 实测结果 |
|---|--------|------|------|----------|
| 1 | **同一旧数据，"查看"保留旧时间** | 注入 seq=100 帧 → 查两次 | 两次 `recv_ts` 相同，且不产生采集请求 | ✅ 自动化断言通过 |
| 2 | **"重新采集"等待对应新结果** | 真实板子在线，说"重新采集一次" | 新观测 seq=7994（下发前 7993），checks 全真 | ✅ 实测 `2026-09-28T06:32:16Z`，`simulated:false` |
| 3 | **无位置/过期位置说明不足，不生成坐标** | "设备在哪里" / "给我坐标" | 说明不提供位置；回复中无经纬度样式数字 | ✅ 自动化断言通过 |
| 4 | 含糊输入 | 只说"数据" | 澄清两个任务，不执行 | ✅ |
| 5 | 越界请求 | 白名单外设备 / 删除记录 | 拒绝并说明范围 | ✅ |
| 6 | 设备无响应 | 关掉 mockDevice 再"重新采集" | 如实报"未能确认采集完成"，**不含"采集成功"** | ✅ status=timeout |
| 7 | 备用路径 | 不配置 LLM | 规则解析全用例通过，引擎如实标注 | ✅ 35/35 |

**自动化测试**：`node test/nl-test.js` → **35 项断言全部通过**（隔离端口 8098 + 临时数据目录，不污染真实数据；当堂时 35 项，现为 37 项）。

**真实设备实测记录**（2026-09-28 14:32，串口在线）：

```
"查看上次数据" → query_last：上次记录接收于 2026-09-28T06:32:02.144Z，距今约 0 秒，
                 三轴 acc_g=(0.3123, -0.0588, 0.1085)，温度 46.8°C（历史数据声明）
"重新采集一次" → collect_once：设备已回执（received），新观测 seq=7994 于
                 2026-09-28T06:32:16.172Z 到达，回执与新观测同一 request_id，证据链完整
```

页面截图：[`week4-ask-page.png`](week4-ask-page.png)（导航「自然语言」页，引擎徽章、能力说明、受限声明）。

---

## 七、文件改动清单

| 文件 | 改动 |
|------|------|
| `server.js` | NL 模块：LLM 解析器（OpenAI 兼容 + 结构化校验 + 超时降级）、规则兜底解析器、设备白名单闸门、`nlRunQueryLast/nlRunCollectOnce` 受限工具、`nlHandle` 主入口；路由 `POST /api/nl`（对话）与 `GET /api/nl`（能力说明，不泄密钥） |
| `public/index.html` | 导航新增「自然语言」；`#ask` 分页（对话区 + 输入框 + 受限声明） |
| `public/app.js` | `PAGES` 增加 `ask`；`loadNlCap/nlBubble/nlEvidenceHtml/nlSend`；证据区渲染（状态/request_id/seq 前后/时间/模拟标注/校验结果） |
| `public/style.css` | 聊天气泡、意图/工具/引擎徽章、证据键值表样式 |
| `test/nl-test.js` | 当堂验证自动化测试（35 项断言，隔离端口 8098 + `DATA_DIR` 临时目录；现为 37 项） |
| `test/.test-nl-config.json` | NL 测试夹具（mockDevice=true、白名单 S3EYE-GROUP01、超时 2.5s；**必须提交**，同 §5.6 教训） |
| `config.local.json.example` | LLM 配置模板（`config.local.json` 已加入 `.gitignore`） |
| `docs/week4-nl-assistant.md` | 本文档 |

---

## 八、备用路径与迁移

- **服务异常时**：LLM 超时/报错/输出非法 JSON → 自动降级规则解析，回复 `engine` 字段如实标注来源，可用结构化样例（本文第三节）定位解析问题；
- **真实模型调用补验**：拿到教师授权服务的 endpoint + key 后填入 `config.local.json` 即可，无需改代码（协议为 OpenAI 兼容）；
- **向个人项目迁移**：受限语言入口 = 「意图白名单 + 设备白名单 + 工具表 + 证据结构」四件套。
  迁移时只需替换 ① 工具表（换成本项目的接口）、② 设备白名单、③ LLM 提示词中的意图清单；
  诚实性规则（无证据不声称成功、无位置不生成坐标）应原样保留。
