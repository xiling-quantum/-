import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

let enrichmentModule;

function addressKey(value) {
  const address = String(value || "").trim();
  return address.startsWith("0x") ? address.toLowerCase() : address;
}

function optional(value) {
  const text = String(value || "").trim();
  return text || undefined;
}

async function loadEnvFile(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function loadSourceEnvironment(config) {
  if (!config.narrativeLoadSourceEnv) return;
  await loadEnvFile(path.join(config.narrativeSourceProject, ".env.local"));
  await loadEnvFile(path.join(config.narrativeSourceProject, ".env"));
}

async function loadEnrichmentModule(config) {
  if (enrichmentModule) return enrichmentModule;
  await loadSourceEnvironment(config);
  const modulePath = path.join(config.narrativeSourceProject, "src", "token-enrichment.js");
  enrichmentModule = await import(pathToFileURL(modulePath).href);
  return enrichmentModule;
}

async function loadCache(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { items: {} };
  } catch (error) {
    if (error.code === "ENOENT") return { items: {} };
    throw error;
  }
}

async function saveCache(file, cache) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function isFresh(record, ttlHours) {
  const updatedAt = Date.parse(record?.updatedAt || "");
  if (!Number.isFinite(updatedAt)) return false;
  return updatedAt >= Date.now() - ttlHours * 60 * 60 * 1000;
}

function tradeCard(trade) {
  const symbol = optional(trade.base_token?.symbol);
  const name = optional(trade.base_token?.name) || symbol;
  const walletName = optional(trade.maker_info?.name) || optional(trade.maker_info?.twitter_username);
  const side = String(trade.side || "").toLowerCase();
  const story = [
    "GMGN follow wallet trade",
    side ? `side ${side}` : "",
    symbol ? `token ${symbol}` : "",
    walletName ? `wallet ${walletName}` : "",
    trade.amount_usd ? `amount USD ${trade.amount_usd}` : "",
  ].filter(Boolean).join("; ");

  return {
    address: trade.base_address,
    count: 1,
    chain: trade.chain || "sol",
    ticker: symbol || "",
    name: name || "",
    source: "GMGN follow-wallet",
    primarySender: walletName || trade.maker || "",
    sourceSenders: [walletName || trade.maker || ""].filter(Boolean),
    sourceStories: [story],
    narrative: "",
  };
}

function narrativeRecord(enriched) {
  return {
    updatedAt: new Date().toISOString(),
    address: enriched.address,
    chain: enriched.chain || "",
    ticker: enriched.ticker || "",
    name: enriched.name || "",
    dexFound: Boolean(enriched.dexFound),
    pairUrl: enriched.pairUrl || "",
    briefNarrative: enriched.briefNarrative || "",
    narrative: enriched.narrative || "",
    metadataDescription: enriched.metadataDescription || "",
    metadataSourceCount: enriched.metadataSourceCount || 0,
  };
}

function usableNarrative(record) {
  return record?.briefNarrative || record?.narrative || record?.metadataDescription || "";
}

export async function enrichTradeNarratives(config, trades) {
  if (!config.narrativeEnabled || !trades.length) return new Map();

  const cache = await loadCache(config.narrativeCacheFile);
  cache.items ??= {};

  const byAddress = new Map();
  for (const trade of trades) {
    if (!trade.base_address) continue;
    const key = addressKey(trade.base_address);
    if (!byAddress.has(key)) byAddress.set(key, trade);
  }

  const result = new Map();
  const missing = [];
  for (const [key, trade] of byAddress) {
    const cached = cache.items[key];
    if (isFresh(cached, config.narrativeCacheTtlHours) && usableNarrative(cached)) {
      result.set(trade.base_address, cached);
    } else if (missing.length < config.narrativeMaxPerPoll) {
      missing.push(trade);
    }
  }

  if (missing.length) {
    const mod = await loadEnrichmentModule(config);
    const rpm = config.narrativeRequestsPerMinute;
    const delayMs = mod.dexRequestDelayMs ? mod.dexRequestDelayMs(rpm) : Math.ceil(60000 / Math.max(1, rpm));
    const proxy = mod.configuredDexProxy ? mod.configuredDexProxy() : "";
    const { cards } = await mod.enrichContractCards(missing.map(tradeCard), {
      requestsPerMinute: rpm,
      delayMs,
      concurrency: config.narrativeConcurrency,
      proxy,
      metadataSources: config.narrativeMetadataSources,
    });

    for (const card of cards) {
      if (!card?.address) continue;
      const key = addressKey(card.address);
      const record = narrativeRecord(card);
      cache.items[key] = record;
      result.set(card.address, record);
    }

    await saveCache(config.narrativeCacheFile, cache);
    console.log(`Narrative enriched ${cards.length} token(s).`);
  }

  return result;
}
