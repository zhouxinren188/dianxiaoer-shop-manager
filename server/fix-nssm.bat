@echo off
chcp 65001 >nul

echo Configuring dianxiaoer-server service...

C:\nssm\nssm.exe stop dianxiaoer-server 2>nul

C:\nssm\nssm.exe set dianxiaoer-server Application "C:\Program Files\nodejs\node.exe"
C:\nssm\nssm.exe set dianxiaoer-server AppParameters "index.js"
C:\nssm\nssm.exe set dianxiaoer-server AppDirectory "C:\Users\Administrator\dianxiaoer-server"
C:\nssm\nssm.exe set dianxiaoer-server AppStdout "C:\Users\Administrator\dianxiaoer-server\nssm-stdout.log"
C:\nssm\nssm.exe set dianxiaoer-server AppStderr "C:\Users\Administrator\dianxiaoer-server\nssm-stderr.log"
C:\nssm\nssm.exe set dianxiaoer-server AppStdoutCreationDisposition 2
C:\nssm\nssm.exe set dianxiaoer-server AppStderrCreationDisposition 2

taskkill /IM node.exe /F 2>nul
ping 127.0.0.1 -n 3 >nul

C:\nssm\nssm.exe start dianxiaoer-server
ping 127.0.0.1 -n 5 >nul

echo --- Verify ---
C:\nssm\nssm.exe get dianxiaoer-server Application
C:\nssm\nssm.exe get dianxiaoer-server AppDirectory
C:\nssm\nssm.exe get dianxiaoer-server AppParameters
sc query dianxiaoer-server | findstr STATE
netstat -ano | findstr :3002

echo Done.
