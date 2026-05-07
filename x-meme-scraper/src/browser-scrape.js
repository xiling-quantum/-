import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");
const sessionDir = path.join(dataDir, "x-session");

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function normalizeUsername(value) {
  return String(value ?? "")
    .trim()
    .replace(/^@+/, "")
    .replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "")
    .split(/[/?#]/)[0];
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function parseDateArg(name) {
  const value = String(argValue(name, "") ?? "").trim();
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --${name} date: ${value}`);
  }
  return date;
}

function argList(name, fallback = []) {
  const raw = String(argValue(name, "") ?? "").trim();
  if (!raw) return fallback;
  return raw.split(",").map((item) => normalizeUsername(item)).filter(Boolean);
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function startOfLocalDay() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function textMatches(text, query) {
  const trimmed = String(query ?? "").trim().toLowerCase();
  if (!trimmed) return true;
  return String(text ?? "").toLowerCase().includes(trimmed);
}

const MEME_SIGNALS = [
  { pattern: /\bmeme\s*coin\b/i, weight: 3, reason: "meme coin" },
  { pattern: /\bmemecoin\b/i, weight: 3, reason: "memecoin" },
  { pattern: /\bmeme\b/i, weight: 2, reason: "meme" },
  { pattern: /\bdegen\b/i, weight: 2, reason: "degen" },
  { pattern: /\bpump\.?fun\b/i, weight: 3, reason: "pump.fun" },
  { pattern: /\b100x\b/i, weight: 2, reason: "100x" },
  { pattern: /\bca[:：\s]/i, weight: 2, reason: "CA" },
  { pattern: /\bcontract\s*address\b/i, weight: 2, reason: "contract address" },
  { pattern: /\bfair\s*launch\b/i, weight: 2, reason: "fair launch" },
  { pattern: /\$[A-Z][A-Z0-9_]{1,11}\b/, weight: 1, reason: "cashtag" },
  { pattern: /\b(pepe|doge|shib|bonk|wif|floki|popcat|mog|giga)\b/i, weight: 2, reason: "known meme ticker" },
  { pattern: /土狗|迷因|meme币|合约地址|冲土狗|发射/i, weight: 2, reason: "中文 meme 信号" }
];

function extractContractAddresses(text) {
  const value = String(text ?? "");
  const addresses = new Set();
  for (const match of value.matchAll(/\b0x[a-fA-F0-9]{40}\b/g)) {
    addresses.add(match[0]);
  }
  for (const match of value.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)) {
    const address = match[0];
    if (/[A-Z]/.test(address) && /[a-z]/.test(address) && /\d/.test(address)) {
      addresses.add(address);
    }
  }
  return [...addresses];
}

function memeAnalysis(post) {
  const text = String(post.text ?? "");
  const reasons = [];
  let score = 0;
  for (const signal of MEME_SIGNALS) {
    if (signal.pattern.test(text)) {
      score += signal.weight;
      reasons.push(signal.reason);
    }
  }
  if (post.imageUrls?.length && /\$[A-Z][A-Z0-9_]{1,11}\b/.test(text)) {
    score += 1;
    reasons.push("media + cashtag");
  }
  const contractAddresses = extractContractAddresses(text);
  if (contractAddresses.length) {
    score += 4;
    reasons.push("contract address");
  }
  return { score, reasons: [...new Set(reasons)], contractAddresses };
}

function isMemeCoinPost(post, minScore) {
  const analysis = memeAnalysis(post);
  post.memeScore = analysis.score;
  post.memeReasons = analysis.reasons;
  post.contractAddresses = analysis.contractAddresses;
  return analysis.score >= minScore;
}

const ANALYSIS_SIGNALS = [
  { pattern: /\b(thread|deep\s*dive|research|analysis|thesis|framework|breakdown)\b/i, weight: 3, reason: "英文分析词" },
  { pattern: /\b(on-?chain|metrics?|data|chart|dashboard|volume|liquidity|holder|holders)\b/i, weight: 2, reason: "数据/链上" },
  { pattern: /\b(because|therefore|however|risk|catalyst|narrative|market\s*structure)\b/i, weight: 2, reason: "推理结构" },
  { pattern: /\b(alpha|strategy|watchlist|rotation|cycle|trend|setup)\b/i, weight: 1, reason: "交易/周期观点" },
  { pattern: /(^|\n)\s*(1\.|2\.|3\.|①|②|③|一、|二、|三、)/, weight: 2, reason: "分点长文" },
  { pattern: /分析|研报|研究|复盘|解读|观点|逻辑|原因|趋势|数据|图表|链上|持仓|流动性|交易量|市值|筹码|风险|催化剂|叙事/, weight: 2, reason: "中文分析词" }
];

function analysisPostScore(post) {
  const text = String(post.text ?? "");
  const reasons = [];
  let score = 0;
  for (const signal of ANALYSIS_SIGNALS) {
    if (signal.pattern.test(text)) {
      score += signal.weight;
      reasons.push(signal.reason);
    }
  }
  const textLength = [...text].length;
  if (textLength >= 180) {
    score += 2;
    reasons.push("长文本");
  } else if (textLength >= 100) {
    score += 1;
    reasons.push("中长文本");
  }
  if ((post.imageUrls?.length || 0) > 0 && /(chart|data|图|表|数据|链上|volume|liquidity|holder)/i.test(text)) {
    score += 1;
    reasons.push("配图+数据词");
  }
  return { score, reasons: [...new Set(reasons)] };
}

function isAnalysisPost(post, minScore) {
  const analysis = analysisPostScore(post);
  post.analysisScore = analysis.score;
  post.analysisReasons = analysis.reasons;
  return analysis.score >= minScore;
}

function annotateScores(post) {
  const meme = memeAnalysis(post);
  post.memeScore = meme.score;
  post.memeReasons = meme.reasons;
  post.contractAddresses = meme.contractAddresses;
  const analysis = analysisPostScore(post);
  post.analysisScore = analysis.score;
  post.analysisReasons = analysis.reasons;
  return post;
}

function aiCandidate(post, mode) {
  annotateScores(post);
  const textLength = [...String(post.text ?? "")].length;
  if (mode === "meme") {
    return post.memeScore >= 1 || /\$[A-Z][A-Z0-9_]{1,11}\b/.test(post.text || "");
  }
  return post.analysisScore >= 1 || textLength >= 80;
}

function responseOutputText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  return (body?.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? "")
    .join("");
}

function aiProviderConfig(provider) {
  if (provider === "deepseek") {
    return {
      provider,
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      type: "chat"
    };
  }
  if (provider === "kimi") {
    return {
      provider,
      apiKey: process.env.KIMI_API_KEY,
      model: process.env.KIMI_MODEL || "moonshot-v1-8k",
      baseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1",
      type: "chat"
    };
  }
  return {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-5.2",
    baseUrl: "https://api.openai.com/v1",
    type: "responses"
  };
}

function classificationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "isMatch", "confidence", "label", "reason"],
          properties: {
            id: { type: "string" },
            isMatch: { type: "boolean" },
            confidence: { type: "number" },
            label: { type: "string", enum: ["meme_coin", "analysis", "other"] },
            reason: { type: "string" }
          }
        }
      }
    }
  };
}

function classificationMessages(mode, posts, criteria) {
  return [
    {
      role: "system",
      content: `You are classifying X posts for a crypto monitoring dashboard. ${criteria} Be conservative. Return only valid JSON matching the requested schema.`
    },
    {
      role: "user",
      content: JSON.stringify({
        mode,
        posts: posts.map((post) => ({
          id: post.id,
          authorHandle: post.authorHandle,
          publishedAt: post.publishedAt,
          text: post.text,
          hasImages: Boolean(post.imageUrls?.length),
          ruleScores: {
            memeScore: post.memeScore ?? 0,
            analysisScore: post.analysisScore ?? 0,
            memeReasons: post.memeReasons ?? [],
            analysisReasons: post.analysisReasons ?? []
          }
        }))
      })
    }
  ];
}

async function classifyWithOpenAIResponses(config, messages) {
  const response = await fetch(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      input: messages,
      text: {
        format: {
          type: "json_schema",
          name: "post_classification",
          strict: true,
          schema: classificationSchema()
        }
      }
    })
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${config.provider} API ${response.status}: ${body?.error?.message || response.statusText}`);
  }
  return JSON.parse(responseOutputText(body));
}

async function classifyWithChatCompletions(config, messages) {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0,
      response_format: { type: "json_object" }
    })
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${config.provider} API ${response.status}: ${body?.error?.message || response.statusText}`);
  }
  return JSON.parse(body?.choices?.[0]?.message?.content || "{}");
}

async function classifyPostsWithAI(posts, mode, minConfidence) {
  if (!posts.length) return posts;
  const provider = argValue("aiProvider", process.env.AI_PROVIDER || "openai");
  const config = aiProviderConfig(provider);
  if (!config.apiKey) {
    throw new Error(`AI classification is enabled, but ${config.provider.toUpperCase()}_API_KEY is not set.`);
  }
  const criteria = mode === "meme"
    ? "Return isMatch=true only for posts primarily about meme coins, new token launches, memecoin trading, contract/CA discovery, or concrete meme-token market discussion. Exclude ordinary exchange campaigns, generic BNB/BTC/ETH news, giveaways, and unrelated memes."
    : "Return isMatch=true only for analytical crypto posts: reasoned market views, on-chain/data analysis, risk/catalyst discussion, thesis threads, long-form breakdowns, or research-style observations. Exclude short updates, greetings, giveaways, pure news headlines, ads, and generic announcements.";

  const messages = classificationMessages(mode, posts, criteria);
  const parsed = config.type === "responses"
    ? await classifyWithOpenAIResponses(config, messages)
    : await classifyWithChatCompletions(config, messages);
  const byId = new Map((parsed.items ?? []).map((item) => [String(item.id), item]));
  return posts
    .map((post) => {
      const result = byId.get(String(post.id));
      return {
        ...post,
        aiClassification: result ?? null,
        aiMode: mode,
        aiProvider: config.provider,
        aiModel: config.model
      };
    })
    .filter((post) => post.aiClassification?.isMatch && Number(post.aiClassification.confidence ?? 0) >= minConfidence);
}

function dateMatches(value, startDate, endDate) {
  if (!startDate && !endDate) return true;
  const relativeTime = String(value?.relativeText ?? value?.relativeTime ?? "").trim();
  if (startDate && !endDate && /(\d+\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours)|\d+\s*(秒|分钟|小時|小时|时)|刚刚|现在)/i.test(relativeTime)) {
    return true;
  }
  value = typeof value === "object" && value !== null ? value.publishedAt : value;
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  if (startDate && date < startDate) return false;
  if (endDate && date > endDate) return false;
  return true;
}

async function autoScroll(page, maxPosts, maxScrolls) {
  let previousCount = 0;
  let staleRounds = 0;

  for (let i = 0; i < maxScrolls; i += 1) {
    const count = await page.locator("article").count();
    if (count >= maxPosts) break;

    if (count === previousCount) {
      staleRounds += 1;
    } else {
      staleRounds = 0;
      previousCount = count;
    }
    if (staleRounds >= 4) break;

    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1400);
  }
}

async function collectTimelinePosts(page, username, maxPosts, maxScrolls) {
  const collected = new Map();
  let previousCount = 0;
  let staleRounds = 0;

  for (let i = 0; i <= maxScrolls; i += 1) {
    const posts = await extractPosts(page, username, Math.max(maxPosts, maxPosts * 3));
    for (const post of posts) {
      if (!collected.has(post.id)) collected.set(post.id, post);
    }
    if (collected.size >= maxPosts) break;
    if (i === maxScrolls) break;

    const count = await page.locator("article").count();
    if (count === previousCount) {
      staleRounds += 1;
    } else {
      staleRounds = 0;
      previousCount = count;
    }
    if (staleRounds >= 4) break;

    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1400);
  }

  return [...collected.values()];
}

async function waitForTimeline(page, username, articleTimeoutMs, retries) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (attempt > 0) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
      }
      await page.locator("article").first().waitFor({ timeout: articleTimeoutMs });
      return;
    } catch (error) {
      lastError = error;
      const pageText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
      if (/log in|sign in|登录|登入/i.test(pageText)) {
        throw new Error(`X requires login before @${username} timeline can be read. Run headed mode once and log in.`);
      }
      if (/something went wrong|try again|rate limit|temporarily unavailable/i.test(pageText)) {
        throw new Error(`X did not render @${username} timeline: ${pageText.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
  }
  throw new Error(`Timed out waiting for @${username} timeline articles after ${(retries + 1) * articleTimeoutMs}ms. Last error: ${lastError?.message || "unknown"}`);
}

async function selectPostsTab(page) {
  const tab = page
    .locator('a[href$="/with_replies"], a[href$="/media"]')
    .locator("xpath=../..")
    .locator(`a[href^="/"]`)
    .first();
  await tab.click({ timeout: 3000 }).catch(() => {});
}

async function saveDebugSnapshot(page, username) {
  if (argValue("debug", "false") !== "true") return;
  await fs.mkdir(dataDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const textPath = path.join(dataDir, `debug-${username}-${timestamp}.txt`);
  const pngPath = path.join(dataDir, `debug-${username}-${timestamp}.png`);
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch((error) => error.message);
  await fs.writeFile(textPath, bodyText, "utf8");
  await page.screenshot({ path: pngPath, fullPage: false }).catch(() => {});
  console.log(`DEBUG_TEXT: ${textPath}`);
  console.log(`DEBUG_PNG:  ${pngPath}`);
}

async function extractPosts(page, username, maxPosts) {
  return page.locator("article").evaluateAll(
    (articles, args) => {
      const { username: targetUsername, maxPosts: limit } = args;
      const unique = new Map();

      for (const article of articles) {
        const statusLink = [...article.querySelectorAll('a[href*="/status/"]')]
          .map((link) => link.href)
          .find((href) => href.includes(`/${targetUsername}/status/`) || href.includes("/status/"));
        if (!statusLink) continue;

        const statusId = statusLink.match(/\/status\/(\d+)/)?.[1];
        if (!statusId || unique.has(statusId)) continue;

        const time = article.querySelector("time");
        const tweetText = article.querySelector('[data-testid="tweetText"]');
        const text = tweetText?.innerText?.trim() || article.innerText?.trim() || "";
        if (!text) continue;

        const images = [...article.querySelectorAll("img")]
          .map((img) => img.src)
          .filter((src) => src && !src.includes("profile_images"));

        const videos = [...article.querySelectorAll("video")]
          .map((video) => video.poster || video.currentSrc || video.src)
          .filter(Boolean);

        unique.set(statusId, {
          id: statusId,
          url: `https://x.com/${targetUsername}/status/${statusId}`,
          authorHandle: `@${targetUsername}`,
          publishedAt: time?.getAttribute("datetime") || null,
          relativeTime: time?.innerText?.trim() || time?.textContent?.trim() || null,
          text,
          imageUrls: [...new Set(images)],
          videoPosters: [...new Set(videos)],
          scrapedAt: new Date().toISOString()
        });

        if (unique.size >= limit) break;
      }

      return [...unique.values()];
    },
    { username, maxPosts }
  );
}

async function scrapeUser(context, username, options) {
  const {
    maxPosts,
    maxScrolls,
    headless,
    articleTimeoutMs,
    retries,
    query,
    memeOnly,
    memeMinScore,
    analysisOnly,
    analysisMinScore,
    todayOnly,
    aiClassify,
    aiProvider,
    aiMode,
    aiMinConfidence,
    startDate,
    endDate
  } = options;

  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    throw new Error(`Invalid X username: ${username}`);
  }

  const page = await context.newPage();
  try {
    await page.goto(`https://x.com/${username}`, { waitUntil: "domcontentloaded", timeout: 45_000 });

    const loginVisible = await page
      .locator('input[name="text"], input[name="password"], a[href="/login"]')
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (loginVisible && !headless) {
      console.log(`X is asking for login before @${username}. Complete login in the opened browser window.`);
      await page.locator("article").first().waitFor({ timeout: 300_000 });
    }

    await waitForTimeline(page, username, articleTimeoutMs, retries);
    await selectPostsTab(page);
    await waitForTimeline(page, username, articleTimeoutMs, retries);
    await saveDebugSnapshot(page, username);

    const rawPosts = await collectTimelinePosts(page, username, Math.max(maxPosts, maxPosts * 3), maxScrolls);
    let posts = rawPosts
      .filter((post) => textMatches(post.text, query))
      .filter((post) => dateMatches(post, startDate, endDate))
      .map((post) => annotateScores(post));

    if (aiClassify) {
      const mode = aiMode === "meme" ? "meme" : "analysis";
      const candidates = posts.filter((post) => aiCandidate(post, mode)).slice(0, Math.max(maxPosts, maxPosts * 2));
      posts = await classifyPostsWithAI(candidates, mode, aiMinConfidence);
    } else {
      posts = posts
        .filter((post) => !memeOnly || isMemeCoinPost(post, memeMinScore))
        .filter((post) => !analysisOnly || isAnalysisPost(post, analysisMinScore));
    }

    return {
      username,
      filters: {
        query,
        memeOnly,
        memeMinScore,
        analysisOnly,
        analysisMinScore,
        todayOnly,
        aiClassify,
        aiProvider,
        aiMode,
        aiMinConfidence,
        start: startDate?.toISOString() ?? null,
        end: endDate?.toISOString() ?? null
      },
      totalScanned: rawPosts.length,
      totalPosts: posts.slice(0, maxPosts).length,
      generatedAt: new Date().toISOString(),
      posts: posts.slice(0, maxPosts)
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function concurrentMap(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const users = argList("users", [normalizeUsername(argValue("user", "heyibinance"))]);
  const maxPosts = Number(argValue("max", "20"));
  const maxScrolls = Number(argValue("scrolls", "12"));
  const headless = argValue("headless", "false") === "true";
  const articleTimeoutMs = Number(argValue("articleTimeoutMs", "20000"));
  const retries = Number(argValue("retries", "1"));
  const concurrency = boundedNumber(argValue("concurrency", "3"), 3, 1, 5);
  const query = String(argValue("query", "") ?? "").trim();
  const memeOnly = argValue("memeOnly", "false") === "true";
  const memeMinScore = Number(argValue("memeMinScore", "2"));
  const analysisOnly = argValue("analysisOnly", "false") === "true";
  const analysisMinScore = Number(argValue("analysisMinScore", "3"));
  const todayOnly = argValue("todayOnly", "false") === "true";
  const aiClassify = argValue("aiClassify", "false") === "true";
  const aiProvider = argValue("aiProvider", process.env.AI_PROVIDER || "openai");
  const aiMode = argValue("aiMode", analysisOnly ? "analysis" : "meme");
  const aiMinConfidence = Number(argValue("aiMinConfidence", "0.65"));
  const startDate = parseDateArg("start") || (todayOnly ? startOfLocalDay() : null);
  const endDate = parseDateArg("end");

  await fs.mkdir(dataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });

  try {
    await Promise.all(context.pages().map((page) => page.close().catch(() => {})));
    const settled = await concurrentMap(users, concurrency, async (username) => {
      try {
        return {
          ok: true,
          result: await scrapeUser(context, username, {
            maxPosts,
            maxScrolls,
            headless,
            articleTimeoutMs,
            retries,
            query,
            memeOnly,
            memeMinScore,
            analysisOnly,
            analysisMinScore,
            todayOnly,
            aiClassify,
            aiProvider,
            aiMode,
            aiMinConfidence,
            startDate,
            endDate
          })
        };
      } catch (error) {
        return {
          ok: false,
          username,
          error: error.message
        };
      }
    });

    const runs = settled.filter((item) => item.ok).map((item) => item.result);
    const errors = settled.filter((item) => !item.ok).map((item) => ({ username: item.username, message: item.error }));
    const posts = runs
      .flatMap((run) => run.posts)
      .sort((left, right) => String(right.publishedAt || "").localeCompare(String(left.publishedAt || "")));
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runName = users.length === 1 ? users[0] : "monitor";
    const jsonPath = path.join(dataDir, `browser-${runName}-${timestamp}.json`);
    const csvPath = path.join(dataDir, `browser-${runName}-${timestamp}.csv`);
    const payload = {
      username: users.length === 1 ? users[0] : "monitor",
      usernames: users,
      concurrency,
      filters: {
        query,
        memeOnly,
        memeMinScore,
        analysisOnly,
        analysisMinScore,
        todayOnly,
        aiClassify,
        aiProvider,
        aiMode,
        aiMinConfidence,
        start: startDate?.toISOString() ?? null,
        end: endDate?.toISOString() ?? null
      },
      totalScanned: runs.reduce((sum, run) => sum + Number(run.totalScanned || 0), 0),
      totalPosts: posts.length,
      generatedAt: new Date().toISOString(),
      accounts: runs.map((run) => ({
        username: run.username,
        totalPosts: run.totalPosts,
        totalScanned: run.totalScanned
      })),
      errors,
      posts
    };

    await fs.writeFile(
      jsonPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8"
    );

    const csvRows = [
      ["id", "url", "authorHandle", "publishedAt", "text", "imageUrls", "videoPosters", "scrapedAt"].map(csvCell).join(","),
      ...posts.map((post) =>
        [
          post.id,
          post.url,
          post.authorHandle,
          post.publishedAt,
          post.text,
          post.imageUrls.join(" "),
          post.videoPosters.join(" "),
          post.scrapedAt
        ].map(csvCell).join(",")
      )
    ];
    await fs.writeFile(csvPath, `${csvRows.join("\n")}\n`, "utf8");

    console.log(`Scraped ${posts.length} posts from ${users.map((user) => `@${user}`).join(", ")} with concurrency ${concurrency}`);
    console.log(`JSON: ${jsonPath}`);
    console.log(`CSV:  ${csvPath}`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
