@echo off
chcp 65001 >nul
echo ==========================================
echo   店小二后端服务 - 一键启动
echo ==========================================
echo.

REM 检查 node 是否安装
node -v >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

echo [1/3] 正在安装依赖...
npm install
if errorlevel 1 (
    echo [错误] npm install 失败
    pause
    exit /b 1
)

echo.
echo [2/3] 依赖安装完成，正在启动服务...
echo.

REM 设置环境变量
set DB_HOST=localhost
set DB_PORT=3307
set DB_USER=root
set DB_PASSWORD=jd123456
set DB_NAME=dianxiaoer
set PORT=3002

node index.js

pause
