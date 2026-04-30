import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  analyzeRecords,
  flattenLeaderboardsForCsv
} from "../src/core/analysis.js";
import {
  buildBinanceUniverse,
  countConsecutiveTopListAppearances,
  countPositiveDailyStreak,
  isLeveragedToken,
  previousDateLabel,
  selectTopMovers,
  toMoverRow
} from "../src/core/binance-analysis.js";
import {
  buildEnglishSummary as buildSummary,
  computeShoppingSignal as computeSignal,
  enrichRecord as enrich,
  inferProductHint as inferHint
} from "../src/core/enrichment.js";
import { buildStorageStateFromCookieText } from "../src/core/cookie-import.js";
import { loadConfig } from "../src/core/config.js";
import { runPlatformCollection } from "../src/core/platform-runner.js";
import { createStandardRecord } from "../src/core/scrape-helpers.js";
import { buildStaticSite } from "../src/core/site-builder.js";
import { normalizePostUrl, parseCount } from "../src/core/utils.js";
import { extractFastmossApiItems } from "../src/platforms/fastmoss.js";
import {
  buildTikTokDiscoveryUrls,
  extractTikTokRehydrationData
} from "../src/platforms/tiktok.js";
import {
  findMemeKeywordMatches,
  mapTweetToXRecord,
  normalizeXUsername
} from "../src/platforms/x.js";

test("parseCount supports raw numbers and suffixes", () => {
  assert.equal(parseCount("12.3K"), 12300);
  assert.equal(parseCount("4M"), 4000000);
  assert.equal(parseCount("1,234"), 1234);
  assert.equal(parseCount(""), null);
});

test("isLeveragedToken identifies Binance leveraged token suffixes", () => {
  assert.equal(isLeveragedToken("BTCUP"), true);
  assert.equal(isLeveragedToken("ETHDOWN"), true);
  assert.equal(isLeveragedToken("BTC"), false);
});

test("buildBinanceUniverse keeps only tradable spot pairs for the target quote asset", () => {
  const universe = buildBinanceUniverse(
    [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        isSpotTradingAllowed: true,
        baseAsset: "BTC",
        quoteAsset: "USDT"
      },
      {
        symbol: "BTCFDUSD",
        status: "TRADING",
        isSpotTradingAllowed: true,
        baseAsset: "BTC",
        quoteAsset: "FDUSD"
      },
      {
        symbol: "BTCUPUSDT",
        status: "TRADING",
        isSpotTradingAllowed: true,
        baseAsset: "BTCUP",
        quoteAsset: "USDT"
      }
    ],
    {
      quoteAsset: "USDT",
      excludeLeveraged: true
    }
  );

  assert.deepEqual(universe, [
    {
      symbol: "BTCUSDT",
      status: "TRADING",
      baseAsset: "BTC",
      quoteAsset: "USDT"
    }
  ]);
});

test("countPositiveDailyStreak counts trailing green daily candles only", () => {
  const streakDays = countPositiveDailyStreak([
    [1, "10", "11", "9", "9.5"],
    [2, "9.5", "10.2", "9.3", "10.1"],
    [3, "10.1", "11.4", "10", "10.8"],
    [4, "10.8", "11.8", "10.7", "11.5"]
  ]);

  assert.equal(streakDays, 3);
});

test("selectTopMovers ranks gainers and losers by daily percent move", () => {
  const rows = [
    toMoverRow(
      { symbol: "AAAUSDT", priceChange: "1", priceChangePercent: "11", openPrice: "10", lastPrice: "11" },
      { symbol: "AAAUSDT", baseAsset: "AAA", quoteAsset: "USDT" },
      2
    ),
    toMoverRow(
      { symbol: "BBBUSDT", priceChange: "-2", priceChangePercent: "-8", openPrice: "10", lastPrice: "9.2" },
      { symbol: "BBBUSDT", baseAsset: "BBB", quoteAsset: "USDT" },
      0
    ),
    toMoverRow(
      { symbol: "CCCUSDT", priceChange: "0.5", priceChangePercent: "5", openPrice: "10", lastPrice: "10.5" },
      { symbol: "CCCUSDT", baseAsset: "CCC", quoteAsset: "USDT" },
      1
    )
  ];

  const result = selectTopMovers(rows, 2);

  assert.equal(result.gainers[0].symbol, "AAAUSDT");
  assert.equal(result.gainers[0].isRisingStreak, true);
  assert.equal(result.losers[0].symbol, "BBBUSDT");
});

test("countConsecutiveTopListAppearances stops when a calendar day is missing", () => {
  const repeatDays = countConsecutiveTopListAppearances({
    symbol: "AAAUSDT",
    side: "gainers",
    currentDateLabel: "2026-04-03",
    previousSummaries: [
      {
        dateLabel: "2026-04-01",
        gainers: [{ symbol: "AAAUSDT" }]
      }
    ]
  });

  assert.equal(repeatDays, 1);
});

test("countConsecutiveTopListAppearances requires adjacent daily appearances", () => {
  const repeatDays = countConsecutiveTopListAppearances({
    symbol: "AAAUSDT",
    side: "gainers",
    currentDateLabel: "2026-04-03",
    previousSummaries: [
      {
        dateLabel: "2026-04-01",
        gainers: [{ symbol: "AAAUSDT" }]
      },
      {
        dateLabel: "2026-04-02",
        gainers: [{ symbol: "AAAUSDT" }]
      }
    ]
  });

  assert.equal(repeatDays, 3);
});

test("previousDateLabel handles month boundaries", () => {
  assert.equal(previousDateLabel("2026-05-01"), "2026-04-30");
});

test("normalizePostUrl removes tracking parameters and fragments", () => {
  assert.equal(
    normalizePostUrl("https://www.tiktok.com/@shop/video/123456?lang=en&utm_source=feed#top"),
    "https://www.tiktok.com/@shop/video/123456?lang=en"
  );
  assert.equal(
    normalizePostUrl("https://www.instagram.com/p/ABC123/?utm_source=ig_web_copy_link"),
    "https://www.instagram.com/p/ABC123"
  );
  assert.equal(
    normalizePostUrl("https://www.amazon.com/dp/B012345678?currency=USD&language=en_US&tag=abc"),
    "https://www.amazon.com/dp/B012345678?currency=USD&language=en_US"
  );
});

test("loadConfig merges defaults and resolves relative paths", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "social-hotlist-"));
  const configPath = path.join(tempDir, "config.json");

  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        global: {
          delayMs: 2000
        },
        tiktok: {
          targets: [
            {
              type: "keyword",
              value: "viral gadget",
              limit: 3
            }
          ]
        },
        instagram: {
          enabled: false,
          targets: []
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const config = await loadConfig(configPath);

  assert.equal(config.global.delayMs, 2000);
  assert.equal(config.global.maxPostsPerTarget, 20);
  assert.equal(config.global.maxRecordsPerPlatform, 10);
  assert.equal(config.global.minCommentCount, 0);
  assert.equal(config.global.maxSocialPostAgeDays, 7);
  assert.equal(config.global.minHotScore, 0);
  assert.equal(config.tiktok.targets[0].value, "viral gadget");
  assert.equal(config.instagram.enabled, false);
  assert.ok(
    config.tiktok.storageState.endsWith(path.join("social-hotlist-scraper", "storage", "tiktok-state.json"))
  );
  assert.ok(
    config.global.outputDir.endsWith(path.join("social-hotlist-scraper", "data", "runs"))
  );
  assert.equal(config.x.enabled, false);
  assert.equal(config.x.bearerTokenEnv, "X_BEARER_TOKEN");
});

test("loadConfig supports X profile targets and keyword overrides", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "social-hotlist-x-"));
  const configPath = path.join(tempDir, "config.json");

  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        x: {
          enabled: true,
          targets: [
            {
              type: "profile",
              value: "@meme_blogger",
              limit: 2,
              keywords: ["$DOGE"]
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const config = await loadConfig(configPath);

  assert.equal(config.x.enabled, true);
  assert.equal(config.x.targets[0].value, "@meme_blogger");
  assert.deepEqual(config.x.targets[0].keywords, ["$DOGE"]);
});

test("loadConfig preserves persistent profile session settings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "social-hotlist-profile-"));
  const configPath = path.join(tempDir, "config.json");

  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        tiktok: {
          sessionMode: "persistentProfile",
          persistentProfile: {
            enabled: true,
            userDataDir: "./profiles/chrome",
            profileDirectory: "Profile 3",
            channel: "msedge"
          },
          targets: [
            {
              type: "hashtag",
              value: "tiktokmademebuyit",
              limit: 1
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const config = await loadConfig(configPath);

  assert.equal(config.tiktok.sessionMode, "persistentProfile");
  assert.equal(config.tiktok.persistentProfile.enabled, true);
  assert.equal(config.tiktok.persistentProfile.profileDirectory, "Profile 3");
  assert.equal(config.tiktok.persistentProfile.channel, "msedge");
  assert.ok(config.tiktok.persistentProfile.userDataDir.endsWith(path.join("profiles", "chrome")));
});

test("buildStorageStateFromCookieText imports JSON cookie exports", () => {
  const storageState = buildStorageStateFromCookieText(
    JSON.stringify([
      {
        name: "sessionid",
        value: "abc123",
        domain: ".tiktok.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
        expires: 1893456000
      }
    ]),
    "tiktok"
  );

  assert.equal(storageState.cookies.length, 1);
  assert.equal(storageState.cookies[0].domain, ".tiktok.com");
  assert.equal(storageState.cookies[0].sameSite, "None");
});

test("buildStorageStateFromCookieText imports raw cookie headers", () => {
  const storageState = buildStorageStateFromCookieText(
    "sessionid=abc123; tt_csrf_token=xyz456",
    "tiktok"
  );

  assert.equal(storageState.cookies.length, 2);
  assert.equal(storageState.cookies[0].domain, ".tiktok.com");
  assert.equal(storageState.cookies[0].path, "/");
});

test("createStandardRecord keeps cover image in the normalized output", () => {
  const record = createStandardRecord(
    "instagram",
    {
      type: "profile",
      value: "instagram"
    },
    {
      postId: "abc123",
      postUrl: "https://www.instagram.com/p/abc123",
      coverImageUrl: "https://example.com/cover.jpg",
      authorHandle: "instagram",
      authorName: "Instagram",
      caption: "hello world",
      hashtags: ["hello"],
      publishedAt: "2026-04-21T00:00:00.000Z"
    }
  );

  assert.equal(record.coverImageUrl, "https://example.com/cover.jpg");
});

test("normalizeXUsername accepts handles and profile URLs", () => {
  assert.equal(normalizeXUsername("@example_blogger"), "example_blogger");
  assert.equal(normalizeXUsername("https://x.com/example_blogger/status/123"), "example_blogger");
  assert.equal(normalizeXUsername("https://twitter.com/example_blogger"), "example_blogger");
});

test("findMemeKeywordMatches matches meme coin terms without partial words", () => {
  const matches = findMemeKeywordMatches(
    "Watching $PEPE and pump.fun launches, but remember risk management.",
    ["$PEPE", "pump.fun", "meme", "shib"]
  );

  assert.deepEqual(matches, ["$PEPE", "pump.fun"]);
});

test("mapTweetToXRecord normalizes X meme tweet output", () => {
  const mediaMap = new Map([
    [
      "media-1",
      {
        media_key: "media-1",
        type: "photo",
        url: "https://example.com/pepe.jpg"
      }
    ]
  ]);
  const record = mapTweetToXRecord(
    {
      user: {
        id: "42",
        username: "meme_blogger",
        name: "Meme Blogger"
      },
      tweet: {
        id: "100",
        text: "New $PEPE meme coin watchlist #memecoin",
        created_at: "2026-04-22T00:00:00.000Z",
        entities: {
          hashtags: [{ tag: "memecoin" }],
          cashtags: [{ tag: "PEPE" }]
        },
        attachments: {
          media_keys: ["media-1"]
        },
        public_metrics: {
          like_count: 100,
          reply_count: 7,
          retweet_count: 8,
          quote_count: 2,
          impression_count: 5000
        }
      },
      mediaMap,
      matchedKeywords: ["$PEPE", "meme coin"]
    },
    {
      type: "profile",
      value: "meme_blogger"
    }
  );

  assert.equal(record.platform, "x");
  assert.equal(record.postUrl, "https://x.com/meme_blogger/status/100");
  assert.equal(record.coverImageUrl, "https://example.com/pepe.jpg");
  assert.equal(record.authorHandle, "@meme_blogger");
  assert.equal(record.shareCount, 10);
  assert.equal(record.productHint, "Meme Coin: $PEPE");
  assert.deepEqual(record.rawMeta.matchedKeywords, ["$PEPE", "meme coin"]);
});

test("inferProductHint prefers concrete product phrases", () => {
  const productHint = inferHint({
    caption: "Okay but these foldable on-the-go flip flops are genius for travel.",
    hashtags: ["amazonfinds", "travelmusthaves"],
    rawMeta: {
      metaEntries: {
        keywords: "foldable flip flops, travel accessories, comfortable sandals"
      }
    }
  });

  assert.equal(productHint, "Foldable Flip Flops");
});

test("inferProductHint can recover product names from compact hashtags", () => {
  const productHint = inferHint({
    caption: "Small but mighty!",
    hashtags: ["amazonfinds", "phonecharger", "portablecharger"],
    rawMeta: {
      metaEntries: {}
    }
  });

  assert.equal(productHint, "Phone Charger");
});

test("buildEnglishSummary produces an English product-focused summary", () => {
  const summary = buildSummary(
    {
      caption: "Link in bio. Comment NEED for the link. These foldable on-the-go flip flops are easy to pack and clean.",
      hashtags: ["amazonfinds"],
      rawMeta: {
        metaEntries: {}
      }
    },
    "Foldable Flip Flops"
  );

  assert.match(summary, /Likely promoting/i);
  assert.match(summary, /Foldable Flip Flops/i);
  assert.doesNotMatch(summary, /Link in bio/i);
});

test("inferProductHint falls back to a category when caption is mostly CTA noise", () => {
  const productHint = inferHint({
    caption: "Find this on my website. Link in bio. All products are linked on my page.",
    hashtags: ["amazonhome", "amazongadgets", "amazonfinds"],
    rawMeta: {
      metaEntries: {}
    }
  });

  assert.equal(productHint, "Kitchen Or Household Gadget");
});

test("computeShoppingSignal is high for clear shopping posts", () => {
  const score = computeSignal(
    {
      caption: "Amazon finds. Link in bio. Shop my favorites.",
      hashtags: ["amazonfinds", "amazonhome"],
      authorHandle: "tophomefinds",
      authorName: "Top Home Finds",
      rawMeta: {
        metaEntries: {}
      }
    },
    "Kitchen Or Household Gadget"
  );

  assert.ok(score >= 4);
});

test("computeShoppingSignal does not treat meta comment counts as a shopping CTA", () => {
  const score = computeSignal(
    {
      caption: "sending these to the group chat rn",
      hashtags: [],
      authorHandle: "instagram",
      authorName: "Instagram",
      rawMeta: {
        metaEntries: {
          description: "71K likes, 5,866 comments - instagram on March 31, 2026"
        }
      }
    },
    "General Consumer Product"
  );

  assert.equal(score, 0);
});

test("enrichRecord marks editorial posts as non-product when shopping signal is weak", () => {
  const record = enrich({
    platform: "instagram",
    targetType: "profile",
    targetValue: "instagram",
    postId: "demo",
    postUrl: "https://example.com",
    coverImageUrl: null,
    authorHandle: "instagram",
    authorName: "Instagram",
    productHint: "Kendama",
    caption: "Video by a creator showing an Irish dancing performance.",
    hashtags: ["inthemoment"],
    publishedAt: "2026-04-21T00:00:00.000Z",
    likeCount: 1000,
    commentCount: 100,
    shareCount: null,
    viewCount: null,
    collectedAt: "2026-04-21T00:00:00.000Z",
    rawMeta: {
      metaEntries: {}
    }
  });

  assert.equal(record.isLikelyProductPost, false);
  assert.equal(record.productHint, "No Clear Product");
  assert.ok(typeof record.hotScore === "number");
});

test("enrichRecord keeps casual editorial captions out of the product board", () => {
  const record = enrich({
    platform: "instagram",
    targetType: "profile",
    targetValue: "instagram",
    postId: "chat-demo",
    postUrl: "https://example.com/chat",
    coverImageUrl: null,
    authorHandle: "instagram",
    authorName: "Instagram",
    caption: "sending these to the group chat rn",
    hashtags: [],
    publishedAt: "2026-04-21T00:00:00.000Z",
    likeCount: 100,
    commentCount: 20,
    shareCount: null,
    viewCount: null,
    collectedAt: "2026-04-21T00:00:00.000Z",
    rawMeta: {
      metaEntries: {
        description: "71K likes, 5,866 comments - instagram on March 31, 2026"
      }
    }
  });

  assert.equal(record.isLikelyProductPost, false);
  assert.equal(record.productHint, "No Clear Product");
  assert.match(record.englishSummary, /No clear product/i);
});

test("enrichRecord treats amazon board records as product candidates", () => {
  const record = enrich({
    platform: "amazon",
    targetType: "movers-shakers",
    targetValue: "all",
    postId: "B0TEST123",
    postUrl: "https://www.amazon.com/dp/B0TEST123",
    title: "Kitchen Organizer Rack with Adjustable Compartments",
    coverImageUrl: "https://example.com/rack.jpg",
    authorHandle: null,
    authorName: "Example Brand",
    sourceBoard: "Movers & Shakers in Home & Kitchen",
    boardRank: 3,
    movementPercent: 112,
    priceText: "$24.99",
    caption: "Kitchen Organizer Rack with Adjustable Compartments",
    hashtags: [],
    publishedAt: null,
    likeCount: null,
    commentCount: null,
    shareCount: null,
    viewCount: null,
    collectedAt: "2026-04-21T00:00:00.000Z",
    rawMeta: {}
  });

  assert.equal(record.isLikelyProductPost, true);
  assert.equal(record.shoppingSignalScore, 10);
  assert.match(record.englishSummary, /Movers & Shakers/i);
  assert.ok(record.hotScore > 0);
});

test("analyzeRecords builds validated leaderboards from social and amazon signals", () => {
  const result = analyzeRecords([
    {
      platform: "tiktok",
      targetType: "hashtag",
      targetValue: "amazonfinds",
      postId: "social-1",
      postUrl: "https://example.com/social-1",
      title: null,
      coverImageUrl: "https://example.com/social-1.jpg",
      authorHandle: "@cozyfinds",
      authorName: "Cozy Finds",
      productHint: "Mini Vacuum",
      englishSummary: "Likely promoting a Mini Vacuum.",
      shoppingSignalScore: 8,
      hotScore: 140000,
      isLikelyProductPost: true,
      caption: "Small but mighty mini vacuum for the car.",
      hashtags: ["amazonfinds", "minivacuum", "carvacuum"],
      publishedAt: "2026-04-01T00:00:00.000Z",
      sourceBoard: null,
      boardRank: null,
      movementPercent: null,
      priceText: null,
      likeCount: 1000,
      commentCount: 20,
      shareCount: 10,
      viewCount: 30000,
      collectedAt: "2026-04-22T00:00:00.000Z",
      rawMeta: {
        metaEntries: {
          keywords: "mini vacuum, car vacuum"
        }
      }
    },
    {
      platform: "amazon",
      targetType: "movers-shakers",
      targetValue: "all",
      postId: "amazon-1",
      postUrl: "https://example.com/amazon-1",
      title: "Portable Mini Vacuum Cleaner for Car and Desk",
      coverImageUrl: "https://example.com/amazon-1.jpg",
      authorHandle: null,
      authorName: "Example Brand",
      productHint: "Portable Mini Vacuum Cleaner for Car and Desk",
      englishSummary: "Listed in Movers & Shakers.",
      shoppingSignalScore: 10,
      hotScore: 4000,
      isLikelyProductPost: true,
      caption: "Portable Mini Vacuum Cleaner for Car and Desk",
      hashtags: [],
      publishedAt: null,
      sourceBoard: "Movers & Shakers in Home & Kitchen",
      boardRank: 2,
      movementPercent: 118,
      priceText: "$29.99",
      likeCount: null,
      commentCount: null,
      shareCount: null,
      viewCount: null,
      collectedAt: "2026-04-22T00:00:00.000Z",
      rawMeta: {}
    }
  ]);

  assert.ok(result.boards.overall.length >= 2);
  assert.ok(result.boards.moversShakers.length >= 1);
  assert.ok(
    result.boards.overall.some((entry) => entry.matchedAmazonBoards.includes("movers-shakers"))
  );

  const flattened = flattenLeaderboardsForCsv(result);
  assert.ok(flattened.some((row) => row.board === "overall"));
  assert.ok(flattened.some((row) => row.board === "movers-shakers"));
});

test("analyzeRecords derives salesAmount from comma-separated prices", () => {
  const leaderboards = analyzeRecords([
    createStandardRecord(
      "amazon",
      {
        type: "movers-shakers",
        value: "all"
      },
      {
        postId: "B012345678",
        postUrl: "https://www.amazon.com/dp/B012345678?currency=USD&language=en_US",
        title: "Example Product",
        priceText: "$1,512.00 - $1,514.00",
        salesCount: 50,
        salesAmount: null,
        boardRank: 1,
        sourceBoard: "Amazon Movers & Shakers"
      }
    )
  ]);

  assert.equal(leaderboards.boards.overall[0].salesAmount, 75600);
});

test("runPlatformCollection does not backfill amazon below the sales threshold", async () => {
  const collector = {
    platform: "amazon",
    async discoverPostUrls() {
      return [
        { postUrl: "https://www.amazon.com/dp/B000000001" },
        { postUrl: "https://www.amazon.com/dp/B000000002" }
      ];
    },
    async scrapePost(_page, discoveredEntry, target) {
      if (discoveredEntry.postUrl.endsWith("1")) {
        return createStandardRecord("amazon", target, {
          postId: "B000000001",
          postUrl: discoveredEntry.postUrl,
          title: "Low sales product",
          salesCount: 5,
          priceText: "$10.00"
        });
      }

      return createStandardRecord("amazon", target, {
        postId: "B000000002",
        postUrl: discoveredEntry.postUrl,
        title: "Qualified product",
        salesCount: 20,
        priceText: "$10.00"
      });
    }
  };

  const result = await runPlatformCollection({
    collector,
    context: null,
    globalConfig: {
      maxRecordsPerPlatform: 2,
      minCommentCount: 1000,
      minAmazonSalesCount: 10,
      delayMs: 250,
      retries: 0
    },
    platformConfig: {
      targets: [
        {
          type: "movers-shakers",
          value: "all",
          limit: 2
        }
      ]
    }
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].postId, "B000000002");
  assert.equal(
    result.warnings.some((item) => item.code === "PLATFORM_BACKFILLED"),
    false
  );
});

test("runPlatformCollection keeps only recent social posts inside the configured age window", async () => {
  const recentPublishedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const stalePublishedAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
  const collector = {
    platform: "tiktok",
    async discoverPostUrls() {
      return [
        { postUrl: "https://www.tiktok.com/@shop/video/1001" },
        { postUrl: "https://www.tiktok.com/@shop/video/1002" }
      ];
    },
    async scrapePost(_page, discoveredEntry, target) {
      if (discoveredEntry.postUrl.endsWith("1001")) {
        return createStandardRecord("tiktok", target, {
          postId: "1001",
          postUrl: discoveredEntry.postUrl,
          caption: "Recent product video",
          commentCount: 650,
          publishedAt: recentPublishedAt
        });
      }

      return createStandardRecord("tiktok", target, {
        postId: "1002",
        postUrl: discoveredEntry.postUrl,
        caption: "Old product video",
        commentCount: 900,
        publishedAt: stalePublishedAt
      });
    }
  };

  const result = await runPlatformCollection({
    collector,
    context: null,
    globalConfig: {
      maxRecordsPerPlatform: 2,
      minCommentCount: 500,
      maxSocialPostAgeDays: 7,
      minAmazonSalesCount: 10,
      delayMs: 250,
      retries: 0
    },
    platformConfig: {
      targets: [
        {
          type: "hashtag",
          value: "amazonfinds",
          limit: 2
        }
      ]
    }
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].postId, "1001");
  assert.equal(result.targets[0].filteredByPublishedAt, 1);
});

test("runPlatformCollection does not backfill social posts below the comment threshold", async () => {
  const collector = {
    platform: "tiktok",
    async discoverPostUrls() {
      return [
        { postUrl: "https://www.tiktok.com/@shop/video/2001" },
        { postUrl: "https://www.tiktok.com/@shop/video/2002" }
      ];
    },
    async scrapePost(_page, discoveredEntry, target) {
      if (discoveredEntry.postUrl.endsWith("2001")) {
        return createStandardRecord("tiktok", target, {
          postId: "2001",
          postUrl: discoveredEntry.postUrl,
          caption: "Qualified product video",
          commentCount: 700,
          publishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        });
      }

      return createStandardRecord("tiktok", target, {
        postId: "2002",
        postUrl: discoveredEntry.postUrl,
        caption: "Low-comment product video",
        commentCount: 320,
        publishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      });
    }
  };

  const result = await runPlatformCollection({
    collector,
    context: null,
    globalConfig: {
      maxRecordsPerPlatform: 2,
      minCommentCount: 500,
      maxSocialPostAgeDays: 7,
      minAmazonSalesCount: 10,
      delayMs: 250,
      retries: 0
    },
    platformConfig: {
      targets: [
        {
          type: "hashtag",
          value: "amazonfinds",
          limit: 2
        }
      ]
    }
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].postId, "2001");
  assert.equal(
    result.warnings.some((item) => item.code === "PLATFORM_BACKFILLED"),
    false
  );
});

test("extractTikTokRehydrationData pulls image, stats, and author from rehydration JSON", () => {
  const rehydrated = extractTikTokRehydrationData(
    JSON.stringify({
      __DEFAULT_SCOPE__: {
        "webapp.video-detail": {
          itemInfo: {
            itemStruct: {
              desc: "A compact phone charger for travel.",
              createTime: "1710000000",
              video: {
                cover: "https://example.com/cover.jpg"
              },
              author: {
                uniqueId: "shopfinds",
                nickname: "Shop Finds",
                avatarMedium: "https://example.com/avatar.jpg",
                signature: "Daily finds"
              },
              challenges: [
                {
                  title: "amazonfinds"
                }
              ],
              stats: {
                diggCount: 1200,
                commentCount: 44,
                shareCount: 18,
                playCount: 9900
              }
            }
          }
        }
      }
    })
  );

  assert.equal(rehydrated.coverImageUrl, "https://example.com/cover.jpg");
  assert.equal(rehydrated.authorHandle, "@shopfinds");
  assert.equal(rehydrated.authorName, "Shop Finds");
  assert.equal(rehydrated.authorAvatarUrl, "https://example.com/avatar.jpg");
  assert.equal(rehydrated.likeCount, 1200);
  assert.deepEqual(rehydrated.hashtags, ["amazonfinds"]);
  assert.match(rehydrated.publishedAt, /^2024-/);
});

test("buildTikTokDiscoveryUrls prioritizes hashtag video search before tag pages", () => {
  assert.deepEqual(buildTikTokDiscoveryUrls({ type: "hashtag", value: "amazonfinds" }), [
    "https://www.tiktok.com/search/video?q=%23amazonfinds",
    "https://www.tiktok.com/tag/amazonfinds"
  ]);
  assert.deepEqual(buildTikTokDiscoveryUrls({ type: "keyword", value: "kitchen gadgets" }), [
    "https://www.tiktok.com/search/video?q=kitchen%20gadgets"
  ]);
});

test("extractFastmossApiItems maps nested JSON payloads into collector rows", () => {
  const items = extractFastmossApiItems({
    data: {
      list: [
        {
          product_id: "123",
          product_title: "Portable Blender Cup",
          detail_url: "https://example.com/product/123?region=US",
          product_image: "https://example.com/product/123.jpg",
          price: "$19.99",
          sold_count: "12.3K",
          sales_change: "45",
          gmv: "$245K",
          creator_count: "388",
          shop_name: "Blend Store"
        }
      ]
    }
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Portable Blender Cup");
  assert.equal(items[0].postUrl, "https://example.com/product/123");
  assert.equal(items[0].salesText, "12.3K");
  assert.equal(items[0].authorName, "Blend Store");
});

test("extractFastmossApiItems maps FastMoss hotvideo rows to TikTok video links", () => {
  const items = extractFastmossApiItems(
    {
      data: {
        product_list: [
          {
            product_id: "1729448464509734958",
            title: "Toplux Magnesium Complex 8 Essential Magnesium Supplement 1000mg",
            cover: "https://example.com/product.jpg",
            price: "$15.97",
            sold_count: 13284,
            sold_count_show: "13.2k",
            sold_amount: 253494.84,
            sold_amount_show: "$253.4k",
            digg_count: 72004,
            digg_count_show: "72.0k",
            share_count: 7241,
            share_count_show: "7.2k",
            play_count: 9216394,
            play_count_show: "9.2m",
            comment_count: 1088,
            comment_count_show: "1.0k",
            video_count: 475,
            video_count_show: "475",
            shop_name: "Toplux Nutrition",
            detail_url: "https://shop.tiktok.com/view/product/1729448464509734958?region=US&local=en",
            video_list: [
              {
                video_id: "7631339589994646797",
                author_unique_id: "tumejorsalud97",
                author_nickname: "La Mejor Salud",
                video_desc: "Todo luce bien hasta que … #ushealth",
                cover: "https://example.com/video.jpg"
              }
            ]
          }
        ]
      }
    },
    "hotvideo"
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].postUrl, "https://www.tiktok.com/@tumejorsalud97/video/7631339589994646797");
  assert.equal(items[0].authorName, "Toplux Nutrition");
  assert.equal(items[0].authorHandle, "@tumejorsalud97");
  assert.equal(items[0].coverImageUrl, "https://example.com/video.jpg");
  assert.equal(items[0].commentCountText, "1.0k");
});

test("buildStaticSite creates lightweight multi-page dashboard outputs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "social-hotlist-site-"));
  const records = [
    {
      platform: "tiktok",
      targetType: "hashtag",
      targetValue: "amazonfinds",
      postId: "social-1",
      postUrl: "https://example.com/social-1",
      title: "Mini Vacuum",
      coverImageUrl: "https://example.com/social-1.jpg",
      authorHandle: "@cozyfinds",
      authorName: "Cozy Finds",
      productHint: "Mini Vacuum",
      englishSummary: "Likely promoting a Mini Vacuum.",
      shoppingSignalScore: 8,
      hotScore: 140000,
      isLikelyProductPost: true,
      caption: "Small but mighty mini vacuum for the car.",
      hashtags: ["amazonfinds", "minivacuum", "carvacuum"],
      publishedAt: "2026-04-01T00:00:00.000Z",
      sourceBoard: null,
      boardRank: null,
      movementPercent: null,
      priceText: null,
      ratingValue: null,
      ratingCount: null,
      salesCount: null,
      salesAmount: null,
      creatorCount: null,
      salesSignal: null,
      likeCount: 1000,
      commentCount: 20,
      shareCount: 10,
      viewCount: 30000,
      collectedAt: "2026-04-22T00:00:00.000Z",
      rawMeta: {}
    }
  ];
  const leaderboards = analyzeRecords(records);
  const summary = {
    runId: "demo-run",
    finishedAt: "2026-04-22T00:00:00.000Z",
    platforms: {
      tiktok: {
        status: "completed",
        records: 1
      }
    }
  };

  const result = await buildStaticSite({
    outputDir: tempDir,
    summary,
    records,
    leaderboards
  });

  const entryHtml = await fs.readFile(result.entryFile, "utf8");
  const productsJson = JSON.parse(
    await fs.readFile(path.join(result.dataDir, "products.json"), "utf8")
  );

  assert.ok(/热推榜|鐑帹姒?/.test(entryHtml));
  assert.ok(productsJson.length >= 1);
  assert.equal(productsJson[0].name, "Mini Vacuum");
});

