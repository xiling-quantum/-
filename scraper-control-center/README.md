# Scraper Control Center

Local front desk for scraper dashboards.

## Run

```powershell
cd D:\Vscode\scraper-control-center
npm run start:all
```

Open:

```text
http://127.0.0.1:49031/
```

## Keep It Online

The control center and child dashboards are local processes. If Windows restarts, sleeps, or the process exits, the page becomes unavailable or a child dashboard shows offline.

Register auto-start:

```powershell
cd D:\Vscode\scraper-control-center
npm run startup:register
```

The script first tries Windows Task Scheduler. If Windows denies that, it falls back to the current user's Startup folder. It starts `scripts/watch-online.ps1`, which checks once per minute and restarts any missing dashboard. After that, Windows will keep these services available while you are logged in:

- Control Center: `49031`
- X Meme Dashboard: `48931`
- Social Hotlist Dashboard: `47831`
- Binance Dashboard: `47832`

Telegram is still a placeholder until a frontend service is added.

## Binance Daily Schedule

Binance auto collection is owned by the Binance dashboard server process, not by the browser tab.

Default schedule:

```text
08:30 local Windows time
```

Current status:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:47832/api/status
```

Important behavior:

- Closing the browser page does not stop the daily run.
- Stopping `binance-dashboard-server.js` stops the timer.
- Restarting Windows or sleeping through the scheduled time prevents that run unless the process is back online at that time.
- `scripts/watch-online.ps1` keeps the dashboard process online while Windows is logged in.

Override schedule before starting:

```powershell
$env:BINANCE_DAILY_HOUR="9"
$env:BINANCE_DAILY_MINUTE="0"
npm run start:all
```
