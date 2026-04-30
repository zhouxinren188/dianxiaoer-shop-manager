@echo off
chcp 65001 >nul
setlocal

:: ============================================================
:: 店小二 - NSSM 服务卸载脚本
:: ============================================================

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 请以管理员身份运行此脚本！
    pause
    exit /b 1
)

set "NSSM=C:\nssm\nssm.exe"
set "SVC1_NAME=dianxiaoer-server"
set "SVC2_NAME=dianxiaoer-api"

if not exist "%NSSM%" (
    echo [错误] 未找到 nssm.exe: %NSSM%
    pause
    exit /b 1
)

echo ============================================================
echo  店小二 - Windows 服务卸载
echo ============================================================
echo.
echo  即将卸载以下服务:
echo    - %SVC1_NAME% (主API服务)
echo    - %SVC2_NAME% (认证API服务)
echo.

set /p "CONFIRM=确认卸载？(Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo 已取消
    pause
    exit /b 0
)

echo.

:: 停止并卸载服务1
echo [1/2] 卸载 %SVC1_NAME% ...
"%NSSM%" stop %SVC1_NAME% >nul 2>&1
"%NSSM%" remove %SVC1_NAME% confirm
if %errorlevel% equ 0 (
    echo       [OK] %SVC1_NAME% 已卸载
) else (
    echo       [跳过] %SVC1_NAME% 不存在或已卸载
)

echo.

:: 停止并卸载服务2
echo [2/2] 卸载 %SVC2_NAME% ...
"%NSSM%" stop %SVC2_NAME% >nul 2>&1
"%NSSM%" remove %SVC2_NAME% confirm
if %errorlevel% equ 0 (
    echo       [OK] %SVC2_NAME% 已卸载
) else (
    echo       [跳过] %SVC2_NAME% 不存在或已卸载
)

echo.
echo ============================================================
echo  卸载完成
echo ============================================================
echo.
echo  注意: 日志文件未删除，如需清理请手动删除:
echo    C:\Users\Administrator\dianxiaoer-server\logs\
echo    C:\dianxiaoer-api\logs\
echo.

pause
