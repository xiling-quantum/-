$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$envPath = Join-Path $root ".env"
$defaultPrivateKeyPath = Join-Path (Split-Path -Parent $root) "ed25519-keys\ed25519_private.pem"

function Escape-EnvValue([string] $value) {
  return $value.Replace("`r`n", "\n").Replace("`n", "\n").Replace('"', '\"')
}

function Read-Required([string] $prompt) {
  do {
    $value = Read-Host $prompt
  } while ([string]::IsNullOrWhiteSpace($value))
  return $value.Trim()
}

if (Test-Path $envPath) {
  $answer = Read-Host ".env already exists. Overwrite? (y/N)"
  if ($answer -notin @("y", "Y", "yes", "YES")) {
    Write-Host "Aborted."
    exit 0
  }
}

$gmgnApiKey = Read-Required "GMGN_API_KEY"

if (Test-Path $defaultPrivateKeyPath) {
  $useDefault = Read-Host "Use existing private key at $defaultPrivateKeyPath ? (Y/n)"
  if ($useDefault -in @("", "y", "Y", "yes", "YES")) {
    $privateKey = Get-Content -Raw $defaultPrivateKeyPath
  } else {
    $privateKeyPath = Read-Required "Path to GMGN_PRIVATE_KEY PEM"
    $privateKey = Get-Content -Raw $privateKeyPath
  }
} else {
  $privateKeyPath = Read-Required "Path to GMGN_PRIVATE_KEY PEM"
  $privateKey = Get-Content -Raw $privateKeyPath
}

$telegramBotToken = Read-Required "TELEGRAM_BOT_TOKEN"
$telegramChatId = Read-Required "TELEGRAM_CHAT_ID"

$proxy = ""
$proxySettings = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue
if ($proxySettings.ProxyEnable -eq 1 -and $proxySettings.ProxyServer) {
  $detectedProxy = $proxySettings.ProxyServer
  if (-not $detectedProxy.StartsWith("http://") -and -not $detectedProxy.StartsWith("https://")) {
    $detectedProxy = "http://$detectedProxy"
  }
  $useProxy = Read-Host "Use detected proxy $detectedProxy ? (Y/n)"
  if ($useProxy -in @("", "y", "Y", "yes", "YES")) {
    $proxy = $detectedProxy
  }
}

$lines = @(
  "GMGN_API_KEY=$gmgnApiKey",
  "GMGN_PRIVATE_KEY=""$(Escape-EnvValue $privateKey)""",
  "TELEGRAM_BOT_TOKEN=$telegramBotToken",
  "TELEGRAM_CHAT_ID=$telegramChatId",
  "HTTPS_PROXY=$proxy",
  "CHAIN=sol",
  "POLL_INTERVAL_SECONDS=10",
  "LIMIT=50",
  "SIDE=all",
  "MIN_AMOUNT_USD=",
  "MAX_AMOUNT_USD=",
  "WALLET_FILTER=",
  "DRY_RUN=false",
  "STARTUP_SUPPRESS_EXISTING=true",
  "MAX_MESSAGES_PER_POLL=20",
  "STATE_FILE=data/state.json",
  "SEEN_LIMIT=5000"
)

Set-Content -Path $envPath -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
Write-Host ".env written to $envPath"
