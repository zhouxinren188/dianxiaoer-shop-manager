@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: ============================================================
:: 店小二 - NSSM 服务安装脚本
:: 将 dianxiaoer-server (端口3002) 和 dianxiaoer-api (端口3001)
:: 注册为 Windows 服务，开机自启 + 自动重启
:: ============================================================

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 请以管理员身份运行此脚本！
    echo        右键此文件 -^> 以管理员身份运行
    pause
    exit /b 1
)

:: ========== 配置区域（按实际环境修改） ==========

:: NSSM 路径（需要先下载 nssm.exe 放到此路径）
set "NSSM=C:\nssm\nssm.exe"

:: Node.js 路径
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

:: 服务1: dianxiaoer-server（业务API服务，端口3002）
set "SVC1_NAME=dianxiaoer-server"
set "SVC1_DIR=C:\Users\Administrator\dianxiaoer-server"
set "SVC1_SCRIPT=index.js"
set "SVC1_LOG_DIR=C:\Users\Administrator\dianxiaoer-server\logs"

:: 服务2: dianxiaoer-api（认证API服务，端口3001）
set "SVC2_NAME=dianxiaoer-api"
set "SVC2_DIR=C:\dianxiaoer-api"
set "SVC2_SCRIPT=index.js"
set "SVC2_LOG_DIR=C:\dianxiaoer-api\logs"

:: ========== 前置检查 ==========

if not exist "%NSSM%" (
    echo [错误] 未找到 nssm.exe: %NSSM%
    echo.
    echo 请先下载 NSSM:
    echo   1. 访问 https://nssm.cc/download
    echo   2. 解压后将 nssm.exe 放到 C:\nssm\ 目录
    echo   3. 确保使用 win64 版本的 nssm.exe
    echo.
    pause
    exit /b 1
)

if not exist "%NODE_EXE%" (
    echo [错误] 未找到 Node.js: %NODE_EXE%
    echo        请确认 Node.js 已安装
    pause
    exit /b 1
)

echo ============================================================
echo  店小二 - Windows 服务安装
echo ============================================================
echo.
echo  Node.js: %NODE_EXE%
echo  NSSM:    %NSSM%
echo.

:: ========== 安装服务1: dianxiaoer-server ==========

echo [1/2] 安装服务: %SVC1_NAME%
echo       目录: %SVC1_DIR%
echo       端口: 3002

if not exist "%SVC1_DIR%\%SVC1_SCRIPT%" (
    echo [错误] 未找到入口文件: %SVC1_DIR%\%SVC1_SCRIPT%
    echo        请先将 server 部署到该目录
    pause
    exit /b 1
)

:: 创建日志目录
if not exist "%SVC1_LOG_DIR%" mkdir "%SVC1_LOG_DIR%"

:: 先移除旧服务（忽略错误）
"%NSSM%" stop %SVC1_NAME% >nul 2>&1
"%NSSM%" remove %SVC1_NAME% confirm >nul 2>&1

:: 安装服务
"%NSSM%" install %SVC1_NAME% "%NODE_EXE%" "%SVC1_SCRIPT%"
if %errorlevel% neq 0 (
    echo [错误] 安装服务 %SVC1_NAME% 失败
    pause
    exit /b 1
)

:: 配置工作目录
"%NSSM%" set %SVC1_NAME% AppDirectory "%SVC1_DIR%"

:: 配置环境变量
"%NSSM%" set %SVC1_NAME% AppEnvironmentExtra ^
    DB_HOST=127.0.0.1 ^
    DB_PORT=3307 ^
    DB_USER=root ^
    DB_PASSWORD=jd123456 ^
    DB_NAME=dianxiaoer ^
    PORT=3002 ^
    NODE_ENV=production

:: 配置日志输出
"%NSSM%" set %SVC1_NAME% AppStdout "%SVC1_LOG_DIR%\stdout.log"
"%NSSM%" set %SVC1_NAME% AppStderr "%SVC1_LOG_DIR%\stderr.log"
"%NSSM%" set %SVC1_NAME% AppStdoutCreationDisposition 4
"%NSSM%" set %SVC1_NAME% AppStderrCreationDisposition 4
"%NSSM%" set %SVC1_NAME% AppRotateFiles 1
"%NSSM%" set %SVC1_NAME% AppRotateOnline 1
"%NSSM%" set %SVC1_NAME% AppRotateBytes 5242880

:: 配置重启策略（崩溃后自动重启）
"%NSSM%" set %SVC1_NAME% AppExit Default Restart
"%NSSM%" set %SVC1_NAME% AppRestartDelay 3000

:: 配置启动类型为自动
"%NSSM%" set %SVC1_NAME% Start SERVICE_AUTO_START

:: 描述
"%NSSM%" set %SVC1_NAME% DisplayName "店小二业务API服务"
"%NSSM%" set %SVC1_NAME% Description "店小二网店管家 - 业务API服务器 (端口3002, MySQL)"

echo       [OK] %SVC1_NAME% 安装完成
echo.

:: ========== 安装服务2: dianxiaoer-api ==========

echo [2/2] 安装服务: %SVC2_NAME%
echo       目录: %SVC2_DIR%
echo       端口: 3001

if not exist "%SVC2_DIR%\%SVC2_SCRIPT%" (
    echo [错误] 未找到入口文件: %SVC2_DIR%\%SVC2_SCRIPT%
    echo        请先将 server-api 部署到该目录
    pause
    exit /b 1
)

:: 创建日志目录
if not exist "%SVC2_LOG_DIR%" mkdir "%SVC2_LOG_DIR%"

:: 先移除旧服务（忽略错误）
"%NSSM%" stop %SVC2_NAME% >nul 2>&1
"%NSSM%" remove %SVC2_NAME% confirm >nul 2>&1

:: 安装服务
"%NSSM%" install %SVC2_NAME% "%NODE_EXE%" "%SVC2_SCRIPT%"
if %errorlevel% neq 0 (
    echo [错误] 安装服务 %SVC2_NAME% 失败
    pause
    exit /b 1
)

:: 配置工作目录
"%NSSM%" set %SVC2_NAME% AppDirectory "%SVC2_DIR%"

:: 配置环境变量（server-api 显式设置 PORT=3001）
"%NSSM%" set %SVC2_NAME% AppEnvironmentExtra ^
    PORT=3001 ^
    NODE_ENV=production

:: 配置日志输出
"%NSSM%" set %SVC2_NAME% AppStdout "%SVC2_LOG_DIR%\stdout.log"
"%NSSM%" set %SVC2_NAME% AppStderr "%SVC2_LOG_DIR%\stderr.log"
"%NSSM%" set %SVC2_NAME% AppStdoutCreationDisposition 4
"%NSSM%" set %SVC2_NAME% AppStderrCreationDisposition 4
"%NSSM%" set %SVC2_NAME% AppRotateFiles 1
"%NSSM%" set %SVC2_NAME% AppRotateOnline 1
"%NSSM%" set %SVC2_NAME% AppRotateBytes 5242880

:: 配置重启策略（崩溃后自动重启）
"%NSSM%" set %SVC2_NAME% AppExit Default Restart
"%NSSM%" set %SVC2_NAME% AppRestartDelay 3000

:: 配置启动类型为自动
"%NSSM%" set %SVC2_NAME% Start SERVICE_AUTO_START

:: 描述
"%NSSM%" set %SVC2_NAME% DisplayName "店小二认证API服务"
"%NSSM%" set %SVC2_NAME% Description "店小二网店管家 - 认证API服务器 (端口3001, HTTPS+JWT)"

echo       [OK] %SVC2_NAME% 安装完成
echo.

:: ========== 启动服务 ==========

echo ============================================================
echo  启动服务...
echo ============================================================
echo.

"%NSSM%" start %SVC1_NAME%
if %errorlevel% equ 0 (
    echo [OK] %SVC1_NAME% 已启动
) else (
    echo [警告] %SVC1_NAME% 启动失败，请检查日志: %SVC1_LOG_DIR%
)

"%NSSM%" start %SVC2_NAME%
if %errorlevel% equ 0 (
    echo [OK] %SVC2_NAME% 已启动
) else (
    echo [警告] %SVC2_NAME% 启动失败，请检查日志: %SVC2_LOG_DIR%
)

echo.
echo ============================================================
echo  安装完成！服务状态:
echo ============================================================
echo.

"%NSSM%" status %SVC1_NAME%
"%NSSM%" status %SVC2_NAME%

echo.
echo  日志位置:
echo    %SVC1_LOG_DIR%
echo    %SVC2_LOG_DIR%
echo.
echo  管理命令:
echo    nssm start/stop/restart dianxiaoer-server
echo    nssm start/stop/restart dianxiaoer-api
echo.

pause
