$ErrorActionPreference = "Stop"

$projectRoot = "D:\Vscode\social-hotlist-scraper"
$nodePath = "C:\Program Files\nodejs\node.exe"
$serverScript = Join-Path $projectRoot "src\binance-dashboard-server.js"
$logDir = Join-Path $projectRoot "data\logs"
$stdoutLog = Join-Path $logDir "binance-dashboard-stdout.log"
$stderrLog = Join-Path $logDir "binance-dashboard-stderr.log"
$url = "http://127.0.0.1:47832"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*binance-dashboard-server.js*" }

if (-not $existing) {
  Start-Process `
    -FilePath $nodePath `
    -ArgumentList "`"$serverScript`"" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

  Start-Sleep -Seconds 1
}

Start-Process $url
