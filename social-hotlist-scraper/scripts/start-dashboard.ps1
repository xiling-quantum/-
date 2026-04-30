$ErrorActionPreference = "Stop"
Set-Location "D:\Vscode\social-hotlist-scraper"
$env:DASHBOARD_PORT = "47831"
npm run dashboard *> "D:\Vscode\social-hotlist-scraper\dashboard-autostart.log"
