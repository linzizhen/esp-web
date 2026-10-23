# VPS 部署手册（Windows Server）

> **当前状态：未部署**（本组暂无分配的 VPS，按课程「备用路径」以本机作服务器）。
> 本文档提供**完整可执行的部署方案**，拿到 VPS 后照此操作即可上线；
> 提交材料中的「部署状态」一栏应如实填写为「VPS 待补」。

---

## 一、部署形态

本项目是**单进程 Node.js 服务**，无数据库、无构建步骤、无反向代理需求：

| 组件 | 说明 |
|---|---|
| 依赖 | `serialport`（原生模块）+ `ws`，仅 2 个 |
| 静态资源 | `public/` 由 `server.js` 直接托管，无需 nginx |
| 数据 | NDJSON 落盘到 `data/`，无需数据库 |
| 端口 | 默认 8080（可由 `PORT` 环境变量覆盖） |
| VPS 上是否需要串口 | **不需要**。`config.vps.json` 已关闭串口自动探测，板子走 WiFi |

> 关键前提：**VPS 上不连开发板**。上行靠板端 `POST /api/data`，下行靠板端轮询
> `GET /api/cmd`，两条路都走网络，串口只是本机调试的额外通道。

---

## 二、前置准备

### 2.1 安装 Node.js 18+

下载 LTS 版安装包（`.msi`），安装时勾选「Add to PATH」：

<https://nodejs.org/en/download>

安装后在 PowerShell 验证：

```powershell
node --version    # 应 ≥ v18
npm --version
```

### 2.2 安装 Native 编译环境（`serialport` 需要）

`serialport` 是原生模块，`npm install` 时需要编译。若 VPS 上没有编译环境会报错
（见第五节）。安装方式：

```powershell
# 以管理员身份运行
npm install --global windows-build-tools    # 旧方案，可能已废弃
```

**推荐**：直接安装 **Visual Studio Build Tools**，勾选「使用 C++ 的桌面开发」，
再装 Python 3 并加入 PATH。详见 <https://github.com/nodejs/node-gyp#installation>

> 若只是在 VPS 上跑服务、不做串口相关开发，可用下面这条绕过编译：
> ```powershell
> npm install --omit=dev --ignore-scripts
> ```
> 但注意：跳过编译后 `serialport` 无法使用。VPS 上不连板子，**通常可以接受**，
> 只是 `/api/diag` 里的串口枚举会报错，不影响 WiFi 上报。

---

## 三、部署步骤

### 3.1 上传代码

把整个项目目录传到 VPS，例如 `C:\apps\imu-monitor`。两种方式：

```powershell
# 方式 A：Git（推荐，便于后续更新）
git clone <仓库地址> C:\apps\imu-monitor

# 方式 B：打包上传后解压
#   scp -r imu-monitor user@vps:/C:/apps/
```

**不要上传**（已被 `.gitignore` 排除，且含本机私密信息）：

- `config.local.json`（LLM 密钥）
- `firmware/s3eye_imu_idf/main/app_config.local.h`（WiFi 密码）
- `data/`、`recordings/`（本机历史数据）

### 3.2 一键部署

以**管理员身份**打开 PowerShell：

```powershell
cd C:\apps\imu-monitor
.\scripts\deploy-vps.ps1
```

脚本会依次完成：

1. 检查 Node.js 版本、`config.vps.json` 是否存在
2. `npm install --omit=dev` 安装依赖
3. 创建 `data/`、`recordings/`、`logs/` 目录
4. 添加入站防火墙规则（TCP 8080）
5. 停止占用端口的旧进程
6. **注册开机自启计划任务**（SYSTEM 身份，失败自动重启 3 次）
7. 启动并探活验证

常用参数：

```powershell
.\scripts\deploy-vps.ps1 -Port 9000            # 换端口
.\scripts\deploy-vps.ps1 -SkipNpmInstall       # 跳过依赖安装
.\scripts\deploy-vps.ps1 -Status               # 查看状态
.\scripts\deploy-vps.ps1 -Uninstall            # 卸载
```

### 3.3 放行云厂商安全组

脚本只处理 **Windows 防火墙**。云服务器（阿里云/腾讯云/AWS 等）还有一层
**安全组**，必须单独放行 8080（或你指定的端口），否则外网仍无法访问。

### 3.4 验证

```powershell
# 本机
Invoke-RestMethod http://127.0.0.1:8080/api/state

# 外网（在另一台机器上）
curl http://<VPS公网IP>:8080/api/state
```

看到 JSON 且 `connected` 字段存在，说明服务端已就绪。

---

## 四、让开发板连上 VPS

### 4.1 改固件指向

编辑 `firmware/s3eye_imu_idf/main/app_config.local.h`（已被 gitignore）：

```c
#define APP_WIFI_SSID   "你的热点名"
#define APP_WIFI_PASS   "你的密码"
#define APP_SERVER_HOST "VPS 公网 IP"      // ← 改成 VPS 地址
#define APP_SERVER_PORT 8080
#define APP_DEVICE_ID   "S3EYE-GROUP01"
```

### 4.2 烧录

```powershell
npm run firmware:flash
```

### 4.3 验证独立联网

开发板**不插电脑**（接充电头供电），观察：

- VPS 上 `Invoke-RestMethod http://127.0.0.1:8080/api/state` 中
  `transport` 应为 **`wifi`**，`device.path` 应为 `WiFi(<板子IP>)`
- `seq` 持续增长（板子在持续上报）
- 网页刷新能看到实时数值

> 这正是第 1 周「独立网络上传已验证」的判据。**USB 直连不算通过**，
> 必须看到 `transport=wifi`。

---

## 五、常见问题

### 5.1 `npm install` 报错（node-gyp / MSBuild）

```
gyp ERR! find VS  msvs_version not set from command line or npm config
```

**原因**：缺少 C++ 编译环境。
**做法**：安装 Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」），
或改用 `npm install --omit=dev --ignore-scripts`（VPS 不需要串口时可用）。

### 5.2 服务启动但外网访问不了

按顺序排查：

1. **Windows 防火墙**：`Get-NetFirewallRule -DisplayName "IMU-Monitor-HTTP"`
   确认存在且 `Enabled=True`
2. **云厂商安全组**：控制台检查入站规则是否放行该端口
3. **服务监听地址**：必须是 `0.0.0.0` 而非 `127.0.0.1`
   ```powershell
   Get-NetTCPConnection -LocalPort 8080 -State Listen   # LocalAddress 应为 0.0.0.0
   ```

### 5.3 端口被占用（EADDRINUSE）

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen
# 记下 OwningProcess，然后
Stop-Process -Id <PID> -Force
```

或换端口：`.\scripts\deploy-vps.ps1 -Port 9000`（记得同步改固件与安全组）。

### 5.4 板子上报失败（页面一直「未检测到开发板」）

看板端串口日志（插电脑时）：

- `（串口未打开，开发板也未在轮询）` → 心通道不可用
- `WiFi 上传连续失败` → 检查 `APP_SERVER_HOST` 是否可达

在 VPS 上验证板子是否真的到了：

```powershell
# 看最近记录
Invoke-RestMethod 'http://127.0.0.1:8080/api/records?limit=5'

# 看诊断
Invoke-RestMethod http://127.0.0.1:8080/api/diag
```

### 5.5 服务日志在哪

`logs/server.log`（脚本创建的计划任务会把 stdout/stderr 追加进去）：

```powershell
Get-Content C:\apps\imu-monitor\logs\server.log -Tail 50
```

### 5.6 更新代码后如何重启

```powershell
# 停任务 → 拉代码 → 重装依赖（如有变化）→ 再启动
Stop-ScheduledTask -TaskName IMU-Monitor
git pull
npm install --omit=dev
Start-ScheduledTask -TaskName IMU-Monitor
```

或直接重跑 `.\scripts\deploy-vps.ps1`（幂等，会覆盖旧任务）。

---

## 六、与课程要求的对应

| 课程要求 | 本项目落地 |
|---|---|
| 「部署到分配的 VPS 空间」 | **待补**（暂无 VPS）。脚本与配置已就绪，拿到即用 |
| 「提交……部署入口」 | `scripts/deploy-vps.ps1` + `config.vps.json` + 本文档 |
| 「一帧真实观测对应一条记录」 | `data/records.ndjson`，`verification` 见 README §9 |
| 「备用路径：无 VPS 时用自己电脑当服务器」 | 当前采用，见 `ASSIGNMENT.md §5` |
| 「VPS 故障可在本地服务定位，明确部署待补」 | **本文档即「待补」的明确声明** |

---

## 七、备注：为什么脚本要求 UTF-8 BOM

`deploy-vps.ps1` 必须存为 **UTF-8 with BOM**。

Windows Server 自带的 PowerShell 5.1 在读取**无 BOM** 的 `.ps1` 时会按系统
ANSI 代码页（简体中文环境为 GBK）解析。文件里的中文注释与提示会被解码成乱码，
进而吞掉或错配引号，导致脚本报出一堆看似无关的语法错误（实测：「语句块或
表达式缺少 }」「字符串缺少终止符」）。

若你编辑后保存成了「UTF-8 无 BOM」，重新存为「UTF-8 with BOM」即可。
用 PowerShell 检查：

```powershell
$b = [IO.File]::ReadAllBytes('.\scripts\deploy-vps.ps1')
if ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { 'BOM 正常' } else { '缺 BOM，需重新保存' }
```
