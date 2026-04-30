@echo off
chcp 65001 >nul

echo Fixing PORT to 3002...

C:\nssm\nssm.exe stop dianxiaoer-server 2>nul
ping 127.0.0.1 -n 3 >nul

C:\nssm\nssm.exe set dianxiaoer-server AppEnvironmentExtra DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=jd123456 DB_NAME=dianxiaoer PORT=3002 NODE_ENV=production

taskkill /IM node.exe /F 2>nul
ping 127.0.0.1 -n 3 >nul

C:\nssm\nssm.exe start dianxiaoer-server
ping 127.0.0.1 -n 6 >nul

echo --- Verify ---
sc query dianxiaoer-server | findstr STATE
netstat -ano | findstr :3002
type %USERPROFILE%\dianxiaoer-server\nssm-stdout.log 2>nul

echo Done.
