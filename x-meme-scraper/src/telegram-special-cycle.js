import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { loadLocalEnv, parseSocksProxy } from "./local-env.js";
import {
  annotateRepeatedContracts,
  buildContractCards,
  extractContractAddresses,
  extractTokenInfo
} from "./telegram-contracts.js";
import {
  configuredDexProxy,
  configuredDexRequestsPerMinute,
  dexRequestDelayMs,
  enrichContractCards,
  hasUsableNarrative
} from "./token-enrichment.js";
import { acquireTelegramSendLock } from "./telegram-send-lock.js";

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");
const configPath = path.join(projectRoot, "config", "telegram-special-groups.json");
const MAX_MESSAGE_LENGTH = 3900;

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function mark(value) {
  if (value === "yes" || value === true) return "OK";
  if (value === "no" || value === false) return "NO";
  return "UNKNOWN";
}

function safeNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function contractKey(address) {
  const value = String(address || "").trim();
  return value.startsWith("0x") ? value.toLowerCase() : value;
}

function extractCardAddress(text) {
  return String(text || "").match(/^CA:\s*(\S+)/m)?.[1] || "";
}

function entityInfo(entity) {
  return {
    id: entity?.id?.toString?.() || "",
    title: String(entity?.title || entity?.username || entity?.firstName || "").trim(),
    username: String(entity?.username || "").trim()
  };
}

function matchesGroup(entity, group) {
  const info = entityInfo(entity);
  return Boolean(
    (group.id && info.id === String(group.id)) ||
    (group.username && normalize(info.username) === normalize(group.username)) ||
    (group.title && info.title === group.title) ||
    (group.name && info.title === group.name)
  );
}

function messageUrl(entity, messageId) {
  const info = entityInfo(entity);
  if (info.username) return `https://t.me/${info.username}/${messageId}`;
  if (info.id) return `https://t.me/c/${info.id}/${messageId}`;
  return "";
}

async function messageSenderInfo(message) {
  const senderId = message.senderId !== undefined ? String(message.senderId) : "";
  try {
    const sender = typeof message.getSender === "function" ? await message.getSender() : null;
    return {
      senderId,
      senderUsername: sender?.username || "",
      senderName: [sender?.firstName, sender?.lastName].filter(Boolean).join(" ")
    };
  } catch {
    return { senderId, senderUsername: "", senderName: "" };
  }
}

async function readConfig() {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  return {
    ...config,
    maxMessages: safeNumber(argValue("max", config.maxMessages || 500), 500, 1, 1000),
    sendLimit: safeNumber(argValue("sendLimit", config.sendLimit || 80), 80, 1, 1000),
    candidateLimit: safeNumber(argValue("candidateLimit", config.candidateLimit || 240), 240, 1, 1000),
    sendWindowMinutes: safeNumber(argValue("sendWindowMinutes", config.sendWindowMinutes || 30), 30, 1, 120),
    sendPerMinute: safeNumber(
      argValue("sendPerMinute", config.sendPerMinute || process.env.TELEGRAM_SPECIAL_SEND_PER_MINUTE || process.env.TELEGRAM_SEND_PER_MINUTE || 4),
      4,
      1,
      240
    ),
    dexRequestsPerMinute: configuredDexRequestsPerMinute(argValue("dexRpm", config.dexRequestsPerMinute || "")),
    dexProxy: configuredDexProxy(argValue("dexProxy", config.dexProxy || "")),
    dexTimeoutSeconds: safeNumber(argValue("dexTimeoutSeconds", config.dexTimeoutSeconds || process.env.DEXSCREENER_TIMEOUT_SECONDS || 8), 8, 3, 30),
    dexConcurrency: safeNumber(argValue("dexConcurrency", config.dexConcurrency || process.env.DEXSCREENER_CONCURRENCY || 4), 4, 1, 8),
    mentionWindowHours: safeNumber(argValue("mentionWindowHours", config.mentionWindowHours || 48), 48, 1, 168),
    onChainAgeHours: safeNumber(argValue("onChainAgeHours", config.onChainAgeHours || 12), 12, 1, 168),
    skipAlreadySent: boolValue(argValue("skipAlreadySent", config.skipAlreadySent), true)
  };
}

async function resolveEntityFromDialogs(client, matcher, label) {
  const dialogs = await withTimeout(client.getDialogs({ limit: 500 }), 90_000, "getDialogs");
  const entity = dialogs
    .map((dialog) => dialog.entity)
    .filter(Boolean)
    .find((item) => matcher(item));
  if (!entity) throw new Error(`Telegram dialog not found: ${label}`);
  return entity;
}

async function scrapeSpecialGroups(client, config) {
  const selected = (config.groups || []).filter((group) => group.selected !== false);
  console.log(`Resolving Telegram dialogs for ${selected.length} special groups...`);
  const dialogs = await withTimeout(client.getDialogs({ limit: 500 }), 90_000, "getDialogs");
  const entities = dialogs.map((dialog) => dialog.entity).filter(Boolean);
  const posts = [];
  const accounts = [];
  const errors = [];

  for (const group of selected) {
    const entity = entities.find((item) => matchesGroup(item, group));
    const label = group.name || group.title || group.username || group.id;
    if (!entity) {
      errors.push({ target: label, message: "dialog not found" });
      continue;
    }

    try {
      const info = entityInfo(entity);
      console.log(`Scanning special group: ${label}; max ${config.maxMessages}`);
      const messages = await withTimeout(
        client.getMessages(entity, { limit: config.maxMessages }),
        90_000,
        `getMessages ${label}`
      );
      let matched = 0;
      for (const message of messages) {
        const text = message.message || "";
        const contractAddresses = extractContractAddresses(text);
        if (config.contractOnly !== false && !contractAddresses.length) continue;
        const tokenInfo = extractTokenInfo(text);
        const sender = await messageSenderInfo(message);
        matched += 1;
        posts.push({
          id: String(message.id),
          platform: "telegram",
          group: info.title || label,
          groupId: info.id,
          authorHandle: info.username || info.title || label,
          senderId: sender.senderId,
          senderUsername: sender.senderUsername,
          senderName: sender.senderName,
          publishedAt: message.date ? new Date(message.date * 1000).toISOString() : null,
          text,
          memeScore: 0,
          contractAddresses,
          tokenInfo,
          url: messageUrl(entity, message.id),
          scrapedAt: new Date().toISOString()
        });
      }
      accounts.push({ target: label, id: info.id, username: info.username, scanned: messages.length, matched });
      console.log(`Scanned special group: ${label}; messages ${messages.length}; CA posts ${matched}`);
    } catch (error) {
      errors.push({ target: label, message: error.message });
      console.log(`Special group error: ${label}; ${error.message}`);
    }
  }

  posts.sort((left, right) => String(right.publishedAt || "").localeCompare(String(left.publishedAt || "")));
  return { posts, accounts, errors };
}

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return String(value || "UNKNOWN");
  if (number >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(2)}B`;
  if (number >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `$${(number / 1_000).toFixed(1)}K`;
  return `$${number.toFixed(number >= 10 ? 0 : 2)}`;
}

function compactPlainNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "UNKNOWN";
  const number = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(number)) return raw;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number);
}

function formatPercent(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "UNKNOWN";
  const number = Number(raw.replace(/[%+\s]/g, ""));
  if (!Number.isFinite(number)) return raw;
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(Math.abs(number) >= 10 ? 1 : 2)}%`;
}

function formatAgeAgo(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "UNKNOWN";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days}d ago`;
  if (hours >= 1) return `${hours}h ago`;
  if (minutes >= 1) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

function okMark(value) {
  return value === "yes" || value === true ? "✅" : "❌";
}

function cleanTokenTitlePart(value) {
  return String(value || "").trim().replace(/^\$+/, "").trim();
}

function displayTokenTitle(card) {
  const name = cleanTokenTitlePart(card.name);
  const ticker = cleanTokenTitlePart(card.ticker);
  const title = name && ticker && normalize(name) !== normalize(ticker)
    ? `${name} (${ticker})`
    : name || ticker;
  if (!title) return "$UNKNOWN";
  return title.startsWith("$") ? title : `$${title}`;
}

function displayChain(card) {
  const chain = String(card.chain || "").trim().toUpperCase();
  if (chain === "ETHEREUM") return "ETH";
  if (chain === "SOLANA") return "SOL";
  return chain || "UNKNOWN";
}

function mentionCountInWindow(card, hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const timestamps = Array.isArray(card.mentionTimestamps) ? card.mentionTimestamps : [];
  const count = timestamps.filter((value) => {
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  }).length;
  return count || card.count || 1;
}

function senderDisplay(card) {
  return String(card.primarySender || card.sourceSenders?.[0] || "未知").replace(/^@+/, "").trim() || "未知";
}

function narrativeDisplay(card) {
  return String(card.briefNarrative || card.narrative || card.signalNarrative || "")
    .replace(/^讲了什么[:：]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360) || "暂未抓到明确叙事，当前只依据群内提及和链上交易数据做候选监控，后续需要用项目方推文、官网或社群原文继续验证。";
}

function marketMetricsLine(card) {
  return [
    `流动性: ${compactNumber(card.liquidity)}`,
    `24h量: ${compactNumber(card.volume24h)}`,
    `24h交易: ${compactPlainNumber(card.txns24h)}笔`,
    `24h涨跌: ${formatPercent(card.change24h)}`
  ].join(" | ");
}

function formatSpecialCard(card, mentionWindowHours = 48) {
  const lines = [];
  lines.push(`${displayTokenTitle(card)} - ${displayChain(card)}`);
  lines.push(card.address);
  lines.push("");
  lines.push("📈 交易信息");
  lines.push(`├开盘时间: ${formatAgeAgo(card.pairCreatedAt)}`);
  lines.push(`├市值: ${compactNumber(card.marketCap || card.fdv)}`);
  lines.push(`├${marketMetricsLine(card)}`);
  lines.push(`└ 🔗 推特${okMark(card.hasTwitter)} 电报${okMark(card.hasTelegram)} 官网${okMark(card.hasWebsite)} gmgn`);
  lines.push("");
  lines.push(`📚 叙事: ${narrativeDisplay(card)}`);
  lines.push("");
  lines.push(`📊 ${mentionWindowHours}小时内该CA被提到 ${mentionCountInWindow(card, mentionWindowHours)} 次`);
  lines.push("");
  lines.push(`👤 ${senderDisplay(card)} 💬 ${card.source || card.groups?.[0] || "Telegram"}`);
  return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

function sendDelayMs(count, minutes, perMinute) {
  if (count <= 0) return 0;
  const windowDelay = count > 1 ? Math.ceil((minutes * 60 * 1000) / (count - 1)) : 0;
  const rateLimitDelay = Math.ceil(60000 / Math.max(1, perMinute));
  return Math.max(2000, windowDelay, rateLimitDelay);
}

function dedupeWindowHours() {
  return safeNumber(argValue("dedupeHours", process.env.TELEGRAM_DEDUPE_HOURS || "10"), 10, 0, 720);
}

function sentRecently(sentAt, now = Date.now()) {
  const timestamp = Date.parse(sentAt || "");
  if (!Number.isFinite(timestamp)) return false;
  const windowMs = dedupeWindowHours() * 60 * 60 * 1000;
  return windowMs > 0 && timestamp >= now - windowMs;
}

function pairCreatedTimestamp(card) {
  const timestamp = Date.parse(card?.pairCreatedAt || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function withinOnChainAge(card, hours) {
  const timestamp = pairCreatedTimestamp(card);
  if (timestamp === null) return false;
  return timestamp >= Date.now() - hours * 60 * 60 * 1000;
}

function oldestOnChainFirst(left, right) {
  return (pairCreatedTimestamp(left) || 0) - (pairCreatedTimestamp(right) || 0);
}

async function sendMessageWithFloodWait(client, target, message) {
  let sent = false;
  while (!sent) {
    try {
      await withTimeout(
        client.sendMessage(target, {
          message: String(message || "").slice(0, MAX_MESSAGE_LENGTH),
          linkPreview: false
        }),
        60_000,
        "sendMessage"
      );
      sent = true;
    } catch (error) {
      const waitSeconds = Number(String(error.message || "").match(/wait of (\d+) seconds/i)?.[1] || 0);
      if (!waitSeconds) throw error;
      const waitMs = (waitSeconds + 5) * 1000;
      console.log(`Telegram flood wait ${waitSeconds}s; retrying after ${Math.round(waitMs / 1000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function sentAddressesFromTelegram(client, target) {
  const sent = new Set();
  const now = Date.now();
  try {
    const messages = await withTimeout(client.getMessages(target, { limit: 1000 }), 90_000, "read sent Telegram history");
    for (const message of messages) {
      const address = extractCardAddress(message.message || "");
      const sentAt = message.date ? new Date(message.date * 1000).toISOString() : "";
      if (address && sentRecently(sentAt, now)) sent.add(contractKey(address));
    }
  } catch (error) {
    console.log(`Could not read sent Telegram history: ${error.message}`);
  }
  return sent;
}

function preparedOutputPath(source) {
  const provided = argValue("preparedOutput", "");
  if (provided) return path.resolve(projectRoot, provided);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dataDir, `telegram-prepared-${source}-${timestamp}.json`);
}

async function writePreparedOutput(prepared, source) {
  const outputPath = preparedOutputPath(source);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(prepared, null, 2)}\n`, "utf8");
  console.log(`Prepared JSON: ${outputPath}`);
  return outputPath;
}

function preparedBatchPath(source, index) {
  const provided = argValue("preparedOutput", "");
  const suffix = `batch-${String(index).padStart(2, "0")}`;
  if (provided) {
    const resolved = path.resolve(projectRoot, provided);
    return resolved.replace(/\.json$/i, `-${suffix}.json`);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dataDir, `telegram-prepared-${source}-${timestamp}-${suffix}.json`);
}

async function writePreparedBatch(prepared, source, index) {
  const outputPath = preparedBatchPath(source, index);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(prepared, null, 2)}\n`, "utf8");
  console.log(`Prepared batch JSON: ${outputPath}`);
  return outputPath;
}

function launchPreparedSender(inputPath) {
  console.log(`Launching prepared sender: ${inputPath}`);
  const child = spawn(process.execPath, ["./src/telegram-prepared-sender.js", "--input", inputPath], {
    cwd: projectRoot,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    detached: true
  });
  child.unref();
}

function mentionTimestamp(card) {
  const timestamp = Date.parse(card?.lastMentionAt || card?.firstMentionAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function selectSpecialBaseCards(payload) {
  const allCards = buildContractCards(payload, Number.POSITIVE_INFINITY)
    .sort((left, right) => mentionTimestamp(right) - mentionTimestamp(left));
  console.log(`Special candidate selection: ${allCards.length}; all CAs, recent mention first, no repeat-count cap.`);
  return allCards;
}

async function enrichSpecialCards(cards, config, label = "") {
  console.log(`Building special cards${label ? ` ${label}` : ""}: ${cards.length}; enriching via DexScreener...`);
  return enrichContractCards(cards, {
    requestsPerMinute: config.dexRequestsPerMinute,
    delayMs: dexRequestDelayMs(config.dexRequestsPerMinute),
    proxy: config.dexProxy,
    timeoutSeconds: config.dexTimeoutSeconds,
    concurrency: config.dexConcurrency,
    onProgress: ({ completed, total, found }) => {
      if (completed === 1 || completed % 20 === 0 || completed === total) {
        console.log(`DexScreener enriched ${completed}/${total}; found ${found}.`);
      }
    }
  });
}

function filterSpecialCards(enrichedCards, config) {
  return enrichedCards
    .filter((card) => withinOnChainAge(card, config.onChainAgeHours))
    .filter(hasUsableNarrative)
    .sort(oldestOnChainFirst);
}

function buildSpecialPreparedFromCards(cards, config) {
  return {
    source: "telegram-special",
    generatedAt: new Date().toISOString(),
    sendWindowMinutes: config.sendWindowMinutes,
    sendPerMinute: config.sendPerMinute,
    items: cards.map((card) => ({
      source: "telegram-special",
      target: { mode: "dialog", ...(config.notifyTarget || {}) },
      address: card.address,
      pairCreatedAt: card.pairCreatedAt || "",
      rank: card.rank,
      count: mentionCountInWindow(card, config.mentionWindowHours),
      history: "special",
      message: formatSpecialCard(card, config.mentionWindowHours)
    }))
  };
}

async function streamSpecialBatches(config, payload) {
  const baseCards = selectSpecialBaseCards(payload);
  const batchSize = safeNumber(argValue("batchSize", process.env.TELEGRAM_SPECIAL_BATCH_SIZE || 80), 80, 20, 250);
  const allEligible = [];
  let foundTotal = 0;
  let launched = 0;
  for (let offset = 0, batch = 1; offset < baseCards.length; offset += batchSize, batch += 1) {
    const chunk = baseCards.slice(offset, offset + batchSize);
    const { cards: enrichedCards, rateLimit } = await enrichSpecialCards(chunk, config, `batch ${batch}`);
    foundTotal += enrichedCards.filter((card) => card.dexFound).length;
    const cards = filterSpecialCards(enrichedCards, config);
    allEligible.push(...cards);
    console.log(
      `Special batch ${batch}: ${enrichedCards.filter((card) => card.dexFound).length}/${enrichedCards.length} found; ` +
      `eligible ${cards.length}; ${rateLimit.configuredRequestsPerMinute}/min.`
    );
    if (cards.length) {
      const preparedPath = await writePreparedBatch(buildSpecialPreparedFromCards(cards, config), "special", batch);
      launchPreparedSender(preparedPath);
      launched += 1;
    }
  }
  console.log(
    `Special streaming complete: ${foundTotal}/${baseCards.length} found; ` +
    `eligible ${allEligible.length}; launched ${launched} sender batch(es).`
  );
  return { sent: 0, cards: allEligible.length, streamBatches: true, launched };
}

async function buildSpecialPrepared(config, payload) {
  const baseCards = selectSpecialBaseCards(payload);
  const { cards: enrichedCards, rateLimit } = await enrichSpecialCards(baseCards, config);
  const cards = enrichedCards
    .filter((card) => withinOnChainAge(card, config.onChainAgeHours))
    .filter(hasUsableNarrative)
    .sort(oldestOnChainFirst);
  console.log(
    `DexScreener enrichment: ${enrichedCards.filter((card) => card.dexFound).length}/${enrichedCards.length}; ` +
    `${rateLimit.configuredRequestsPerMinute}/min. Eligible ${cards.length}: ` +
    `on-chain <=${config.onChainAgeHours}h + usable narrative, sent oldest first so newest appears last.`
  );
  const prepared = buildSpecialPreparedFromCards(cards, config);
  return { cards, prepared };
}

async function notifySpecial(client, config, payload) {
  if (argValue("streamBatches", "false") === "true") {
    return streamSpecialBatches(config, payload);
  }
  const { cards, prepared } = await buildSpecialPrepared(config, payload);
  if (argValue("prepareOnly", "false") === "true") {
    const preparedPath = await writePreparedOutput(prepared, "special");
    return { sent: 0, cards: cards.length, preparedPath, prepareOnly: true };
  }

  const target = await resolveEntityFromDialogs(
    client,
    (entity) => matchesGroup(entity, config.notifyTarget || {}),
    config.notifyTarget?.title || config.notifyTarget?.id || "special notify target"
  );
  if (!cards.length) {
    await sendMessageWithFloodWait(client, target, `本轮没有发现 ${config.onChainAgeHours} 小时内且有明确叙事的 CA。`);
    return { sent: 1, cards: 0 };
  }
  const sentBefore = config.skipAlreadySent ? await sentAddressesFromTelegram(client, target) : new Set();
  const pendingCards = config.skipAlreadySent
    ? cards.filter((card) => !sentBefore.has(contractKey(card.address)))
    : cards;
  const skipped = cards.length - pendingCards.length;
  if (!pendingCards.length) {
    await sendMessageWithFloodWait(client, target, "\u672c\u8f6e\u7279\u6b8a\u7fa4\u6ca1\u6709\u65b0\u589e CA\u5361\u7247\u3002");
    return { sent: 1, cards: cards.length, skipped };
  }
  const delayMs = sendDelayMs(pendingCards.length, config.sendWindowMinutes, config.sendPerMinute);
  console.log(`Special Telegram pacing: ${pendingCards.length}/${cards.length} cards over ${config.sendWindowMinutes}m, max ${config.sendPerMinute}/min, delay ${Math.round(delayMs / 1000)}s, dedupe window ${dedupeWindowHours()}h, skipped=${skipped}.`);
  const releaseSendLock = await acquireTelegramSendLock("telegram-special-cycle");
  let sent = 0;
  try {
    for (let index = 0; index < pendingCards.length; index += 1) {
      const card = pendingCards[index];
      await sendMessageWithFloodWait(client, target, formatSpecialCard(card, config.mentionWindowHours));
      sent += 1;
      if (sent === 1 || sent % 20 === 0 || sent === pendingCards.length) {
        console.log(`Special Telegram sent ${sent}/${pendingCards.length}.`);
      }
      if (index < pendingCards.length - 1 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  } finally {
    await releaseSendLock();
  }
  return { sent, cards: cards.length, skipped };
}

async function writeOutputs(payload) {
  await fs.mkdir(dataDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(dataDir, `telegram-special-${timestamp}.json`);
  const csvPath = path.join(dataDir, `telegram-special-${timestamp}.csv`);
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const rows = [
    ["id", "group", "senderId", "senderUsername", "publishedAt", "contractAddresses", "repeatedContracts", "ticker", "name", "marketCap", "liquidity", "holders", "volume24h", "change24h", "narrative", "text", "url", "scrapedAt"].map(csvCell).join(","),
    ...payload.posts.map((post) => [
      post.id,
      post.group,
      post.senderId,
      post.senderUsername,
      post.publishedAt,
      (post.contractAddresses || []).join(" "),
      (post.repeatedContracts || []).join(" "),
      post.tokenInfo?.ticker || "",
      post.tokenInfo?.name || "",
      post.tokenInfo?.marketCap || "",
      post.tokenInfo?.liquidity || "",
      post.tokenInfo?.holders || "",
      post.tokenInfo?.volume24h || "",
      post.tokenInfo?.change24h || "",
      post.tokenInfo?.narrative || "",
      post.text,
      post.url,
      post.scrapedAt
    ].map(csvCell).join(","))
  ];
  await fs.writeFile(csvPath, `${rows.join("\n")}\n`, "utf8");
  return { jsonPath, csvPath };
}

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
  const stringSession = String(process.env.TELEGRAM_STRING_SESSION || "").trim();
  if (!apiId || !apiHash || !stringSession) throw new Error("Telegram session config is missing.");
  const config = await readConfig();
  const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
    connectionRetries: 5,
    proxy: parseSocksProxy(process.env.TELEGRAM_PROXY_URL)
  });
  await client.connect();
  try {
    const result = await scrapeSpecialGroups(client, config);
    const contractSummary = annotateRepeatedContracts(result.posts);
    const payload = {
      source: "telegram-special",
      targets: (config.groups || []).filter((group) => group.selected !== false).map((group) => group.name || group.title || group.username || group.id),
      notifyTarget: config.notifyTarget,
      filters: {
        maxMessages: config.maxMessages,
        sendLimit: config.sendLimit,
        candidateLimit: config.candidateLimit,
        sendWindowMinutes: config.sendWindowMinutes,
        sendPerMinute: config.sendPerMinute,
        dexRequestsPerMinute: config.dexRequestsPerMinute,
        dexTimeoutSeconds: config.dexTimeoutSeconds,
        dexConcurrency: config.dexConcurrency,
        mentionWindowHours: config.mentionWindowHours,
        onChainAgeHours: config.onChainAgeHours,
        skipAlreadySent: config.skipAlreadySent,
        contractOnly: config.contractOnly !== false
      },
      generatedAt: new Date().toISOString(),
      totalPosts: result.posts.length,
      contractSummary,
      accounts: result.accounts,
      errors: result.errors,
      posts: result.posts
    };
    const outputs = await writeOutputs(payload);
    const dryRun = argValue("dryRun", "false") === "true";
    const notifyResult = dryRun
      ? { sent: 0, cards: buildContractCards(payload, config.sendLimit).length, dryRun: true }
      : await notifySpecial(client, config, payload);
    console.log(`Special Telegram cycle complete: ${outputs.jsonPath}`);
    console.log(`CSV: ${outputs.csvPath}`);
    console.log(`Sent: ${notifyResult.sent}; cards: ${notifyResult.cards}; dryRun: ${Boolean(notifyResult.dryRun)}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
