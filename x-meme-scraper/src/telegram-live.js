import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TelegramClient } from "telegram";
import { NewMessage } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";
import { loadLocalEnv, parseSocksProxy } from "./local-env.js";

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");
const configPath = path.join(projectRoot, "config", "telegram-groups.json");
const latestPath = path.join(dataDir, "telegram-live-latest.json");

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function listArg(name) {
  const raw = String(argValue(name, "") ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((item) => normalizeTarget(item)).filter(Boolean);
}

function senderArg(name) {
  const raw = String(argValue(name, "") ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((item) => normalizeSenderFilter(item)).filter(Boolean);
}

function normalizeTarget(value) {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@+/, "")
    .split(/[?#]/)[0];
}

function normalizeSenderFilter(value) {
  return String(value ?? "").trim().replace(/^@+/, "");
}

function textMatches(text, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return true;
  return String(text ?? "").toLowerCase().includes(needle);
}

const MEME_SIGNALS = [
  /\bmeme\s*coin\b/i,
  /\bmemecoin\b/i,
  /\bmeme\b/i,
  /\bdegen\b/i,
  /\bpump\.?fun\b/i,
  /\bca[:\s]/i,
  /\bcontract\s*address\b/i,
  /\$[A-Z][A-Z0-9_]{1,11}\b/,
  /\b(pepe|doge|shib|bonk|wif|floki|popcat|mog|giga)\b/i,
  /土狗|迷因|合约地址|冲土狗|发射/i
];

function memeScore(text) {
  return MEME_SIGNALS.reduce((score, pattern) => score + (pattern.test(text || "") ? 1 : 0), 0);
}

async function readTargets() {
  const cliTargets = listArg("groups");
  if (cliTargets.length) return cliTargets;
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  return (config.groups ?? [])
    .filter((group) => group.selected !== false)
    .map((group) => normalizeTarget(group.target))
    .filter(Boolean);
}

function messageUrl(target, id) {
  const clean = normalizeTarget(target);
  return clean ? `https://t.me/${clean}/${id}` : null;
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeLivePayload(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function emptyPayload(targets, filters) {
  return {
    source: "telegram-live",
    targets,
    filters,
    generatedAt: new Date().toISOString(),
    totalPosts: 0,
    accounts: targets.map((target) => ({ target, received: 0, matched: 0 })),
    errors: [],
    posts: []
  };
}

async function resolveChatLabel(message, fallback) {
  try {
    const chat = typeof message.getChat === "function" ? await message.getChat() : null;
    return chat?.username || chat?.title || chat?.firstName || fallback;
  } catch {
    return fallback;
  }
}

async function resolveSenderFilters(client, values) {
  const ids = new Set();
  const unresolved = [];
  for (const value of values.map(normalizeSenderFilter).filter(Boolean)) {
    if (/^-?\d+$/.test(value)) {
      ids.add(value);
      continue;
    }
    try {
      const entity = await client.getEntity(value);
      if (entity?.id !== undefined) {
        const id = String(entity.id);
        ids.add(id);
        ids.add(`-100${id}`);
      } else {
        unresolved.push(value);
      }
    } catch {
      unresolved.push(value);
    }
  }
  return { ids, unresolved };
}

async function messageSenderInfo(message) {
  const senderId = message?.senderId !== undefined ? String(message.senderId) : "";
  try {
    const sender = typeof message?.getSender === "function" ? await message.getSender() : null;
    return {
      senderId,
      senderUsername: sender?.username || "",
      senderName: [sender?.firstName, sender?.lastName].filter(Boolean).join(" ")
    };
  } catch {
    return { senderId, senderUsername: "", senderName: "" };
  }
}

async function persistPost(post, targets, filters, maxLatest) {
  const latest = await readJsonFile(latestPath, emptyPayload(targets, filters));
  const latestIds = new Set((latest.posts || []).map((item) => item.key || `telegram:${item.group}:${item.id}`));
  if (!latestIds.has(post.key)) {
    latest.posts = [post, ...(latest.posts || [])].slice(0, maxLatest);
  }
  latest.source = "telegram-live";
  latest.targets = targets;
  latest.filters = filters;
  latest.generatedAt = new Date().toISOString();
  latest.totalPosts = latest.posts.length;
  latest.accounts = targets.map((target) => ({
    target,
    received: (latest.posts || []).filter((item) => item.group === target).length,
    matched: (latest.posts || []).filter((item) => item.group === target).length
  }));
  await writeLivePayload(latestPath, latest);

  const dailyPath = path.join(dataDir, `telegram-live-${localDateKey(post.publishedAt)}.json`);
  const daily = await readJsonFile(dailyPath, emptyPayload(targets, filters));
  const dailyIds = new Set((daily.posts || []).map((item) => item.key || `telegram:${item.group}:${item.id}`));
  if (!dailyIds.has(post.key)) {
    daily.posts = [post, ...(daily.posts || [])];
  }
  daily.source = "telegram-live";
  daily.targets = targets;
  daily.filters = filters;
  daily.generatedAt = new Date().toISOString();
  daily.totalPosts = daily.posts.length;
  await writeLivePayload(dailyPath, daily);
}

let persistQueue = Promise.resolve();

function queuePersistPost(post, targets, filters, maxLatest) {
  persistQueue = persistQueue
    .then(() => persistPost(post, targets, filters, maxLatest))
    .catch((error) => {
      emit({ type: "persist-error", message: error.message });
    });
  return persistQueue;
}

async function initializeLatestPayload(targets, filters) {
  const latest = await readJsonFile(latestPath, emptyPayload(targets, filters));
  latest.source = "telegram-live";
  latest.targets = targets;
  latest.filters = filters;
  latest.generatedAt = new Date().toISOString();
  latest.posts = Array.isArray(latest.posts) ? latest.posts.slice(0, Number(filters.maxLatest || 500)) : [];
  latest.totalPosts = latest.posts.length;
  latest.accounts = targets.map((target) => ({
    target,
    received: latest.posts.filter((item) => item.group === target).length,
    matched: latest.posts.filter((item) => item.group === target).length
  }));
  latest.errors = Array.isArray(latest.errors) ? latest.errors : [];
  await writeLivePayload(latestPath, latest);
}

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
  const stringSession = String(process.env.TELEGRAM_STRING_SESSION || "").trim();
  const proxy = parseSocksProxy(process.env.TELEGRAM_PROXY_URL);
  const query = String(argValue("query", "") ?? "").trim();
  const memeOnly = argValue("memeOnly", "false") === "true";
  const memeMinScore = Math.max(1, Math.min(8, Number(argValue("memeMinScore", "2")) || 2));
  const maxLatest = Math.max(50, Math.min(1000, Number(argValue("maxLatest", "500")) || 500));
  const senderFilters = senderArg("senders");
  const targets = await readTargets();
  const filters = { query, memeOnly, memeMinScore, maxLatest, senderFilters, senderIds: [], unresolvedSenders: [] };

  if (!apiId || !apiHash || !stringSession) {
    throw new Error("Set TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_STRING_SESSION before live monitoring Telegram.");
  }
  if (!targets.length) {
    throw new Error("No selected Telegram groups configured.");
  }

  await fs.mkdir(dataDir, { recursive: true });
  await initializeLatestPayload(targets, filters);

  const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
    connectionRetries: 5,
    proxy
  });
  await client.connect();
  const resolvedSenders = await resolveSenderFilters(client, senderFilters);
  filters.senderIds = [...resolvedSenders.ids];
  filters.unresolvedSenders = resolvedSenders.unresolved;

  const entities = [];
  const targetByPeer = new Map();
  const errors = [];
  for (const target of targets) {
    try {
      const entity = await client.getEntity(target);
      entities.push(entity);
      const id = String(entity.id ?? "");
      if (id) {
        targetByPeer.set(id, target);
        targetByPeer.set(`-100${id}`, target);
      }
    } catch (error) {
      errors.push({ target, message: error.message });
      emit({ type: "target-error", target, message: error.message });
    }
  }

  if (!entities.length) {
    throw new Error("No Telegram targets could be resolved.");
  }

  let received = 0;
  let matched = 0;
  const seen = new Set();

  client.addEventHandler(async (event) => {
    try {
      received += 1;
      const message = event.message;
      const text = message?.message || "";
      const sender = await messageSenderInfo(message);
      if (resolvedSenders.ids.size && !resolvedSenders.ids.has(sender.senderId)) return;
      if (!textMatches(text, query)) return;
      const score = memeScore(text);
      if (memeOnly && score < memeMinScore) return;

      const peerKey = String(message?.chatId ?? message?.peerId?.channelId ?? message?.peerId?.chatId ?? "");
      const fallbackGroup = targetByPeer.get(peerKey) || targetByPeer.get(peerKey.replace(/^-100/, "")) || peerKey || "telegram";
      const group = normalizeTarget(await resolveChatLabel(message, fallbackGroup));
      const key = `telegram:${group}:${message.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      matched += 1;

      const post = {
        key,
        id: String(message.id),
        platform: "telegram",
        group,
        authorHandle: group,
        senderId: sender.senderId,
        senderUsername: sender.senderUsername,
        senderName: sender.senderName,
        publishedAt: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
        text,
        memeScore: score,
        url: messageUrl(group, message.id),
        scrapedAt: new Date().toISOString()
      };

      await queuePersistPost(post, targets, filters, maxLatest);
      emit({ type: "message", received, matched, group, id: post.id, publishedAt: post.publishedAt });
    } catch (error) {
      emit({ type: "handler-error", message: error.message });
    }
  }, new NewMessage({ chats: targets, incoming: true }));

  emit({
    type: "ready",
    targets,
    resolvedTargets: entities.length,
    errors,
    filters
  });

  process.on("SIGINT", async () => {
    emit({ type: "stopping" });
    await client.disconnect();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    emit({ type: "stopping" });
    await client.disconnect();
    process.exit(0);
  });
}

main().catch((error) => {
  emit({ type: "fatal", message: error.message });
  process.exitCode = 1;
});
