import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "public");
const configPath = path.join(projectRoot, "config", "bloggers.json");
const watchersPath = path.join(projectRoot, "config", "watchers.json");
const uiSettingsPath = path.join(projectRoot, "config", "ui-settings.json");
const dataDir = path.join(projectRoot, "data");
const defaultPort = Number(process.env.PORT || 48931);
const appMode = process.env.APP_MODE === "analysis" ? "analysis" : "meme";
const X_API_BASE = "https://api.x.com/2";

const USER_FIELDS = ["id", "name", "username", "description", "public_metrics", "profile_image_url", "verified"];
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
const MEDIA_FIELDS = ["media_key", "type", "url", "preview_image_url", "width", "height"];

let activeRun = null;
let lastRun = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  outputFile: null,
  totalPosts: 0,
  error: null
};

let activeBrowserRun = null;
let lastBrowserRun = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  outputFile: null,
  csvFile: null,
  totalPosts: 0,
  error: null,
  stdout: "",
  stderr: ""
};
let activeTelegramRun = null;
let lastTelegramRun = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  outputFile: null,
  csvFile: null,
  totalPosts: 0,
  error: null,
  stdout: "",
  stderr: ""
};
let monitorTimer = null;
let monitorConfig = null;
let monitorState = {
  enabled: false,
  intervalSeconds: 180,
  nextRunAt: null,
  lastRunAt: null,
  runCount: 0
};

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function textResponse(response, statusCode, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(text);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  return "application/octet-stream";
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

async function readConfig() {
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

const defaultWatchers = [
  { name: "Yi He", handle: "heyibinance", note: "Binance", selected: true },
  { name: "CZ", handle: "cz_binance", note: "Binance", selected: true },
  { name: "MustStopMurad", handle: "MustStopMurad", note: "Meme KOL", selected: true },
  { name: "Degenerate News", handle: "DegenerateNews", note: "Crypto news", selected: true },
  { name: "Lookonchain", handle: "lookonchain", note: "On-chain", selected: true },
  { name: "币安Binance华语", handle: "binancezh", note: "中文", selected: true }
];

function normalizeWatcher(item) {
  const handle = normalizeUsername(item?.handle);
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(handle)) return null;
  return {
    name: String(item?.name || handle).trim().slice(0, 80),
    handle,
    note: String(item?.note || "").trim().slice(0, 120),
    selected: item?.selected !== false
  };
}

async function readWatchers() {
  try {
    const saved = JSON.parse(await fs.readFile(watchersPath, "utf8"));
    const watchers = (Array.isArray(saved) ? saved : saved.watchers)
      .map(normalizeWatcher)
      .filter(Boolean);
    if (watchers.length) return watchers;
  } catch {
    // Fall through to defaults.
  }
  return defaultWatchers.map((item) => ({ ...item }));
}

async function writeWatchers(watchers) {
  const normalized = watchers.map(normalizeWatcher).filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const watcher of normalized) {
    const key = watcher.handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(watcher);
  }
  await fs.mkdir(path.dirname(watchersPath), { recursive: true });
  await fs.writeFile(watchersPath, `${JSON.stringify({ watchers: unique }, null, 2)}\n`, "utf8");
  return unique;
}

const defaultUiSettings = {
  maxPosts: 20,
  maxScrolls: 8,
  concurrency: 3,
  memeMinScore: 2,
  aiMinConfidence: 0.65,
  aiProvider: "openai",
  query: "",
  intervalSeconds: 180,
  soundEnabled: true,
  memeOnly: true,
  onlyNewPosts: false,
  aiClassify: false,
  headless: true,
  accountSelect: "__selected__"
};

function normalizeUiSettings(value = {}) {
  return {
    maxPosts: boundedNumber(value.maxPosts, defaultUiSettings.maxPosts, 1, 100),
    maxScrolls: boundedNumber(value.maxScrolls, defaultUiSettings.maxScrolls, 1, 50),
    concurrency: boundedNumber(value.concurrency, defaultUiSettings.concurrency, 1, 5),
    memeMinScore: boundedNumber(value.memeMinScore, defaultUiSettings.memeMinScore, 1, 8),
    aiMinConfidence: Math.max(0, Math.min(1, Number(value.aiMinConfidence ?? defaultUiSettings.aiMinConfidence))),
    aiProvider: ["openai", "deepseek", "kimi"].includes(value.aiProvider) ? value.aiProvider : defaultUiSettings.aiProvider,
    query: String(value.query ?? defaultUiSettings.query).slice(0, 200),
    intervalSeconds: boundedNumber(value.intervalSeconds, defaultUiSettings.intervalSeconds, 30, 3600),
    soundEnabled: value.soundEnabled !== false,
    memeOnly: value.memeOnly !== false,
    onlyNewPosts: Boolean(value.onlyNewPosts),
    aiClassify: Boolean(value.aiClassify),
    headless: value.headless !== false,
    accountSelect: String(value.accountSelect || defaultUiSettings.accountSelect).slice(0, 80)
  };
}

async function readUiSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(uiSettingsPath, "utf8"));
    return normalizeUiSettings({ ...defaultUiSettings, ...saved });
  } catch {
    return { ...defaultUiSettings };
  }
}

async function writeUiSettings(settings) {
  const normalized = normalizeUiSettings({ ...defaultUiSettings, ...settings });
  await fs.mkdir(path.dirname(uiSettingsPath), { recursive: true });
  await fs.writeFile(uiSettingsPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function normalizeUsername(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let candidate = raw;
  try {
    const parsed = new URL(raw);
    if (/^(?:www\.)?(?:x|twitter)\.com$/i.test(parsed.hostname)) {
      candidate = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    }
  } catch {
    candidate = raw;
  }
  return candidate.replace(/^@+/, "").split(/[/?#]/)[0].trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordMatches(text, keyword) {
  const haystack = String(text ?? "").toLowerCase();
  const needle = String(keyword ?? "").trim().toLowerCase();
  if (!needle) return false;
  if (/[\s$.:/_-]|[^\x00-\x7F]/.test(needle)) {
    return haystack.includes(needle);
  }
  return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(needle)}(?=$|[^a-z0-9_])`, "i").test(haystack);
}

function matchedKeywords(text, keywords) {
  return unique(keywords.map((keyword) => String(keyword ?? "").trim()).filter((keyword) => keywordMatches(text, keyword)));
}

function getHashtags(tweet) {
  return (tweet.entities?.hashtags ?? []).map((item) => String(item.tag ?? "").trim()).filter(Boolean);
}

function getCashtags(tweet) {
  return (tweet.entities?.cashtags ?? []).map((item) => String(item.tag ?? "").trim().toUpperCase()).filter(Boolean);
}

function getUrls(tweet) {
  return (tweet.entities?.urls ?? []).flatMap((item) => [item.expanded_url, item.display_url, item.unwound_url]).filter(Boolean);
}

function signalText(tweet) {
  return [
    tweet.text,
    ...getHashtags(tweet).map((item) => `#${item}`),
    ...getCashtags(tweet).map((item) => `$${item}`),
    ...getUrls(tweet)
  ].filter(Boolean).join(" ");
}

function mediaMap(includes) {
  return new Map((includes?.media ?? []).map((media) => [media.media_key, media]));
}

function coverImage(tweet, mediaByKey) {
  const key = tweet.attachments?.media_keys?.[0];
  const media = key ? mediaByKey.get(key) : null;
  return media?.url ?? media?.preview_image_url ?? null;
}

function hotScore(tweet) {
  const metrics = tweet.public_metrics ?? {};
  const likes = Number(metrics.like_count ?? 0);
  const replies = Number(metrics.reply_count ?? 0);
  const retweets = Number(metrics.retweet_count ?? 0);
  const quotes = Number(metrics.quote_count ?? 0);
  const views = Number(metrics.impression_count ?? 0);
  return Math.round(likes + replies * 8 + (retweets + quotes) * 12 + views * 0.02);
}

function bearerTokenFrom(requestBody) {
  const token = String(requestBody?.bearerToken || process.env.X_BEARER_TOKEN || "").trim();
  if (!token) {
    throw new Error("缺少 X API Bearer Token：请在页面输入 token，或先设置环境变量 X_BEARER_TOKEN。");
  }
  return token;
}

async function xApiGet(apiPath, params, bearerToken) {
  const url = new URL(`${X_API_BASE}${apiPath}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "User-Agent": "x-meme-scraper/0.1"
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = body?.detail || body?.title || body?.errors?.map((item) => item.detail || item.message).join("; ") || text || response.statusText;
    const retryAfter = response.headers.get("retry-after");
    throw new Error(`X API ${response.status}: ${detail}${retryAfter ? `；请 ${retryAfter}s 后重试` : ""}`);
  }
  return body;
}

async function resolveUser(handle, bearerToken) {
  const username = normalizeUsername(handle);
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(username)) {
    throw new Error(`无效 X handle：${handle}`);
  }
  const body = await xApiGet(`/users/by/username/${encodeURIComponent(username)}`, {
    "user.fields": USER_FIELDS.join(",")
  }, bearerToken);
  if (!body?.data?.id) {
    throw new Error(`找不到 X 用户：${username}`);
  }
  return body.data;
}

async function fetchTimelinePage(userId, params, bearerToken) {
  return xApiGet(`/users/${encodeURIComponent(userId)}/tweets`, {
    "tweet.fields": TWEET_FIELDS.join(","),
    expansions: "attachments.media_keys",
    "media.fields": MEDIA_FIELDS.join(","),
    ...params
  }, bearerToken);
}

function toRecord(user, tweet, mediaByKey, keywords) {
  const metrics = tweet.public_metrics ?? {};
  const cashtags = getCashtags(tweet).map((item) => `$${item}`);
  return {
    id: tweet.id,
    platform: "x",
    postUrl: `https://x.com/${user.username}/status/${tweet.id}`,
    authorHandle: `@${user.username}`,
    authorName: user.name,
    text: tweet.text,
    title: tweet.text.replace(/\s+/g, " ").slice(0, 120),
    coverImageUrl: coverImage(tweet, mediaByKey),
    publishedAt: tweet.created_at,
    matchedKeywords: keywords,
    cashtags,
    hashtags: getHashtags(tweet),
    likeCount: metrics.like_count ?? 0,
    replyCount: metrics.reply_count ?? 0,
    repostCount: Number(metrics.retweet_count ?? 0) + Number(metrics.quote_count ?? 0),
    viewCount: metrics.impression_count ?? null,
    hotScore: hotScore(tweet),
    collectedAt: new Date().toISOString()
  };
}

async function collectForBlogger(blogger, config, bearerToken) {
  const user = await resolveUser(blogger.handle, bearerToken);
  const baseKeywords = asArray(config.keywords);
  const bloggerKeywords = asArray(blogger.keywords);
  const keywords = unique([...baseKeywords, ...bloggerKeywords]);
  const limit = Number(blogger.limit || config.maxPostsPerBlogger || 10);
  const scanLimit = Number(blogger.scanLimit || config.scanLimitPerBlogger || 80);
  const startTime = new Date(Date.now() - Number(config.lookbackDays || 30) * 86_400_000).toISOString();
  const exclude = asArray(config.exclude).join(",");
  const records = [];
  let scanned = 0;
  let nextToken = null;

  do {
    const body = await fetchTimelinePage(user.id, {
      max_results: 100,
      start_time: startTime,
      exclude,
      pagination_token: nextToken
    }, bearerToken);
    const mediaByKey = mediaMap(body?.includes);
    const tweets = body?.data ?? [];
    for (const tweet of tweets) {
      scanned += 1;
      const matches = matchedKeywords(signalText(tweet), keywords);
      if (matches.length) {
        records.push(toRecord(user, tweet, mediaByKey, matches));
      }
      if (records.length >= limit || scanned >= scanLimit) break;
    }
    nextToken = body?.meta?.next_token ?? null;
  } while (records.length < limit && scanned < scanLimit && nextToken);

  return {
    handle: user.username,
    name: user.name,
    scanned,
    matched: records.length,
    records
  };
}

async function collect(requestBody) {
  const bearerToken = bearerTokenFrom(requestBody);
  const config = await readConfig();
  const selectedHandles = asArray(requestBody?.handles);
  const bloggers = selectedHandles.length
    ? config.bloggers.filter((blogger) => selectedHandles.includes(normalizeUsername(blogger.handle)))
    : config.bloggers;

  if (!bloggers.length) {
    throw new Error("没有可抓取的博主，请检查 config/bloggers.json。");
  }

  const results = [];
  const errors = [];
  for (const blogger of bloggers) {
    try {
      results.push(await collectForBlogger(blogger, config, bearerToken));
    } catch (error) {
      errors.push({
        handle: blogger.handle,
        message: error.message
      });
    }
  }

  const posts = results.flatMap((result) => result.records).sort((left, right) => right.hotScore - left.hotScore);
  const run = {
    generatedAt: new Date().toISOString(),
    source: "independent-x-meme-scraper",
    bloggers: results.map(({ records, ...rest }) => rest),
    errors,
    totalPosts: posts.length,
    posts
  };

  await fs.mkdir(dataDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = path.join(dataDir, `${runId}.json`);
  await fs.writeFile(outputFile, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return {
    ...run,
    outputFile
  };
}

async function readLatestApiRun() {
  await fs.mkdir(dataDir, { recursive: true });
  const files = await fs.readdir(dataDir);
  const runs = [];
  for (const file of files) {
    if (!/^\d{4}-\d{2}-\d{2}T.+\.json$/.test(file)) continue;
    const filePath = path.join(dataDir, file);
    const stat = await fs.stat(filePath);
    runs.push({ file, path: filePath, modifiedAt: stat.mtime.toISOString() });
  }
  runs.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  const [latest] = runs;
  if (!latest) {
    return {
      generatedAt: null,
      totalPosts: 0,
      bloggers: [],
      errors: [],
      posts: []
    };
  }
  return {
    file: latest.file,
    path: latest.path,
    ...(JSON.parse(await fs.readFile(latest.path, "utf8")))
  };
}

function safeUsername(value) {
  const username = normalizeUsername(value || "heyibinance");
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(username)) {
    throw new Error(`无效 X 用户名：${value}`);
  }
  return username;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

const EXCLUDED_SYMBOLS = new Set([
  "BTC",
  "ETH",
  "BNB",
  "SOL",
  "USDT",
  "USDC",
  "USD",
  "FDUSD",
  "DAI",
  "XRP",
  "ADA",
  "DOGE",
  "TRX",
  "TON",
  "LINK",
  "AVAX",
  "DOT",
  "MATIC",
  "OP",
  "ARB",
  "SUI",
  "APT"
]);

const KNOWN_MEME_ALIASES = [
  { key: "PEPE", pattern: /\bpepe\b/i },
  { key: "SHIB", pattern: /\bshib(?:a)?\b/i },
  { key: "BONK", pattern: /\bbonk\b/i },
  { key: "WIF", pattern: /\bwif\b|\bdogwifhat\b/i },
  { key: "FLOKI", pattern: /\bfloki\b/i },
  { key: "POPCAT", pattern: /\bpopcat\b/i },
  { key: "MOG", pattern: /\bmog\b/i },
  { key: "GIGA", pattern: /\bgiga\b/i },
  { key: "FARTCOIN", pattern: /\bfartcoin\b/i }
];

function normalizeAuthor(value) {
  return String(value || "").replace(/^@/, "").trim().toLowerCase();
}

function extractCoinMentions(post) {
  const text = String(post?.text || "");
  const mentions = new Map();

  for (const match of text.matchAll(/\$([A-Za-z][A-Za-z0-9_]{1,11})\b/g)) {
    const symbol = match[1].toUpperCase();
    if (!EXCLUDED_SYMBOLS.has(symbol)) {
      mentions.set(symbol, { key: symbol, type: "ticker", display: `$${symbol}` });
    }
  }

  for (const alias of KNOWN_MEME_ALIASES) {
    if (!EXCLUDED_SYMBOLS.has(alias.key) && alias.pattern.test(text)) {
      mentions.set(alias.key, { key: alias.key, type: "alias", display: `$${alias.key}` });
    }
  }

  for (const match of text.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)) {
    const address = match[0];
    if (/[A-Z]/.test(address) && /[a-z]/.test(address) && /\d/.test(address)) {
      mentions.set(`CA:${address}`, { key: `CA:${address}`, type: "contract", display: `CA ${address.slice(0, 6)}...${address.slice(-4)}` });
    }
  }

  for (const match of text.matchAll(/\b0x[a-fA-F0-9]{40}\b/g)) {
    const address = match[0];
    mentions.set(`CA:${address.toLowerCase()}`, { key: `CA:${address.toLowerCase()}`, type: "contract", display: `CA ${address.slice(0, 6)}...${address.slice(-4)}` });
  }

  return [...mentions.values()];
}

function applyCrossValidation(posts, minAuthors = 2) {
  const byCoin = new Map();
  for (const post of posts) {
    const author = normalizeAuthor(post.authorHandle);
    if (!author) continue;
    const mentions = extractCoinMentions(post);
    post.coinMentions = mentions;
    for (const mention of mentions) {
      if (!byCoin.has(mention.key)) {
        byCoin.set(mention.key, {
          key: mention.key,
          display: mention.display,
          type: mention.type,
          authors: new Set(),
          postIds: new Set(),
          latestAt: null,
          score: 0
        });
      }
      const item = byCoin.get(mention.key);
      item.authors.add(author);
      item.postIds.add(String(post.id));
      if (!item.latestAt || String(post.publishedAt || "") > item.latestAt) {
        item.latestAt = post.publishedAt || null;
      }
    }
  }

  const consensus = [...byCoin.values()]
    .filter((item) => item.authors.size >= minAuthors)
    .map((item) => ({
      key: item.key,
      display: item.display,
      type: item.type,
      authorCount: item.authors.size,
      postCount: item.postIds.size,
      authors: [...item.authors].map((author) => `@${author}`),
      postIds: [...item.postIds],
      latestAt: item.latestAt,
      score: item.authors.size * 10 + item.postIds.size
    }))
    .sort((left, right) => right.score - left.score || String(right.latestAt || "").localeCompare(String(left.latestAt || "")));

  const consensusByKey = new Map(consensus.map((item) => [item.key, item]));
  for (const post of posts) {
    post.consensusSignals = (post.coinMentions || [])
      .map((mention) => consensusByKey.get(mention.key))
      .filter(Boolean)
      .map((item) => ({
        key: item.key,
        display: item.display,
        type: item.type,
        authorCount: item.authorCount,
        postCount: item.postCount,
        authors: item.authors
      }));
  }

  return consensus;
}

function uniqueUsernames(values) {
  const usernames = asArray(values).map(safeUsername);
  return [...new Set(usernames)].slice(0, 20);
}

function optionalDateInput(value, name) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${name} 时间格式无效`);
  }
  return date.toISOString();
}

async function listBrowserRuns() {
  await fs.mkdir(dataDir, { recursive: true });
  const files = await fs.readdir(dataDir);
  const runs = [];
  for (const file of files) {
    if (!/^browser-monitor-.+\.json$/.test(file)) continue;
    const filePath = path.join(dataDir, file);
    const stat = await fs.stat(filePath);
    runs.push({
      file,
      path: filePath,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    });
  }
  return runs.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

async function loadBrowserRun(run) {
  return {
    file: run.file,
    path: run.path,
    size: run.size || 0,
    ...(JSON.parse(await fs.readFile(run.path, "utf8")))
  };
}

function browserRunGroupKey(run) {
  const time = new Date(run.generatedAt || run.modifiedAt || 0).getTime();
  if (!Number.isFinite(time)) return run.file;
  return String(Math.floor(time / 5000));
}

function preferBrowserRun(left, right) {
  const leftEnriched = Array.isArray(left.consensus) ? 1 : 0;
  const rightEnriched = Array.isArray(right.consensus) ? 1 : 0;
  if (leftEnriched !== rightEnriched) return rightEnriched - leftEnriched;
  return Number(right.size || 0) - Number(left.size || 0);
}

async function listLoadedBrowserRuns() {
  const loaded = [];
  for (const run of await listBrowserRuns()) {
    try {
      loaded.push(await loadBrowserRun(run));
    } catch {
      // Ignore corrupt partial files.
    }
  }
  return loaded;
}

function uniqueBrowserRunAttempts(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = browserRunGroupKey(run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups.values()]
    .map((group) => group.sort(preferBrowserRun)[0])
    .sort((left, right) => String(right.generatedAt || "").localeCompare(String(left.generatedAt || "")));
}

function withNewPostDelta(current, previous) {
  const previousIds = new Set((previous?.posts || []).map((post) => String(post.id || post.url || "")));
  const newPosts = (current.posts || []).filter((post) => !previousIds.has(String(post.id || post.url || "")));
  return {
    ...current,
    allTotalPosts: Number(current.totalPosts || 0),
    newTotalPosts: newPosts.length,
    newPosts,
    previousRun: previous ? {
      file: previous.file,
      generatedAt: previous.generatedAt,
      totalPosts: previous.totalPosts || 0
    } : null
  };
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function postLocalDateKey(post, fallback) {
  return localDateKey(post?.publishedAt || post?.createdAt || fallback);
}

function postUniqueKey(post) {
  return String(post?.id || post?.url || `${post?.authorHandle || ""}:${post?.publishedAt || ""}:${post?.text || ""}`);
}

async function listBrowserRunDates() {
  const attempts = uniqueBrowserRunAttempts(await listLoadedBrowserRuns())
    .filter((run) => Number(run.totalPosts || 0) > 0);
  const byDate = new Map();
  for (const run of attempts) {
    for (const post of run.posts || []) {
      const date = postLocalDateKey(post, run.generatedAt || run.modifiedAt);
      if (!date) continue;
      if (!byDate.has(date)) {
        byDate.set(date, {
          date,
          runCount: 0,
          latestAt: null,
          latestFile: null,
          latestTotalPosts: 0,
          postIds: new Set(),
          runFiles: new Set()
        });
      }
      const item = byDate.get(date);
      item.postIds.add(postUniqueKey(post));
      item.runFiles.add(run.file);
      if (!item.latestAt || String(run.generatedAt || "") > item.latestAt) {
        item.latestAt = run.generatedAt || null;
        item.latestFile = run.file;
      }
    }
  }
  return [...byDate.values()]
    .map((item) => ({
      date: item.date,
      runCount: item.runFiles.size,
      latestAt: item.latestAt,
      latestFile: item.latestFile,
      latestTotalPosts: item.postIds.size
    }))
    .sort((left, right) => right.date.localeCompare(left.date));
}

async function readBrowserRunByDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    throw new Error("日期格式无效，应为 YYYY-MM-DD");
  }
  const attempts = uniqueBrowserRunAttempts(await listLoadedBrowserRuns())
    .filter((run) => Number(run.totalPosts || 0) > 0)
    .sort((left, right) => String(right.generatedAt || "").localeCompare(String(left.generatedAt || "")));

  const postsById = new Map();
  const accountsByName = new Map();
  const errors = [];
  let runCount = 0;
  for (const run of attempts) {
    let hasDatePost = false;
    for (const account of run.accounts || []) {
      accountsByName.set(account.username, account);
    }
    for (const error of run.errors || []) {
      errors.push(error);
    }
    for (const post of run.posts || []) {
      if (postLocalDateKey(post, run.generatedAt || run.modifiedAt) !== date) continue;
      hasDatePost = true;
      const key = postUniqueKey(post);
      if (!key || postsById.has(key)) continue;
      postsById.set(key, post);
    }
    if (hasDatePost) runCount += 1;
  }

  const posts = [...postsById.values()]
    .sort((left, right) => String(right.publishedAt || "").localeCompare(String(left.publishedAt || "")));
  const consensus = applyCrossValidation(posts, 2);
  const latest = attempts.find((run) =>
    (run.posts || []).some((post) => postLocalDateKey(post, run.generatedAt || run.modifiedAt) === date)
  ) || null;
  return {
    source: "browser-history-date",
    date,
    file: latest?.file || null,
    generatedAt: latest?.generatedAt || null,
    runCount,
    totalPosts: posts.length,
    allTotalPosts: posts.length,
    newTotalPosts: posts.length,
    newPosts: posts,
    usernames: latest?.usernames || [],
    filters: latest?.filters || {},
    totalScanned: attempts.reduce((sum, run) => sum + Number(run.totalScanned || 0), 0),
    accounts: [...accountsByName.values()],
    consensus,
    errors,
    posts
  };
}

async function readLatestBrowserRun() {
  const runs = uniqueBrowserRunAttempts(await listLoadedBrowserRuns());
  if (!runs.length) {
    return {
      generatedAt: null,
      username: null,
      latestAttempt: null,
      newTotalPosts: 0,
      newPosts: [],
      totalPosts: 0,
      posts: []
    };
  }

  const latestAttempt = runs[0];
  if (Number(latestAttempt.totalPosts || 0) > 0) {
    const previous = runs.slice(1).find((run) => Number(run.totalPosts || 0) > 0);
    return {
      ...withNewPostDelta(latestAttempt, previous),
      latestAttempt: {
        file: latestAttempt.file,
        generatedAt: latestAttempt.generatedAt,
        totalPosts: latestAttempt.totalPosts,
        errors: latestAttempt.errors || []
      }
    };
  }

  for (const run of runs.slice(1)) {
    const candidate = run;
    if (Number(candidate.totalPosts || 0) > 0) {
      const previous = runs.slice(runs.indexOf(run) + 1).find((item) => Number(item.totalPosts || 0) > 0);
      return {
        ...withNewPostDelta(candidate, previous),
        staleBecauseLatestFailed: true,
        latestAttempt: {
          file: latestAttempt.file,
          generatedAt: latestAttempt.generatedAt,
          totalPosts: latestAttempt.totalPosts || 0,
          errors: latestAttempt.errors || []
        }
      };
    }
  }

  return {
    ...latestAttempt,
    newTotalPosts: 0,
    newPosts: [],
    latestAttempt: {
      file: latestAttempt.file,
      generatedAt: latestAttempt.generatedAt,
      totalPosts: latestAttempt.totalPosts || 0,
      errors: latestAttempt.errors || []
    }
  };
}

async function readLatestTelegramRun() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const files = await fs.readdir(dataDir);
    const runs = [];
    for (const file of files) {
      if (!/^telegram-monitor-.+\.json$/.test(file)) continue;
      const filePath = path.join(dataDir, file);
      const stat = await fs.stat(filePath);
      runs.push({ file, path: filePath, modifiedAt: stat.mtime.toISOString() });
    }
    runs.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    const [latest] = runs;
    if (latest) {
      return {
        file: latest.file,
        path: latest.path,
        ...(JSON.parse(await fs.readFile(latest.path, "utf8")))
      };
    }
  } catch {
    // Fall through to an empty Telegram result.
  }
  return {
    source: "telegram",
    generatedAt: null,
    totalPosts: 0,
    accounts: [],
    errors: [],
    posts: []
  };
}

async function collectWithTelegram(requestBody) {
  const groups = asArray(requestBody?.groups).map((item) => String(item).trim()).filter(Boolean);
  const maxMessages = boundedNumber(requestBody?.maxMessages, 50, 1, 200);
  const query = String(requestBody?.query ?? "").trim();
  const memeOnly = Boolean(requestBody?.memeOnly);
  const memeMinScore = boundedNumber(requestBody?.memeMinScore, 2, 1, 8);
  const scriptPath = path.join(projectRoot, "src", "telegram-scrape.js");
  const args = [
    scriptPath,
    "--max",
    String(maxMessages),
    "--memeOnly",
    String(memeOnly),
    "--memeMinScore",
    String(memeMinScore)
  ];
  if (groups.length) args.push("--groups", groups.join(","));
  if (query) args.push("--query", query);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      try {
        if (code !== 0) {
          throw new Error(stderr.trim() || stdout.trim() || `telegram scraper exited with ${code}`);
        }
        const jsonPath = stdout.match(/JSON:\s*(.+\.json)/)?.[1]?.trim();
        const csvPath = stdout.match(/CSV:\s*(.+\.csv)/)?.[1]?.trim();
        const payload = jsonPath ? JSON.parse(await fs.readFile(jsonPath, "utf8")) : await readLatestTelegramRun();
        resolve({
          ...payload,
          outputFile: jsonPath || null,
          csvFile: csvPath || null,
          stdout,
          stderr
        });
      } catch (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function collectWithBrowser(requestBody) {
  const usernames = uniqueUsernames(requestBody?.usernames?.length ? requestBody.usernames : requestBody?.username);
  if (!usernames.length) usernames.push("heyibinance");
  const maxPosts = boundedNumber(requestBody?.maxPosts, 20, 1, 100);
  const maxScrolls = boundedNumber(requestBody?.maxScrolls, 10, 1, 50);
  const headless = requestBody?.headless !== false;
  const query = String(requestBody?.query ?? "").trim();
  const start = "";
  const end = "";
  const memeOnly = Boolean(requestBody?.memeOnly);
  const memeMinScore = boundedNumber(requestBody?.memeMinScore, 2, 1, 8);
  const analysisOnly = false;
  const analysisMinScore = 3;
  const todayOnly = true;
  const articleTimeoutMs = boundedNumber(requestBody?.articleTimeoutMs, 20_000, 5_000, 60_000);
  const retries = boundedNumber(requestBody?.retries, 1, 0, 3);
  const concurrency = boundedNumber(requestBody?.concurrency, 3, 1, 5);
  const aiClassify = Boolean(requestBody?.aiClassify);
  const aiProvider = ["openai", "deepseek", "kimi"].includes(requestBody?.aiProvider) ? requestBody.aiProvider : "openai";
  const aiMode = requestBody?.aiMode === "meme" ? "meme" : "analysis";
  const aiMinConfidence = Math.max(0, Math.min(1, Number(requestBody?.aiMinConfidence ?? 0.65)));
  const scriptPath = path.join(projectRoot, "src", "browser-scrape.js");

  async function runBrowserBatch() {
    const args = [
      scriptPath,
      "--users",
      usernames.join(","),
      "--max",
      String(maxPosts),
      "--scrolls",
      String(maxScrolls),
      "--headless",
      String(headless),
      "--memeOnly",
      String(memeOnly),
      "--memeMinScore",
      String(memeMinScore),
      "--analysisOnly",
      String(analysisOnly),
      "--analysisMinScore",
      String(analysisMinScore),
      "--todayOnly",
      String(todayOnly),
      "--articleTimeoutMs",
      String(articleTimeoutMs),
      "--retries",
      String(retries),
      "--concurrency",
      String(concurrency),
      "--aiClassify",
      String(aiClassify),
      "--aiProvider",
      aiProvider,
      "--aiMode",
      aiMode,
      "--aiMinConfidence",
      String(aiMinConfidence)
    ];
    if (query) args.push("--query", query);
    if (start) args.push("--start", start);
    if (end) args.push("--end", end);

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: projectRoot,
        windowsHide: headless,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", async (code) => {
        try {
          if (code !== 0) {
            throw new Error(stderr.trim() || stdout.trim() || `browser scraper exited with ${code}`);
          }
          const jsonPath = stdout.match(/JSON:\s*(.+\.json)/)?.[1]?.trim();
          const csvPath = stdout.match(/CSV:\s*(.+\.csv)/)?.[1]?.trim();
          const payload = jsonPath ? JSON.parse(await fs.readFile(jsonPath, "utf8")) : null;
          resolve({
            payload,
            outputFile: jsonPath || null,
            csvFile: csvPath || null,
            stdout,
            stderr
          });
        } catch (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        }
      });
    });
  }

  let batchRun = null;
  let errors = [];
  try {
    batchRun = await runBrowserBatch();
    errors = batchRun.payload?.errors ?? [];
  } catch (error) {
    errors = [{
      username: "monitor",
      message: error.message,
      stdout: error.stdout || "",
      stderr: error.stderr || ""
    }];
  }

  const posts = (batchRun?.payload?.posts ?? [])
    .sort((left, right) => String(right.publishedAt || "").localeCompare(String(left.publishedAt || "")));
  const consensus = applyCrossValidation(posts, 2);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = path.join(dataDir, `browser-monitor-${timestamp}.json`);
  const csvFile = path.join(dataDir, `browser-monitor-${timestamp}.csv`);
  const payload = {
    username: usernames.length === 1 ? usernames[0] : "monitor",
    usernames,
    filters: { query, memeOnly, memeMinScore, analysisOnly, analysisMinScore, todayOnly, articleTimeoutMs, retries, concurrency, aiClassify, aiProvider, aiMode, aiMinConfidence, start: start || null, end: end || null },
    generatedAt: new Date().toISOString(),
    totalPosts: posts.length,
    totalScanned: Number(batchRun?.payload?.totalScanned || 0),
    accounts: batchRun?.payload?.accounts ?? [],
    consensus,
    errors,
    posts
  };
  await fs.writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const csvRows = [
    ["id", "url", "authorHandle", "publishedAt", "text", "contractAddresses", "coinMentions", "consensusSignals", "imageUrls", "videoPosters", "scrapedAt"].map(csvCell).join(","),
    ...posts.map((post) =>
      [
        post.id,
        post.url,
        post.authorHandle,
        post.publishedAt,
        post.text,
        (post.contractAddresses || []).join(" "),
        (post.coinMentions || []).map((item) => item.display).join(" "),
        (post.consensusSignals || []).map((item) => item.display).join(" "),
        (post.imageUrls || []).join(" "),
        (post.videoPosters || []).join(" "),
        post.scrapedAt
      ].map(csvCell).join(",")
    )
  ];
  await fs.writeFile(csvFile, `${csvRows.join("\n")}\n`, "utf8");
  return {
    ...payload,
    outputFile,
    csvFile,
    stdout: batchRun?.stdout || "",
    stderr: [batchRun?.stderr, ...errors.map((error) => error.stderr)].filter(Boolean).join("\n")
  };
}

function monitorSnapshot() {
  return {
    ...monitorState,
    config: monitorConfig
  };
}

function stopMonitor() {
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
  monitorState = {
    ...monitorState,
    enabled: false,
    nextRunAt: null
  };
}

function scheduleMonitor() {
  if (!monitorState.enabled || !monitorConfig) return;
  if (monitorTimer) clearTimeout(monitorTimer);
  const delay = Math.max(10, Number(monitorState.intervalSeconds || 180)) * 1000;
  monitorState.nextRunAt = new Date(Date.now() + delay).toISOString();
  monitorTimer = setTimeout(() => {
    runMonitorOnce();
  }, delay);
}

async function runMonitorOnce() {
  if (!monitorState.enabled || !monitorConfig) return;
  if (activeBrowserRun) {
    scheduleMonitor();
    return;
  }

  lastBrowserRun = {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outputFile: null,
    csvFile: null,
    totalPosts: 0,
    error: null,
    stdout: "",
    stderr: ""
  };
  monitorState.lastRunAt = lastBrowserRun.startedAt;
  activeBrowserRun = collectWithBrowser(monitorConfig);
  activeBrowserRun
    .then((result) => {
      monitorState.runCount += 1;
      lastBrowserRun = {
        status: "completed",
        startedAt: lastBrowserRun.startedAt,
        finishedAt: new Date().toISOString(),
        outputFile: result.outputFile,
        csvFile: result.csvFile,
        totalPosts: result.totalPosts,
        error: result.errors?.length ? `${result.errors.length} 个账号抓取失败` : null,
        stdout: result.stdout,
        stderr: result.stderr
      };
    })
    .catch((error) => {
      lastBrowserRun = {
        status: "failed",
        startedAt: lastBrowserRun.startedAt,
        finishedAt: new Date().toISOString(),
        outputFile: null,
        csvFile: null,
        totalPosts: 0,
        error: error.message,
        stdout: error.stdout || "",
        stderr: error.stderr || ""
      };
    })
    .finally(() => {
      activeBrowserRun = null;
      scheduleMonitor();
    });
}

async function serveStatic(urlPath, response) {
  const requestPath = urlPath === "/" ? "/index.html" : urlPath;
  const targetPath = path.normalize(path.join(publicDir, requestPath));
  if (!targetPath.startsWith(publicDir)) {
    textResponse(response, 403, "Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(targetPath);
    textResponse(response, 200, content, getContentType(targetPath));
  } catch {
    textResponse(response, 404, "Not Found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/app-info") {
      jsonResponse(response, 200, {
        mode: appMode,
        title: appMode === "analysis" ? "推特分析博文监控" : "推特秒级监控",
        defaultPort,
        defaultFilters: appMode === "analysis"
          ? { memeOnly: false, memeMinScore: 2, analysisOnly: true, analysisMinScore: 3, todayOnly: true }
          : { memeOnly: true, memeMinScore: 2, analysisOnly: false, analysisMinScore: 3, todayOnly: true }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      const config = await readConfig();
      jsonResponse(response, 200, {
        ...config,
        hasEnvToken: Boolean(process.env.X_BEARER_TOKEN)
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/watchers") {
      jsonResponse(response, 200, {
        watchers: await readWatchers()
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/ui-settings") {
      jsonResponse(response, 200, await readUiSettings());
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/ui-settings") {
      const requestBody = await readRequestJson(request);
      jsonResponse(response, 200, await writeUiSettings(requestBody));
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/watchers") {
      const requestBody = await readRequestJson(request);
      const watchers = await writeWatchers(asArray(requestBody?.watchers).length ? requestBody.watchers : []);
      jsonResponse(response, 200, { watchers });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/latest") {
      jsonResponse(response, 200, await readLatestApiRun());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      jsonResponse(response, 200, {
        running: Boolean(activeRun),
        ...lastRun
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/browser/status") {
      jsonResponse(response, 200, {
        running: Boolean(activeBrowserRun),
        ...lastBrowserRun
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/telegram/status") {
      jsonResponse(response, 200, {
        running: Boolean(activeTelegramRun),
        ...lastTelegramRun
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/telegram/latest") {
      jsonResponse(response, 200, await readLatestTelegramRun());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/monitor/status") {
      jsonResponse(response, 200, monitorSnapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/monitor/stop") {
      stopMonitor();
      jsonResponse(response, 200, monitorSnapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/monitor/start") {
      const requestBody = await readRequestJson(request);
      monitorConfig = requestBody;
      monitorState = {
        ...monitorState,
        enabled: true,
        intervalSeconds: boundedNumber(requestBody?.intervalSeconds, 180, 30, 3600),
        nextRunAt: null
      };
      if (requestBody?.runImmediately !== false) {
        runMonitorOnce();
      } else {
        scheduleMonitor();
      }
      jsonResponse(response, 202, monitorSnapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/monitor/run-now") {
      if (!monitorConfig) {
        jsonResponse(response, 400, { error: "监控尚未启动，缺少配置" });
        return;
      }
      if (activeBrowserRun) {
        jsonResponse(response, 409, { error: "已有抓取任务在运行" });
        return;
      }
      runMonitorOnce();
      jsonResponse(response, 202, monitorSnapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/browser/latest") {
      jsonResponse(response, 200, await readLatestBrowserRun());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/browser/dates") {
      jsonResponse(response, 200, { dates: await listBrowserRunDates() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/browser/by-date") {
      jsonResponse(response, 200, await readBrowserRunByDate(url.searchParams.get("date")));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/browser/runs") {
      jsonResponse(response, 200, {
        runs: await listBrowserRuns()
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/browser/collect") {
      if (activeBrowserRun) {
        jsonResponse(response, 409, {
          running: true,
          message: "已有浏览器抓取任务在运行"
        });
        return;
      }

      const requestBody = await readRequestJson(request);
      lastBrowserRun = {
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outputFile: null,
        csvFile: null,
        totalPosts: 0,
        error: null,
        stdout: "",
        stderr: ""
      };
      activeBrowserRun = collectWithBrowser(requestBody);
      activeBrowserRun
        .then((result) => {
          lastBrowserRun = {
            status: "completed",
            startedAt: lastBrowserRun.startedAt,
            finishedAt: new Date().toISOString(),
            outputFile: result.outputFile,
            csvFile: result.csvFile,
            totalPosts: result.totalPosts,
            error: null,
            stdout: result.stdout,
            stderr: result.stderr
          };
        })
        .catch((error) => {
          lastBrowserRun = {
            status: "failed",
            startedAt: lastBrowserRun.startedAt,
            finishedAt: new Date().toISOString(),
            outputFile: null,
            csvFile: null,
            totalPosts: 0,
            error: error.message,
            stdout: error.stdout || "",
            stderr: error.stderr || ""
          };
        })
        .finally(() => {
          activeBrowserRun = null;
        });

      jsonResponse(response, 202, {
        accepted: true,
        running: true,
        ...lastBrowserRun
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/telegram/collect") {
      if (activeTelegramRun) {
        jsonResponse(response, 409, {
          running: true,
          message: "Telegram scrape is already running"
        });
        return;
      }

      const requestBody = await readRequestJson(request);
      lastTelegramRun = {
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outputFile: null,
        csvFile: null,
        totalPosts: 0,
        error: null,
        stdout: "",
        stderr: ""
      };
      activeTelegramRun = collectWithTelegram(requestBody);
      activeTelegramRun
        .then((result) => {
          lastTelegramRun = {
            status: "completed",
            startedAt: lastTelegramRun.startedAt,
            finishedAt: new Date().toISOString(),
            outputFile: result.outputFile,
            csvFile: result.csvFile,
            totalPosts: result.totalPosts,
            error: result.errors?.length ? `${result.errors.length} Telegram targets failed` : null,
            stdout: result.stdout,
            stderr: result.stderr
          };
        })
        .catch((error) => {
          lastTelegramRun = {
            status: "failed",
            startedAt: lastTelegramRun.startedAt,
            finishedAt: new Date().toISOString(),
            outputFile: null,
            csvFile: null,
            totalPosts: 0,
            error: error.message,
            stdout: error.stdout || "",
            stderr: error.stderr || ""
          };
        })
        .finally(() => {
          activeTelegramRun = null;
        });

      jsonResponse(response, 202, {
        accepted: true,
        running: true,
        ...lastTelegramRun
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/collect") {
      if (activeRun) {
        jsonResponse(response, 409, {
          running: true,
          message: "已有抓取任务在运行"
        });
        return;
      }

      const requestBody = await readRequestJson(request);
      lastRun = {
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outputFile: null,
        totalPosts: 0,
        error: null
      };
      activeRun = collect(requestBody);
      activeRun
        .then((result) => {
          lastRun = {
            status: "completed",
            startedAt: lastRun.startedAt,
            finishedAt: new Date().toISOString(),
            outputFile: result.outputFile,
            totalPosts: result.totalPosts,
            error: result.errors?.length ? `${result.errors.length} 个博主抓取失败` : null
          };
        })
        .catch((error) => {
          lastRun = {
            status: "failed",
            startedAt: lastRun.startedAt,
            finishedAt: new Date().toISOString(),
            outputFile: null,
            totalPosts: 0,
            error: error.message
          };
        })
        .finally(() => {
          activeRun = null;
        });

      jsonResponse(response, 202, {
        accepted: true,
        running: true,
        ...lastRun
      });
      return;
    }

    if (request.method === "GET") {
      await serveStatic(url.pathname, response);
      return;
    }

    textResponse(response, 405, "Method Not Allowed");
  } catch (error) {
    jsonResponse(response, 500, {
      error: error.message
    });
  }
});

server.listen(defaultPort, "127.0.0.1", () => {
  console.log(`independent X ${appMode} dashboard: http://127.0.0.1:${defaultPort}`);
  console.log(`project root: ${projectRoot}`);
});
