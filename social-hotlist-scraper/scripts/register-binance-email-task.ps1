param(
  [string[]]$Times = @("10:00", "22:00")
)

$ErrorActionPreference = "Stop"

$projectRoot = "D:\Vscode\social-hotlist-scraper"
$runnerScript = Join-Path $projectRoot "scripts\run-binance-email.ps1"
$taskName = "BinanceDailyEmail"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerScript`""

$triggers = foreach ($time in $Times) {
  $parts = $time.Split(":")
  if ($parts.Count -ne 2) {
    throw "Invalid time format: $time. Expected HH:mm."
  }

  $at = (Get-Date).Date.AddHours([int]$parts[0]).AddMinutes([int]$parts[1])
  New-ScheduledTaskTrigger -Daily -At $at
}

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -WakeToRun `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Principal $principal `
  -Description "Fetch Binance daily movers and email the report at 10:00 and 22:00." `
  -Force | Out-Null

Write-Output "Scheduled task created: $taskName"
Write-Output "Times: $($Times -join ', ')"
Write-Output "WakeToRun: enabled"
Write-Output "StartWhenAvailable: enabled"
Write-Output "Retry: 3 times every 5 minutes"
