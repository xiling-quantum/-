# X Meme / Analysis Scraper

Local X/Twitter browser scraper with two dashboard modes:

- Meme coin monitor
- Analysis post monitor

## Install

```powershell
npm install
```

## Start

Meme monitor:

```powershell
npm run start:meme
```

Open:

```text
http://127.0.0.1:48932
```

Analysis monitor:

```powershell
npm run start:analysis
```

Open:

```text
http://127.0.0.1:48933
```

## Optional AI Classification

Copy `.env.example` to `.env`, or set environment variables in PowerShell.

OpenAI:

```powershell
$env:OPENAI_API_KEY="..."
$env:OPENAI_MODEL="gpt-5.2"
```

DeepSeek:

```powershell
$env:DEEPSEEK_API_KEY="..."
$env:DEEPSEEK_MODEL="deepseek-chat"
$env:DEEPSEEK_BASE_URL="https://api.deepseek.com"
```

Kimi / Moonshot:

```powershell
$env:KIMI_API_KEY="..."
$env:KIMI_MODEL="moonshot-v1-8k"
$env:KIMI_BASE_URL="https://api.moonshot.cn/v1"
```

The UI has an `AI 提供方` selector for:

- `OpenAI`
- `DeepSeek`
- `Kimi`

## Browser Concurrency

The dashboard has a `并发页数` input. It is capped at 1-5 and defaults to 3.
The scraper opens multiple pages inside one persistent browser session, so X login state is reused.

## Telegram Groups

Telegram scraping uses MTProto, not browser scraping.

1. Create `api_id` and `api_hash` at `https://my.telegram.org/apps`.
2. Set them in PowerShell:

```powershell
$env:TELEGRAM_API_ID="123456"
$env:TELEGRAM_API_HASH="..."
```

3. Generate a local session:

```powershell
npm run telegram:login
```

4. Put the printed value into:

```powershell
$env:TELEGRAM_STRING_SESSION="..."
```

5. Scrape public groups/channels or groups your account has joined:

```powershell
npm run telegram:scrape -- --groups group1,group2 --max 50 --memeOnly true
```

Latest output is written to `data/telegram-latest.json`.

AI is only called when `AI 二次判断` is enabled.
