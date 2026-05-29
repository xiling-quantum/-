import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env") });

function toBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optional(value) {
  return value && value.trim() ? value.trim() : undefined;
}

export function loadConfig() {
  const config = {
    rootDir,
    gmgnApiKey: optional(process.env.GMGN_API_KEY),
    gmgnPrivateKey: optional(process.env.GMGN_PRIVATE_KEY),
    telegramBotToken: optional(process.env.TELEGRAM_BOT_TOKEN),
    telegramChatId: optional(process.env.TELEGRAM_CHAT_ID),
    telegramSendMode: optional(process.env.TELEGRAM_SEND_MODE) ?? "auto",
    telegramApiId: toInt(process.env.TELEGRAM_API_ID, 0),
    telegramApiHash: optional(process.env.TELEGRAM_API_HASH),
    telegramStringSession: optional(process.env.TELEGRAM_STRING_SESSION),
    telegramNotifyTarget: optional(process.env.TELEGRAM_NOTIFY_TARGET) ?? "me",
    telegramProxyUrl: optional(process.env.TELEGRAM_PROXY_URL),
    chain: optional(process.env.CHAIN) ?? "sol",
    pollIntervalMs: Math.max(5, toInt(process.env.POLL_INTERVAL_SECONDS, 10)) * 1000,
    limit: Math.min(100, Math.max(1, toInt(process.env.LIMIT, 50))),
    side: optional(process.env.SIDE) ?? "all",
    minAmountUsd: optional(process.env.MIN_AMOUNT_USD),
    maxAmountUsd: optional(process.env.MAX_AMOUNT_USD),
    gmgnWebFollowSync: toBool(process.env.GMGN_WEB_FOLLOW_SYNC, true),
    configuredWalletFilter: optional(process.env.WALLET_FILTER),
    walletAliasFile: path.resolve(rootDir, optional(process.env.WALLET_ALIAS_FILE) ?? "data/wallet-aliases.json"),
    walletAutoNumberAliases: toBool(process.env.WALLET_AUTO_NUMBER_ALIASES, true),
    dryRun: toBool(process.env.DRY_RUN, false),
    startupSuppressExisting: toBool(process.env.STARTUP_SUPPRESS_EXISTING, true),
    maxMessagesPerPoll: Math.max(1, toInt(process.env.MAX_MESSAGES_PER_POLL, 20)),
    stateFile: path.resolve(rootDir, optional(process.env.STATE_FILE) ?? "data/state.json"),
    seenLimit: Math.max(100, toInt(process.env.SEEN_LIMIT, 5000)),
    narrativeEnabled: toBool(process.env.NARRATIVE_ENABLED, true),
    narrativeSourceProject: path.resolve(optional(process.env.NARRATIVE_SOURCE_PROJECT) ?? "D:/Vscode/x-meme-scraper"),
    narrativeLoadSourceEnv: toBool(process.env.NARRATIVE_LOAD_SOURCE_ENV, true),
    narrativeCacheFile: path.resolve(rootDir, optional(process.env.NARRATIVE_CACHE_FILE) ?? "data/narrative-cache.json"),
    narrativeCacheTtlHours: Math.max(1, toInt(process.env.NARRATIVE_CACHE_TTL_HOURS, 72)),
    narrativeMaxPerPoll: Math.max(1, toInt(process.env.NARRATIVE_MAX_PER_POLL, 20)),
    narrativeRequestsPerMinute: Math.max(1, toInt(process.env.NARRATIVE_REQUESTS_PER_MINUTE, 60)),
    narrativeConcurrency: Math.max(1, Math.min(8, toInt(process.env.NARRATIVE_CONCURRENCY, 2))),
    narrativeMetadataSources: optional(process.env.NARRATIVE_METADATA_SOURCES) ??
      optional(process.env.TOKEN_METADATA_SOURCES) ??
      "bitget_wallet_coininfo,dexscreener_profile,pumpfun,jupiter,solana_metaplex,ca_pages,ca_search",
  };

  if (!["sol", "bsc", "base", "eth"].includes(config.chain)) {
    throw new Error("CHAIN must be one of: sol, bsc, base, eth");
  }

  if (!["all", "buy", "sell"].includes(config.side)) {
    throw new Error("SIDE must be one of: all, buy, sell");
  }

  if (!["auto", "bot", "user"].includes(config.telegramSendMode)) {
    throw new Error("TELEGRAM_SEND_MODE must be one of: auto, bot, user");
  }

  if (config.telegramSendMode === "auto") {
    config.telegramSendMode =
      config.telegramBotToken && config.telegramChatId ? "bot" : "user";
  }

  config.walletFilter = config.gmgnWebFollowSync ? undefined : config.configuredWalletFilter;

  return config;
}

export function validateConfig(config) {
  const missing = [];
  if (!config.gmgnApiKey) missing.push("GMGN_API_KEY");
  if (!config.gmgnPrivateKey) missing.push("GMGN_PRIVATE_KEY");

  if (!config.dryRun && config.telegramSendMode === "bot") {
    if (!config.telegramBotToken) missing.push("TELEGRAM_BOT_TOKEN");
    if (!config.telegramChatId) missing.push("TELEGRAM_CHAT_ID");
  }

  if (!config.dryRun && config.telegramSendMode === "user") {
    if (!config.telegramApiId) missing.push("TELEGRAM_API_ID");
    if (!config.telegramApiHash) missing.push("TELEGRAM_API_HASH");
    if (!config.telegramStringSession) missing.push("TELEGRAM_STRING_SESSION");
    if (!config.telegramNotifyTarget) missing.push("TELEGRAM_NOTIFY_TARGET");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(", ")}`);
  }
}
