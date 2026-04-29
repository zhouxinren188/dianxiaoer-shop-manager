Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\dianxiaoer-api && node index.js > api.log 2>&1", 0, False
Set WshShell = Nothing
