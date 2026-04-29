$action = New-ScheduledTaskAction -Execute "node" -Argument "index.js" -WorkingDirectory "C:\dianxiaoer-api"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "DianxiaoerAPI" -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName "DianxiaoerAPI"
