@echo off
chcp 65001 >nul
setlocal

:: ============================================================
:: 店小二 - NSSM 服务状态检查 / 管理脚本
:: ============================================================

set "NSSM=C:\nssm\nssm.exe"
set "SVC1_NAME=dianxiaoer-server"
set "SVC2_NAME=dianxiaoer-api"

if not exist "%NSSM%" (
    echo [错误] 未找到 nssm.exe: %NSSM%
    pause
    exit /b 1
)

:MENU
echo.
echo ============================================================
echo  店小二 - 服务管理
echo ============================================================
echo.
echo  [1] 查看服务状态
echo  [2] 启动全部服务
echo  [3] 停止全部服务
echo  [4] 重启全部服务
echo  [5] 查看服务日志路径
echo  [0] 退出
echo.
set /p "CHOICE=请选择操作: "

if "%CHOICE%"=="1" goto STATUS
if "%CHOICE%"=="2" goto START
if "%CHOICE%"=="3" goto STOP
if "%CHOICE%"=="4" goto RESTART
if "%CHOICE%"=="5" goto LOGS
if "%CHOICE%"=="0" exit /b 0
echo [错误] 无效选择
goto MENU

:STATUS
echo.
echo --- %SVC1_NAME% ---
"%NSSM%" status %SVC1_NAME%
echo.
echo --- %SVC2_NAME% ---
"%NSSM%" status %SVC2_NAME%
goto MENU

:START
echo.
echo 启动 %SVC1_NAME% ...
"%NSSM%" start %SVC1_NAME%
echo 启动 %SVC2_NAME% ...
"%NSSM%" start %SVC2_NAME%
goto MENU

:STOP
echo.
echo 停止 %SVC1_NAME% ...
"%NSSM%" stop %SVC1_NAME%
echo 停止 %SVC2_NAME% ...
"%NSSM%" stop %SVC2_NAME%
goto MENU

:RESTART
echo.
echo 重启 %SVC1_NAME% ...
"%NSSM%" restart %SVC1_NAME%
echo 重启 %SVC2_NAME% ...
"%NSSM%" restart %SVC2_NAME%
goto MENU

:LOGS
echo.
echo  dianxiaoer-server 日志:
echo    C:\Users\Administrator\dianxiaoer-server\logs\stdout.log
echo    C:\Users\Administrator\dianxiaoer-server\logs\stderr.log
echo.
echo  dianxiaoer-api 日志:
echo    C:\dianxiaoer-api\logs\stdout.log
echo    C:\dianxiaoer-api\logs\stderr.log
goto MENU
