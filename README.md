# Crypto Scraper Suite

Local scraper projects for crypto and social monitoring.

## Projects

- `social-hotlist-scraper`: Node.js Playwright collectors for TikTok, Instagram, X, FastMoss, Amazon, and Binance-related dashboards.
- `x-meme-scraper`: Local X/Twitter meme-coin monitor with a browser-based dashboard, watch list, meme scoring, and interval monitoring.
- `telegram-meme-scraper`: Python Telethon-based Telegram meme/crypto message collector.
- `scraper-control-center`: Local control center for starting and monitoring scraper services.

## What Is Excluded

This repository intentionally excludes:

- API keys and `.env` files
- Browser login state and cookies
- Telegram session files
- Local configs such as `config.json` and `*.local.json`
- Generated scrape results
- `node_modules`, `.venv`, logs, and build output

Use the included `*.example.*` files as templates and create local config files on each machine.

## Quick Start

### X Meme Scraper

```powershell
cd .\x-meme-scraper
npm install
npm run check
npm start
```

Open:

```text
http://127.0.0.1:48931
```

If the port is busy:

```powershell
$env:PORT="48932"
npm start
```

### Social Hotlist Scraper

```powershell
cd .\social-hotlist-scraper
npm install
npm run browsers
npm run collect:x
```

### Telegram Meme Scraper

```powershell
cd .\telegram-meme-scraper
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
Copy-Item config.example.json config.json
python .\scrape_memes.py
```

### Control Center

```powershell
cd .\scraper-control-center
npm install
npm run check
npm start
```

## Security Notes

Never commit real tokens, cookies, browser sessions, Telegram sessions, scrape output, or local config files. The root `.gitignore` is intentionally strict because these projects handle account sessions and third-party data.

