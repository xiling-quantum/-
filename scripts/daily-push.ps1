$ErrorActionPreference = "Stop"

$repo = "D:\Vscode\crypto-scraper-suite"
$key = "$env:USERPROFILE\.ssh\crypto_scraper_suite_deploy"
$log = Join-Path $repo "daily-push.log"

Set-Location $repo
$env:GIT_SSH_COMMAND = "ssh -i `"$key`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

function Write-Log {
  param([string]$Message)
  $line = "$(Get-Date -Format "yyyy-MM-dd HH:mm:ss") $Message"
  Add-Content -Path $log -Value $line
  Write-Host $line
}

Write-Log "Starting daily push."

git add -A
$changed = git status --porcelain

if (-not $changed) {
  Write-Log "No changes to commit."
  exit 0
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
git commit -m "Daily sync $timestamp"
git push origin main

Write-Log "Push completed."
