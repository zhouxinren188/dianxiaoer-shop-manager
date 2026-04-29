$proc = ([wmiclass]"Win32_Process").Create("cmd.exe /c cd /d C:\Users\Administrator\dianxiaoer-server & C:\progra~1\nodejs\node.exe index.js >> out.log 2>> err.log")
if ($proc.ReturnValue -eq 0) {
    Write-Host "Process started with PID: $($proc.ProcessId)"
} else {
    Write-Host "Failed to start, return: $($proc.ReturnValue)"
}
