import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
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

function normalize(value) {
  return String(value || "").trim().toLowerCase();
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
    sendLimit: safeNumber(argValue("sendLimit", config.sendLimit || 400), 400, 1, 1000),
    sendWindowMinutes: safeNumber(argValue("sendWindowMinutes", config.sendWindowMinutes || 20), 20, 1, 120)
  };
}

async function resolveEntityFromDialogs(client, matcher, label) {
  const dialogs = await client.getDialogs({ limit: 500 });
  const entity = dialogs
    .map((dialog) => dialog.entity)
    .filter(Boolean)
    .find((item) => matcher(item));
  if (!entity) throw new Error(`Telegram dialog not found: ${label}`);
  return entity;
}

async function scrapeSpecialGroups(client, config) {
  const selected = (config.groups || []).filter((group) => group.selected !== false);
  const dialogs = await client.getDialogs({ limit: 500 });
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
      const messages = await client.getMessages(entity, { limit: config.maxMessages });
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
    } catch (error) {
      errors.push({ target: label, message: error.message });
    }
  }

  posts.sort((left, right) => String(right.publishedAt || "").localeCompare(String(left.publishedAt || "")));
  return { posts, accounts, errors };
}

function formatSpecialCard(card) {
  const lines = [];
  const titleParts = [];
  if (card.ticker) titleParts.push(`$${card.ticker}`);
  if (card.name && card.name !== card.ticker) titleParts.push(card.name);
  if (card.chain) titleParts.push(card.chain);
  lines.push("[Special Group CA]");
  lines.push(`#${String(card.rank).padStart(2, "0")} | ${card.count}x | ${titleParts.join(" - ") || "UNKNOWN"}`);
  lines.push(`CA: ${card.address}`);
  lines.push("");
  lines.push("\u4ea4\u6613\u4fe1\u606f:");
  if (card.age) lines.push(`- \u5f00\u76d8\u65f6\u95f4: ${card.age}`);
  if (card.marketCap) lines.push(`- \u5e02\u503c: ${card.marketCap}`);
  if (card.liquidity) lines.push(`- \u6d41\u52a8\u6027: ${card.liquidity}`);
  if (card.holders) lines.push(`- \u6301\u6709\u4eba: ${card.holders}`);
  if (card.volume24h) lines.push(`- 24h \u4ea4\u6613\u91cf: ${card.volume24h}`);
  if (card.change24h) lines.push(`- 24h: ${card.change24h}`);
  lines.push(`- \u94fe\u63a5: gmgn ${mark(card.hasGmgn)} | dex ${mark(card.hasDexscreener)} | \u5b98\u7f51 ${mark(card.hasWebsite)} | \u63a8\u7279 ${mark(card.hasTwitter)}`);
  if (card.narrative) {
    lines.push("");
    lines.push("\u53d9\u4e8b:");
    lines.push(card.narrative);
  }
  lines.push("");
  lines.push(`\u672c\u8f6e\u63d0\u53ca\u6b21\u6570: ${card.count}`);
  lines.push(`\u6765\u6e90\u7fa4: ${(card.groups || []).join(" / ")}`);
  if (card.url) lines.push(`\u6765\u6e90\u94fe\u63a5: ${card.url}`);
  return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

function sendDelayMs(count, minutes) {
  if (count <= 0) return 0;
  return Math.max(2000, Math.ceil((minutes * 60 * 1000) / count));
}

async function sendMessageWithFloodWait(client, target, message) {
  let sent = false;
  while (!sent) {
    try {
      await client.sendMessage(target, {
        message: String(message || "").slice(0, MAX_MESSAGE_LENGTH),
        linkPreview: false
      });
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

async function notifySpecial(client, config, payload) {
  const target = await resolveEntityFromDialogs(
    client,
    (entity) => matchesGroup(entity, config.notifyTarget || {}),
    config.notifyTarget?.title || config.notifyTarget?.id || "special notify target"
  );
  const cards = buildContractCards(payload, config.sendLimit);
  if (!cards.length) {
    await sendMessageWithFloodWait(client, target, "\u672c\u8f6e\u7279\u6b8a\u7fa4\u6ca1\u6709\u53d1\u73b0 CA\u3002");
    return { sent: 1, cards: 0 };
  }
  const delayMs = sendDelayMs(cards.length, config.sendWindowMinutes);
  console.log(`Special Telegram pacing: ${cards.length} cards over ${config.sendWindowMinutes}m, delay ${Math.round(delayMs / 1000)}s.`);
  let sent = 0;
  for (const card of cards) {
    await sendMessageWithFloodWait(client, target, formatSpecialCard(card));
    sent += 1;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { sent, cards: cards.length };
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
        sendWindowMinutes: config.sendWindowMinutes,
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
