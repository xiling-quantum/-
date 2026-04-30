import { createStandardRecord } from "../core/scrape-helpers.js";

const X_API_BASE = "https://api.x.com/2";
const USER_FIELDS = [
  "id",
  "name",
  "username",
  "description",
  "public_metrics",
  "profile_image_url",
  "verified"
];
const TWEET_FIELDS = [
  "id",
  "text",
  "created_at",
  "public_metrics",
  "entities",
  "attachments",
  "author_id",
  "conversation_id",
  "lang",
  "referenced_tweets",
  "possibly_sensitive"
];
const MEDIA_FIELDS = [
  "media_key",
  "type",
  "url",
  "preview_image_url",
  "width",
  "height"
];
const FALLBACK_MEME_KEYWORDS = [
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
];

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function truncateText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getBearerToken(platformConfig) {
  const envName = platformConfig.bearerTokenEnv || "X_BEARER_TOKEN";
  const token = process.env[envName];
  if (!token) {
    throw new Error(
      `Missing X API bearer token. Set ${envName} before running the x collector.`
    );
  }
  return token;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function xApiGet(path, params, platformConfig) {
  const url = new URL(`${X_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getBearerToken(platformConfig)}`,
      "User-Agent": "social-hotlist-scraper/0.1"
    }
  });
  const bodyText = await response.text();
  const body = bodyText ? safeJsonParse(bodyText) : null;

  if (!response.ok) {
    const detail =
      body?.detail ||
      body?.title ||
      body?.errors?.map((item) => item.detail || item.message).join("; ") ||
      bodyText ||
      response.statusText;
    const retryAfter = response.headers.get("retry-after");
    const retryText = retryAfter ? ` Retry after ${retryAfter}s.` : "";
    throw new Error(`X API request failed (${response.status}): ${detail}.${retryText}`);
  }

  return body;
}

export function normalizeXUsername(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  let candidate = raw;
  try {
    const parsed = new URL(raw);
    if (/^(?:www\.)?(?:x|twitter)\.com$/i.test(parsed.hostname)) {
      candidate = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    }
  } catch {
    candidate = raw;
  }

  return candidate
    .replace(/^@+/, "")
    .split(/[/?#]/)[0]
    .trim();
}

function validateUsername(username) {
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(username)) {
    throw new Error(`Invalid X username: ${username}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordMatches(text, keyword) {
  const normalizedText = String(text ?? "").toLowerCase();
  const normalizedKeyword = String(keyword ?? "").trim().toLowerCase();
  if (!normalizedKeyword) {
    return false;
  }

  if (/[\s$.:/_-]|[^\x00-\x7F]/.test(normalizedKeyword)) {
    return normalizedText.includes(normalizedKeyword);
  }

  const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(normalizedKeyword)}(?=$|[^a-z0-9_])`, "i");
  return pattern.test(normalizedText);
}

export function findMemeKeywordMatches(text, keywords) {
  return unique(
    keywords
      .map((keyword) => String(keyword ?? "").trim())
      .filter((keyword) => keywordMatches(text, keyword))
  );
}

function normalizeKeywordList(target, platformConfig) {
  return unique([
    ...asArray(platformConfig.memeKeywords ?? FALLBACK_MEME_KEYWORDS),
    ...asArray(target.keywords)
  ]);
}

function getTweetHashtags(tweet) {
  return (tweet.entities?.hashtags ?? [])
    .map((item) => String(item.tag ?? "").trim())
    .filter(Boolean);
}

function getTweetCashtags(tweet) {
  return (tweet.entities?.cashtags ?? [])
    .map((item) => String(item.tag ?? "").trim().toUpperCase())
    .filter(Boolean);
}

function getTweetUrls(tweet) {
  return (tweet.entities?.urls ?? [])
    .flatMap((item) => [item.expanded_url, item.display_url, item.unwound_url])
    .filter(Boolean);
}

function buildSignalText(tweet) {
  const hashtags = getTweetHashtags(tweet).map((item) => `#${item}`);
  const cashtags = getTweetCashtags(tweet).map((item) => `$${item}`);
  return [
    tweet.text,
    ...hashtags,
    ...cashtags,
    ...getTweetUrls(tweet)
  ]
    .filter(Boolean)
    .join(" ");
}

function buildMediaMap(includes) {
  const pairs = (includes?.media ?? []).map((media) => [media.media_key, media]);
  return new Map(pairs);
}

function pickCoverImage(tweet, mediaMap) {
  const mediaKey = tweet.attachments?.media_keys?.[0];
  if (!mediaKey) {
    return null;
  }
  const media = mediaMap.get(mediaKey);
  return media?.url ?? media?.preview_image_url ?? null;
}

function buildPostUrl(user, tweet) {
  return `https://x.com/${user.username}/status/${tweet.id}`;
}

function buildMemeHint(matchedKeywords, tweet) {
  const cashtags = getTweetCashtags(tweet).map((item) => `$${item}`);
  const featured = unique([
    ...cashtags.filter((tag) =>
      matchedKeywords.some((keyword) => keyword.toLowerCase() === tag.toLowerCase())
    ),
    ...cashtags
  ]).slice(0, 4);

  if (featured.length) {
    return `Meme Coin: ${featured.join(", ")}`;
  }

  const labels = matchedKeywords.slice(0, 3);
  return labels.length ? `Meme Coin Topic: ${labels.join(", ")}` : "Meme Coin Topic";
}

function buildEnglishSummary(user, tweet, matchedKeywords) {
  const matchedText = matchedKeywords.slice(0, 6).join(", ");
  const prefix = `Meme-coin-related post from @${user.username}`;
  const suffix = matchedText ? ` Keywords matched: ${matchedText}.` : "";
  return truncateText(`${prefix}.${suffix} ${tweet.text}`, 240);
}

export function mapTweetToXRecord(discoveredEntry, target) {
  const { tweet, user, mediaMap, matchedKeywords } = discoveredEntry;
  const metrics = tweet.public_metrics ?? {};
  const shareCount = Number(metrics.retweet_count ?? 0) + Number(metrics.quote_count ?? 0);
  const hashtags = unique([
    ...getTweetHashtags(tweet).map((item) => item.toLowerCase()),
    ...getTweetCashtags(tweet).map((item) => `$${item}`)
  ]);

  return createStandardRecord("x", target, {
    postId: tweet.id,
    postUrl: buildPostUrl(user, tweet),
    title: truncateText(tweet.text, 100),
    coverImageUrl: pickCoverImage(tweet, mediaMap),
    authorHandle: `@${user.username}`,
    authorName: user.name,
    productHint: buildMemeHint(matchedKeywords, tweet),
    englishSummary: buildEnglishSummary(user, tweet, matchedKeywords),
    shoppingSignalScore: Math.min(10, 5 + matchedKeywords.length),
    isLikelyProductPost: true,
    caption: tweet.text,
    hashtags,
    publishedAt: tweet.created_at,
    likeCount: metrics.like_count ?? null,
    commentCount: metrics.reply_count ?? null,
    shareCount,
    viewCount: metrics.impression_count ?? null,
    rawMeta: {
      matchedKeywords,
      user,
      tweet,
      media: [...mediaMap.values()]
    }
  });
}

async function resolveUser(username, platformConfig) {
  const body = await xApiGet(
    `/users/by/username/${encodeURIComponent(username)}`,
    {
      "user.fields": USER_FIELDS.join(",")
    },
    platformConfig
  );

  if (!body?.data?.id) {
    throw new Error(`X user not found: ${username}`);
  }

  return body.data;
}

function buildStartTime(platformConfig) {
  const lookbackDays = normalizePositiveInt(platformConfig.lookbackDays, 30);
  if (!lookbackDays) {
    return null;
  }
  return new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
}

function normalizeExclude(platformConfig) {
  const exclude = asArray(platformConfig.exclude);
  return exclude.length ? exclude.join(",") : null;
}

async function fetchTimelinePage(userId, params, platformConfig) {
  return xApiGet(
    `/users/${encodeURIComponent(userId)}/tweets`,
    {
      "tweet.fields": TWEET_FIELDS.join(","),
      expansions: "attachments.media_keys",
      "media.fields": MEDIA_FIELDS.join(","),
      ...params
    },
    platformConfig
  );
}

async function discoverMemeTweets(user, target, limit, platformConfig, logger) {
  const keywords = normalizeKeywordList(target, platformConfig);
  const scanLimit = normalizePositiveInt(
    target.scanLimit,
    normalizePositiveInt(platformConfig.scanLimitPerTarget, Math.max(limit * 5, 20))
  );
  const pageSize = Math.min(100, Math.max(5, normalizePositiveInt(platformConfig.pageSize, 100)));
  const startTime = buildStartTime(platformConfig);
  const exclude = normalizeExclude(platformConfig);
  const results = [];
  let scanned = 0;
  let paginationToken = null;

  do {
    const body = await fetchTimelinePage(
      user.id,
      {
        max_results: Math.min(pageSize, 100),
        start_time: startTime,
        exclude,
        pagination_token: paginationToken
      },
      platformConfig
    );
    const mediaMap = buildMediaMap(body?.includes);
    const tweets = body?.data ?? [];

    for (const tweet of tweets) {
      scanned += 1;
      const signalText = buildSignalText(tweet);
      const matchedKeywords = findMemeKeywordMatches(signalText, keywords);
      if (matchedKeywords.length) {
        results.push({
          postUrl: buildPostUrl(user, tweet),
          tweet,
          user,
          mediaMap,
          matchedKeywords
        });
      }

      if (results.length >= limit || scanned >= scanLimit) {
        break;
      }
    }

    paginationToken = body?.meta?.next_token ?? null;
    logger?.info("Scanned X timeline page", {
      username: user.username,
      scanned,
      matched: results.length,
      hasNextPage: Boolean(paginationToken)
    });
  } while (results.length < limit && scanned < scanLimit && paginationToken);

  return results.slice(0, limit);
}

export const xCollector = {
  platform: "x",
  requiresBrowser: false,
  async discoverPostUrls(_page, target, limit, { platformConfig, logger }) {
    const username = normalizeXUsername(target.value);
    validateUsername(username);
    const user = await resolveUser(username, platformConfig);
    return discoverMemeTweets(user, target, limit, platformConfig, logger);
  },
  async scrapePost(_page, discoveredEntry, target) {
    return mapTweetToXRecord(discoveredEntry, target);
  }
};
