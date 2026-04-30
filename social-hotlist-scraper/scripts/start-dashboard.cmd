@echo off
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:47831/ -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch { exit 1 }"
if %ERRORLEVEL%==0 exit /b 0
cd /d D:\Vscode\social-hotlist-scraper
set DASHBOARD_PORT=47831
npm run dashboard >> D:\Vscode\social-hotlist-scraper\dashboard-autostart.log 2>&1
