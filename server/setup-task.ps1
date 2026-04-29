$taskName = "dianxiaoer-server"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$workDir = "C:\Users\Administrator\dianxiaoer-server"
$scriptPath = "C:\Users\Administrator\dianxiaoer-server\index.js"

# Remove existing task
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Create action
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $scriptPath -WorkingDirectory $workDir

# Create trigger (at startup)
$trigger = New-ScheduledTaskTrigger -AtStartup

# Create settings
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# Register task as SYSTEM
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force

# Run the task immediately
Start-ScheduledTask -TaskName $taskName

Write-Host "Task created and started"
