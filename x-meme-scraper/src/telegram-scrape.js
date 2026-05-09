import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { loadLocalEnv, parseSocksProxy } from "./local-env.js";
import { formatTelegramBatchNotification, sendTelegramNotification, telegramNotifyConfigured } from "./telegram-notify.js";
import { annotateRepeatedContracts, extractContractAddresses } from "./telegram-contracts.js";

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");
const configPath = path.join(projectRoot, "config", "telegram-groups.json");

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function listArg(name) {
  const raw = String(argValue(name, "") ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function booleanArg(name, fallback = false) {
  return String(argValue(name, String(fallback))).trim().toLowerCase() === "true";
}

function normalizeSenderFilter(value) {
  return String(value ?? "").trim().replace(/^@+/, "");
}

function normalizeTarget(value) {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@+/, "")
    .split(/[?#]/)[0];
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
  const cliTargets = listArg("groups").map(normalizeTarget);
  if (cliTargets.length) return cliTargets;
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  return (config.groups ?? []).map((group) => normalizeTarget(group.target)).filter(Boolean);
}

function targetLabel(entity) {
  return normalizeTarget(entity?.username || entity?.title || entity?.firstName || entity?.id || "");
}

async function readDialogTargets(client, excludeGroups) {
  const excluded = excludeGroups.map((item) => String(item || "").toLowerCase()).filter(Boolean);
  const dialogs = await client.getDialogs({});
  return dialogs
    .map((dialog) => dialog.entity)
    .filter((entity) => entity && (entity.className === "Channel" || entity.className === "Chat"))
    .map((entity) => ({
      target: targetLabel(entity),
      entity,
      title: String(entity.title || entity.username || entity.firstName || entity.id || "")
    }))
    .filter((item) => item.target)
    .filter((item) => !excluded.some((needle) =>
      item.target.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle)
    ));
}

function messageUrl(target, id) {
  const clean = normalizeTarget(target);
  return clean ? `https://t.me/${clean}/${id}` : null;
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

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
  const stringSession = String(process.env.TELEGRAM_STRING_SESSION || "").trim();
  const proxy = parseSocksProxy(process.env.TELEGRAM_PROXY_URL);
  const maxMessages = Math.max(1, Math.min(200, Number(argValue("max", "50")) || 50));
  const query = String(argValue("query", "") ?? "").trim();
  const memeOnly = booleanArg("memeOnly", false);
  const memeMinScore = Math.max(1, Math.min(8, Number(argValue("memeMinScore", "2")) || 2));
  const contractOnly = booleanArg("contractOnly", false);
  const allDialogs = booleanArg("allDialogs", false);
  const excludeGroups = listArg("excludeGroups").map(normalizeTarget);
  const senderFilters = listArg("senders").map(normalizeSenderFilter).filter(Boolean);
  const configuredTargets = await readTargets();

  if (!apiId || !apiHash || !stringSession) {
    throw new Error("Set TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_STRING_SESSION before scraping Telegram.");
  }
  if (!allDialogs && !configuredTargets.length) {
    throw new Error("No Telegram groups configured. Use --groups group1,group2 or edit config/telegram-groups.json.");
  }

  await fs.mkdir(dataDir, { recursive: true });

  const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
    connectionRetries: 5,
    proxy
  });
  await client.connect();
  const resolvedSenders = await resolveSenderFilters(client, senderFilters);
  const targetItems = allDialogs
    ? await readDialogTargets(client, excludeGroups)
    : configuredTargets.map((target) => ({ target, entity: null, title: target }));
  const targets = targetItems.map((item) => item.target);

  if (!targetItems.length) {
    throw new Error("No Telegram groups matched the current selection.");
  }

  try {
    const accounts = [];
    const errors = [];
    const posts = [];

    for (const item of targetItems) {
      const target = item.target;
      try {
        const entity = item.entity || await client.getEntity(target);
        const messages = await client.getMessages(entity, { limit: maxMessages });
        let matched = 0;
        for (const message of messages) {
          const text = message.message || "";
          const contractAddresses = extractContractAddresses(text);
          if (contractOnly && !contractAddresses.length) continue;
          const sender = await messageSenderInfo(message);
          if (resolvedSenders.ids.size && !resolvedSenders.ids.has(sender.senderId)) continue;
          if (!textMatches(text, query)) continue;
          const score = memeScore(text);
          if (memeOnly && score < memeMinScore) continue;
          matched += 1;
          posts.push({
            id: String(message.id),
            platform: "telegram",
            group: target,
            authorHandle: target,
            senderId: sender.senderId,
            senderUsername: sender.senderUsername,
            senderName: sender.senderName,
            publishedAt: message.date ? new Date(message.date * 1000).toISOString() : null,
            text,
            memeScore: score,
            contractAddresses,
            url: messageUrl(target, message.id),
            scrapedAt: new Date().toISOString()
          });
        }
        accounts.push({ target, scanned: messages.length, matched });
      } catch (error) {
        errors.push({ target, message: error.message });
      }
    }

    posts.sort((left, right) => String(right.publishedAt || "").localeCompare(String(left.publishedAt || "")));
    const contractSummary = annotateRepeatedContracts(posts);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = path.join(dataDir, `telegram-monitor-${timestamp}.json`);
    const csvPath = path.join(dataDir, `telegram-monitor-${timestamp}.csv`);
    const payload = {
      source: "telegram",
      targets,
      filters: { query, memeOnly, memeMinScore, maxMessages, senderFilters, senderIds: [...resolvedSenders.ids], unresolvedSenders: resolvedSenders.unresolved, contractOnly, allDialogs, excludeGroups },
      generatedAt: new Date().toISOString(),
      totalPosts: posts.length,
      contractSummary,
      accounts,
      errors,
      posts
    };

    await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const csvRows = [
      ["id", "group", "senderId", "senderUsername", "publishedAt", "memeScore", "contractAddresses", "repeatedContracts", "text", "url", "scrapedAt"].map(csvCell).join(","),
      ...posts.map((post) => [
        post.id,
        post.group,
        post.senderId,
        post.senderUsername,
        post.publishedAt,
        post.memeScore,
        (post.contractAddresses || []).join(" "),
        (post.repeatedContracts || []).join(" "),
        post.text,
        post.url,
        post.scrapedAt
      ].map(csvCell).join(","))
    ];
    await fs.writeFile(csvPath, `${csvRows.join("\n")}\n`, "utf8");
    if (telegramNotifyConfigured() && posts.length) {
      try {
        await sendTelegramNotification(client, formatTelegramBatchNotification(payload));
      } catch (error) {
        console.error(`Telegram notify failed: ${error.message}`);
      }
    }

    console.log(`Scraped ${posts.length} Telegram messages from ${targets.join(", ")}`);
    console.log(`JSON: ${jsonPath}`);
    console.log(`CSV:  ${csvPath}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
