@echo off
cd /d C:\Users\Administrator\dianxiaoer-server
taskkill /IM node.exe /F >nul 2>&1
ping 127.0.0.1 -n 2 >nul
node index.js > out.log 2> err.log
