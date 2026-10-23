# =====================================================================
# Windows Server VPS 一键部署脚本
#
# 作用：把本项目部署为「开机自启 + 崩溃自动重启」的后台服务。
#       部署后开发板通过 WiFi POST /api/data 上报，下行靠板端轮询 /api/cmd，
#       **VPS 上不需要串口**（config.vps.json 已关闭串口自动探测）。
#
# 用法（在 VPS 上以【管理员】身份运行 PowerShell）：
#   cd <项目目录>
#   .\scripts\deploy-vps.ps1                    # 部署并启动
#   .\scripts\deploy-vps.ps1 -Port 8080         # 指定端口
#   .\scripts\deploy-vps.ps1 -Uninstall         # 卸载（删除服务与开机任务）
#   .\scripts\deploy-vps.ps1 -Status            # 查看运行状态
#
# 注意：首次运行前请确认已安装 Node.js 18+（见 docs/vps-deploy.md）。
# =====================================================================
[CmdletBinding()]
param(
    [int]$Port = 8080,
    [string]$TaskName = 'IMU-Monitor',
    [int]$DeviceId = 0,
    [switch]$Uninstall,
    [switch]$Status,
    [switch]$SkipNpmInstall
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot      # 项目根目录（scripts 的上一级）
$ConfigPath = Join-Path $Root 'config.vps.json'
$DataDir = Join-Path $Root 'data'
$RecordDir = Join-Path $Root 'recordings'
$LogDir = Join-Path $Root 'logs'

function Write-Step($msg) { Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !!  $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "    XX  $msg" -ForegroundColor Red }

# ---------------------------------------------------------------- 状态查询
if ($Status) {
    Write-Step "服务状态"
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Ok "计划任务存在：$TaskName"
        Write-Host "       状态：$($task.State)"
        Write-Host "       上次运行：$($info.LastRunTime)  结果：$($info.LastTaskResult)"
        Write-Host "       下次运行：$($info.NextRunTime)"
    } else {
        Write-Warn2 "未找到计划任务 $TaskName（尚未部署）"
    }

    # 端口监听
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $ownerPid = $conn[0].OwningProcess
        Write-Ok "端口 $Port 正在监听（PID $ownerPid）"
    } else {
        Write-Warn2 "端口 $Port 未监听（服务可能未启动）"
    }

    # 接口探活
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 5
        Write-Ok "HTTP 接口正常：connected=$($r.connected) transport=$($r.transport)"
    } catch {
        Write-Warn2 "HTTP 接口无响应：$($_.Exception.Message)"
    }
    exit 0
}

# ---------------------------------------------------------------- 卸载
if ($Uninstall) {
    Write-Step "卸载服务"
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Ok "已删除计划任务 $TaskName"
    } else {
        Write-Warn2 "计划任务 $TaskName 不存在，跳过"
    }
    # 停掉占用端口的进程
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        Stop-Process -Id $conn[0].OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Ok "已停止占用端口 $Port 的进程"
    }
    $rule = Get-NetFirewallRule -DisplayName "$TaskName-HTTP" -ErrorAction SilentlyContinue
    if ($rule) { Remove-NetFirewallRule -DisplayName "$TaskName-HTTP"; Write-Ok '已删除防火墙规则' }
    Write-Host "`n卸载完成。数据目录（$DataDir）未删除，如需清理请手动删除。" -ForegroundColor Yellow
    exit 0
}

# ---------------------------------------------------------------- 前置检查
Write-Step '检查部署前置条件'

if (-not (Test-Path $ConfigPath)) {
    Write-Err2 "缺少 $ConfigPath，无法部署"
    exit 1
}
Write-Ok "找到 VPS 配置：config.vps.json（已关闭串口自动探测）"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Err2 '未找到 Node.js。请先安装 Node.js 18 或更高版本：https://nodejs.org'
    exit 1
}
$nodeVer = (& node --version).Trim()
Write-Ok "Node.js $nodeVer  ($($node.Source))"

$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
if ($major -lt 18) {
    Write-Err2 "Node.js 版本过低（$nodeVer），需要 18 或更高"
    exit 1
}

Write-Ok "端口 $Port"

# ---------------------------------------------------------------- 依赖安装
if (-not $SkipNpmInstall) {
    Write-Step '安装依赖（serialport 含原生模块，需要编译环境）'
    Write-Host '    若失败：VPS 需安装 "Visual Studio Build Tools" + Python 3，' -ForegroundColor DarkGray
    Write-Host '    见 docs/vps-deploy.md 的「依赖安装失败」一节。' -ForegroundColor DarkGray
    Push-Location $Root
    try {
        & npm install --omit=dev 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) {
            Write-Err2 "npm install 失败（exit $LASTEXITCODE）"
            Write-Warn2 '若只是 serialport 编译失败，可尝试：npm install --omit=dev --ignore-scripts 后再单独处理'
            exit 1
        }
        Write-Ok '依赖安装完成'
    } finally { Pop-Location }
} else {
    Write-Warn2 '已跳过 npm install（-SkipNpmInstall）'
}

# ---------------------------------------------------------------- 数据目录
Write-Step '准备数据目录'
foreach ($d in @($DataDir, $RecordDir, $LogDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    Write-Ok $d
}

# ---------------------------------------------------------------- 防火墙
Write-Step "放行防火墙端口 $Port（开发板需要访问）"
$rule = Get-NetFirewallRule -DisplayName "$TaskName-HTTP" -ErrorAction SilentlyContinue
if (-not $rule) {
    New-NetFirewallRule -DisplayName "$TaskName-HTTP" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
    Write-Ok "已创建入站规则 $TaskName-HTTP (TCP $Port)"
} else {
    Write-Ok "入站规则已存在，跳过"
}

# ---------------------------------------------------------------- 停止旧实例
Write-Step '停止可能占用端口的旧实例'
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    foreach ($c in $conn) {
        try {
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
            Write-Ok "已停止旧进程 PID $($c.OwningProcess)"
        } catch { Write-Warn2 "无法停止 PID $($c.OwningProcess)：$($_.Exception.Message)" }
    }
    Start-Sleep -Seconds 2
} else {
    Write-Ok "端口 $Port 空闲"
}

# ---------------------------------------------------------------- 注册计划任务
Write-Step "注册开机自启计划任务（$TaskName）"
$oldTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($oldTask) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Ok '已移除旧任务'
}

# 用 cmd 包一层，确保环境变量与工作目录正确；日志追加到 logs/server.log
# 注意：这里刻意用 [string]::Join + 单引号拼接，避免 PowerShell 长字符串里
# 的反引号转义在多行场景下产生歧义（曾导致脚本解析失败）。
$q = [char]34                            # 双引号字符
$logFile = Join-Path $LogDir 'server.log'
$envPrefix = 'set CONFIG_PATH=' + $ConfigPath + '&& set PORT=' + $Port + '&& set HOST=0.0.0.0&& set DATA_DIR=' + $DataDir + '&& '
$cmdLine = '/c ' + $q + $envPrefix + 'cd /d ' + $q + $Root + $q + ' && node server.js >> ' + $q + $logFile + $q + ' 2>&1' + $q

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdLine -WorkingDirectory $Root
# 开机即启（不登录也运行）
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'ESP32-S3-EYE IMU 监控服务端（开机自启）' | Out-Null
Write-Ok "已注册计划任务：$TaskName（SYSTEM 身份，开机自启，失败自动重启 3 次）"

# ---------------------------------------------------------------- 启动并验证
Write-Step '启动服务并验证'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 8

$ok = $false
for ($i = 1; $i -le 5; $i++) {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 5
        Write-Ok "服务已响应：connected=$($r.connected) transport=$($r.transport)"
        $ok = $true
        break
    } catch {
        Write-Host "    等待服务就绪（$i/5）…" -ForegroundColor DarkGray
        Start-Sleep -Seconds 3
    }
}

if (-not $ok) {
    Write-Err2 '服务未在预期时间内响应。排查步骤：'
    Write-Host ('    1. 查看日志：' + $LogDir + '\server.log') -ForegroundColor Yellow
    Write-Host '    2. 查看任务状态：.\scripts\deploy-vps.ps1 -Status' -ForegroundColor Yellow
    Write-Host '    3. 常见原因：端口被占用、Node 版本过低、依赖未装好' -ForegroundColor Yellow
    exit 1
}

# ---------------------------------------------------------------- 完成提示
Write-Host "`n============================================================" -ForegroundColor Green
Write-Host '  部署完成' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
       Where-Object { $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254\.' }
Write-Host "  本机访问:   http://127.0.0.1:${Port}"
if ($ips) {
    Write-Host '  对外地址（填进固件 app_config.h 的 APP_SERVER_HOST）:'
    foreach ($ip in $ips) { Write-Host "      http://$($ip.IPAddress):${Port}" -ForegroundColor Cyan }
}Write-Host ''
Write-Host '  下一步：' -ForegroundColor Yellow
Write-Host '    1. 把上面的对外地址填入 firmware/s3eye_imu_idf/main/app_config.h'
Write-Host '       （APP_SERVER_HOST / APP_SERVER_PORT）'
Write-Host '    2. 烧录固件，开发板即可脱离电脑独立联网上报'
Write-Host '    3. 确保云厂商安全组也放行了该端口（本脚本只处理 Windows 防火墙）'
Write-Host ''
Write-Host "  常用命令：" -ForegroundColor DarkGray
Write-Host "    .\scripts\deploy-vps.ps1 -Status      查看状态" -ForegroundColor DarkGray
Write-Host "    .\scripts\deploy-vps.ps1 -Uninstall   卸载" -ForegroundColor DarkGray
Write-Host ('    日志：' + $LogDir + '\server.log') -ForegroundColor DarkGray
Write-Host ''
