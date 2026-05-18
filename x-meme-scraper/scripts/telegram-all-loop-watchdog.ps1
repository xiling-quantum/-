$ErrorActionPreference = "Continue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $ProjectRoot "data"
$LoopLogPath = Join-Path $DataDir "telegram-all-loop-task.log"
$WatchdogLogPath = Join-Path $DataDir "telegram-all-loop-watchdog.log"

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

while ($true) {
  $startedAt = Get-Date
  Add-Content -Path $WatchdogLogPath -Encoding UTF8 -Value "[$($startedAt.ToString('o'))] starting telegram:all:loop"

  try {
    Push-Location $ProjectRoot
    try {
      npm run telegram:all:loop *>> $LoopLogPath
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    Add-Content -Path $WatchdogLogPath -Encoding UTF8 -Value "[$((Get-Date).ToString('o'))] telegram:all:loop exited with code $exitCode; restarting after 300s"
  } catch {
    Add-Content -Path $WatchdogLogPath -Encoding UTF8 -Value "[$((Get-Date).ToString('o'))] watchdog error: $($_.Exception.Message); restarting after 300s"
  }

  Start-Sleep -Seconds 300
}
