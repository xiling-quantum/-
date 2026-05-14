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
  enrichContractCards
} from "./token-enrichment.js";
import { acquireTelegramSendLock } from "./telegram-send-lock.js";

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");
const sentContractsPath = path.join(dataDir, "telegram-contract-sent.json");

const EXCLUDE_GROUPS = [
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

function formatContractCard(card) {
  const lines = [];
  const titleParts = [];
  if (card.ticker) titleParts.push(`$${card.ticker}`);
  if (card.name && card.name !== card.ticker) titleParts.push(card.name);
  if (card.chain) titleParts.push(card.chain);
  lines.push(`#${String(card.rank).padStart(2, "0")} | ${card.count}x | ${titleParts.join(" - ") || "UNKNOWN"}`);
  lines.push(`CA: ${card.address}`);
  lines.push("");
  lines.push("\u4ea4\u6613\u4fe1\u606f:");
  lines.push(`- \u94fe\u4e0a\u5f00\u76d8\u65f6\u95f4: ${formatTime(card.pairCreatedAt) || "UNKNOWN"}${card.dexFound ? " (DexScreener)" : ""}`);
  if (card.dexId) lines.push(`- DEX: ${card.dexId}`);
  if (card.marketCap) lines.push(`- \u5e02\u503c: ${card.marketCap}`);
  if (card.liquidity) lines.push(`- \u6d41\u52a8\u6027: ${card.liquidity}`);
  if (card.holders) lines.push(`- \u6301\u6709\u4eba: ${card.holders}`);
  if (card.volume24h) lines.push(`- 24h \u4ea4\u6613\u91cf: ${card.volume24h}`);
  if (card.change24h) lines.push(`- 24h: ${card.change24h}`);
  lines.push(`- \u94fe\u63a5: gmgn ${mark(card.hasGmgn)} | dex ${mark(card.hasDexscreener)} | \u5b98\u7f51 ${mark(card.hasWebsite)} | \u63a8\u7279 ${mark(card.hasTwitter)}`);
  if (card.dexError) lines.push(`- API: ${card.dexError}`);
  if (card.onChainNarrative) {
    lines.push("");
    lines.push("\u94fe\u4e0a\u753b\u50cf(API):");
    lines.push(card.onChainNarrative);
  }
  if (card.signalNarrative) {
    lines.push("");
    lines.push("\u4fe1\u53f7\u6765\u6e90/\u539f\u5e16\u6545\u4e8b:");
    lines.push(card.signalNarrative);
  }
  if (card.narrative && !String(card.signalNarrative || "").includes(String(card.narrative).slice(0, 40))) {
    lines.push("");
    lines.push("\u7fa4\u5185\u53d9\u4e8b:");
    lines.push(card.narrative);
  }
  lines.push("");
  lines.push(`\u672c\u8f6e\u63d0\u53ca\u6b21\u6570: ${card.count}`);
  return lines.join("\n");
}

function formatContractCards(payload) {
  const cards = buildContractCards(payload);
  if (!cards.length) return ["\u672c\u8f6e\u6ca1\u6709\u53d1\u73b0 CA\u3002"];
  return cards.map(formatContractCard);
}

function notifyTarget() {
  return String(process.env.TELEGRAM_NOTIFY_TARGET || "").trim();
}

function contractKey(address) {
  const value = String(address || "").trim();
  return value.startsWith("0x") ? value.toLowerCase() : value;
}

function extractCardAddress(text) {
  return String(text || "").match(/^CA:\s*(\S+)/m)?.[1] || "";
}

function sendWindowMs() {
  const minutes = Number(argValue("sendWindowMinutes", process.env.TELEGRAM_SEND_WINDOW_MINUTES || "20"));
  const safeMinutes = Number.isFinite(minutes) ? Math.max(1, Math.min(120, minutes)) : 20;
  return safeMinutes * 60 * 1000;
}

function sendCardLimit() {
  const limit = Number(argValue("sendLimit", process.env.TELEGRAM_SEND_CARD_LIMIT || "80"));
  return Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 80;
}

function sendPerMinute() {
  const limit = Number(argValue("sendPerMinute", process.env.TELEGRAM_SEND_PER_MINUTE || "4"));
  return Number.isFinite(limit) ? Math.max(1, Math.min(240, Math.trunc(limit))) : 4;
}

function dexRequestsPerMinute() {
  return configuredDexRequestsPerMinute(argValue("dexRpm", process.env.DEXSCREENER_REQUESTS_PER_MINUTE || ""));
}

function sendDelayMs(pendingCount) {
  if (pendingCount <= 0) return 0;
  const windowDelay = Math.ceil(sendWindowMs() / pendingCount);
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

function runScrape() {
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
    "500"
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
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
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

async function notifyMany(cards) {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
  const stringSession = String(process.env.TELEGRAM_STRING_SESSION || "").trim();
  if (!apiId || !apiHash || !stringSession) throw new Error("Telegram session config is missing.");
  const skipAlreadySent = argValue("skipAlreadySent", process.env.TELEGRAM_SKIP_ALREADY_SENT || "false") === "true";
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
    const pendingCards = [];
    for (const card of cards) {
      const key = contractKey(card.address);
      if (skipAlreadySent && sentContracts[key]) {
        skippedCount += 1;
        continue;
      }
      pendingCards.push(card);
    }
    const delayMs = sendDelayMs(pendingCards.length);
    console.log(`Telegram notification pacing: ${pendingCards.length} cards over ${Math.round(sendWindowMs() / 60000)}m, max ${sendPerMinute()}/min, delay ${Math.round(delayMs / 1000)}s, skipAlreadySent=${skipAlreadySent}.`);
    const releaseSendLock = await acquireTelegramSendLock("telegram-contract-cycle");
    try {
      for (let index = 0; index < pendingCards.length; index += 1) {
        const card = pendingCards[index];
        const key = contractKey(card.address);
        const message = formatContractCard(card);
        let sent = false;
        while (!sent) {
          try {
            await sendTelegramNotification(client, message);
            sent = true;
            sentCount += 1;
            sentContracts[key] = {
              address: card.address,
              sentAt: new Date().toISOString(),
              rank: card.rank,
              count: card.count
            };
            await writeSentContracts(sentContracts);
          } catch (error) {
            const waitSeconds = Number(String(error.message || "").match(/wait of (\d+) seconds/i)?.[1] || 0);
            if (!waitSeconds) throw error;
            const waitMs = (waitSeconds + 5) * 1000;
            console.log(`Telegram flood wait ${waitSeconds}s; retrying after ${Math.round(waitMs / 1000)}s.`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
        }
        if (index < pendingCards.length - 1 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
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
  const baseCards = buildContractCards(payload, sendCardLimit());
  const rpm = dexRequestsPerMinute();
  const { cards, rateLimit } = await enrichContractCards(baseCards, {
    requestsPerMinute: rpm,
    delayMs: dexRequestDelayMs(rpm),
    proxy: configuredDexProxy(argValue("dexProxy", ""))
  });
  console.log(`DexScreener enrichment: ${cards.filter((card) => card.dexFound).length}/${cards.length}; ${rateLimit.configuredRequestsPerMinute}/min.`);
  if (cards.length) {
    await notifyMany(cards);
  } else {
    await notify("\u672c\u8f6e\u6ca1\u6709\u53d1\u73b0 CA\u3002");
  }
  console.log(`Telegram contract cycle complete: ${result.jsonPath}`);
  console.log(`Duplicate CSV: ${duplicateCsv}`);
}

main().catch((error) => {
  console.error(error.message);
  if (error.stderr) console.error(error.stderr);
  process.exitCode = 1;
});
