export const SUPPORTED_PLATFORMS = ["tiktok", "instagram", "amazon", "fastmoss", "x"];

export const TARGET_TYPES_BY_PLATFORM = {
  tiktok: ["hashtag", "keyword", "profile"],
  instagram: ["hashtag", "profile"],
  amazon: ["new-releases", "movers-shakers", "search"],
  fastmoss: ["saleslist", "new-products", "hotlist", "hotvideo"],
  x: ["profile"]
};

export const STANDARD_FIELDS = [
  "platform",
  "targetType",
  "targetValue",
  "postId",
  "postUrl",
  "title",
  "coverImageUrl",
  "authorHandle",
  "authorName",
  "productHint",
  "englishSummary",
  "shoppingSignalScore",
  "hotScore",
  "isLikelyProductPost",
  "caption",
  "hashtags",
  "publishedAt",
  "sourceBoard",
  "boardRank",
  "movementPercent",
  "priceText",
  "ratingValue",
  "ratingCount",
  "salesCount",
  "salesAmount",
  "creatorCount",
  "salesSignal",
  "likeCount",
  "commentCount",
  "shareCount",
  "viewCount",
  "collectedAt",
  "rawMeta"
];

export const DEFAULT_CONFIG = {
  global: {
    headless: true,
    maxPostsPerTarget: 20,
    maxRecordsPerPlatform: 10,
    minCommentCount: 0,
    maxSocialPostAgeDays: 7,
    minHotScore: 0,
    minAmazonSalesCount: 0,
    delayMs: 1800,
    navigationTimeoutMs: 45000,
    retries: 2,
    outputDir: "./data/runs"
  },
  tiktok: {
    enabled: true,
    storageState: "./storage/tiktok-state.json",
    sessionMode: "storageState",
    persistentProfile: {
      enabled: false,
      userDataDir: "",
      profileDirectory: "Default",
      channel: "chrome"
    },
    targets: []
  },
  instagram: {
    enabled: true,
    storageState: "./storage/instagram-state.json",
    sessionMode: "storageState",
    persistentProfile: {
      enabled: false,
      userDataDir: "",
      profileDirectory: "Default",
      channel: "chrome"
    },
    targets: []
  },
  amazon: {
    enabled: true,
    storageState: null,
    sessionMode: "storageState",
    persistentProfile: {
      enabled: false,
      userDataDir: "",
      profileDirectory: "Default",
      channel: "chrome"
    },
    targets: []
  },
  fastmoss: {
    enabled: false,
    storageState: null,
    sessionMode: "persistentProfile",
    persistentProfile: {
      enabled: true,
      userDataDir: "C:/Users/PC/AppData/Local/Google/Chrome/User Data",
      profileDirectory: "Default",
      channel: "chrome"
    },
    targets: []
  },
  x: {
    enabled: false,
    storageState: null,
    sessionMode: "storageState",
    bearerTokenEnv: "X_BEARER_TOKEN",
    lookbackDays: 30,
    scanLimitPerTarget: 100,
    exclude: ["replies", "retweets"],
    memeKeywords: [
      "meme",
      "meme coin",
      "memecoin",
      "meme token",
      "meme币",
      "迷因币",
      "土狗",
      "$DOGE",
      "$SHIB",
      "$PEPE",
      "$BONK",
      "$WIF",
      "$FLOKI",
      "dogecoin",
      "shib",
      "pepe",
      "bonk",
      "dogwifhat",
      "floki",
      "pump.fun",
      "pumpfun",
      "dexscreener",
      "dextools",
      "gmgn",
      "contract address",
      "ca:",
      "solana meme",
      "base meme"
    ],
    targets: []
  }
};
