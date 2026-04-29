$nodePath = "C:\Program Files\nodejs\node.exe"
$workDir = "C:\Users\Administrator\dianxiaoer-server"
Set-Location $workDir
Start-Process -FilePath $nodePath -ArgumentList "index.js" -WorkingDirectory $workDir -WindowStyle Hidden
Write-Host "Server process started"
