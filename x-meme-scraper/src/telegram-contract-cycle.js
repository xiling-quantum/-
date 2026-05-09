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

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

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

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function mark(value) {
  if (value === "yes" || value === true) return "OK";
  if (value === "no" || value === false) return "NO";
  return "UNKNOWN";
}

function formatContractCards(payload) {
  const cards = buildContractCards(payload, 20);
  const lines = [
    "\u005bTelegram CA \u76d1\u63a7 - 30\u5206\u949f\u66f4\u65b0\u005d",
    "\u4ec5\u5c55\u793a\u6d88\u606f\u4e2d\u80fd\u63d0\u53d6\u5230\u7684\u5b57\u6bb5\u3002",
    `\u6709\u6548\u7fa4/\u9891\u9053: ${payload.targets?.length || 0}`,
    `\u542b CA \u6d88\u606f: ${payload.totalPosts || 0}`,
    `\u91cd\u590d CA \u6570: ${payload.contractSummary?.length || 0}`,
    ""
  ];

  for (const card of cards) {
    const titleParts = [];
    if (card.ticker) titleParts.push(`$${card.ticker}`);
    if (card.name && card.name !== card.ticker) titleParts.push(card.name);
    if (card.chain) titleParts.push(card.chain);
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
    lines.push("");
  }

  if (!cards.length) {
    lines.push("\u672c\u8f6e\u6ca1\u6709\u53d1\u73b0\u91cd\u590d CA\u3002");
  }
  return lines.join("\n");
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
    "100"
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
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

async function main() {
  const result = await runScrape();
  if (!result.jsonPath) throw new Error("Telegram scrape completed but no JSON output path was found.");
  const payload = JSON.parse(await fs.readFile(result.jsonPath, "utf8"));
  const duplicateCsv = await writeDuplicateCsv(payload, result.jsonPath);
  await notify(`${formatContractCards(payload)}\n\u5b8c\u6574 CSV: ${path.basename(duplicateCsv)}`);
  console.log(`Telegram contract cycle complete: ${result.jsonPath}`);
  console.log(`Duplicate CSV: ${duplicateCsv}`);
}

main().catch((error) => {
  console.error(error.message);
  if (error.stderr) console.error(error.stderr);
  process.exitCode = 1;
});
