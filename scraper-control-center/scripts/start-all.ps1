$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Workspace = Resolve-Path (Join-Path $Root "..")
$Node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $Node)) {
  $Node = "node.exe"
}
$BinanceDailyHour = 8
$BinanceDailyMinute = 30
if ($env:BINANCE_DAILY_HOUR) {
  $BinanceDailyHour = [int]$env:BINANCE_DAILY_HOUR
}
if ($env:BINANCE_DAILY_MINUTE) {
  $BinanceDailyMinute = [int]$env:BINANCE_DAILY_MINUTE
}

function Test-ListeningPort {
  param([int]$Port)
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  return $null -ne $connection
}

function Start-NodeDashboard {
  param(
    [string]$Name,
    [int]$Port,
    [string]$ProjectDir,
    [string]$ScriptPath,
    [string]$OutLog,
    [string]$ErrLog
  )

  if (Test-ListeningPort -Port $Port) {
    Write-Host "$Name already online: http://127.0.0.1:$Port"
    return
  }

  $logDir = Split-Path -Parent $OutLog
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

  Start-Process `
    -FilePath $Node `
    -ArgumentList @($ScriptPath) `
    -WorkingDirectory $ProjectDir `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -WindowStyle Hidden

  Start-Sleep -Seconds 2

  if (Test-ListeningPort -Port $Port) {
    Write-Host "$Name started: http://127.0.0.1:$Port"
  } else {
    Write-Host "$Name did not start. Check log: $ErrLog"
  }
}

Start-NodeDashboard `
  -Name "Control Center" `
  -Port 49031 `
  -ProjectDir "$Root" `
  -ScriptPath (Join-Path $Root "server.js") `
  -OutLog (Join-Path $Root "server.out.log") `
  -ErrLog (Join-Path $Root "server.err.log")

Start-NodeDashboard `
  -Name "X Meme Dashboard" `
  -Port 48931 `
  -ProjectDir (Join-Path $Workspace "x-meme-scraper") `
  -ScriptPath (Join-Path $Workspace "x-meme-scraper\src\server.js") `
  -OutLog (Join-Path $Workspace "x-meme-scraper\tmp\server.out.log") `
  -ErrLog (Join-Path $Workspace "x-meme-scraper\tmp\server.err.log")

Start-NodeDashboard `
  -Name "Social Hotlist Dashboard" `
  -Port 47831 `
  -ProjectDir (Join-Path $Workspace "social-hotlist-scraper") `
  -ScriptPath (Join-Path $Workspace "social-hotlist-scraper\src\dashboard-server.js") `
  -OutLog (Join-Path $Workspace "social-hotlist-scraper\dashboard-server.out.log") `
  -ErrLog (Join-Path $Workspace "social-hotlist-scraper\dashboard-server.err.log")

$env:BINANCE_DAILY_HOUR = [string]$BinanceDailyHour
$env:BINANCE_DAILY_MINUTE = [string]$BinanceDailyMinute

Start-NodeDashboard `
  -Name "Binance Dashboard" `
  -Port 47832 `
  -ProjectDir (Join-Path $Workspace "social-hotlist-scraper") `
  -ScriptPath (Join-Path $Workspace "social-hotlist-scraper\src\binance-dashboard-server.js") `
  -OutLog (Join-Path $Workspace "social-hotlist-scraper\binance-dashboard.out.log") `
  -ErrLog (Join-Path $Workspace "social-hotlist-scraper\binance-dashboard.err.log")

Write-Host ""
Write-Host "Control Center: http://127.0.0.1:49031/"
Write-Host "Binance daily schedule: $($BinanceDailyHour.ToString('00')):$($BinanceDailyMinute.ToString('00'))"
