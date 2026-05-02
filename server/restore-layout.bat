@echo off
chcp 65001 >nul

echo ========================================
echo  Restoring dual-service layout
echo  3001: dianxiaoer-api (Auth API)
echo  3002: dianxiaoer-server (Business API)
echo ========================================

REM 1. Stop current services
echo [1/5] Stopping services...
C:\nssm\nssm.exe stop dianxiaoer-server 2>nul
C:\nssm\nssm.exe stop dianxiaoer-api 2>nul
ping 127.0.0.1 -n 3 >nul

REM 2. Set dianxiaoer-server to port 3002
echo [2/5] Configuring dianxiaoer-server on port 3002...
C:\nssm\nssm.exe set dianxiaoer-server Application "C:\Program Files\nodejs\node.exe"
C:\nssm\nssm.exe set dianxiaoer-server AppParameters "index.js"
C:\nssm\nssm.exe set dianxiaoer-server AppDirectory "C:\Users\Administrator\dianxiaoer-server"
C:\nssm\nssm.exe set dianxiaoer-server AppEnvironmentExtra DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=jd123456 DB_NAME=dianxiaoer PORT=3002 NODE_ENV=production
C:\nssm\nssm.exe set dianxiaoer-server AppStdout "C:\Users\Administrator\dianxiaoer-server\logs\stdout.log"
C:\nssm\nssm.exe set dianxiaoer-server AppStderr "C:\Users\Administrator\dianxiaoer-server\logs\stderr.log"
C:\nssm\nssm.exe set dianxiaoer-server AppStdoutCreationDisposition 4
C:\nssm\nssm.exe set dianxiaoer-server AppStderrCreationDisposition 4

REM 3. Configure dianxiaoer-api service on port 3001
echo [3/5] Configuring dianxiaoer-api on port 3001...
C:\nssm\nssm.exe remove dianxiaoer-api confirm 2>nul
C:\nssm\nssm.exe install dianxiaoer-api "C:\Program Files\nodejs\node.exe" "index.js"
C:\nssm\nssm.exe set dianxiaoer-api AppDirectory "C:\dianxiaoer-api"
C:\nssm\nssm.exe set dianxiaoer-api AppEnvironmentExtra PORT=3001 NODE_ENV=production
C:\nssm\nssm.exe set dianxiaoer-api AppStdout "C:\dianxiaoer-api\logs\stdout.log"
C:\nssm\nssm.exe set dianxiaoer-api AppStderr "C:\dianxiaoer-api\logs\stderr.log"
C:\nssm\nssm.exe set dianxiaoer-api AppStdoutCreationDisposition 4
C:\nssm\nssm.exe set dianxiaoer-api AppStderrCreationDisposition 4
C:\nssm\nssm.exe set dianxiaoer-api DisplayName "dianxiaoer-api"
C:\nssm\nssm.exe set dianxiaoer-api Start SERVICE_AUTO_START

REM 4. Create logs directories
mkdir C:\Users\Administrator\dianxiaoer-server\logs 2>nul
mkdir C:\dianxiaoer-api\logs 2>nul

REM 5. Start both services
echo [4/5] Starting services...
C:\nssm\nssm.exe start dianxiaoer-api
ping 127.0.0.1 -n 3 >nul
C:\nssm\nssm.exe start dianxiaoer-server
ping 127.0.0.1 -n 5 >nul

REM 6. Verify
echo [5/5] Verifying...
echo.
echo === Service Status ===
sc query dianxiaoer-server | findstr STATE
sc query dianxiaoer-api | findstr STATE
echo.
echo === Port Listeners ===
netstat -ano | findstr "LISTENING" | findstr "3001 3002"
echo.
echo === Logs (server 3002) ===
type C:\Users\Administrator\dianxiaoer-server\logs\stdout.log 2>nul
echo.
echo === Logs (api 3001) ===
type C:\dianxiaoer-api\logs\stdout.log 2>nul
echo.
echo ========================================
echo  Done!
echo  3001: dianxiaoer-api (login/register/updates)
echo  3002: dianxiaoer-server (business API)
echo ========================================
