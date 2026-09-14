@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ESP32-S3-EYE 三轴传感器监控（本机服务器）

set NODE_BIN=C:\Users\user\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe

echo.
echo   启动本机服务器（电脑即服务器，不依赖 VPS）…
echo   控制台会打印"局域网访问"地址，把它填进固件 app_config.h 的 APP_SERVER_HOST。
echo.

rem 2 秒后自动打开浏览器
start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:8080"

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else if exist "%NODE_BIN%" (
  "%NODE_BIN%" server.js
) else (
  echo 未找到 Node.js，请先安装 Node.js 18 或更高版本： https://nodejs.org
)

pause
