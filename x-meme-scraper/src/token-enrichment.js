import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

export const DEXSCREENER_SEARCH_LIMIT_PER_MINUTE = 300;
export const DEFAULT_DEXSCREENER_REQUESTS_PER_MINUTE = 240;
export const DEFAULT_DEXSCREENER_TIMEOUT_SECONDS = 8;
export const DEFAULT_DEXSCREENER_CONCURRENCY = 4;
const DEXSCREENER_API_BASE = "https://api.dexscreener.com";
const GECKOTERMINAL_API_BASE = "https://api.geckoterminal.com/api/v2";
const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";
const CMC_API_BASE = "https://pro-api.coinmarketcap.com/v2";
const JUPITER_API_BASE = "https://api.jup.ag";
const JUPITER_PUBLIC_TOKEN_BASE = "https://tokens.jup.ag";
const PUMPFUN_API_BASES = [
  "https://frontend-api-v3.pump.fun",
  "https://frontend-api.pump.fun"
];
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const SOLANA_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DEFAULT_METADATA_SOURCES = [
  "dexscreener_profile",
  "dexscreener_cto",
  "dexscreener_ads",
  "dexscreener_boost",
  "dexscreener_boost_latest",
  "pumpfun",
  "geckoterminal",
  "coingecko",
  "coinmarketcap",
  "jupiter",
  "solana_metaplex",
  "chain_explorer",
  "ca_pages",
  "ca_search"
];
const metadataPayloadCache = new Map();
const metadataTextCache = new Map();

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addressKey(value) {
  const address = String(value || "").trim();
  return address.startsWith("0x") ? address.toLowerCase() : address;
}

function chainName(value) {
  const key = String(value || "").trim().toLowerCase();
  const names = {
    ethereum: "Ethereum",
    ether: "Ethereum",
    bsc: "BSC",
    base: "Base",
    solana: "Solana",
    polygon: "Polygon",
    arbitrum: "Arbitrum",
    avalanche: "Avalanche",
    tron: "Tron"
  };
  return names[key] || String(value || "").trim();
}

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  if (number >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(2)}B`;
  if (number >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `$${(number / 1_000).toFixed(1)}K`;
  return `$${number.toFixed(number >= 10 ? 0 : 2)}`;
}

function mostlyAscii(value) {
  const text = String(value || "");
  if (!text) return false;
  const asciiCount = [...text].filter((char) => char.charCodeAt(0) <= 127).length;
  return asciiCount / text.length >= 0.65;
}

function translateDuration(value) {
  return String(value || "")
    .replace(/\b(\d+(?:\.\d+)?)\s*d(?:ays?)?\b/gi, "$1天")
    .replace(/\b(\d+(?:\.\d+)?)\s*h(?:ours?)?\b/gi, "$1小时")
    .replace(/\b(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\b/gi, "$1分钟");
}

function translateSignalStory(story) {
  let text = String(story || "").replace(/\s+/g, " ").trim();
  if (!text || !mostlyAscii(text)) return text;
  text = text
    .replace(/[\u{1F4B0}\u{1F4B5}\u{1F53C}\u{1F53D}\u{2705}\u{274C}]/gu, "")
    .replace(/\bUPDATE CALL FROM PREMIUM CHANNEL\b/gi, "高级频道更新喊单")
    .replace(/\bPREMIUM CHANNEL\b/gi, "高级频道")
    .replace(/\bDONE\s+(\d+(?:\.\d+)?)X\s+in\s+([0-9.]+\s*[dhm](?:ours?|ays?|in(?:ute)?s?)?)\b/gi, "已完成 $1倍，用时 $2")
    .replace(/\bDONE\s+(\d+(?:\.\d+)?)X\b/gi, "已完成 $1倍")
    .replace(/\bis back at\b/gi, "回到")
    .replace(/\bis becoming\b/gi, "正在成为")
    .replace(/\bcommunity is paying attention to\b/gi, "社区正在关注")
    .replace(/\bhopefully the dev keeps updating with more characters and features\b/gi, "希望开发者继续更新更多角色和功能")
    .replace(/\bthe dev keeps updating\b/gi, "开发者持续更新")
    .replace(/\bdev\b/gi, "开发者")
    .replace(/\bcommunity\b/gi, "社区")
    .replace(/\bpixel-art\b/gi, "像素风")
    .replace(/\bgame\b/gi, "游戏")
    .replace(/\bfeatures\b/gi, "功能")
    .replace(/\bcharacters\b/gi, "角色")
    .replace(/\bfrom\b/gi, "从")
    .replace(/\bto\b/gi, "到");
  return translateDuration(text).replace(/\s+/g, " ").trim();
}

function normalizeUrl(value) {
  const url = String(value || "").trim();
  if (url.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${url.replace(/^ipfs:\/\//, "").replace(/^\/+/, "")}`;
  if (url.startsWith("ar://")) return `https://arweave.net/${url.replace(/^ar:\/\//, "").replace(/^\/+/, "")}`;
  return url;
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(parseInt(number, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function metadataSourceEntry(source, description = "", url = "", title = "") {
  return {
    source: String(source || "").trim(),
    title: String(title || "").trim(),
    description: stripHtml(description).replace(/\s+/g, " ").trim(),
    url: normalizeUrl(url)
  };
}

function mergeMetadataEntries(existing = [], newEntries = []) {
  const merged = [];
  const seen = new Set();
  for (const entry of [...existing, ...newEntries]) {
    if (!entry || typeof entry !== "object") continue;
    const source = String(entry.source || "").trim();
    const title = String(entry.title || "").trim();
    const description = String(entry.description || "").trim();
    const url = String(entry.url || "").trim();
    if (!source && !title && !description && !url) continue;
    const key = [source.toLowerCase(), title.toLowerCase(), description.toLowerCase(), url.toLowerCase()].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(metadataSourceEntry(source, description, url, title));
  }
  return merged;
}

function isLowSignalMetadataText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  const genericPatterns = [
    /\bblock explorer and search\b.*\bapi\b.*\banalytics platform\b/i,
    /\b(?:solscan|bscscan|etherscan|basescan|arbiscan|polygonscan)\b.*\b(?:block explorer|search|api|analytics)\b/i,
    /\btrade\b.*\b(?:on phantom|solflare|wallet)\b/i,
    /\blearn how to buy\b/i,
    /\bswap\s+(?:sol|bnb|eth|usdc|usdt)\b/i,
    /\bcurrent price\b.*\bmarket cap\b/i,
    /\bexplore live price,\s*charts,\s*trades and volume info\b/i,
    /\bprice on\s+(?:solana|bsc|ethereum|base|arbitrum|polygon)\s*\|\s*birdeye\b/i,
    /\btoken rep:\s*unknown\b.*\bas at\b/i,
    /^\s*token\s+0x[a-f0-9]{40}\b/i
  ];
  return genericPatterns.some((pattern) => pattern.test(text));
}

function metadataSignalScore(entry) {
  const description = String(entry?.description || "").trim();
  if (!description || isLowSignalMetadataText(description)) return -1;
  const source = String(entry?.source || "").toLowerCase();
  const title = String(entry?.title || "").trim();
  let score = Math.min(description.length, 260);
  if (source.includes("chain_explorer") || /scan_token/i.test(source)) score += 180;
  if (source.includes("jupiter")) score += 150;
  if (source.includes("pumpfun") || source.includes("solana_metaplex")) score += 120;
  if (source === "ca_search") score += 60;
  if (title) score += 20;
  if (/[\u4e00-\u9fff]/u.test(description)) score += 30;
  if (/叙事|热点|官方|项目|文化|动物|ai|agent|meme|game|nft|token|erc|bep/i.test(description)) score += 40;
  return score;
}

function bestMetadataEntry(entries = []) {
  return entries
    .map((entry) => ({ entry, score: metadataSignalScore(entry) }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score)[0]?.entry || null;
}

function bestMetadataDescription(entries = []) {
  return String(bestMetadataEntry(entries)?.description || "").trim();
}

function tokenIdentityFromMetadata(entries = []) {
  const entry = bestMetadataEntry(entries);
  const title = String(entry?.title || "").trim();
  const description = String(entry?.description || "").trim();
  const fromDescription = description.match(/「(.+?)（(.+?)）」/u);
  if (fromDescription) {
    return {
      name: fromDescription[1].trim(),
      ticker: fromDescription[2].trim()
    };
  }
  const fromTitle = title.match(/^(.+?)\s+\$([^\s]+)$/u);
  if (fromTitle) {
    return {
      name: fromTitle[1].trim(),
      ticker: fromTitle[2].trim()
    };
  }
  return { name: title, ticker: "" };
}

function cleanNarrativeText(value, maxLength = 220) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\bCA\s*[:：]\s*\S+/gi, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b(?:MC|MCap|Market\s*Cap|Liquidity|Holders?|Volume|Vol|DEX|Chain)\s*[:：]\s*\S+/gi, "")
    .replace(/[|#]+/g, " ")
    .trim()
    .slice(0, maxLength)
    .replace(/[，,。.\s]+$/u, "");
}

function tokenLabel(card, dex = {}) {
  return dex.tokenName || card.name || card.ticker || dex.tokenSymbol || "";
}

function looksLikeCallUpdate(value) {
  const text = String(value || "").toLowerCase();
  return Boolean(
    /update call from premium channel/i.test(value || "") ||
    /\bdone\s+\d+(?:\.\d+)?x\b/i.test(value || "") ||
    /\bcalled:\s*\$?[0-9,.]+\s*(?:➡|->|to)\s*\$?[0-9,.]+/i.test(value || "") ||
    text.includes("call by:")
  );
}

function inferNarrativeTheme(text) {
  const value = String(text || "");
  const lower = value.toLowerCase();
  if (/特朗普|川普|trump|访华|中美|喜鹊|magpie/i.test(value)) {
    if (/喜鹊|magpie/i.test(value)) {
      return "项目来源是特朗普访华热点，把「喜鹊」吉祥鸟意象包装成动物/文化 Meme；热度方向主要看中美事件发酵、中文社区传播和低市值资金承接。";
    }
    return "项目来源是特朗普/中美政治事件热点，借公共事件注意力做短线 Meme；热度方向主要看新闻发酵、中文社群传播和链上成交承接。";
  }
  if (/\bbuildmaxxing\b|gen\s*z/i.test(lower)) {
    return "项目来源是 Gen Z / buildmaxxing 网络梗，属于自我提升黑话包装的 Meme；热度方向主要看社媒梗图扩散、群内喊单和低市值波动。";
  }
  if (/\b(?:troll|poop|shit|fart|toilet)\b|trollo|troll|poop/i.test(lower)) {
    return "项目来源是 troll/poop 恶搞梗，属于低门槛 Meme/厕所幽默方向；热度方向更多来自群内喊单、极小市值波动和短线传播，缺少官网社媒时持续性偏弱。";
  }
  if (/\bchina\b|中国|中美|国别/i.test(value)) {
    return "项目来源是 China/中国国别符号，属于宏观情绪和地域身份 Meme；热度方向主要看中文社区扩散、国别叙事情绪和短线资金是否继续接力。";
  }
  if (/币安|binance|bnb|cz|何一|赵长鹏/i.test(value)) {
    return "项目来源是币安身份/交易所信仰梗，把「币安人」这类社区归属感做成 Meme；热度方向主要看币安生态情绪、中文交易圈传播和低市值接力。";
  }
  if (/tesla|特斯拉|musk|elon|rizo|hedgehog|刺猬|haba yes hedgehog/i.test(value)) {
    return "项目来源是 Tesla/马斯克相关活动叙事叠加 Rizo/刺猬吉祥物动物梗；热度方向主要看特斯拉事件、吉祥物二创和动物 Meme 社区扩散。";
  }
  if (/\beth\b|ethereum|以太坊/i.test(value)) {
    return "项目来源是 ETH/以太坊主流符号的蹭名叙事，借大链认知降低理解门槛；热度方向主要看群内传播、链上交易承接和是否有真实项目方叙事补充。";
  }
  if (/\b(?:doge|shib|inu|pepe|frog|cat|dog|goat)\b|狗|猫|蛙|佩佩/i.test(value)) {
    return "项目来源是动物/IP 跟风 Meme，借现成符号认知降低传播成本；热度方向主要看梗图扩散、群内喊单和小市值资金接力。";
  }
  if (/\bai\b|agent|人工智能|智能体/i.test(value)) {
    return "项目来源是 AI/Agent 热点，借当前加密市场高关注概念做包装；热度方向主要看产品证明、社媒扩散和链上成交承接。";
  }
  if (/\bnft\b|erc-721|erc-1155|非同质/i.test(lower)) {
    return "项目来源偏 NFT/合约标准叙事，但缺少发行计划、IP 内容或社区故事时信息面偏薄；热度方向主要看铸造/交易活跃度和社区承接。";
  }
  return "";
}

function buildCallSignalSummary(card) {
  const stories = [
    ...(Array.isArray(card.sourceStories) ? card.sourceStories : []),
    card.narrative || ""
  ].filter(Boolean);
  const callTexts = stories.filter(looksLikeCallUpdate);
  if (!callTexts.length) return "";
  const multiples = callTexts
    .map((item) => String(item).match(/\bdone\s+(\d+(?:\.\d+)?)x\b/i)?.[1])
    .filter(Boolean)
    .slice(0, 2);
  const callers = callTexts
    .map((item) => String(item).match(/call by:\s*([^|\n\r]+)/i)?.[1]?.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (!callers.length) {
    callers.push(...[
      card.primarySender,
      ...(Array.isArray(card.sourceSenders) ? card.sourceSenders : [])
    ].filter(Boolean).slice(0, 2));
  }
  const parts = [];
  if (callTexts.length) parts.push(`群内主要是 ${callTexts.length} 条喊单/战绩更新`);
  if (multiples.length) parts.push(`最高提到 ${multiples[0]}X`);
  if (callers.length) parts.push(`来源 ${callers.join("/")}`);
  return parts.join("，");
}

function buildDataOnlyNarrative(card, dex = {}) {
  const label = tokenLabel(card, dex);
  const subject = `项目${label ? `「${label}」` : ""}`;
  const venue = [chainName(dex.chainId || card.chain), dex.dexId].filter(Boolean).join(" / ");
  const metrics = [
    dex.marketCap || card.marketCap ? `市值 ${compactNumber(dex.marketCap || card.marketCap) || (dex.marketCap || card.marketCap)}` : "",
    dex.liquidityUsd || card.liquidity ? `流动性 ${compactNumber(dex.liquidityUsd || card.liquidity) || (dex.liquidityUsd || card.liquidity)}` : "",
    dex.volume24h || card.volume24h ? `24h 成交 ${compactNumber(dex.volume24h || card.volume24h) || (dex.volume24h || card.volume24h)}` : "",
    dex.txns24h ? `24h 交易 ${dex.txns24h} 笔` : "",
    dex.priceChange24h !== undefined && dex.priceChange24h !== "" ? `24h ${dex.priceChange24h}%` : ""
  ].filter(Boolean);
  const missing = [
    dex.websites?.length || card.hasWebsite === "yes" ? "" : "官网",
    dex.socials?.some((item) => item.toLowerCase().includes("twitter") || item.toLowerCase().includes("x.com")) || card.hasTwitter === "yes" ? "" : "推特",
    dex.socials?.some((item) => item.toLowerCase().includes("telegram") || item.toLowerCase().includes("t.me")) || card.hasTelegram === "yes" ? "" : "电报"
  ].filter(Boolean);
  const callSignal = buildCallSignalSummary(card);

  if (dex?.found) {
    const profile = [venue ? `在 ${venue} 交易` : "有链上交易对", metrics.join("，")].filter(Boolean).join("，");
    const socialRisk = missing.length ? `未抓到${missing.join("/")}入口` : "有外部入口但缺少文字叙事";
    const signal = callSignal ? `；${callSignal}` : "";
    return `${subject}暂无项目方叙事，${profile}，${socialRisk}${signal}。信息面偏薄，更像短线跟单/盘口热度盘，持续性主要看后续是否补官网、推特或社区原文。`;
  }

  const chain = chainName(dex.chainId || card.chain);
  const signal = callSignal ? `；${callSignal}` : "";
  return `${subject}暂无明确叙事，${chain ? `${chain} ` : ""}CA 未在 DexScreener 找到有效交易对，链上/搜索也没有返回可用项目介绍${signal}。先按未验证合约或早期低信息盘处理。`;
}

function labelFromDescription(description) {
  const text = String(description || "");
  const match = text.match(/「(.+?)(?:（(.+?)）)?」/u);
  if (!match) return "";
  return [match[2], match[1]].filter(Boolean).join("/");
}

function buildNameBasedNarrative(card, dex = {}, story = "", description = "") {
  const label = tokenLabel(card, dex) || labelFromDescription(description) || card.address || "";
  const chain = chainName(dex.chainId || card.chain);
  const source = story
    ? `项目叙事主要来自群内原文和名称「${label || "未知"}」`
    : `项目叙事主要来自名称「${label || "未知"}」和链上标签`;
  const chainPart = chain ? `${chain} 链上` : "链上";
  return `${source}，目前没有抓到项目方完整故事；热度方向主要看名称符号能否被社区二创、群内提及是否继续增加，以及${chainPart}成交和持有人是否跟上。`;
}

function buildVerificationHint(metadataEntry, card, dex = {}) {
  const source = String(metadataEntry?.source || "").toLowerCase();
  const hints = [];
  if (source.includes("birdeye")) hints.push("Birdeye 有价格/图表/成交页");
  else if (source.includes("gmgn")) hints.push("GMGN 页面可查");
  else if (source.includes("jupiter")) hints.push("Jupiter 有代币元数据");
  else if (source.includes("solscan")) hints.push("Solscan 有代币页");
  else if (source.includes("scan_token")) hints.push("链上浏览器有代币页");
  else if (source === "ca_search") hints.push("CA 搜索有外部结果");

  const callSignal = buildCallSignalSummary(card);
  if (callSignal) hints.push(callSignal);
  if (!hints.length) return "";

  const socialMissing = [
    dex.websites?.length || card.hasWebsite === "yes" ? "" : "官网",
    dex.socials?.some((item) => item.toLowerCase().includes("twitter") || item.toLowerCase().includes("x.com")) || card.hasTwitter === "yes" ? "" : "推特",
    dex.socials?.some((item) => item.toLowerCase().includes("telegram") || item.toLowerCase().includes("t.me")) || card.hasTelegram === "yes" ? "" : "电报"
  ].filter(Boolean);
  if (socialMissing.length) hints.push(`未抓到${socialMissing.join("/")}叙事`);
  return ` 验证线索：${hints.slice(0, 3).join("；")}。`;
}

export function buildBriefNarrative(card, dex = {}, metadataSources = []) {
  const metadataEntry = bestMetadataEntry(metadataSources);
  const metadataDescription = cleanNarrativeText(metadataEntry?.description || "", 320);
  const description = cleanNarrativeText(metadataDescription || dex.description, 320);
  const stories = Array.isArray(card.sourceStories) ? card.sourceStories : [];
  const rawStory = stories.find((item) => !looksLikeCallUpdate(item)) || (looksLikeCallUpdate(card.narrative) ? "" : card.narrative);
  const story = cleanNarrativeText(rawStory ? translateSignalStory(rawStory) : "", 260);
  const label = tokenLabel(card, dex);
  const topic = description || story;
  const theme = inferNarrativeTheme([label, description, story, card.ticker, card.name].filter(Boolean).join(" "));

  if (theme) return theme.slice(0, 360);

  if (description) {
    if (/^链上浏览器标识为/u.test(description)) {
      return buildNameBasedNarrative(card, dex, story, description).slice(0, 360);
    }
    if (/^项目|^源于|^基于|^围绕/u.test(topic)) {
      return topic.slice(0, 360);
    }
    return buildNameBasedNarrative(card, dex, story, description).slice(0, 360);
  }

  if (story) {
    return buildNameBasedNarrative(card, dex, story, description).slice(0, 360);
  }

  return buildDataOnlyNarrative(card, dex).slice(0, 360);
}

export function configuredDexRequestsPerMinute(value = "") {
  return boundedNumber(
    value || process.env.DEXSCREENER_REQUESTS_PER_MINUTE || String(DEFAULT_DEXSCREENER_REQUESTS_PER_MINUTE),
    DEFAULT_DEXSCREENER_REQUESTS_PER_MINUTE,
    1,
    DEXSCREENER_SEARCH_LIMIT_PER_MINUTE
  );
}

export function dexRequestDelayMs(requestsPerMinute = configuredDexRequestsPerMinute()) {
  return Math.ceil(60000 / Math.max(1, requestsPerMinute));
}

export function configuredDexProxy(value = "") {
  const raw = String(value || process.env.DEXSCREENER_PROXY_URL || process.env.TELEGRAM_PROXY_URL || "").trim();
  if (!raw) return "";
  return raw.replace(/^socks5:\/\//i, "socks5h://");
}

function metadataEnabled(value = process.env.TOKEN_METADATA_ENABLED) {
  const raw = String(value ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function configuredMetadataSources(value = process.env.TOKEN_METADATA_SOURCES) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_METADATA_SOURCES;
  return raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function caSearchEnabled(value = process.env.TOKEN_CA_SEARCH_ENABLED) {
  const raw = String(value ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function fallbackMetadataOptions(options = {}) {
  if (options.metadataSources || process.env.TOKEN_METADATA_SOURCES) return options;
  return {
    ...options,
    metadataSources: "pumpfun,geckoterminal,coingecko,coinmarketcap,jupiter,solana_metaplex,chain_explorer,ca_pages,ca_search"
  };
}

function bestPairForAddress(address, pairs = []) {
  const key = addressKey(address);
  const ranked = pairs
    .filter((pair) => {
      const base = addressKey(pair?.baseToken?.address);
      const quote = addressKey(pair?.quoteToken?.address);
      return base === key || quote === key;
    })
    .map((pair) => {
      const baseMatch = addressKey(pair?.baseToken?.address) === key ? 1 : 0;
      const liquidity = Number(pair?.liquidity?.usd || 0);
      const volume = Number(pair?.volume?.h24 || 0);
      return { pair, score: baseMatch * 1_000_000_000 + liquidity * 10 + volume };
    })
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.pair || null;
}

async function curlJson(url, options = {}) {
  const proxy = configuredDexProxy(options.proxy);
  const timeoutSeconds = boundedNumber(
    options.timeoutSeconds || process.env.DEXSCREENER_TIMEOUT_SECONDS || DEFAULT_DEXSCREENER_TIMEOUT_SECONDS,
    DEFAULT_DEXSCREENER_TIMEOUT_SECONDS,
    3,
    30
  );
  const args = ["--silent", "--show-error", "--fail", "--max-time", String(timeoutSeconds)];
  if (proxy) args.push("--proxy", proxy);
  if (options.method) args.push("--request", options.method);
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value !== undefined && value !== null && value !== "") args.push("--header", `${key}: ${value}`);
  }
  if (options.body !== undefined) {
    args.push("--data-binary", typeof options.body === "string" ? options.body : JSON.stringify(options.body));
  }
  args.push(url);
  const { stdout } = await execFileAsync("curl.exe", args, {
    cwd: projectRoot,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });
  return JSON.parse(stdout);
}

async function curlText(url, options = {}) {
  const proxy = configuredDexProxy(options.proxy);
  const timeoutSeconds = boundedNumber(
    options.timeoutSeconds || process.env.TOKEN_CA_SEARCH_TIMEOUT_SECONDS || DEFAULT_DEXSCREENER_TIMEOUT_SECONDS,
    DEFAULT_DEXSCREENER_TIMEOUT_SECONDS,
    3,
    30
  );
  const args = ["--silent", "--show-error", "--fail", "--location", "--max-time", String(timeoutSeconds)];
  if (proxy) args.push("--proxy", proxy);
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value !== undefined && value !== null && value !== "") args.push("--header", `${key}: ${value}`);
  }
  args.push(url);
  const { stdout } = await execFileAsync("curl.exe", args, {
    cwd: projectRoot,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

async function cachedCurlJson(url, options = {}) {
  const cacheKey = `${url}\n${JSON.stringify(options.headers || {})}`;
  if (metadataPayloadCache.has(cacheKey)) return metadataPayloadCache.get(cacheKey);
  const payload = await curlJson(url, options);
  metadataPayloadCache.set(cacheKey, payload);
  return payload;
}

async function cachedCurlText(url, options = {}) {
  const cacheKey = `${url}\n${JSON.stringify(options.headers || {})}`;
  if (metadataTextCache.has(cacheKey)) return metadataTextCache.get(cacheKey);
  const payload = await curlText(url, options);
  metadataTextCache.set(cacheKey, payload);
  return payload;
}

async function postJson(url, payload, options = {}) {
  return curlJson(url, {
    ...options,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: payload
  });
}

export async function fetchDexScreener(address, options = {}) {
  const url = `${DEXSCREENER_API_BASE}/latest/dex/search?q=${encodeURIComponent(address)}`;
  const body = await curlJson(url, options);
  const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
  const pair = bestPairForAddress(address, pairs);
  if (!pair) return { address, found: false, pairsFound: pairs.length };
  const tokenIsBase = addressKey(pair.baseToken?.address) === addressKey(address);
  const token = tokenIsBase ? pair.baseToken : pair.quoteToken;
  return {
    address,
    found: true,
    source: "dexscreener",
    chainId: pair.chainId || "",
    dexId: pair.dexId || "",
    pairAddress: pair.pairAddress || "",
    pairUrl: pair.url || "",
    pairCreatedAt: pair.pairCreatedAt ? new Date(Number(pair.pairCreatedAt)).toISOString() : "",
    baseToken: pair.baseToken || null,
    quoteToken: pair.quoteToken || null,
    tokenName: token?.name || "",
    tokenSymbol: token?.symbol || "",
    tokenAddress: token?.address || address,
    priceUsd: pair.priceUsd || "",
    marketCap: pair.marketCap ?? pair.fdv ?? "",
    fdv: pair.fdv ?? "",
    liquidityUsd: pair.liquidity?.usd ?? "",
    volume24h: pair.volume?.h24 ?? "",
    txns24h: Number(pair.txns?.h24?.buys || 0) + Number(pair.txns?.h24?.sells || 0),
    priceChange24h: pair.priceChange?.h24 ?? "",
    description: pair.info?.description || "",
    websites: (pair.info?.websites || []).map((item) => item.url || item.label || "").filter(Boolean),
    socials: (pair.info?.socials || []).map((item) => `${item.type || "social"}:${item.url || item.handle || ""}`).filter(Boolean),
    labels: pair.labels || [],
    pairsFound: pairs.length
  };
}

function dexGlobalItemEntries(payload, chainId, tokenAddress, source) {
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
  const chainKey = String(chainId || "").toLowerCase();
  const tokenKey = addressKey(tokenAddress);
  const entries = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const itemChain = String(item.chainId || item.chain_id || "").toLowerCase();
    const itemAddress = addressKey(item.tokenAddress || item.token_address || item.address);
    if (itemChain && itemChain !== chainKey) continue;
    if (itemAddress !== tokenKey) continue;
    const links = Array.isArray(item.links) ? item.links : [];
    const linkText = links.map((link) => link?.url || "").filter(Boolean).join(" ");
    const description = String(item.description || item.text || item.header || linkText || "").trim();
    entries.push(metadataSourceEntry(
      source,
      description,
      item.url || "",
      item.tokenName || item.name || ""
    ));
  }
  return entries;
}

async function queryDexScreenerMetadataSources(chainId, tokenAddress, options = {}) {
  const endpoints = [
    ["dexscreener_profile", `${DEXSCREENER_API_BASE}/token-profiles/latest/v1`],
    ["dexscreener_cto", `${DEXSCREENER_API_BASE}/community-takeovers/latest/v1`],
    ["dexscreener_ads", `${DEXSCREENER_API_BASE}/ads/latest/v1`],
    ["dexscreener_boost", `${DEXSCREENER_API_BASE}/token-boosts/top/v1`],
    ["dexscreener_boost_latest", `${DEXSCREENER_API_BASE}/token-boosts/latest/v1`]
  ];
  let entries = [];
  for (const [source, url] of endpoints) {
    try {
      const payload = await cachedCurlJson(url, options);
      entries = mergeMetadataEntries(entries, dexGlobalItemEntries(payload, chainId, tokenAddress, source));
    } catch (error) {
      entries = mergeMetadataEntries(entries, [metadataSourceEntry(`${source}_error`, error.message)]);
    }
  }
  return entries.filter((entry) => !entry.source.endsWith("_error"));
}

function geckoTerminalNetworkSlug(chainId) {
  const key = String(chainId || "").trim().toLowerCase();
  const slugs = {
    ethereum: "eth",
    ether: "eth",
    eth: "eth",
    bsc: "bsc",
    "binance-smart-chain": "bsc",
    base: "base",
    solana: "solana",
    sol: "solana",
    polygon: "polygon_pos",
    polygon_pos: "polygon_pos",
    arbitrum: "arbitrum",
    "arbitrum-one": "arbitrum",
    avalanche: "avax",
    avax: "avax",
    tron: "tron"
  };
  return slugs[key] || "";
}

function coinGeckoPlatformSlug(chainId) {
  const key = String(chainId || "").trim().toLowerCase();
  const slugs = {
    ethereum: "ethereum",
    ether: "ethereum",
    eth: "ethereum",
    bsc: "binance-smart-chain",
    "binance-smart-chain": "binance-smart-chain",
    base: "base",
    solana: "solana",
    sol: "solana",
    polygon: "polygon-pos",
    polygon_pos: "polygon-pos",
    arbitrum: "arbitrum-one",
    "arbitrum-one": "arbitrum-one",
    avalanche: "avalanche",
    avax: "avalanche",
    tron: "tron"
  };
  return slugs[key] || "";
}

function isSolanaChain(chainId) {
  return ["solana", "sol"].includes(String(chainId || "").trim().toLowerCase());
}

async function queryGeckoTerminalMetadata(chainId, tokenAddress, options = {}) {
  const network = geckoTerminalNetworkSlug(chainId);
  if (!network) return [];
  try {
    const url = `${GECKOTERMINAL_API_BASE}/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(tokenAddress)}/info`;
    const payload = await curlJson(url, options);
    const attributes = payload?.data?.attributes || {};
    const websites = Array.isArray(attributes.websites) ? attributes.websites : [];
    const firstWebsite = websites[0];
    const homepage = typeof firstWebsite === "string" ? firstWebsite : firstWebsite?.url || "";
    return mergeMetadataEntries([], [metadataSourceEntry("geckoterminal", attributes.description || "", homepage, attributes.name || "")]);
  } catch {
    return [];
  }
}

async function queryPumpFunMetadata(chainId, tokenAddress, options = {}) {
  if (!isSolanaChain(chainId)) return [];
  for (const baseUrl of PUMPFUN_API_BASES) {
    try {
      const payload = await cachedCurlJson(`${baseUrl}/coins/${encodeURIComponent(tokenAddress)}`, options);
      if (!payload || typeof payload !== "object") continue;
      const socials = [
        payload.twitter ? `twitter:${payload.twitter}` : "",
        payload.telegram ? `telegram:${payload.telegram}` : "",
        payload.website ? `website:${payload.website}` : ""
      ].filter(Boolean);
      const description = [
        payload.description || "",
        socials.length ? `Socials: ${socials.join(", ")}` : ""
      ].filter(Boolean).join("\n");
      return mergeMetadataEntries([], [
        metadataSourceEntry("pumpfun", description, payload.website || payload.uri || payload.metadata_uri || "", payload.name || "")
      ]);
    } catch {
      // Try the next public pump.fun API host.
    }
  }
  return [];
}

function jupiterTokenEntries(payload, tokenAddress) {
  const tokenKey = addressKey(tokenAddress);
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.tokens)
      ? payload.tokens
      : payload && typeof payload === "object"
        ? [payload]
        : [];
  const entries = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const address = addressKey(item.address || item.mint || item.id);
    if (address !== tokenKey) continue;
    const name = String(item.name || "").trim();
    const symbol = String(item.symbol || "").trim();
    const tags = [
      ...(Array.isArray(item.tags) ? item.tags : []),
      item.verified ? "verified" : "",
      item.strict ? "strict" : ""
    ].filter(Boolean);
    const metrics = [
      item.mcap || item.marketCap ? `mcap ${compactNumber(item.mcap || item.marketCap) || (item.mcap || item.marketCap)}` : "",
      item.fdv ? `fdv ${compactNumber(item.fdv) || item.fdv}` : "",
      item.daily_volume || item.dailyVolume ? `daily volume ${compactNumber(item.daily_volume || item.dailyVolume) || (item.daily_volume || item.dailyVolume)}` : "",
      item.decimals !== undefined ? `${item.decimals} decimals` : ""
    ].filter(Boolean);
    const description = [
      `Jupiter 标识为 Solana 代币${name || symbol ? `「${name || symbol}${symbol && symbol !== name ? `（${symbol}）` : ""}」` : ""}`,
      tags.length ? `标签 ${tags.slice(0, 6).join("/")}` : "",
      metrics.length ? metrics.join("，") : "",
      item.logoURI || item.icon ? "有图标元数据" : ""
    ].filter(Boolean).join("，") + "。";
    entries.push(metadataSourceEntry("jupiter_token", description, item.logoURI || item.icon || "", name || symbol));
  }
  return mergeMetadataEntries([], entries);
}

async function queryJupiterTokenMetadata(chainId, tokenAddress, options = {}) {
  if (!isSolanaChain(chainId)) return [];
  const headers = { ...(options.headers || {}) };
  const apiKey = String(process.env.JUPITER_API_KEY || process.env.JUP_API_KEY || "").trim();
  if (apiKey) headers["x-api-key"] = apiKey;
  const urls = [
    `${JUPITER_API_BASE}/tokens/v2/search?query=${encodeURIComponent(tokenAddress)}`,
    `${JUPITER_API_BASE}/tokens/v1/token/${encodeURIComponent(tokenAddress)}`,
    `${JUPITER_PUBLIC_TOKEN_BASE}/token/${encodeURIComponent(tokenAddress)}`
  ];
  let entries = [];
  for (const url of urls) {
    try {
      const payload = await cachedCurlJson(url, { ...options, headers });
      entries = mergeMetadataEntries(entries, jupiterTokenEntries(payload, tokenAddress));
      if (entries.length) break;
    } catch {
      // Try the next Jupiter token endpoint; availability differs by deployment/API key.
    }
  }
  return entries;
}

async function queryCoinGeckoMetadata(chainId, tokenAddress, options = {}) {
  const platform = coinGeckoPlatformSlug(chainId);
  if (!platform) return [];
  const headers = {};
  const apiKey = String(process.env.COINGECKO_API_KEY || process.env.CG_API_KEY || "").trim();
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
  try {
    const url = `${COINGECKO_API_BASE}/coins/${encodeURIComponent(platform)}/contract/${encodeURIComponent(tokenAddress)}`;
    const payload = await curlJson(url, { ...options, headers: { ...(options.headers || {}), ...headers } });
    const description = payload?.description?.en || "";
    const homepage = (payload?.links?.homepage || []).find(Boolean) || "";
    const categories = Array.isArray(payload?.categories) ? payload.categories.slice(0, 5).filter(Boolean).join(", ") : "";
    return mergeMetadataEntries([], [
      metadataSourceEntry("coingecko", categories ? `${description}\nCategories: ${categories}` : description, homepage, payload?.name || "")
    ]);
  } catch {
    return [];
  }
}

async function queryCoinMarketCapMetadata(tokenAddress, options = {}) {
  const apiKey = String(process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY || "").trim();
  if (!apiKey) return [];
  try {
    const url = `${CMC_API_BASE}/cryptocurrency/info?address=${encodeURIComponent(tokenAddress)}`;
    const payload = await curlJson(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        "X-CMC_PRO_API_KEY": apiKey
      }
    });
    const data = payload?.data || {};
    const assets = [];
    if (Array.isArray(data)) {
      assets.push(...data.filter((item) => item && typeof item === "object"));
    } else if (data && typeof data === "object") {
      for (const value of Object.values(data)) {
        if (Array.isArray(value)) assets.push(...value.filter((item) => item && typeof item === "object"));
        else if (value && typeof value === "object") assets.push(value);
      }
    }
    return mergeMetadataEntries([], assets.map((asset) => {
      const homepage = Array.isArray(asset?.urls?.website) ? asset.urls.website.find(Boolean) || "" : "";
      return metadataSourceEntry("coinmarketcap", asset.description || "", homepage, asset.name || "");
    }));
  } catch {
    return [];
  }
}

function base58Decode(value) {
  let number = 0n;
  for (const char of String(value || "")) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base58 character: ${char}`);
    number = number * 58n + BigInt(index);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  for (const char of String(value || "")) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function base58Encode(buffer) {
  let number = 0n;
  for (const byte of buffer) number = (number << 8n) + BigInt(byte);
  let encoded = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    number /= 58n;
    encoded = BASE58_ALPHABET[remainder] + encoded;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let current = ((base % modulus) + modulus) % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * current) % modulus;
    current = (current * current) % modulus;
    power >>= 1n;
  }
  return result;
}

function modInverse(value, modulus) {
  return modPow(value, modulus - 2n, modulus);
}

function ed25519IsOnCurve(publicKey) {
  if (publicKey.length !== 32) return false;
  const p = (1n << 255n) - 19n;
  const d = ((-121665n * modInverse(121666n, p)) % p + p) % p;
  const y = BigInt(`0x${Buffer.from(publicKey).reverse().toString("hex")}`) & ((1n << 255n) - 1n);
  if (y >= p) return false;
  const y2 = (y * y) % p;
  const numerator = (y2 - 1n + p) % p;
  const denominator = (d * y2 + 1n) % p;
  if (denominator === 0n) return false;
  const x2 = (numerator * modInverse(denominator, p)) % p;
  if (x2 === 0n) return true;
  return modPow(x2, (p - 1n) / 2n, p) === 1n;
}

function createProgramAddress(seeds, programId) {
  const marker = Buffer.from("ProgramDerivedAddress");
  const digest = createHash("sha256").update(Buffer.concat([...seeds, programId, marker])).digest();
  if (ed25519IsOnCurve(digest)) throw new Error("Derived address is on curve");
  return digest;
}

function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump -= 1) {
    try {
      return createProgramAddress([...seeds, Buffer.from([bump])], programId);
    } catch {
      // Try next bump.
    }
  }
  throw new Error("Could not find a valid program address");
}

function parseBorshString(buffer, offset) {
  if (offset + 4 > buffer.length) return { value: "", offset: buffer.length };
  const length = buffer.readUInt32LE(offset);
  const start = offset + 4;
  const end = Math.min(start + length, buffer.length);
  return {
    value: buffer.subarray(start, end).toString("utf8").replace(/\0+$/g, ""),
    offset: end
  };
}

function solanaMetadataPda(mintAddress) {
  const programId = base58Decode(SOLANA_METADATA_PROGRAM_ID);
  const mint = base58Decode(mintAddress);
  return base58Encode(findProgramAddress([Buffer.from("metadata"), programId, mint], programId));
}

function parseSolanaMetadataAccount(accountData) {
  let offset = 1 + 32 + 32;
  const name = parseBorshString(accountData, offset);
  offset = name.offset;
  const symbol = parseBorshString(accountData, offset);
  offset = symbol.offset;
  const uri = parseBorshString(accountData, offset);
  return { name: name.value, symbol: symbol.value, uri: uri.value };
}

async function querySolanaMetaplexMetadata(chainId, tokenAddress, options = {}) {
  if (!isSolanaChain(chainId)) return [];
  try {
    const metadataAccount = solanaMetadataPda(tokenAddress);
    const rpcUrl = String(process.env.SOLANA_RPC_URL || SOLANA_RPC_URL).trim();
    const response = await postJson(rpcUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [metadataAccount, { encoding: "base64", commitment: "confirmed" }]
    }, options);
    const encoded = response?.result?.value?.data?.[0];
    if (!encoded) return [];
    const parsed = parseSolanaMetadataAccount(Buffer.from(encoded, "base64"));
    const metadataUrl = normalizeUrl(parsed.uri || "");
    const metadataJson = metadataUrl ? await curlJson(metadataUrl, options).catch(() => ({})) : {};
    return mergeMetadataEntries([], [
      metadataSourceEntry(
        "solana_metaplex",
        metadataJson?.description || "",
        metadataJson?.external_url || metadataUrl,
        metadataJson?.name || parsed.name || ""
      )
    ]);
  } catch {
    return [];
  }
}

function explorerConfigForChain(chainId) {
  const key = String(chainId || "").trim().toLowerCase();
  const configs = {
    bsc: { id: "bscscan", baseUrl: "https://bscscan.com" },
    bnb: { id: "bscscan", baseUrl: "https://bscscan.com" },
    ethereum: { id: "etherscan", baseUrl: "https://etherscan.io" },
    eth: { id: "etherscan", baseUrl: "https://etherscan.io" },
    base: { id: "basescan", baseUrl: "https://basescan.org" },
    arbitrum: { id: "arbiscan", baseUrl: "https://arbiscan.io" },
    polygon: { id: "polygonscan", baseUrl: "https://polygonscan.com" },
    polygon_pos: { id: "polygonscan", baseUrl: "https://polygonscan.com" },
    avalanche: { id: "snowtrace", baseUrl: "https://snowtrace.io" },
    avax: { id: "snowtrace", baseUrl: "https://snowtrace.io" }
  };
  return configs[key] || null;
}

function htmlAttributeValue(attributes, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i");
  return decodeHtmlEntities(attributes.match(pattern)?.[1] || "");
}

function metaContent(html, names = []) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const metaPattern = /<meta\b([^>]*)>/gi;
  let match;
  while ((match = metaPattern.exec(String(html || "")))) {
    const attributes = match[1] || "";
    const key = htmlAttributeValue(attributes, "name") || htmlAttributeValue(attributes, "property");
    if (!wanted.has(key.toLowerCase())) continue;
    const content = htmlAttributeValue(attributes, "content");
    if (content) return content.replace(/\s+/g, " ").trim();
  }
  return "";
}

function parseExplorerTokenLabel(html) {
  const direct = String(html || "").match(/>\s*Token\s*<\/[^>]+>\s*([^<>{}]{2,140}?)\s*<span[^>]*>\s*\(([^<]{1,60})\)\s*<\/span>/i);
  if (direct) {
    return {
      name: decodeHtmlEntities(stripHtml(direct[1])).replace(/\s+/g, " ").trim(),
      symbol: decodeHtmlEntities(stripHtml(direct[2])).replace(/\s+/g, " ").trim()
    };
  }
  const text = decodeHtmlEntities(stripHtml(html)).replace(/\s+/g, " ").trim();
  const fromText = text.match(/\bToken\s+(.{2,120}?)\s+\(([^()]{1,60})\)\s+(?:Reputation|Buy|Play|Gaming|BEP-|ERC-|Source Code)/i);
  if (!fromText) return { name: "", symbol: "" };
  return {
    name: fromText[1].trim(),
    symbol: fromText[2].trim()
  };
}

function parseExplorerTokenMetadata(html) {
  const pageTitle = decodeHtmlEntities(String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  const metaDescription = metaContent(html, ["description", "og:description", "twitter:description"]);
  const { name, symbol } = parseExplorerTokenLabel(html);
  const standard = (
    String(html || "").match(/>\s*((?:BEP|ERC)-(?:20|721|1155))\s*</i)?.[1] ||
    pageTitle.match(/\b((?:BEP|ERC)-(?:20|721|1155))\b/i)?.[1] ||
    ""
  ).toUpperCase();
  const holders = metaDescription.match(/\bHolders:\s*([0-9,]+)/i)?.[1] || "";
  const transactions = metaDescription.match(/\bTransactions:\s*([0-9,]+)/i)?.[1] || "";
  const supply = decodeHtmlEntities(
    String(html || "").match(/Max Total Supply[\s\S]{0,420}?title=['"]([^'"]+)['"]/i)?.[1] || ""
  ).replace(/\s+/g, " ").replace(/,\s+/g, ",").trim();
  const contractVerified = /Contract:\s*Verified/i.test(metaDescription) || /Source Code/i.test(String(html || ""));

  if (!name && !symbol && !standard && !contractVerified) return null;

  const title = [name, symbol ? `$${symbol}` : ""].filter(Boolean).join(" ");
  const identity = title ? `「${name}${symbol ? `（${symbol}）` : ""}」` : "";
  const parts = [];
  if (standard) parts.push(`${standard} 代币`);
  else if (contractVerified) parts.push("已验证合约");

  let description = identity
    ? `链上浏览器标识为${parts.join("/") || "代币"}${identity}`
    : `链上浏览器仅返回${parts.join("/") || "合约"}信息`;
  if (supply) description += `，最大供应 ${supply}`;
  if (holders) description += `，持有人 ${holders}`;
  if (!holders && transactions) description += `，交易数 ${transactions}`;
  description += "。";

  return { title, description };
}

function parseSolscanTokenMetadata(html, tokenAddress) {
  const pageTitle = decodeHtmlEntities(String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  const metaDescription = metaContent(html, ["description", "og:description", "twitter:description"]);
  const text = decodeHtmlEntities(stripHtml(html)).replace(/\s+/g, " ").trim();
  const titleMatch = pageTitle.match(/^(.+?)(?:\s+\(([^()]{1,40})\))?\s*(?:Token)?\s*\|\s*Solscan/i);
  const textMatch = text.match(/\bToken\s+(.{2,80}?)\s+\(([^()]{1,40})\)\s+(?:Price|Holders|Supply|Market|Transfers)/i);
  const name = (textMatch?.[1] || titleMatch?.[1] || "").replace(/\s*-\s*Solscan$/i, "").trim();
  const symbol = (textMatch?.[2] || titleMatch?.[2] || "").trim();
  const holders = text.match(/\bHolders?\s*([0-9,]+)/i)?.[1] || "";
  const supply = text.match(/\b(?:Total\s+)?Supply\s*([0-9][0-9,.\s]*)/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
  const externalLinks = [
    /\b(?:Website|Official Site)\s*(https?:\/\/[^\s<>"']+)/i,
    /\b(?:Twitter|X)\s*(https?:\/\/(?:x\.com|twitter\.com)\/[^\s<>"']+)/i,
    /\bTelegram\s*(https?:\/\/t\.me\/[^\s<>"']+)/i
  ].map((pattern) => text.match(pattern)?.[1]).filter(Boolean);

  if (!name && !symbol && isLowSignalMetadataText(metaDescription)) return null;
  if (/solscan|block explorer|search api analytics/i.test(name)) return null;

  const identity = name || symbol ? `「${name || symbol}${symbol && symbol !== name ? `（${symbol}）` : ""}」` : "";
  let description = identity
    ? `Solscan 标识为 Solana 代币${identity}`
    : `Solscan 返回该 Solana CA 的代币页面`;
  if (holders) description += `，持有人 ${holders}`;
  if (supply) description += `，供应 ${supply}`;
  if (externalLinks.length) description += `，页面含外部链接 ${externalLinks.slice(0, 3).join(" / ")}`;
  description += "。";
  return { title: [name, symbol ? `$${symbol}` : ""].filter(Boolean).join(" "), description };
}

async function querySolscanTokenMetadata(chainId, tokenAddress, options = {}) {
  if (!isSolanaChain(chainId)) return [];
  const address = String(tokenAddress || "").trim();
  if (!address) return [];
  const url = `https://solscan.io/token/${encodeURIComponent(address)}`;
  try {
    const html = await cachedCurlText(url, {
      ...options,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        ...(options.headers || {})
      }
    });
    const parsed = parseSolscanTokenMetadata(html, address);
    if (!parsed?.description) return [];
    return mergeMetadataEntries([], [
      metadataSourceEntry("solscan_token", parsed.description, url, parsed.title)
    ]);
  } catch {
    return [];
  }
}

async function queryChainExplorerMetadata(chainId, tokenAddress, options = {}) {
  const address = String(tokenAddress || "").trim();
  if (isSolanaChain(chainId)) return querySolscanTokenMetadata(chainId, address, options);
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return [];
  const explorer = explorerConfigForChain(chainId);
  if (!explorer) return [];
  const url = `${explorer.baseUrl}/token/${encodeURIComponent(address)}`;
  try {
    const html = await cachedCurlText(url, {
      ...options,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        ...(options.headers || {})
      }
    });
    const parsed = parseExplorerTokenMetadata(html);
    if (!parsed?.description) return [];
    return mergeMetadataEntries([], [
      metadataSourceEntry(`${explorer.id}_token`, parsed.description, url, parsed.title)
    ]);
  } catch {
    return [];
  }
}

function pageChainSlugs(chainId) {
  const key = String(chainId || "").trim().toLowerCase();
  const slugs = {
    solana: { gmgn: "sol", birdeye: "solana" },
    sol: { gmgn: "sol", birdeye: "solana" },
    bsc: { gmgn: "bsc", birdeye: "bsc" },
    bnb: { gmgn: "bsc", birdeye: "bsc" },
    ethereum: { gmgn: "eth", birdeye: "ethereum" },
    eth: { gmgn: "eth", birdeye: "ethereum" },
    base: { gmgn: "base", birdeye: "base" },
    arbitrum: { gmgn: "arb", birdeye: "arbitrum" },
    polygon: { gmgn: "polygon", birdeye: "polygon" }
  };
  return slugs[key] || {};
}

function knownTokenPageTargets(chainId, tokenAddress) {
  const address = String(tokenAddress || "").trim();
  if (!address) return [];
  const slugs = pageChainSlugs(chainId);
  const targets = [];
  if (slugs.gmgn) targets.push(["gmgn_page", `https://gmgn.ai/${slugs.gmgn}/token/${encodeURIComponent(address)}`]);
  if (slugs.birdeye) targets.push(["birdeye_page", `https://birdeye.so/token/${encodeURIComponent(address)}?chain=${encodeURIComponent(slugs.birdeye)}`]);
  targets.push(["dexscreener_search_page", `https://dexscreener.com/search?q=${encodeURIComponent(address)}`]);
  return targets;
}

function pageMetaEntry(source, url, html, tokenAddress) {
  const title = decodeHtmlEntities(String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  const description = metaContent(html, ["description", "og:description", "twitter:description"]);
  const text = [title, description].filter(Boolean).join("。").replace(/\s+/g, " ").trim();
  if (!text || isLowSignalMetadataText(text)) return null;
  const address = String(tokenAddress || "").trim();
  const addressHint = address.length >= 10 && String(html || "").toLowerCase().includes(address.toLowerCase());
  const looksTokenPage = /token|price|market cap|liquidity|holders?|volume|gmgn|birdeye|dexscreener|buy|swap/i.test(text);
  if (!addressHint && !looksTokenPage) return null;
  return metadataSourceEntry(source, text, url, title);
}

async function queryKnownTokenPages(card, dex = {}, options = {}) {
  const chainId = dex.chainId || card.chain || "";
  const tokenAddress = dex.tokenAddress || card.address || "";
  const targets = knownTokenPageTargets(chainId, tokenAddress).slice(0, 3);
  let entries = [];
  for (const [source, url] of targets) {
    try {
      const html = await cachedCurlText(url, {
        ...options,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          ...(options.headers || {})
        }
      });
      const entry = pageMetaEntry(source, url, html, tokenAddress);
      if (entry) entries = mergeMetadataEntries(entries, [entry]);
      if (bestMetadataDescription(entries)) break;
    } catch {
      // Keep probing the next known token page.
    }
  }
  return entries;
}

function resultUrlFromDuckDuckGo(value) {
  const url = decodeHtmlEntities(value).replace(/^\/\//, "https://");
  try {
    const parsed = new URL(url);
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url;
  } catch {
    return url;
  }
}

function parseDuckDuckGoResults(html, maxResults) {
  const results = [];
  const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = resultPattern.exec(html)) && results.length < maxResults) {
    const url = resultUrlFromDuckDuckGo(match[1]);
    const title = decodeHtmlEntities(stripHtml(match[2])).replace(/\s+/g, " ").trim();
    const snippet = decodeHtmlEntities(stripHtml(match[3])).replace(/\s+/g, " ").trim();
    if (!title && !snippet) continue;
    results.push(metadataSourceEntry("ca_search", snippet, url, title));
  }
  return mergeMetadataEntries([], results);
}

async function queryContractAddressSearch(card, dex = {}, options = {}) {
  if (!caSearchEnabled(options.caSearchEnabled)) return [];
  const maxResults = boundedNumber(process.env.TOKEN_CA_SEARCH_MAX_RESULTS || options.caSearchMaxResults || 3, 3, 1, 8);
  const tokenTitle = [dex.tokenName || card.name || "", dex.tokenSymbol || card.ticker || ""].filter(Boolean).join(" ");
  const query = [card.address, tokenTitle, dex.chainId || card.chain || "", "crypto token"].filter(Boolean).join(" ");
  try {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await cachedCurlText(url, {
      ...options,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        ...(options.headers || {})
      }
    });
    return parseDuckDuckGoResults(html, maxResults);
  } catch {
    return [];
  }
}

export async function queryTokenMetadataSources(card, dex = {}, options = {}) {
  if (!metadataEnabled(options.metadataEnabled)) return [];
  const chainId = dex.chainId || card.chain || "";
  const tokenAddress = dex.tokenAddress || card.address || "";
  if (!tokenAddress) return [];
  const enabled = new Set(configuredMetadataSources(options.metadataSources));
  let entries = [];
  const pairEntry = metadataSourceEntry(
    "dexscreener_pair",
    dex.description || "",
    dex.pairUrl || "",
    dex.tokenName || card.name || ""
  );
  entries = mergeMetadataEntries(entries, [pairEntry]);
  if (chainId && [...enabled].some((source) => source.startsWith("dexscreener_"))) {
    entries = mergeMetadataEntries(entries, await queryDexScreenerMetadataSources(chainId, tokenAddress, options));
  }
  if (chainId && enabled.has("pumpfun")) {
    entries = mergeMetadataEntries(entries, await queryPumpFunMetadata(chainId, tokenAddress, options));
  }
  if (chainId && enabled.has("geckoterminal")) {
    entries = mergeMetadataEntries(entries, await queryGeckoTerminalMetadata(chainId, tokenAddress, options));
  }
  if (chainId && enabled.has("coingecko")) {
    entries = mergeMetadataEntries(entries, await queryCoinGeckoMetadata(chainId, tokenAddress, options));
  }
  if (enabled.has("coinmarketcap")) {
    entries = mergeMetadataEntries(entries, await queryCoinMarketCapMetadata(tokenAddress, options));
  }
  if (chainId && enabled.has("jupiter")) {
    entries = mergeMetadataEntries(entries, await queryJupiterTokenMetadata(chainId, tokenAddress, options));
  }
  if (chainId && enabled.has("solana_metaplex")) {
    entries = mergeMetadataEntries(entries, await querySolanaMetaplexMetadata(chainId, tokenAddress, options));
  }
  if (chainId && enabled.has("chain_explorer")) {
    entries = mergeMetadataEntries(entries, await queryChainExplorerMetadata(chainId, tokenAddress, options));
  }
  if (enabled.has("ca_pages") && !bestMetadataDescription(entries)) {
    entries = mergeMetadataEntries(entries, await queryKnownTokenPages(card, dex, options));
  }
  if (enabled.has("ca_search") && !bestMetadataDescription(entries)) {
    entries = mergeMetadataEntries(entries, await queryContractAddressSearch(card, dex, options));
  }
  return entries;
}

export function mergeDexNarrative(card, dex, metadataSources = []) {
  const parts = [];
  if (card.narrative) parts.push(card.narrative);
  const metadataDescription = bestMetadataDescription(metadataSources);
  if (metadataDescription) parts.push(metadataDescription);
  const tokenTitle = [dex.tokenName, dex.tokenSymbol ? `$${dex.tokenSymbol}` : ""].filter(Boolean).join(" ");
  if (tokenTitle) parts.push(tokenTitle);
  if (dex.websites?.length) parts.push(`website: ${dex.websites[0]}`);
  if (dex.socials?.length) parts.push(`social: ${dex.socials[0]}`);
  return [...new Set(parts)].join(" | ").slice(0, 360);
}

export function buildOnChainNarrative(dex) {
  if (!dex?.found) return "";
  const title = [dex.tokenName, dex.tokenSymbol ? `$${dex.tokenSymbol}` : ""].filter(Boolean).join(" ");
  const venue = [chainName(dex.chainId), dex.dexId].filter(Boolean).join(" / ");
  const metrics = [
    dex.marketCap ? `MC ${compactNumber(dex.marketCap) || dex.marketCap}` : "",
    dex.liquidityUsd ? `LP ${compactNumber(dex.liquidityUsd) || dex.liquidityUsd}` : "",
    dex.volume24h ? `24h Vol ${compactNumber(dex.volume24h) || dex.volume24h}` : "",
    dex.txns24h ? `24h Tx ${dex.txns24h}` : "",
    dex.priceChange24h !== "" ? `24h ${dex.priceChange24h}%` : ""
  ].filter(Boolean);
  const assets = [
    dex.labels?.length ? `标签 ${dex.labels.join("/")}` : "",
    dex.websites?.length ? "有官网" : "",
    dex.socials?.length ? `有社媒 ${dex.socials.map((item) => item.split(":")[0]).filter(Boolean).join("/")}` : ""
  ].filter(Boolean);
  return [
    title ? `项目: ${title}` : "",
    venue ? `链/DEX: ${venue}` : "",
    metrics.length ? `数据: ${metrics.join(", ")}` : "",
    assets.length ? `外部痕迹: ${assets.join(", ")}` : ""
  ].filter(Boolean).join("\n").slice(0, 500);
}

export function buildSignalNarrative(card) {
  const lines = [];
  const stories = Array.isArray(card.sourceStories) && card.sourceStories.length
    ? card.sourceStories
    : [card.narrative].filter(Boolean);
  if (stories.length) lines.push(`讲了什么: ${stories.slice(0, 2).map(translateSignalStory).join(" / ")}`);
  return lines.join("\n").slice(0, 700);
}

export async function enrichContractCard(card, options = {}) {
  const signalNarrative = buildSignalNarrative(card);
  try {
    const dex = await fetchDexScreener(card.address, options);
    if (!dex.found) {
      const metadataSources = await queryTokenMetadataSources(card, dex, fallbackMetadataOptions(options));
      const metadataDescription = bestMetadataDescription(metadataSources);
      const metadataIdentity = tokenIdentityFromMetadata(metadataSources);
      return {
        ...card,
        dexFound: false,
        dexPairsFound: dex.pairsFound || 0,
        ticker: card.ticker || metadataIdentity.ticker || "",
        name: card.name || metadataIdentity.name || "",
        onChainTimeSource: "dexscreener",
        signalNarrative,
        metadataSources,
        metadataDescription,
        metadataSourceCount: metadataSources.length,
        briefNarrative: buildBriefNarrative(card, dex, metadataSources),
        narrative: mergeDexNarrative(card, dex, metadataSources)
      };
    }
    const metadataSources = await queryTokenMetadataSources(card, dex, options);
    const metadataDescription = bestMetadataDescription(metadataSources);
    return {
      ...card,
      dexFound: true,
      dexPairsFound: dex.pairsFound || 0,
      chain: card.chain || String(dex.chainId || "").toUpperCase(),
      dexId: dex.dexId || "",
      pairUrl: dex.pairUrl || "",
      pairAddress: dex.pairAddress || "",
      pairCreatedAt: dex.pairCreatedAt || "",
      onChainTimeSource: "dexscreener:pairCreatedAt",
      ticker: card.ticker || dex.tokenSymbol || "",
      name: card.name || dex.tokenName || "",
      marketCap: card.marketCap || String(dex.marketCap || ""),
      liquidity: card.liquidity || String(dex.liquidityUsd || ""),
      volume24h: card.volume24h || String(dex.volume24h || ""),
      change24h: card.change24h || String(dex.priceChange24h || ""),
      hasDexscreener: dex.pairUrl ? "yes" : card.hasDexscreener,
      hasWebsite: dex.websites?.length ? "yes" : card.hasWebsite,
      hasTwitter: dex.socials?.some((item) => item.toLowerCase().includes("twitter") || item.toLowerCase().includes("x.com")) ? "yes" : card.hasTwitter,
      hasTelegram: dex.socials?.some((item) => item.toLowerCase().includes("telegram") || item.toLowerCase().includes("t.me")) ? "yes" : card.hasTelegram,
      onChainNarrative: buildOnChainNarrative(dex),
      signalNarrative,
      metadataSources,
      metadataDescription,
      metadataSourceCount: metadataSources.length,
      briefNarrative: buildBriefNarrative(card, dex, metadataSources),
      narrative: mergeDexNarrative(card, dex, metadataSources)
    };
  } catch (error) {
    let metadataSources = [];
    try {
      metadataSources = await queryTokenMetadataSources(card, {}, fallbackMetadataOptions(options));
    } catch {
      metadataSources = [];
    }
    const metadataDescription = bestMetadataDescription(metadataSources);
    const metadataIdentity = tokenIdentityFromMetadata(metadataSources);
    return {
      ...card,
      dexFound: false,
      dexError: error.message,
      ticker: card.ticker || metadataIdentity.ticker || "",
      name: card.name || metadataIdentity.name || "",
      onChainTimeSource: "dexscreener",
      signalNarrative,
      metadataSources,
      metadataDescription,
      metadataSourceCount: metadataSources.length,
      briefNarrative: buildBriefNarrative(card, {}, metadataSources),
      narrative: mergeDexNarrative(card, {}, metadataSources)
    };
  }
}

export async function enrichContractCards(cards, options = {}) {
  const rpm = configuredDexRequestsPerMinute(options.requestsPerMinute);
  const delayMs = options.delayMs ?? dexRequestDelayMs(rpm);
  const concurrency = boundedNumber(
    options.concurrency || process.env.DEXSCREENER_CONCURRENCY || DEFAULT_DEXSCREENER_CONCURRENCY,
    DEFAULT_DEXSCREENER_CONCURRENCY,
    1,
    8
  );
  const enriched = new Array(cards.length);
  let nextIndex = 0;
  let completed = 0;
  let nextLaunchAt = Date.now();

  async function waitForRequestSlot() {
    const now = Date.now();
    const waitMs = Math.max(0, nextLaunchAt - now);
    nextLaunchAt = Math.max(now, nextLaunchAt) + delayMs;
    if (waitMs > 0) await sleep(waitMs);
  }

  async function worker() {
    while (nextIndex < cards.length) {
      const index = nextIndex;
      nextIndex += 1;
      await waitForRequestSlot();
      enriched[index] = await enrichContractCard(cards[index], options);
      completed += 1;
      if (typeof options.onProgress === "function") {
        options.onProgress({
          completed,
          total: cards.length,
          found: enriched.filter((item) => item?.dexFound).length
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cards.length) }, () => worker()));
  return {
    cards: enriched,
    rateLimit: {
      provider: "dexscreener",
      endpoint: "/latest/dex/search + metadata sources",
      officialRequestsPerMinute: DEXSCREENER_SEARCH_LIMIT_PER_MINUTE,
      configuredRequestsPerMinute: rpm,
      delayMs,
      concurrency,
      metadataEnabled: metadataEnabled(options.metadataEnabled),
      metadataSources: configuredMetadataSources(options.metadataSources),
      timeoutSeconds: boundedNumber(
        options.timeoutSeconds || process.env.DEXSCREENER_TIMEOUT_SECONDS || DEFAULT_DEXSCREENER_TIMEOUT_SECONDS,
        DEFAULT_DEXSCREENER_TIMEOUT_SECONDS,
        3,
        30
      )
    }
  };
}
