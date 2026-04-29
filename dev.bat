@echo off
title dianxiaoer-dev
taskkill /f /im electron.exe >nul 2>&1
taskkill /f /im node.exe >nul 2>&1
timeout /t 2 /nobreak >nul
cd /d "h:\dianxiaoer"
call npm run dev
pause
