$ErrorActionPreference = "Continue"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogPath = Join-Path $Root "watch-online.log"
$StartScript = Resolve-Path (Join-Path $PSScriptRoot "start-all.ps1")
$IntervalSeconds = 60
if ($env:SCRAPER_WATCH_INTERVAL_SECONDS) {
  $IntervalSeconds = [int]$env:SCRAPER_WATCH_INTERVAL_SECONDS
}
$CurrentPid = $PID

$ExistingWatchers = Get-CimInstance Win32_Process -Filter "name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ProcessId -ne $CurrentPid -and
    $_.CommandLine -match "(?i)(^|\s)-File\s+`"?[^`"]*watch-online\.ps1`"?"
  }

if ($ExistingWatchers) {
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "$(Get-Date -Format o) watcher already running; exiting duplicate."
  exit 0
}

Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "$(Get-Date -Format o) watcher started."

while ($true) {
  try {
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "$(Get-Date -Format o) checking services."
    $Output = & $StartScript 2>&1 | Out-String
    if ($Output.Trim()) {
      Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value $Output.TrimEnd()
    }
  } catch {
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "$(Get-Date -Format o) watcher error: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $IntervalSeconds
}
