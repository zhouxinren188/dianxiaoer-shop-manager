@echo off
cd /d C:\dianxiaoer-api
start /B node index.js > api.log 2>&1
timeout /t 2 /nobreak >nul
curl -s http://127.0.0.1:3000/api/health
echo.
