# GMGN Telegram Monitor

Polls GMGN `track follow-wallet` trades and forwards new records to Telegram.

## Setup

1. Run `.\scripts\init-env.ps1`.
2. Enter `GMGN_API_KEY`.
3. Use the existing Ed25519 private key at `..\ed25519-keys\ed25519_private.pem`, or enter another PEM path.
4. Create a Telegram bot with `@BotFather`, then enter `TELEGRAM_BOT_TOKEN`.
5. Add the bot to your private chat, group, or channel, then enter `TELEGRAM_CHAT_ID`.
6. If prompted, accept the detected local proxy. On this machine it currently appears to be `http://127.0.0.1:7897`.

You can also reuse an existing GramJS user session instead of Bot API:

```text
TELEGRAM_SEND_MODE=user
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_STRING_SESSION=...
TELEGRAM_NOTIFY_TARGET=me
TELEGRAM_PROXY_URL=socks5://127.0.0.1:7897
```

For a group, send any message in the group, then open:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

Use the returned `chat.id`.

## Run

```bash
npm install
.\scripts\init-env.ps1
npm run once
npm start
```

By default, the first startup records existing GMGN trades without pushing them, so Telegram only receives new trades after the service starts. Set `STARTUP_SUPPRESS_EXISTING=false` if you want the first run to push current results.

## Filters

- `CHAIN`: `sol`, `bsc`, `base`, or `eth`
- `SIDE`: `all`, `buy`, or `sell`
- `MIN_AMOUNT_USD` / `MAX_AMOUNT_USD`: amount filters
- `WALLET_FILTER`: one followed wallet address
- `LIMIT`: GMGN page size, `1` to `100`

## Notes

GMGN `follow-wallet` returns trades from wallets you personally follow on the GMGN platform. Manage the wallet list in GMGN; this service only polls and forwards the feed.
