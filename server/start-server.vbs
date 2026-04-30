Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "taskkill /IM node.exe /F", 0, True
WScript.Sleep 2000
WshShell.CurrentDirectory = "C:\Users\Administrator\dianxiaoer-server"
WshShell.Run "cmd /c node index.js > out.log 2> err.log", 0, False
WScript.Echo "Server started"
