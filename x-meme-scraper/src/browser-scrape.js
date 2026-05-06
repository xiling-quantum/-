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
  return { score, reasons: [...new Set(reasons)] };
}

function isMemeCoinPost(post, minScore) {
  const analysis = memeAnalysis(post);
  post.memeScore = analysis.score;
  post.memeReasons = analysis.reasons;
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

function dateMatches(value, startDate, endDate) {
  if (!startDate && !endDate) return true;
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

async function main() {
  const username = normalizeUsername(argValue("user", "heyibinance"));
  const maxPosts = Number(argValue("max", "20"));
  const maxScrolls = Number(argValue("scrolls", "12"));
  const headless = argValue("headless", "false") === "true";
  const query = String(argValue("query", "") ?? "").trim();
  const memeOnly = argValue("memeOnly", "false") === "true";
  const memeMinScore = Number(argValue("memeMinScore", "2"));
  const analysisOnly = argValue("analysisOnly", "false") === "true";
  const analysisMinScore = Number(argValue("analysisMinScore", "3"));
  const startDate = parseDateArg("start");
  const endDate = parseDateArg("end");

  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    throw new Error(`Invalid X username: ${username}`);
  }

  await fs.mkdir(dataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`https://x.com/${username}`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const loginVisible = await page
      .locator('input[name="text"], input[name="password"], a[href="/login"]')
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (loginVisible && !headless) {
      console.log("X is asking for login. Complete login in the opened browser window.");
      console.log("The scraper will continue automatically after the profile timeline is visible.");
      await page.locator("article").first().waitFor({ timeout: 300_000 });
    }

    await page.locator("article").first().waitFor({ timeout: 45_000 });
    await autoScroll(page, maxPosts, maxScrolls);

    const rawPosts = await extractPosts(page, username, Math.max(maxPosts, maxPosts * 3));
    const posts = rawPosts
      .filter((post) => textMatches(post.text, query))
      .filter((post) => dateMatches(post.publishedAt, startDate, endDate))
      .filter((post) => !memeOnly || isMemeCoinPost(post, memeMinScore))
      .filter((post) => !analysisOnly || isAnalysisPost(post, analysisMinScore))
      .slice(0, maxPosts);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = path.join(dataDir, `browser-${username}-${timestamp}.json`);
    const csvPath = path.join(dataDir, `browser-${username}-${timestamp}.csv`);

    await fs.writeFile(
      jsonPath,
      `${JSON.stringify({
        username,
        filters: {
          query,
          memeOnly,
          memeMinScore,
          analysisOnly,
          analysisMinScore,
          start: startDate?.toISOString() ?? null,
          end: endDate?.toISOString() ?? null
        },
        totalScanned: rawPosts.length,
        totalPosts: posts.length,
        generatedAt: new Date().toISOString(),
        posts
      }, null, 2)}\n`,
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

    console.log(`Scraped ${posts.length} posts from @${username}`);
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
