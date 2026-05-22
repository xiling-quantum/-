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
TELEGRAM_SEND_LOCK_FILE=data/telegram-send.lock
```

When user-session mode is enabled, the monitor connects to Telegram only while sending a new alert. Keep `TELEGRAM_STRING_SESSION` and `TELEGRAM_SEND_LOCK_FILE` independent from other local projects.

For a group, send any message in the group, then open:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

Use the returned `chat.id`.

## Run

```bash
npm install
.\scripts\init-env.ps1
npm run telegram:login
npm run once
npm start
```

Run `npm run telegram:login` again if Telegram returns `AUTH_KEY_DUPLICATED`; it creates a fresh GramJS user session and updates `.env`.

By default, the first startup records existing GMGN trades without pushing them, so Telegram only receives new trades after the service starts. Set `STARTUP_SUPPRESS_EXISTING=false` if you want the first run to push current results.

## Filters

- `CHAIN`: `sol`, `bsc`, `base`, or `eth`
- `SIDE`: `all`, `buy`, or `sell`
- `MIN_AMOUNT_USD` / `MAX_AMOUNT_USD`: amount filters
- `WALLET_FILTER`: one followed wallet address
- `WALLET_ALIAS_FILE`: optional local JSON/CSV/TSV mapping from wallet address to alias
- `WALLET_AUTO_NUMBER_ALIASES`: auto-assign `1号`, `2号`, etc. to newly seen wallets and keep old numbers
- `LIMIT`: GMGN page size, `1` to `100`

## Wallet Aliases

GMGN's OpenAPI trade feed may not include your private follow-list remarks. Export wallet address and note name from GMGN, then save it as `data/wallet-aliases.json`:

```json
{
  "2h6WT2yEMhpdLQRRX5tm58bEt174sbNZq7tMqzVtm3PW": "A"
}
```

CSV and TSV files are also accepted when they contain address/name, wallet/remark, or Chinese `地址`/`备注` columns.

When `WALLET_AUTO_NUMBER_ALIASES=true`, the monitor writes new wallets to the JSON alias file with the next available number. Removed wallets stay in the file, so existing numbers are not changed.

## Notes

GMGN `follow-wallet` returns trades from wallets you personally follow on the GMGN platform. Manage the wallet list in GMGN; this service only polls and forwards the feed.
