# Git Flow 日常协作规范（精简版）

> 分支模型：`master` + `develop` + `feature/*`
> 适用于 `imu-monitor` 仓库（remote: `git@github.com:linzizhen/esp-web.git`）

---

## 一、分支职责

| 分支 | 角色 | 规则 |
|---|---|---|
| `master` | 已验收的稳定版本 | **只接受来自 `develop` 的合并**，不直接提交 |
| `develop` | 日常集成分支 | 所有 `feature/*` 汇入此处，保持随时可运行 |
| `feature/*` | 短生命周期开发分支 | 从 `develop` 切出，完成后合回 `develop` 并删除 |

`master` 与 `develop` 都是**长期分支**；`feature/*` 用完即删，不长期保留。

---

## 二、日常开发流程

### 1. 开始一个新功能

```bash
git checkout develop
git pull                                  # 先同步，避免基于旧代码开发
git checkout -b feature/llm-多轮对话       # 分支名用中文简述也可以
```

### 2. 开发过程中提交（原子提交）

每完成一个逻辑变更就提交，不要把多件事攒在一起：

```bash
git add <相关文件>
git commit -F .git-msg.tmp                # 见第四节：PowerShell 下别用 heredoc
```

**提交前自检**（每次都要过一遍）：

- [ ] 这个提交能独立回滚吗？
- [ ] 能用一句话描述吗？
- [ ] 只改了一件事吗？
- [ ] type 是否正确？
- [ ] subject 是动宾短语且不超过 50 字符、无句号结尾？

**关键原则**：功能代码与它的测试**同一个提交**。本仓库已实测验证过——
NL 功能的测试断言若与 NL 代码分开提交，中间态会红。

### 3. 功能完成，合回 develop

```bash
npm test                                  # 全量 23 个文件 600 项断言，必须全绿
git checkout develop
git merge --no-ff feature/llm-多轮对话     # --no-ff 保留分支拓扑，便于回溯
git push origin develop
git branch -d feature/llm-多轮对话         # 本地删除
git push origin --delete feature/llm-多轮对话   # 远端删除（若推送过）
```

`--no-ff` 让合并产生一个明确的合并提交，`git log --graph` 能看出「这批改动
来自哪个功能」，而不是被压成一条直线。

### 4. 发布一个稳定版本

```bash
git checkout master
git merge --no-ff develop
git tag -a v1.2.0 -m "第 4 周：自然语言查询与受限工具"
git push origin master --tags
```

打标签便于日后 `git checkout v1.2.0` 复现任意历史版本。

---

## 三、提交信息格式

```
<type>(<scope>): <中文简述>

<为什么改 / 怎么改>

<验证方式>
```

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修复缺陷 |
| `refactor` | 重构（不改行为） |
| `perf` | 性能优化 |
| `test` | 测试 |
| `docs` | 文档 |
| `style` | 代码格式 |
| `chore` | 构建 / 工具 |
| `ci` | CI 配置 |
| `revert` | 回滚 |

**示例**（本仓库真实提交的精简形式）：

```
fix(nl): 修复 Base URL 带 /v1 时重复拼接导致 404

原因：原实现无条件拼 /v1/chat/completions，用户按厂商文档粘贴带 /v1 的
Base URL 时会请求到 /v1/v1/chat/completions。
方案：新增 nlChatUrl() 兼容三种写法……
验证：nl-config-test 44 项全过。
```

> 注：该修复实际随 `805792f feat(nl): 任务注册表扩展点、模型润色与 Base URL
> 归一化` 一起提交——因为它与 NL 模块的测试断言互相交叉，拆开会留下不过测试
> 的中间态。这正是第二节「功能代码与测试同一提交」原则的一个真实取舍案例。

写「为什么」比写「改了什么」更有价值——半年后看 `git log` 的人需要知道
当时的约束，而不只是代码差异。

---

## 四、本机环境注意事项

### PowerShell 下不要用 heredoc

```powershell
# ✗ 会报「缺少文件规范」
git commit -m "$(cat <<'EOF'
...
EOF
)"

# ✓ 写文件再引用
git commit -F .git-msg.tmp
```

### 提交信息文件用完即删

`.git-msg.tmp` 不属于仓库内容，提交后立刻删除，避免误提交。

### 行尾警告可以忽略

本仓库文件以 LF 存储，Windows 检出为 CRLF，`git add` 时会提示
`LF will be replaced by CRLF`。这是正常行为，不是错误。

### 测试夹具的行尾会漂移

`test/.test-config.json` 与 `test/.test-nl-config.json` 被测试写入后会显示
为「已修改」，但 `git diff` 内容为空（仅行尾变化），`git diff --raw` /
`--numstat` 也都是空——这不是内容改动，是索引里的 stat 信息过期。

实测有效的处理：

```bash
git add test/.test-config.json test/.test-nl-config.json
git status --short          # 两行 M 消失
```

因为内容哈希没变，`git add` 只刷新 stat 信息，**不会**产生任何暂存差异，
可以放心执行。`git update-index --refresh` 对这种情况无效，别白试。

### 绝不可提交的内容

以下均已 gitignore，若发现被跟踪要立刻处理：

- `config.local.json`（含真实 LLM 密钥）
- `firmware/s3eye_imu_idf/main/app_config.local.h`（含 WiFi 密码）
- `data/*.ndjson`、`recordings/*.csv`（真实采集数据）
- `node_modules/`、`firmware/**/build/`

提交前可用这条命令自查（把 `sk-` 换成你的密钥前缀）：

```bash
git grep -l "sk-你的密钥前缀" HEAD
```

有输出就说明密钥进了历史，需要改写历史（`git filter-repo`）而不是简单删除文件。

---

## 五、常用命令速查

```bash
# 看分支拓扑（推荐常看）
git log --oneline --graph --all -20

# 看某分支比 develop 多/少了什么
git log --oneline develop..feature/xxx
git diff develop...feature/xxx

# 撤销工作区改动（未 add）
git checkout -- <file>

# 撤销已 add 但未提交
git restore --staged <file>

# 临时保存手头工作
git stash push -u -m "说明"
git stash pop

# 安全回滚一个已提交的变更（保留历史）
git revert <commit>

# 查某个文件每一行的最后修改者
git blame <file>
```

---

## 六、当前仓库状态

- 长期分支：`master`（稳定版）、`develop`（集成）
- `develop` 领先 `master` 52 个提交，尚未合并发布
- 测试：`npm test` → 23 个测试文件、600 项断言
- 只读审计：`npm run audit`

**分支现状说明**：截至 2026-10-26，`develop` 上的 32 个提交都是**直接提交**，
没有走 `feature/*`。原因是这批改动是在分支模型确立之前就已在工作区堆好的
存量，只能先按主题拆成原子提交补记历史。**从此往后的新功能一律走
`feature/*`**，见第二节第 1 步。

**下一步建议**：验证一段时间后，按第二节第 4 步把 `develop` 合并到
`master` 并打 `v1.0.0` 标签。
