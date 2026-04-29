Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\Administrator\dianxiaoer-server"
WshShell.Run "cmd /c node index.js > out.log 2> err.log", 0, False
WScript.Echo "Server started"
