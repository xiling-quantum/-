# Social Hotlist Scraper

This is a fully independent project located at `D:\Vscode\social-hotlist-scraper`.

The current scope is the first phase only:
- collect public or account-accessible content from TikTok, Instagram, Amazon, and X
- normalize the results into flat files
- generate a frontend report with images, links, English summaries, likely product hints, and Amazon board metadata

It does not reuse code, config, or runtime files from any other workspace under `D:\Vscode`.

## Current Scope

- Independent Node.js + Playwright project
- TikTok discovery by `hashtag`, `keyword`, and `profile`
- Instagram discovery by `hashtag` and `profile`
- Amazon validation by `new-releases`, `movers-shakers`, and `search`
- X API collection by specified `profile` targets, filtered to meme-coin keywords
- Optional saved login state per platform
- Optional persistent browser profile reuse for TikTok and Instagram
- Retry, delay jitter, deduplication, and per-post failure logging
- Standardized `jsonl`, `csv`, combined output, and `run-summary.json`
- Auto-generated `report.html` frontend after every run
- Auto-generated lightweight multi-page dashboard under `site/`
- Auto-synced latest snapshot under `./data/latest/`
- Default focus seeds for `#amazonfinds`, `#tiktokmademebuyit`, `#kitchengadgets`, `#homeorganization`
- Default Amazon emphasis on `New Releases` and `Movers & Shakers`

## Environment Requirements

- Node.js `>= 24`
- npm `>= 11`
- Chromium browser installed through Playwright
- X API bearer token in `X_BEARER_TOKEN` when using the X collector

## Install

```bash
cd D:\Vscode\social-hotlist-scraper
npm install
npm run browsers
```

## Binance Daily Movers

Grab Binance spot `USDT` pairs with the biggest same-day moves and mark coins that are up for at least 2 consecutive days:

```bash
npm run binance-daily
```

Optional example:

```bash
npm run binance-daily -- --top 10 --quote-asset USDT --timezone-offset 8 --min-streak-days 2
```

Generated files:

- `./data/binance/YYYY-MM-DD/summary.json`
- `./data/binance/YYYY-MM-DD/gainers.csv`
- `./data/binance/YYYY-MM-DD/losers.csv`
- `./data/binance/YYYY-MM-DD/site/index.html`
- `./data/binance/latest/*`

## Save Login State

Saving login state is optional but strongly recommended for stable collection.

TikTok:

```bash
npm run auth -- --platform tiktok
```

Instagram:

```bash
npm run auth -- --platform instagram
```

If direct TikTok login is unreliable, you can reuse an existing Chrome or Edge profile and export it into this project:

```bash
npm run auth -- --platform tiktok --session-mode persistentProfile --user-data-dir "C:\Users\PC\AppData\Local\Google\Chrome\User Data" --profile-directory Default --channel chrome
```

What happens:

1. A Playwright browser window opens.
2. You log in manually.
3. After login is complete, return to the terminal window and press Enter.
4. The session is saved to the platform state file.

Saved files:

- `./storage/tiktok-state.json`
- `./storage/instagram-state.json`

If you already have a local cookie export and do not want to log in again, import it into a Playwright storage state:

```bash
npm run import-cookies -- --platform tiktok --input ./storage/manual/tiktok-cookies.json
```

The input file can be either:

- a JSON cookie export from a browser extension or DevTools
- a plain text `Cookie:` header string copied into a local file

This writes a standard Playwright state file such as `./storage/tiktok-state.json`.

If a state file is missing, the collector still runs in public-only mode and this is recorded in `run-summary.json`.

Persistent profile notes:

- Close the same Chrome or Edge profile first if Windows says the profile is locked.
- Persistent profile mode is useful when TikTok login is blocked in a fresh Playwright session but already works in your everyday browser.
- The collector can either use saved `storageState` files or a persistent browser profile, based on the platform config.

## Config

Example config:

- `./config/sources.example.json`

Structure:

```json
{
  "global": {
    "headless": true,
    "maxPostsPerTarget": 12,
    "maxRecordsPerPlatform": 10,
    "minCommentCount": 1000,
    "minHotScore": 10000,
    "minAmazonSalesCount": 10000,
    "delayMs": 1800,
    "navigationTimeoutMs": 45000,
    "retries": 2,
    "outputDir": "./data/runs"
  },
  "tiktok": {
    "enabled": true,
    "storageState": "./storage/tiktok-state.json",
    "sessionMode": "storageState",
    "persistentProfile": {
      "enabled": false,
      "userDataDir": "C:/Users/PC/AppData/Local/Google/Chrome/User Data",
      "profileDirectory": "Default",
      "channel": "chrome"
    },
    "targets": [
      {
        "type": "hashtag",
        "value": "tiktokmademebuyit",
        "limit": 8
      },
      {
        "type": "hashtag",
        "value": "amazonfinds",
        "limit": 8
      }
    ]
  },
  "instagram": {
    "enabled": true,
    "storageState": "./storage/instagram-state.json",
    "sessionMode": "storageState",
    "targets": [
      {
        "type": "hashtag",
        "value": "amazonfinds",
        "limit": 8
      },
      {
        "type": "profile",
        "value": "instagram",
        "limit": 4
      }
    ]
  },
  "amazon": {
    "enabled": true,
    "storageState": null,
    "targets": [
      {
        "type": "new-releases",
        "value": "all",
        "limit": 12
      },
      {
        "type": "movers-shakers",
        "value": "all",
        "limit": 12
      },
      {
        "type": "search",
        "value": "kitchen gadgets",
        "limit": 8
      }
    ]
  }
}
```

Notes:

- `Instagram` keyword search is not a default v1 entry point.
- Relative paths are resolved from the project root.
- `targets[].type` must be valid for the platform:
  - `TikTok`: `hashtag`, `keyword`, `profile`
  - `Instagram`: `hashtag`, `profile`
  - `Amazon`: `new-releases`, `movers-shakers`, `search`
  - `X`: `profile`
- Set `sessionMode` to `persistentProfile` for TikTok or Instagram if you want to reuse a real browser profile instead of a saved `storageState` file.
- X uses the official API, not Playwright browser scraping. Configure bloggers under `x.targets`, set `X_BEARER_TOKEN`, and edit `x.memeKeywords` or per-target `keywords` to tune meme-coin matching.

## Run Collection

Collect from all enabled platforms:

```bash
npm run collect -- --config ./config/sources.example.json --platform all
```

Collect only Instagram:

```bash
npm run collect -- --config ./config/sources.example.json --platform instagram
```

Collect only Amazon:

```bash
npm run collect -- --config ./config/sources.example.json --platform amazon
```

Collect X meme-coin posts from configured bloggers:

```bash
$env:X_BEARER_TOKEN="YOUR_X_API_BEARER_TOKEN"
npm run collect:x
```

Open a local frontend for X meme-coin monitoring:

```bash
$env:X_BEARER_TOKEN="YOUR_X_API_BEARER_TOKEN"
npm run dashboard:x
```

Then open `http://127.0.0.1:47831` and click `开始抓取`.

The dedicated X example lives at `./config/x-meme.example.json`. It currently seeds `MustStopMurad`, `blknoiz06`, `DegenerateNews`, `lookonchain`, `ai_9684xtpa`, and `tier10k`; replace or add handles as needed, without the leading `@`.

Override the per-target limit and browser mode:

```bash
npm run collect -- --config ./config/sources.example.json --platform instagram --limit 5 --headless false
```

Run the daily pipeline:

```bash
npm run daily -- --config ./config/sources.example.json --platform all
```

Supported CLI flags:

- `--config`
- `--platform`
- `--headless`
- `--limit`
- `--min-comment-count`
- `--min-hot-score`
- `--min-amazon-sales-count`

Filtering thresholds:

- `global.minCommentCount` controls the minimum `commentCount` required for `TikTok` and `Instagram`
- `TikTok` and `Instagram` try to prefilter during discovery, but if discovery cards do not expose comment counts they still fall through to detail-page validation
- `global.maxRecordsPerPlatform` limits final kept records per platform
- `X` scans each blogger timeline up to `x.scanLimitPerTarget`, keeps posts matching `x.memeKeywords`, and exports matched keywords in `rawMeta.matchedKeywords`
- `global.minAmazonSalesCount` controls the minimum Amazon `salesCount` proxy required to keep a record
- `FastMoss` is treated as a board source and is kept by rank cap instead of `hotScore`
- the example config now uses:
  - social comment threshold: `1000`
  - platform cap: `10`
  - Amazon sales threshold: `10000`

Exit behavior:

- returns `0` when all targets succeed
- returns `0` when partially successful, with failures recorded in `run-summary.json`
- returns non-zero for invalid config or startup failure

## Output

Each run creates a timestamped folder:

```text
data/runs/<timestamp>/
```

Typical files:

- `instagram.jsonl`
- `instagram.csv`
- `tiktok.jsonl`
- `tiktok.csv`
- `amazon.jsonl`
- `amazon.csv`
- `x.jsonl`
- `x.csv`
- `combined.csv`
- `run-summary.json`
- `report.html`
- `site/index.html`
- `site/leaderboards-hot.html`
- `site/leaderboards-new.html`
- `site/leaderboards-rising.html`
- `site/products.html`
- `site/shops.html`
- `site/creators.html`
- `site/search.html`

The latest successful run is mirrored to:

```text
data/latest/
```

## Frontend Report

`report.html` is a static frontend generated after every run.

It includes:

- clickable post links
- cover images when available
- creator handle and platform
- Amazon board labels, ranks, prices, and movement percentages
- English summary for each post
- a `Likely product` hint that tries to explain what is being sold
- product vs non-product labeling
- derived `shoppingSignalScore`
- derived `hotScore`
- platform filters and a product-only filter
- keyword search across creators, captions, products, and tags
- a ranked leaderboard for the strongest product candidates

## Standard Record Fields

Each normalized record contains:

- `platform`
- `targetType`
- `targetValue`
- `postId`
- `postUrl`
- `title`
- `coverImageUrl`
- `authorHandle`
- `authorName`
- `productHint`
- `englishSummary`
- `shoppingSignalScore`
- `hotScore`
- `isLikelyProductPost`
- `caption`
- `hashtags`
- `publishedAt`
- `sourceBoard`
- `boardRank`
- `movementPercent`
- `priceText`
- `likeCount`
- `commentCount`
- `shareCount`
- `viewCount`
- `collectedAt`
- `rawMeta`

Field notes:

- `title` is especially useful for Amazon entries and product detail cards.
- `productHint` is a heuristic guess of the likely item or category being promoted.
- `englishSummary` is a cleaned English summary used directly by the frontend.
- `shoppingSignalScore` estimates how likely the post is a selling or recommendation post.
- `hotScore` is a derived ranking score used for frontend sorting. For Amazon entries it is based on board position and movement.
- `sourceBoard`, `boardRank`, `movementPercent`, and `priceText` are most relevant for Amazon records.
- `rawMeta` stores source hints for debugging and future analysis.

## Testing

Run the unit tests:

```bash
npm test
```

Current test coverage includes:

- count parsing such as `12.3K` and `4M`
- URL normalization and deduplication behavior
- config loading and default merging
- cookie import from JSON and raw header strings
- cover image retention in normalized records
- product hint inference
- English summary cleanup
- shopping signal scoring
- editorial content staying out of the product board
- persistent profile config normalization
- Amazon board enrichment and scoring

## Troubleshooting

1. Login-required pages return limited content

Save a login state first with `npm run auth -- --platform <platform>`.

2. Browser does not launch

Run `npm run browsers` to install the Playwright Chromium runtime.

3. Some fields are null

That can be normal. For example, `Instagram` usually does not expose a reliable `shareCount`.

4. A page opens but discovery is weak

Check `run-summary.json` and inspect `rawMeta` in the exported records to understand what the platform exposed.

5. TikTok redirects to an unavailable page

This usually means the current network or region is blocked or limited by TikTok. The collector records the explicit platform error in `run-summary.json`.

6. TikTok login works in your regular browser but not in Playwright

Switch the TikTok config to `sessionMode: "persistentProfile"` or use the `auth` command with `--session-mode persistentProfile` to export a session from Chrome or Edge.

7. Amazon search targets return weak results

Amazon search pages are more volatile than the `New Releases` and `Movers & Shakers` boards. If you need stable validation first, prioritize those two boards.

8. The frontend shows a post as non-product

This is expected for editorial or entertainment content. The project intentionally keeps those posts visible, but marks them separately from likely sell-through posts.

## Feishu Push

This project can run on this PC and push the latest hotlist to a Feishu group through a custom bot webhook.

1. Create local environment config:

```bash
copy .env.example .env.local
```

2. Fill `FEISHU_WEBHOOK_URL` in `.env.local`.

If the Feishu bot has signature verification enabled, also fill `FEISHU_BOT_SECRET`.

3. Push the current latest dashboard result:

```bash
npm run feishu
```

4. Run a full collection and push after it finishes:

```bash
npm run daily:feishu -- --config ./config/sources.example.json --platform all
```

The Feishu message keeps source links for each row, such as Instagram original posts, FastMoss/TikTok video-board rows, Amazon source pages, and FastMoss hotlist records.

Without a server, `DASHBOARD_PUBLIC_URL=http://127.0.0.1:47831/` only opens on this PC. If other people need to open the dashboard link from Feishu, replace it with a LAN IP, intranet tunnel URL, or future cloud domain.

## Compliance Notes

- Only collect content that is publicly visible, or content you can legitimately access while logged into your own account.
- Do not use this project to bypass permissions, access private content, or run abusive high-frequency scraping.
- Platform behavior and rules can change. Review the target platform terms and your local compliance requirements before large-scale use.

## Next Phase

This first-phase output is designed to feed the next stage directly.

Typical next steps:

- tag-level heat analysis across `#amazonfinds`, `#tiktokmademebuyit`, `#kitchengadgets`, and `#homeorganization`
- creator clustering
- engagement-rate ranking
- Amazon board validation against `New Releases` and `Movers & Shakers`
- candidate product ranking
- hotlist generation
- product board or dashboard logic
