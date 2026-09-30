$ErrorActionPreference = 'SilentlyContinue'

$pm2Root = 'C:\Users\Administrator\.pm2'
$maintenanceLog = 'C:\dianxiaoer-api\logs\disk-cleanup.log'
$targets = @()

$daemonLog = Join-Path $pm2Root 'pm2.log'
if (Test-Path -LiteralPath $daemonLog) {
  $targets += [pscustomobject]@{ Path = $daemonLog; MaxBytes = 256MB }
}

$applicationLogDirectory = Join-Path $pm2Root 'logs'
if (Test-Path -LiteralPath $applicationLogDirectory) {
  Get-ChildItem -LiteralPath $applicationLogDirectory -File -Filter '*.log' | ForEach-Object {
    $targets += [pscustomobject]@{ Path = $_.FullName; MaxBytes = 512MB }
  }
}

foreach ($target in $targets) {
  $item = Get-Item -LiteralPath $target.Path
  if (-not $item -or $item.Length -le $target.MaxBytes) { continue }

  $beforeBytes = $item.Length
  $stream = [System.IO.File]::Open(
    $item.FullName,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::ReadWrite
  )
  try {
    $stream.SetLength(0)
    $stream.Flush()
  } finally {
    $stream.Dispose()
  }

  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $message = "[$timestamp] PM2 log guard truncated $($item.FullName) from $beforeBytes bytes"
  Add-Content -LiteralPath $maintenanceLog -Value $message
}
