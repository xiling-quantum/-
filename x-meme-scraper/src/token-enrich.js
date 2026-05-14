import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./local-env.js";
import { buildContractCards } from "./telegram-contracts.js";
import {
  configuredDexProxy,
  configuredDexRequestsPerMinute,
  dexRequestDelayMs,
  enrichContractCards
} from "./token-enrichment.js";

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

async function latestInputPath(source) {
  const explicit = String(argValue("input", "") || "").trim();
  if (explicit) return path.resolve(projectRoot, explicit);
  const prefix = source === "monitor" ? "telegram-monitor-" : "telegram-special-";
  const files = (await fs.readdir(dataDir))
    .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error(`No ${prefix}*.json files found in data/.`);
  return path.join(dataDir, files.at(-1));
}

async function main() {
  const source = String(argValue("source", "special")).trim() === "monitor" ? "monitor" : "special";
  const limit = boundedNumber(argValue("limit", "20"), 20, 1, 200);
  const rpm = configuredDexRequestsPerMinute(argValue("dexRpm", ""));
  const explicitDelay = argValue("delayMs", "");
  const delayMs = explicitDelay === "" ? dexRequestDelayMs(rpm) : boundedNumber(explicitDelay, dexRequestDelayMs(rpm), 0, 60_000);
  const proxy = configuredDexProxy(argValue("proxy", ""));
  const inputPath = await latestInputPath(source);
  const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const baseCards = buildContractCards(payload, limit);

  console.log(`DexScreener pacing: ${rpm}/min, delay ${delayMs}ms.`);
  const { cards, rateLimit } = await enrichContractCards(baseCards, {
    requestsPerMinute: rpm,
    delayMs,
    proxy
  });

  await fs.mkdir(dataDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(dataDir, `token-enriched-${source}-${timestamp}.json`);
  const csvPath = path.join(dataDir, `token-enriched-${source}-${timestamp}.csv`);
  const output = {
    source,
    inputPath,
    generatedAt: new Date().toISOString(),
    proxy: proxy ? "configured" : "direct",
    rateLimit,
    totalRequested: cards.length,
    totalFound: cards.filter((item) => item.dexFound).length,
    items: cards
  };
  await fs.writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  const rows = [
    [
      "rank",
      "count",
      "address",
      "found",
      "chain",
      "dexId",
      "ticker",
      "name",
      "pairCreatedAt",
      "marketCap",
      "liquidity",
      "volume24h",
      "change24h",
      "onChainNarrative",
      "signalNarrative",
      "narrative",
      "pairUrl",
      "groups",
      "error"
    ].map(csvCell).join(","),
    ...cards.map((item) => [
      item.rank,
      item.count,
      item.address,
      item.dexFound,
      item.chain || "",
      item.dexId || "",
      item.ticker || "",
      item.name || "",
      item.pairCreatedAt || "",
      item.marketCap || "",
      item.liquidity || "",
      item.volume24h || "",
      item.change24h || "",
      item.onChainNarrative || "",
      item.signalNarrative || "",
      item.narrative || "",
      item.pairUrl || "",
      (item.groups || []).join(" | "),
      item.dexError || ""
    ].map(csvCell).join(","))
  ];
  await fs.writeFile(csvPath, `${rows.join("\n")}\n`, "utf8");
  console.log(`Enriched ${output.totalFound}/${output.totalRequested} tokens from ${path.basename(inputPath)}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
