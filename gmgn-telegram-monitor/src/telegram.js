import fs from "node:fs/promises";
import path from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

function plainTextFromHtml(value) {
  return String(value || "")
    .replace(/<a\s+href="([^"]+)">([^<]+)<\/a>/g, "$2: $1")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseSocksProxy(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const protocol = parsed.protocol.replace(":", "").toLowerCase();
  if (!["socks4", "socks5"].includes(protocol)) {
    throw new Error("TELEGRAM_PROXY_URL must be socks4:// or socks5://");
  }
  return {
    ip: parsed.hostname,
    port: Number(parsed.port),
    socksType: protocol === "socks4" ? 4 : 5,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    timeout: 20,
  };
}

function normalizeTarget(value) {
  return String(value || "").trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

function processAlive(pid) {
  const number = Number(pid);
  if (!Number.isFinite(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function removeStaleLock(lockPath, staleMs) {
  const lock = await readLock(lockPath);
  if (!lock) return false;
  const ageMs = Date.now() - Date.parse(lock.createdAt || "");
  const stale = Number.isFinite(ageMs) && ageMs > staleMs;
  const alive = processAlive(lock.pid);
  if (!stale && alive) return false;
  await fs.rm(lockPath, { force: true });
  console.log(`Removed stale Telegram send lock: owner=${lock.owner || "unknown"} pid=${lock.pid || "unknown"}`);
  return true;
}

async function acquireTelegramSendLock(lockPath, owner, options = {}) {
  if (!lockPath) return async () => {};

  const staleMs = Number(options.staleMs || 3 * 60 * 60 * 1000);
  const pollMs = Number(options.pollMs || 5_000);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        owner,
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      }, null, 2));
      await handle.close();
      console.log(`Telegram send lock acquired: ${owner}`);
      return async function releaseTelegramSendLock() {
        const lock = await readLock(lockPath);
        if (lock?.token === token) {
          await fs.rm(lockPath, { force: true });
          console.log(`Telegram send lock released: ${owner}`);
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const removed = await removeStaleLock(lockPath, staleMs);
      if (removed) continue;
      const lock = await readLock(lockPath);
      console.log(`Telegram send lock busy: ${lock?.owner || "unknown"} pid=${lock?.pid || "unknown"}; waiting ${Math.round(pollMs / 1000)}s.`);
      await sleep(pollMs);
    }
  }
}

async function resolveTelegramTarget(client, target) {
  const raw = String(target || "").trim();
  if (!raw) throw new Error("TELEGRAM_NOTIFY_TARGET is empty");

  try {
    return await client.getEntity(raw);
  } catch {
    // Private groups often need dialog title lookup instead of getEntity("title").
  }

  const dialogs = await client.getDialogs({ limit: 500 });
  const wanted = normalizeTarget(raw.replace(/^@/, ""));
  const entity = dialogs
    .map((dialog) => dialog.entity)
    .filter(Boolean)
    .find((item) => {
      const id = item?.id?.toString?.() || "";
      const title = normalizeTarget(item?.title || item?.firstName || "");
      const username = normalizeTarget(item?.username || "");
      return id === wanted || title === wanted || username === wanted;
    });

  if (!entity) throw new Error(`Telegram target not found: ${raw}`);
  return entity;
}

function createUserClient(config) {
  const client = new TelegramClient(
    new StringSession(config.telegramStringSession),
    config.telegramApiId,
    config.telegramApiHash,
    {
      connectionRetries: 5,
      proxy: parseSocksProxy(config.telegramProxyUrl),
    }
  );
  client.setLogLevel("error");
  return client;
}

export async function sendTelegramMessage(config, text) {
  if (config.dryRun) {
    console.log("--- DRY RUN TELEGRAM MESSAGE ---");
    console.log(plainTextFromHtml(text));
    return;
  }

  if (config.telegramSendMode === "user") {
    const releaseSendLock = await acquireTelegramSendLock(
      config.telegramSendLockFile,
      "gmgn-telegram-monitor",
      { pollMs: 5_000 }
    );
    const client = createUserClient(config);
    try {
      await withTimeout(client.connect(), 45_000, "Telegram connect");
      const target = await withTimeout(
        resolveTelegramTarget(client, config.telegramNotifyTarget),
        45_000,
        "Telegram target lookup"
      );
      await withTimeout(
        client.sendMessage(target, {
          message: String(text || "").slice(0, 3900),
          parseMode: "html",
          linkPreview: false,
        }),
        45_000,
        "Telegram send"
      );
    } finally {
      try {
        await client.disconnect();
      } catch {
        // The connection may already be closed after a send failure.
      }
      await releaseSendLock();
    }
    return;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }
  );

  const body = await response.json().catch(() => undefined);
  if (!response.ok || body?.ok === false) {
    throw new Error(`Telegram send failed: ${response.status} ${JSON.stringify(body)}`);
  }
}

export async function closeTelegramClient() {
  // User-mode sends use short-lived Telegram clients, so there is no persistent
  // client to close here.
}
