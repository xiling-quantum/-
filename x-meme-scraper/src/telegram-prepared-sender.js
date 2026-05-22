import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { loadLocalEnv, parseSocksProxy } from "./local-env.js";
import { sendTelegramNotification } from "./telegram-notify.js";
import { acquireTelegramSendLock } from "./telegram-send-lock.js";

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");
const sentContractsPath = path.join(dataDir, "telegram-contract-sent.json");
const sentSpecialPath = path.join(dataDir, "telegram-special-sent.json");
const MAX_MESSAGE_LENGTH = 3900;
const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/;
const TRON_ADDRESS = /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/;
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function notifyTarget() {
  return String(process.env.TELEGRAM_NOTIFY_TARGET || "").trim();
}

function contractKey(address) {
  const value = String(address || "").trim();
  return value.startsWith("0x") ? value.toLowerCase() : value;
}

function extractCardAddress(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(0, 6)) {
    const match = line.match(EVM_ADDRESS) || line.match(TRON_ADDRESS) || line.match(SOLANA_ADDRESS);
    if (match) return match[0];
  }
  return "";
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

function dedupeEnabled() {
  return boolValue(argValue("dedupeEnabled", process.env.TELEGRAM_DEDUPE_ENABLED || "false"), false);
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

function sentTimestamp(record) {
  const sentAt = typeof record === "string" ? record : record?.sentAt;
  const timestamp = Date.parse(sentAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sentRecently(record, now = Date.now()) {
  const timestamp = sentTimestamp(record);
  if (!timestamp) return false;
  const windowMs = dedupeWindowHours() * 60 * 60 * 1000;
  return windowMs > 0 && timestamp >= now - windowMs;
}

function shouldStoreSentRecord(existing, sentAt) {
  const nextTimestamp = Date.parse(sentAt || "");
  if (!Number.isFinite(nextTimestamp)) return !existing;
  const existingTimestamp = sentTimestamp(existing);
  return !existingTimestamp || nextTimestamp > existingTimestamp;
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

async function readSentSpecial() {
  try {
    return JSON.parse(await fs.readFile(sentSpecialPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeSentSpecial(sentSpecial) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(sentSpecialPath, `${JSON.stringify(sentSpecial, null, 2)}\n`, "utf8");
}

async function resolveDialogTarget(client, target) {
  const id = String(target?.id || "").trim();
  const title = String(target?.title || target?.name || "").trim();
  const username = String(target?.username || "").replace(/^@/, "").trim();
  const raw = String(target?.target || "").trim();
  const direct = id || username || raw;
  if (direct) {
    try {
      return await client.getEntity(direct);
    } catch {
      // Private/channel titles such as "3* CA" may need dialog lookup.
    }
  }

  const dialogs = await client.getDialogs({ limit: 500 });
  const normalizedTitle = normalize(title || raw);
  const normalizedUsername = normalize(username || raw.replace(/^@/, ""));
  const entity = dialogs
    .map((dialog) => dialog.entity)
    .filter(Boolean)
    .find((item) => {
      const itemId = item?.id?.toString?.() || "";
      const itemTitle = normalize(item?.title || item?.firstName || "");
      const itemUsername = normalize(item?.username || "");
      return (id && itemId === id) ||
        (normalizedTitle && itemTitle === normalizedTitle) ||
        (normalizedUsername && itemUsername === normalizedUsername);
    });
  if (!entity) throw new Error(`Telegram dialog not found: ${title || username || id || raw}`);
  return entity;
}

async function sendItem(client, item, targetCache) {
  const target = item.target || {};
  if (target.mode === "default") {
    const delivered = await sendTelegramNotification(client, item.message || "");
    if (!delivered) throw new Error("Telegram default notification target is not configured.");
    return notifyTarget();
  }

  const cacheKey = JSON.stringify(target);
  if (!targetCache.has(cacheKey)) {
    targetCache.set(cacheKey, await resolveDialogTarget(client, target));
  }
  const entity = targetCache.get(cacheKey);
  await client.sendMessage(entity, {
    message: String(item.message || "").slice(0, MAX_MESSAGE_LENGTH),
    linkPreview: false
  });
  return target.title || target.username || target.id || target.target || "";
}

async function sendWithFloodWait(client, item, targetCache) {
  while (true) {
    try {
      return await sendItem(client, item, targetCache);
    } catch (error) {
      const waitSeconds = Number(String(error.message || "").match(/wait of (\d+) seconds/i)?.[1] || 0);
      if (!waitSeconds) throw error;
      const waitMs = (waitSeconds + 5) * 1000;
      console.log(`Telegram flood wait ${waitSeconds}s; retrying after ${Math.round(waitMs / 1000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function targetEntityForHistory(client, item, targetCache) {
  const target = item.target || {};
  if (target.mode === "default") {
    const raw = notifyTarget();
    if (!raw) return null;
    const cacheKey = `default:${raw}`;
    if (!targetCache.has(cacheKey)) {
      targetCache.set(cacheKey, await client.getEntity(raw));
    }
    return { entity: targetCache.get(cacheKey), label: raw };
  }
  const cacheKey = JSON.stringify(target);
  if (!targetCache.has(cacheKey)) {
    targetCache.set(cacheKey, await resolveDialogTarget(client, target));
  }
  return {
    entity: targetCache.get(cacheKey),
    label: target.title || target.username || target.id || target.target || ""
  };
}

async function seedContractHistoryFromTelegram(client, items, targetCache, sentContracts) {
  const targetItems = new Map();
  for (const item of items) {
    if (item.history !== "contract" || !item.address) continue;
    targetItems.set(JSON.stringify(item.target || {}), item);
  }
  let totalSeeded = 0;
  for (const item of targetItems.values()) {
    try {
      const target = await targetEntityForHistory(client, item, targetCache);
      if (!target?.entity) continue;
      const messages = await client.getMessages(target.entity, { limit: 1000 });
      let seeded = 0;
      for (const message of messages) {
        const address = extractCardAddress(message.message || "");
        if (!address) continue;
        const key = contractKey(address);
        const sentAt = message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString();
        if (shouldStoreSentRecord(sentContracts[key], sentAt)) {
          sentContracts[key] = {
            address,
            sentAt,
            target: target.label,
            source: "telegram-history"
          };
          seeded += 1;
        }
      }
      totalSeeded += seeded;
    } catch (error) {
      console.log(`Could not seed contract CA history from Telegram: ${error.message}`);
    }
  }
  if (totalSeeded) {
    await writeSentContracts(sentContracts);
    console.log(`Seeded contract CA history from Telegram: ${totalSeeded}.`);
  }
}

async function seedSpecialHistoryFromTelegram(client, item, targetCache, sentSpecial) {
  const target = item.target || {};
  const cacheKey = JSON.stringify(target);
  if (!targetCache.has(cacheKey)) {
    targetCache.set(cacheKey, await resolveDialogTarget(client, target));
  }
  const entity = targetCache.get(cacheKey);
  try {
    const messages = await client.getMessages(entity, { limit: 1000 });
    let seeded = 0;
    for (const message of messages) {
      const address = extractCardAddress(message.message || "");
      if (!address) continue;
      const key = contractKey(address);
      const sentAt = message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString();
      if (shouldStoreSentRecord(sentSpecial[key], sentAt)) {
        sentSpecial[key] = {
          address,
          sentAt,
          target: target.title || target.username || target.id || target.target || "",
          source: "telegram-history"
        };
        seeded += 1;
      }
    }
    if (seeded) {
      await writeSentSpecial(sentSpecial);
      console.log(`Seeded special CA history from Telegram: ${seeded}.`);
    }
  } catch (error) {
    console.log(`Could not seed special CA history from Telegram: ${error.message}`);
  }
}

async function main() {
  const input = argValue("input");
  if (!input) throw new Error("Missing --input prepared JSON path.");
  const prepared = JSON.parse(await fs.readFile(path.resolve(projectRoot, input), "utf8"));
  const items = Array.isArray(prepared.items) ? prepared.items : [];
  if (!items.length) {
    console.log(`Prepared sender: ${prepared.source || input} has no items; nothing to send.`);
    return;
  }

  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
  const stringSession = String(process.env.TELEGRAM_STRING_SESSION || "").trim();
  if (!apiId || !apiHash || !stringSession) throw new Error("Telegram session config is missing.");

  const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
    connectionRetries: 5,
    proxy: parseSocksProxy(process.env.TELEGRAM_PROXY_URL)
  });
  const targetCache = new Map();
  await client.connect();
  const releaseSendLock = await acquireTelegramSendLock(`telegram-prepared-sender:${prepared.source || "unknown"}`);
  let sent = 0;
  try {
    const sentContracts = await readSentContracts();
    const sentSpecial = await readSentSpecial();
    const dedupe = dedupeEnabled();
    if (dedupe) {
      await seedContractHistoryFromTelegram(client, items, targetCache, sentContracts);
      const firstSpecialItem = items.find((item) => item.history === "special" && item.address);
      if (firstSpecialItem) await seedSpecialHistoryFromTelegram(client, firstSpecialItem, targetCache, sentSpecial);
    }
    const seenInPrepared = new Set();
    let skippedSpecial = 0;
    let skippedContract = 0;
    let skippedPreparedDuplicate = 0;
    const dedupeHours = dedupeWindowHours();
    const now = Date.now();
    const pendingItems = dedupe ? items.filter((item) => {
      if (!item.address || (item.history !== "special" && item.history !== "contract")) return true;
      const key = contractKey(item.address);
      if (seenInPrepared.has(key)) {
        skippedPreparedDuplicate += 1;
        return false;
      }
      seenInPrepared.add(key);
      if (item.history === "special" && sentRecently(sentSpecial[key], now)) {
        skippedSpecial += 1;
        return false;
      }
      if (item.history === "contract" && sentRecently(sentContracts[key], now)) {
        skippedContract += 1;
        return false;
      }
      return true;
    }) : items;
    const minutes = safeNumber(prepared.sendWindowMinutes, 30, 1, 180);
    const perMinute = safeNumber(prepared.sendPerMinute, 4, 1, 240);
    const delayMs = sendDelayMs(pendingItems.length, minutes, perMinute);
    console.log(
      `Prepared sender: ${prepared.source || input}; ${pendingItems.length}/${items.length} items over ${minutes}m, ` +
      `max ${perMinute}/min, delay ${Math.round(delayMs / 1000)}s, ` +
      `dedupe ${dedupe ? `enabled ${dedupeHours}h` : "disabled"}, ` +
      `skipped special duplicates ${skippedSpecial}, contract duplicates ${skippedContract}, ` +
      `prepared duplicates ${skippedPreparedDuplicate}.`
    );
    if (!pendingItems.length) return;
    for (let index = 0; index < pendingItems.length; index += 1) {
      const item = pendingItems[index];
      const targetLabel = await sendWithFloodWait(client, item, targetCache);
      sent += 1;
      if (item.history === "contract" && item.address) {
        sentContracts[contractKey(item.address)] = {
          address: item.address,
          sentAt: new Date().toISOString(),
          rank: item.rank,
          count: item.count,
          target: targetLabel
        };
        await writeSentContracts(sentContracts);
      }
      if (item.history === "special" && item.address) {
        sentSpecial[contractKey(item.address)] = {
          address: item.address,
          sentAt: new Date().toISOString(),
          rank: item.rank,
          count: item.count,
          target: targetLabel
        };
        await writeSentSpecial(sentSpecial);
      }
      if (sent === 1 || sent % 20 === 0 || sent === pendingItems.length) {
        console.log(`Prepared sender sent ${sent}/${pendingItems.length}.`);
      }
      if (index < pendingItems.length - 1 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  } finally {
    await releaseSendLock();
    await client.disconnect();
  }
  console.log(`Prepared sender complete: ${sent}/${items.length}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
