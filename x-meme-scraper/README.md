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

AI is only called when `AI 二次判断` is enabled.

