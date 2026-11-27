# 项目结构与分类规范

> 这份文件回答一个具体问题：**新写一个文件，该放哪？**
> 目录树本身见 [README.md](../README.md) 第三章；这里只写规则与判定顺序。

## 一、目录职责

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| `server.js` | 唯一后端入口（HTTP / WebSocket / 串口 / 落盘） | 可复用逻辑（下沉到 `lib/`） |
| `lib/` | 可复用、可单独测试的服务端模块（无入口逻辑） | 需要启动服务端才能跑的东西 |
| `public/` | 浏览器三件套：`index.html` / `style.css` / `app.js` | 构建产物、图片素材 |
| `scripts/` | 运维与构建脚本（部署、烧录、WiFi、代码审计） | 产品运行时代码 |
| `scripts/asr/` | 识别引擎脚本（PowerShell / Python），由 `lib/` 的适配层调用 | Node 代码 |
| `scripts/vision/` | 视觉指标 / 推理脚本（Python），由 `lib/` 的适配层调用 | Node 代码 |
| `test/` | 由 `test/run-all.js` 编排的自动化测试 | 需要真机 / 需要人工判断的脚本 |
| `test/manual/` | 需真机或手工执行的取证、探针、验收脚本 | 断言不稳定的东西（不稳定就别进自动化） |
| `docs/` | 周次文档、评审记录、取证报告（`.md` / `.txt`） | 图片与原型 HTML |
| `docs/assets/` | 文档引用的截图（`.png`）与 UI 原型（`.html`） | 正文文档 |
| `data/` `recordings/` | 运行时真实数据（采样、求助、录音、导出 CSV） | 任何代码 |

## 二、命名规范

| 后缀 / 前缀 | 含义 | 例 |
|---|---|---|
| `*-test.js` | 自动化测试，**必须**登记进 `test/run-all.js` | `voice-cancel-test.js` |
| `*-contract-test.js` | 纯静态契约测试（读源码 / HTML 断言，不起服务） | `theme-contract-test.js` |
| `manual/*.js` | 需硬件或人工，文件头写 `用法：node test/manual/xxx` | `voice-hil.js` |
| `lib/*.js` | 服务端模块，导出工厂函数（`createXxx()`） | `lib/voice-vosk-asr.js` |
| `audit-*.js` | 只读代码审计 | `audit-dup.js` |
| `weekN-*.md` | 按课程周次归档 | `week6-voice.md` |
| `*-forensics.md` | 一次专项取证报告 | `fps-degradation-forensics.md` |

## 三、新文件该放哪：按这个顺序问

1. **它是测试吗？**
   - 能在 CI / 无硬件环境下稳定通过 → `test/*-test.js`，并登记 `run-all.js` 的 `SUITES`。
   - 需要板子、需要人工听/看、或要打生产 8080 → `test/manual/`，**不进编排器**。
2. **它是产品代码吗？**
   - 被 `server.js` 引入、可独立单测 → `lib/`。
   - 入口本身 → `server.js`（不要再加第二个入口）。
   - 浏览器端 → `public/`。
3. **它是给人执行的脚本吗？**
   - 构建 / 部署 / 烧录 / 换 WiFi → `scripts/`。
   - 被 `lib/` 调用的引擎脚本（Python / PowerShell）→ `scripts/asr/`。
4. **它是文档吗？**
   - 正文 → `docs/*.md`；截图与原型 → `docs/assets/`。
5. **它是数据吗？** → `data/` 或 `recordings/`，**一律不进库**。

## 四、登记规则（漏一条就算没做完）

新增自动化测试时，下面三处必须同时更新：

1. `test/run-all.js` 的 `SUITES`（`name` / `file` / `kind` / 需要端口就写 `needsServer`）。
2. `README.md` 第三章目录树 + 第「跑测试」章节的命令清单。
3. `ASSIGNMENT.md` §7 的「测试文件与断言数」标题与清单；数字要**实测相加**，不要估。

## 五、不进版本库的东西

`node_modules/`、`firmware/s3eye_imu_idf/build/`、`managed_components/`、`data/`、`recordings/*.csv`、
`config.local.json`（含 Key）、`firmware/.../app_config.local.h`（含 WiFi 密码）、`test/.test-data*`、`data/.asr-tmp/`。
完整清单见 `.gitignore`，每条都带原因注释。

## 六、整理记录

**2026-11-19 分层整理**（21 个文件移动，全套 999 项测试通过）：

- 根目录 3 个业务模块 → `lib/`（`voice-serial-rx.js` / `voice-local-asr.js` / `voice-vosk-asr.js`）。
- 识别引擎脚本 → `scripts/asr/`（`asr-local.ps1` / `asr-vosk.py`）；视觉指标脚本 → `scripts/vision/`（`image-metrics.py`）。
- 12 个真机 / 手工脚本 → `test/manual/`，`run-all.js` 只保留 36 个自动化测试。
- 2 张截图 + 2 个 UI 原型 → `docs/assets/`。
- 清理：7 个 `test/.test-data*` 残留目录、2 个手工日志、243 KB 的 `flash_week3.log`（整理版证据在 `week3-flash-evidence.txt`）。
- 未动：`data/`（636 MB 运行时数据）、`recordings/`（188 个 CSV）、根配置（`config*.json` / `package.json` / `start.bat`）。

**2026-11-27 新增 `scripts/vision/`**（第 8 周前置）

- 新增 `image-metrics.py`：本地可解释画面指标（拉普拉斯方差 / 亮度 / 对比度 / 字节熵），供 `lib/` 视觉适配层调用；不进编排器（需 Python + Pillow）。