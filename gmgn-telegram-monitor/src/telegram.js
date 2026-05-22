import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

let userClient;
let userTarget;

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

async function getUserClient(config) {
  if (!userClient) {
    userClient = new TelegramClient(
      new StringSession(config.telegramStringSession),
      config.telegramApiId,
      config.telegramApiHash,
      {
        connectionRetries: 5,
        proxy: parseSocksProxy(config.telegramProxyUrl),
      }
    );
    userClient.setLogLevel("error");
  }
  await userClient.connect();
  return userClient;
}

export async function sendTelegramMessage(config, text) {
  if (config.dryRun) {
    console.log("--- DRY RUN TELEGRAM MESSAGE ---");
    console.log(plainTextFromHtml(text));
    return;
  }

  if (config.telegramSendMode === "user") {
    const client = await getUserClient(config);
    userTarget ??= await resolveTelegramTarget(client, config.telegramNotifyTarget);
    await client.sendMessage(userTarget, {
      message: String(text || "").slice(0, 3900),
      parseMode: "html",
      linkPreview: false,
    });
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
  if (!userClient) return;
  try {
    await userClient.disconnect();
  } finally {
    userClient = undefined;
    userTarget = undefined;
  }
}
