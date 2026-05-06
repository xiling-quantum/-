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
const dataDir = path.join(projectRoot, "data");
const latestPath = path.join(dataDir, "latest.json");
const latestBrowserPath = path.join(dataDir, "browser-latest.json");
const latestBrowserHitPath = path.join(dataDir, "browser-latest-hit.json");
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
  await fs.writeFile(latestPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return {
    ...run,
    outputFile
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

async function readLatestBrowserRun() {
  try {
    const latestHit = JSON.parse(await fs.readFile(latestBrowserHitPath, "utf8"));
    return {
      file: path.basename(latestBrowserHitPath),
      path: latestBrowserHitPath,
      latestRun: JSON.parse(await fs.readFile(latestBrowserPath, "utf8")).generatedAt,
      ...(latestHit)
    };
  } catch {
    // Fall through to latest run.
  }
  try {
    return {
      file: path.basename(latestBrowserPath),
      path: latestBrowserPath,
      ...(JSON.parse(await fs.readFile(latestBrowserPath, "utf8")))
    };
  } catch {
    // Fall through to historical monitor files.
  }
  const [latest] = await listBrowserRuns();
  if (!latest) {
    return {
      generatedAt: null,
      username: null,
      totalPosts: 0,
      posts: []
    };
  }
  return {
    file: latest.file,
    path: latest.path,
    ...(JSON.parse(await fs.readFile(latest.path, "utf8")))
  };
}

async function collectWithBrowser(requestBody) {
  const usernames = uniqueUsernames(requestBody?.usernames?.length ? requestBody.usernames : requestBody?.username);
  if (!usernames.length) usernames.push("heyibinance");
  const maxPosts = boundedNumber(requestBody?.maxPosts, 20, 1, 100);
  const maxScrolls = boundedNumber(requestBody?.maxScrolls, 10, 1, 50);
  const headless = requestBody?.headless !== false;
  const query = String(requestBody?.query ?? "").trim();
  const start = optionalDateInput(requestBody?.start, "开始");
  const end = optionalDateInput(requestBody?.end, "结束");
  const memeOnly = Boolean(requestBody?.memeOnly);
  const memeMinScore = boundedNumber(requestBody?.memeMinScore, 2, 1, 8);
  const analysisOnly = Boolean(requestBody?.analysisOnly);
  const analysisMinScore = boundedNumber(requestBody?.analysisMinScore, 3, 1, 10);
  const todayOnly = Boolean(requestBody?.todayOnly);
  const articleTimeoutMs = boundedNumber(requestBody?.articleTimeoutMs, 20_000, 5_000, 60_000);
  const retries = boundedNumber(requestBody?.retries, 1, 0, 3);
  const aiClassify = Boolean(requestBody?.aiClassify);
  const aiMode = requestBody?.aiMode === "meme" ? "meme" : "analysis";
  const aiMinConfidence = Math.max(0, Math.min(1, Number(requestBody?.aiMinConfidence ?? 0.65)));
  const scriptPath = path.join(projectRoot, "src", "browser-scrape.js");

  async function runOne(username) {
    const args = [
      scriptPath,
      "--user",
      username,
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
      "--aiClassify",
      String(aiClassify),
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
            username,
            payload,
            outputFile: jsonPath || null,
            csvFile: csvPath || null,
            stdout,
            stderr
          });
        } catch (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          error.username = username;
          reject(error);
        }
      });
    });
  }

  const runs = [];
  const errors = [];
  for (const username of usernames) {
    try {
      runs.push(await runOne(username));
    } catch (error) {
      errors.push({
        username,
        message: error.message,
        stdout: error.stdout || "",
        stderr: error.stderr || ""
      });
    }
  }

  const posts = runs
    .flatMap((run) => run.payload?.posts ?? [])
    .sort((left, right) => String(right.publishedAt || "").localeCompare(String(left.publishedAt || "")));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = path.join(dataDir, `browser-monitor-${timestamp}.json`);
  const csvFile = path.join(dataDir, `browser-monitor-${timestamp}.csv`);
  const payload = {
    username: usernames.length === 1 ? usernames[0] : "monitor",
    usernames,
    filters: { query, memeOnly, memeMinScore, analysisOnly, analysisMinScore, todayOnly, articleTimeoutMs, retries, aiClassify, aiMode, aiMinConfidence, start: start || null, end: end || null },
    generatedAt: new Date().toISOString(),
    totalPosts: posts.length,
    totalScanned: runs.reduce((sum, run) => sum + Number(run.payload?.totalScanned || 0), 0),
    accounts: runs.map((run) => ({
      username: run.username,
      totalPosts: run.payload?.totalPosts || 0,
      totalScanned: run.payload?.totalScanned || 0
    })),
    errors,
    posts
  };
  await fs.writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(latestBrowserPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (posts.length > 0) {
    await fs.writeFile(latestBrowserHitPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  const csvRows = [
    ["id", "url", "authorHandle", "publishedAt", "text", "imageUrls", "videoPosters", "scrapedAt"].map(csvCell).join(","),
    ...posts.map((post) =>
      [
        post.id,
        post.url,
        post.authorHandle,
        post.publishedAt,
        post.text,
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
    stdout: runs.map((run) => run.stdout).join("\n"),
    stderr: [...runs.map((run) => run.stderr), ...errors.map((error) => error.stderr)].filter(Boolean).join("\n")
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
          : { memeOnly: true, memeMinScore: 2, analysisOnly: false, analysisMinScore: 3, todayOnly: false }
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

    if (request.method === "GET" && url.pathname === "/api/latest") {
      try {
        const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
        jsonResponse(response, 200, latest);
      } catch {
        jsonResponse(response, 200, {
          generatedAt: null,
          totalPosts: 0,
          bloggers: [],
          errors: [],
          posts: []
        });
      }
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
