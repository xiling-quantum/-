$ErrorActionPreference = "Continue"

$projectRoot = "D:\Vscode\social-hotlist-scraper"
$nodePath = "C:\Program Files\nodejs\node.exe"
$scriptPath = Join-Path $projectRoot "src\binance-email.js"
$logDir = Join-Path $projectRoot "data\logs"
$logPath = Join-Path $logDir "binance-email-task.log"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
Set-Location $projectRoot

$startedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logPath -Encoding UTF8 -Value "[$startedAt] binance email task started"

& $nodePath $scriptPath --fetch-first 2>&1 | ForEach-Object {
  Add-Content -Path $logPath -Encoding UTF8 -Value $_
}

$exitCode = $LASTEXITCODE
$finishedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logPath -Encoding UTF8 -Value "[$finishedAt] binance email task finished with exit code $exitCode"
Add-Content -Path $logPath -Encoding UTF8 -Value ""

exit $exitCode
