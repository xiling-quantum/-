import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { loadLocalEnv, parseSocksProxy } from "./local-env.js";
import { sendTelegramNotification } from "./telegram-notify.js";
import { buildContractCards } from "./telegram-contracts.js";
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
const sentContractsPath = path.join(dataDir, "telegram-contract-sent.json");
const MAX_MESSAGE_LENGTH = 3900;

const EXCLUDE_GROUPS = [
  "Saved Messages",
  "\u7279\u6b8a\u7fa4",
  "3* CA",
  "\u7fa4\u804a\u6d88\u606f",
  "CA",
  "CryptoD\u5168\u5458\u7fa4\uff5c\u4e8c\u5a03\u805a\u5408",
  "\u7fa4\u4e3b\u53d1\u8a00\u7fa4",
  "Huang\u9ec4\u7fa4\uff08\u4e8c\u7ea7/MEME\uff09",
  "\u4e8c\u7ea7\u4ea4\u6613\u535a\u4e3b\u70b9\u4f4d\u7fa4",
  "\u534a\u5c0f\u65f6\u7fa4\u804aAI\u603b\u7ed3",
  "\u5e01\u5b89\u806a\u660e\u94b1\u5b9e\u76d8\uff5c\u4e8c\u5a03\u805a\u5408",
  "\u6bcf\u65e5\u603b\u7ed3\uff5c\u4e8c\u5a03\u805a\u5408",
  "\u6240\u6709\u7981\u8a00\u7fa4",
  "\u5931\u7720\u805a\u5408\u7fa4\u4ea4\u6d41",
  "\u4e8c\u5a03\u805a\u5408"
];

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

function formatTime(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestamp)).replaceAll("/", "-");
}

function compactNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "UNKNOWN";
  if (raw.startsWith("$")) return raw;
  const number = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return raw;
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

function mentionCountInWindow(card, hours = 48) {
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
    .slice(0, 360);
}

function marketMetricsLine(card) {
  return [
    `流动性: ${compactNumber(card.liquidity)}`,
    `24h量: ${compactNumber(card.volume24h)}`,
    `24h交易: ${compactPlainNumber(card.txns24h)}笔`,
    `24h涨跌: ${formatPercent(card.change24h)}`
  ].join(" | ");
}

function formatContractCard(card) {
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
  lines.push(`📊 48小时内该CA被提到 ${mentionCountInWindow(card, 48)} 次`);
  lines.push("");
  lines.push(`👤 ${senderDisplay(card)} 💬 ${card.source || card.groups?.[0] || "Telegram"}`);
  return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

function formatContractCards(payload) {
  const cards = buildContractCards(payload);
  if (!cards.length) return ["\u672c\u8f6e\u6ca1\u6709\u53d1\u73b0 CA\u3002"];
  return cards.map(formatContractCard);
}

function notifyTarget() {
  return String(process.env.TELEGRAM_NOTIFY_TARGET || "").trim();
}

function repeatNotifyTarget() {
  return String(argValue("repeatNotifyTarget", process.env.TELEGRAM_REPEAT_NOTIFY_TARGET || "3* CA")).trim();
}

function repeatThreshold() {
  const value = Number(argValue("repeatThreshold", process.env.TELEGRAM_REPEAT_THRESHOLD || "3"));
  return Number.isFinite(value) ? Math.max(2, Math.min(100, Math.trunc(value))) : 3;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function entityLabel(entity) {
  return String(entity?.title || entity?.username || entity?.firstName || entity?.id || "").trim();
}

function contractKey(address) {
  const value = String(address || "").trim();
  return value.startsWith("0x") ? value.toLowerCase() : value;
}

function pairCreatedTimestamp(card) {
  const timestamp = Date.parse(card?.pairCreatedAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function oldestOnChainFirst(left, right) {
  return pairCreatedTimestamp(left) - pairCreatedTimestamp(right);
}

function onChainAgeHours() {
  const hours = Number(argValue("onChainAgeHours", process.env.TELEGRAM_ON_CHAIN_AGE_HOURS || "24"));
  return Number.isFinite(hours) ? Math.max(1, Math.min(168, Math.trunc(hours))) : 24;
}

function withinOnChainAge(card, hours) {
  const timestamp = pairCreatedTimestamp(card);
  return timestamp > 0 && timestamp >= Date.now() - hours * 60 * 60 * 1000;
}

function extractCardAddress(text) {
  return String(text || "").match(/^CA:\s*(\S+)/m)?.[1] || "";
}

function sendWindowMs() {
  const minutes = Number(argValue("sendWindowMinutes", process.env.TELEGRAM_SEND_WINDOW_MINUTES || "30"));
  const safeMinutes = Number.isFinite(minutes) ? Math.max(1, Math.min(120, minutes)) : 30;
  return safeMinutes * 60 * 1000;
}

function sendCardLimit() {
  const limit = Number(argValue("sendLimit", process.env.TELEGRAM_SEND_CARD_LIMIT || "80"));
  return Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 80;
}

function sendPerMinute() {
  const limit = Number(argValue("sendPerMinute", process.env.TELEGRAM_SEND_PER_MINUTE || "60"));
  return Number.isFinite(limit) ? Math.max(1, Math.min(240, Math.trunc(limit))) : 60;
}

function dexRequestsPerMinute() {
  return configuredDexRequestsPerMinute(argValue("dexRpm", process.env.DEXSCREENER_REQUESTS_PER_MINUTE || ""));
}

function contractScanMaxMessages() {
  const value = Number(argValue("contractScanMaxMessages", process.env.TELEGRAM_CONTRACT_SCAN_MAX_MESSAGES || "200"));
  return Number.isFinite(value) ? Math.max(50, Math.min(1000, Math.trunc(value))) : 200;
}

function contractDialogLimit() {
  const value = Number(argValue("contractDialogLimit", process.env.TELEGRAM_CONTRACT_DIALOG_LIMIT || "250"));
  return Number.isFinite(value) ? Math.max(20, Math.min(1000, Math.trunc(value))) : 250;
}

function sendDelayMs(pendingCount) {
  if (pendingCount <= 0) return 0;
  const windowDelay = pendingCount > 1 ? Math.ceil(sendWindowMs() / (pendingCount - 1)) : 0;
  const rateLimitDelay = Math.ceil(60000 / sendPerMinute());
  return Math.max(2000, windowDelay, rateLimitDelay);
}

async function readSentContracts() {
  try {
    return JSON.parse(await fs.readFile(sentContractsPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeSentContracts(sentContracts) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(sentContractsPath, `${JSON.stringify(sentContracts, null, 2)}\n`, "utf8");
}

async function seedSentContractsFromTelegram(client, sentContracts) {
  const target = notifyTarget();
  if (!target) return sentContracts;
  try {
    const entity = await client.getEntity(target);
    const messages = await client.getMessages(entity, { limit: 1000 });
    for (const message of messages) {
      const address = extractCardAddress(message.message || "");
      if (!address) continue;
      const key = contractKey(address);
      if (!sentContracts[key]) {
        sentContracts[key] = {
          address,
          sentAt: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
          source: "telegram-history"
        };
      }
    }
  } catch (error) {
    console.log(`Could not seed sent CA history from Telegram: ${error.message}`);
  }
  return sentContracts;
}

async function resolveDialogTarget(client, target) {
  const value = String(target || "").trim();
  if (!value) throw new Error("Telegram repeat notify target is missing.");
  try {
    return await client.getEntity(value);
  } catch {
    // Private/channel titles such as "3* CA" are not always resolvable by getEntity.
  }
  const dialogs = await client.getDialogs({ limit: 500 });
  const normalized = normalize(value.replace(/^@/, ""));
  const entity = dialogs
    .map((dialog) => dialog.entity)
    .filter(Boolean)
    .find((item) => {
      const id = item?.id?.toString?.() || "";
      const title = normalize(item?.title || item?.firstName || "");
      const username = normalize(item?.username || "");
      return id === value || title === normalized || username === normalized;
    });
  if (!entity) throw new Error(`Telegram dialog not found: ${value}`);
  return entity;
}

async function runScrape() {
  console.log(`Contract scrape excludes ${EXCLUDE_GROUPS.length} output/system groups; special source groups are allowed.`);
  const args = [
    path.join(projectRoot, "src", "telegram-scrape.js"),
    "--allDialogs",
    "true",
    "--excludeGroups",
    EXCLUDE_GROUPS.join(","),
    "--contractOnly",
    "true",
    "--memeOnly",
    "false",
    "--max",
    String(contractScanMaxMessages()),
    "--dialogLimit",
    String(contractDialogLimit())
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: { ...process.env, TELEGRAM_NOTIFY_ENABLED: "false" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const error = new Error("telegram contract cycle timed out");
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }, 10 * 60 * 1000);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const jsonPath = stdout.match(/JSON:\s*(.+\.json)/)?.[1]?.trim();
      if (code !== 0 && !jsonPath) {
        const error = new Error(stderr.trim() || stdout.trim() || `telegram scrape exited with ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ jsonPath, stdout, stderr, code });
    });
  });
}

async function writeDuplicateCsv(payload, jsonPath) {
  const csvPath = jsonPath.replace(/\.json$/i, ".duplicates.enriched.csv");
  const rows = [
    ["rank", "address", "count", "groups", "ticker", "name", "marketCap", "liquidity", "holders", "volume24h", "change24h", "narrative"].map(csvCell).join(","),
    ...(payload.contractSummary || []).map((item, index) => [
      index + 1,
      item.address,
      item.count,
      (item.groups || []).join(" | "),
      item.info?.ticker || "",
      item.info?.name || "",
      item.info?.marketCap || "",
      item.info?.liquidity || "",
      item.info?.holders || "",
      item.info?.volume24h || "",
      item.info?.change24h || "",
      item.info?.narrative || ""
    ].map(csvCell).join(","))
  ];
  await fs.writeFile(csvPath, `${rows.join("\n")}\n`, "utf8");
  return csvPath;
}

async function notify(text) {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
  const stringSession = String(process.env.TELEGRAM_STRING_SESSION || "").trim();
  if (!apiId || !apiHash || !stringSession) throw new Error("Telegram session config is missing.");
  const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
    connectionRetries: 5,
    proxy: parseSocksProxy(process.env.TELEGRAM_PROXY_URL)
  });
  await client.connect();
  try {
    await sendTelegramNotification(client, text);
  } finally {
    await client.disconnect();
  }
}

async function sendNotificationMessage(client, message, targetEntity) {
  let sent = false;
  while (!sent) {
    try {
      if (targetEntity) {
        await client.sendMessage(targetEntity, {
          message: String(message || "").slice(0, MAX_MESSAGE_LENGTH),
          linkPreview: false
        });
      } else {
        const delivered = await sendTelegramNotification(client, message);
        if (!delivered) throw new Error("Telegram notification target is not configured.");
      }
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

async function buildPreparedContractPayload(cards) {
  const skipAlreadySent = argValue("skipAlreadySent", process.env.TELEGRAM_SKIP_ALREADY_SENT || "true") === "true";
  const sentContracts = skipAlreadySent ? await readSentContracts() : {};
  const threshold = repeatThreshold();
  const repeatTarget = repeatNotifyTarget();
  const items = [];
  let skipped = 0;
  let normalCount = 0;
  let repeatCount = 0;

  for (const card of cards) {
    const key = contractKey(card.address);
    if (skipAlreadySent && sentContracts[key]) {
      skipped += 1;
      continue;
    }
    const route = Number(card.count || 0) >= threshold ? "repeat" : "default";
    if (route === "repeat") repeatCount += 1;
    else normalCount += 1;
    items.push({
      source: "telegram-contracts",
      target: route === "repeat"
        ? { mode: "dialog", title: repeatTarget }
        : { mode: "default", target: notifyTarget() },
      address: card.address,
      pairCreatedAt: card.pairCreatedAt || "",
      rank: card.rank,
      count: card.count,
      route,
      history: "contract",
      message: formatContractCard(card)
    });
  }

  console.log(
    `Prepared contract routing: ${normalCount} to ${notifyTarget() || "TELEGRAM_NOTIFY_TARGET"}, ` +
    `${repeatCount} to ${repeatTarget}; skipped already sent: ${skipped}.`
  );
  return {
    source: "telegram-contracts",
    generatedAt: new Date().toISOString(),
    sendWindowMinutes: Math.round(sendWindowMs() / 60000),
    sendPerMinute: sendPerMinute(),
    repeatThreshold: threshold,
    items
  };
}

function filterContractCards(cards, ageHours) {
  const recentCards = cards.filter((card) => withinOnChainAge(card, ageHours));
  const sendableCards = recentCards.filter(hasUsableNarrative).sort(oldestOnChainFirst);
  return { recentCards, sendableCards };
}

async function enrichContractBatch(baseCards, rpm, options = {}) {
  return enrichContractCards(baseCards, {
    requestsPerMinute: rpm,
    delayMs: dexRequestDelayMs(rpm),
    proxy: configuredDexProxy(argValue("dexProxy", "")),
    onProgress: ({ completed, total, found }) => {
      if (completed === 1 || completed % 20 === 0 || completed === total) {
        console.log(`Contract DexScreener enriched ${completed}/${total}; found ${found}.`);
      }
    },
    ...options
  });
}

async function streamContractBatches(baseCards, duplicateCsv, resultJsonPath) {
  const rpm = dexRequestsPerMinute();
  const ageHours = onChainAgeHours();
  const batchSize = Number(argValue("batchSize", process.env.TELEGRAM_CONTRACT_BATCH_SIZE || "80"));
  const safeBatchSize = Number.isFinite(batchSize) ? Math.max(20, Math.min(250, Math.trunc(batchSize))) : 80;
  let totalFound = 0;
  let totalSendable = 0;
  let launched = 0;

  for (let offset = 0, batch = 1; offset < baseCards.length; offset += safeBatchSize, batch += 1) {
    const chunk = baseCards.slice(offset, offset + safeBatchSize);
    console.log(`Building contract cards batch ${batch}: ${chunk.length}; enriching via DexScreener...`);
    const { cards, rateLimit } = await enrichContractBatch(chunk, rpm);
    const found = cards.filter((card) => card.dexFound).length;
    totalFound += found;
    const { recentCards, sendableCards } = filterContractCards(cards, ageHours);
    totalSendable += sendableCards.length;
    console.log(
      `Contract batch ${batch}: ${found}/${cards.length} found; ` +
      `on-chain <=${ageHours}h ${recentCards.length}/${cards.length}; eligible ${sendableCards.length}; ` +
      `${rateLimit.configuredRequestsPerMinute}/min.`
    );
    if (sendableCards.length) {
      const prepared = await buildPreparedContractPayload(sendableCards);
      if (prepared.items.length) {
        const preparedPath = await writePreparedBatch(prepared, "contracts", batch);
        launchPreparedSender(preparedPath);
        launched += 1;
      }
    }
  }

  console.log(
    `Telegram contract cycle streamed: ${totalSendable} eligible; ` +
    `${totalFound}/${baseCards.length} DexScreener found; launched ${launched} sender batch(es).`
  );
  console.log(`Telegram contract cycle complete: ${resultJsonPath}`);
  console.log(`Duplicate CSV: ${duplicateCsv}`);
}

async function notifyMany(cards) {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
  const stringSession = String(process.env.TELEGRAM_STRING_SESSION || "").trim();
  if (!apiId || !apiHash || !stringSession) throw new Error("Telegram session config is missing.");
  const skipAlreadySent = argValue("skipAlreadySent", process.env.TELEGRAM_SKIP_ALREADY_SENT || "true") === "true";
  const sentContracts = await readSentContracts();
  const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
    connectionRetries: 5,
    proxy: parseSocksProxy(process.env.TELEGRAM_PROXY_URL)
  });
  await client.connect();
  try {
    if (skipAlreadySent) await seedSentContractsFromTelegram(client, sentContracts);
    let sentCount = 0;
    let skippedCount = 0;
    const threshold = repeatThreshold();
    const repeatTarget = repeatNotifyTarget();
    const pendingItems = [];
    let normalCount = 0;
    let repeatCount = 0;
    for (const card of cards) {
      const key = contractKey(card.address);
      if (skipAlreadySent && sentContracts[key]) {
        skippedCount += 1;
        continue;
      }
      const route = Number(card.count || 0) >= threshold ? "repeat" : "default";
      if (route === "repeat") repeatCount += 1;
      else normalCount += 1;
      pendingItems.push({ card, route });
    }
    const repeatEntity = repeatCount ? await resolveDialogTarget(client, repeatTarget) : null;
    const delayMs = sendDelayMs(pendingItems.length);
    console.log(
      `Telegram notification pacing: ${pendingItems.length} cards over ${Math.round(sendWindowMs() / 60000)}m, ` +
      `max ${sendPerMinute()}/min, delay ${Math.round(delayMs / 1000)}s, skipAlreadySent=${skipAlreadySent}.`
    );
    console.log(
      `Telegram routing: ${normalCount} to ${notifyTarget() || "TELEGRAM_NOTIFY_TARGET"}, ` +
      `${repeatCount} to ${repeatTarget}${repeatEntity ? ` (${entityLabel(repeatEntity)})` : ""}; repeat threshold >=${threshold}.`
    );
    const releaseSendLock = await acquireTelegramSendLock("telegram-contract-cycle");
    try {
      for (let index = 0; index < pendingItems.length; index += 1) {
        const { card, route } = pendingItems[index];
        const key = contractKey(card.address);
        const message = formatContractCard(card);
        await sendNotificationMessage(client, message, route === "repeat" ? repeatEntity : null);
        sentCount += 1;
        sentContracts[key] = {
          address: card.address,
          sentAt: new Date().toISOString(),
          rank: card.rank,
          count: card.count,
          target: route === "repeat" ? repeatTarget : notifyTarget()
        };
        await writeSentContracts(sentContracts);
        if (index < pendingItems.length - 1 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } finally {
      await releaseSendLock();
    }
    console.log(`Telegram notifications sent: ${sentCount}; skipped already sent: ${skippedCount}.`);
  } finally {
    await client.disconnect();
  }
}

async function main() {
  const result = await runScrape();
  if (!result.jsonPath) throw new Error("Telegram scrape completed but no JSON output path was found.");
  const payload = JSON.parse(await fs.readFile(result.jsonPath, "utf8"));
  const duplicateCsv = await writeDuplicateCsv(payload, result.jsonPath);
  const baseCards = buildContractCards(payload, Number.POSITIVE_INFINITY);
  if (argValue("streamBatches", "false") === "true") {
    await streamContractBatches(baseCards, duplicateCsv, result.jsonPath);
    return;
  }
  const rpm = dexRequestsPerMinute();
  const { cards, rateLimit } = await enrichContractCards(baseCards, {
    requestsPerMinute: rpm,
    delayMs: dexRequestDelayMs(rpm),
    proxy: configuredDexProxy(argValue("dexProxy", ""))
  });
  console.log(`DexScreener enrichment: ${cards.filter((card) => card.dexFound).length}/${cards.length}; ${rateLimit.configuredRequestsPerMinute}/min.`);
  const ageHours = onChainAgeHours();
  const recentCards = cards.filter((card) => withinOnChainAge(card, ageHours));
  const sendableCards = recentCards.filter(hasUsableNarrative).sort(oldestOnChainFirst);
  console.log(
    `Contract filters: ${sendableCards.length}/${cards.length}; ` +
    `on-chain <=${ageHours}h ${recentCards.length}/${cards.length}, usable narrative ${sendableCards.length}/${recentCards.length}.`
  );
  console.log("Send order and card format: same as special groups; oldest on-chain opening time first, newest appears last in Telegram.");
  if (argValue("prepareOnly", "false") === "true") {
    const prepared = await buildPreparedContractPayload(sendableCards);
    const preparedPath = await writePreparedOutput(prepared, "contracts");
    console.log(`Telegram contract cycle prepared: ${prepared.items.length} items; ${preparedPath}`);
  } else
  if (sendableCards.length) {
    await notifyMany(sendableCards);
  } else {
    await notify("\u672c\u8f6e\u6ca1\u6709\u53d1\u73b0\u6709\u660e\u786e\u53d9\u4e8b\u7684 CA\u3002");
  }
  console.log(`Telegram contract cycle complete: ${result.jsonPath}`);
  console.log(`Duplicate CSV: ${duplicateCsv}`);
}

main().catch((error) => {
  console.error(error.message);
  if (error.stderr) console.error(error.stderr);
  process.exitCode = 1;
});
