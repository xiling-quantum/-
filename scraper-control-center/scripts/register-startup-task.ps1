$ErrorActionPreference = "Stop"

$TaskName = "ScraperControlCenter"
$WatchScript = Resolve-Path (Join-Path $PSScriptRoot "watch-online.ps1")
$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchScript`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 0)

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Start local scraper dashboards and the control center at Windows logon." `
    -Force | Out-Null

  Write-Host "Registered startup task: $TaskName"
  Write-Host "It will run: $WatchScript"
  exit 0
} catch {
  Write-Host "Scheduled task registration failed: $($_.Exception.Message)"
  Write-Host "Falling back to the current user's Startup folder."
}

$StartupDir = [Environment]::GetFolderPath("Startup")
$LauncherPath = Join-Path $StartupDir "ScraperControlCenter.vbs"
$Command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchScript`""
$VbsCommand = $Command.Replace('"', '""')
$Vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "$VbsCommand", 0, False
"@

Set-Content -LiteralPath $LauncherPath -Encoding ASCII -Value $Vbs

Write-Host "Registered Startup folder launcher: $LauncherPath"
Write-Host "It will run: $WatchScript"
