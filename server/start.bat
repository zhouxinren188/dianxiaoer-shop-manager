@echo off
chcp 65001 >nul
cd /d %~dp0

REM 先杀掉旧的 dianxiaoer-server 进程
for /f "tokens=2" %%i in ('wmic process where "commandline like '%%dianxiaoer-server%%index.js%%' and name='node.exe'" get processid /format:list 2^>nul ^| findstr ProcessId') do (
    taskkill /PID %%i /F >nul 2>&1
)

REM 用独立进程启动 node 服务
start "dianxiaoer-server" /MIN node index.js

echo [OK] dianxiaoer-server started
