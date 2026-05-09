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
  "群聊消息",
  "CA",
  "CryptoD全员群｜二娃聚合",
  "群主发言群",
  "Huang黄群（二级/MEME）",
  "二级交易博主点位群",
  "半小时群聊AI总结",
  "币安聪明钱实盘｜二娃聚合",
  "每日总结｜二娃聚合",
  "所有禁言群",
  "失眠聚合群交流",
  "二娃聚合"
];

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function infoLines(info = {}) {
  const lines = [];
  if (info.ticker) lines.push(`Ticker: ${info.ticker}`);
  if (info.name) lines.push(`Name: ${String(info.name).slice(0, 80)}`);
  if (info.marketCap) lines.push(`MC: ${info.marketCap}`);
  if (info.liquidity) lines.push(`Liq: ${info.liquidity}`);
  if (info.holders) lines.push(`Holders: ${info.holders}`);
  if (info.volume24h) lines.push(`Vol24h: ${info.volume24h}`);
  if (info.change24h) lines.push(`24h: ${info.change24h}`);
  if (info.narrative) lines.push(`Narrative: ${String(info.narrative).slice(0, 140)}`);
  return lines;
}

function mark(value) {
  if (value === "yes" || value === true) return "OK";
  if (value === "no" || value === false) return "NO";
  return "UNKNOWN";
}

function formatContractCards(payload) {
  const cards = buildContractCards(payload, 20);
  const lines = [
    "[Telegram CA 监控 - 30分钟更新]",
    "仅展示消息中能提取到的字段。",
    `有效群/频道: ${payload.targets?.length || 0}`,
    `含 CA 消息: ${payload.totalPosts || 0}`,
    `重复 CA 数: ${payload.contractSummary?.length || 0}`,
    `生成时间: ${payload.generatedAt || new Date().toISOString()}`,
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
    lines.push("交易信息:");
    if (card.age) lines.push(`- 开盘时间: ${card.age}`);
    if (card.marketCap) lines.push(`- 市值: ${card.marketCap}`);
    if (card.liquidity) lines.push(`- 流动性: ${card.liquidity}`);
    if (card.holders) lines.push(`- 持有人: ${card.holders}`);
    if (card.volume24h) lines.push(`- 24h 交易量: ${card.volume24h}`);
    if (card.change24h) lines.push(`- 24h: ${card.change24h}`);
    lines.push(`- 链接: gmgn ${mark(card.hasGmgn)} | dex ${mark(card.hasDexscreener)} | 官网 ${mark(card.hasWebsite)} | 推特 ${mark(card.hasTwitter)}`);
    if (card.narrative) {
      lines.push("");
      lines.push("叙事:");
      lines.push(card.narrative);
    }
    lines.push("");
    lines.push(`本轮提及次数: ${card.count}`);
    lines.push(`来源群: ${(card.groups || []).join(" / ")}`);
    if (card.url) lines.push(`来源链接: ${card.url}`);
    lines.push("");
  }

  if (!cards.length) {
    lines.push("本轮没有发现重复 CA。");
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
    const timer = setTimeout(() => {
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
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
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
  await notify(`${formatContractCards(payload)}\n完整 CSV: ${path.basename(duplicateCsv)}`);
  console.log(`Telegram contract cycle complete: ${result.jsonPath}`);
  console.log(`Duplicate CSV: ${duplicateCsv}`);
}

main().catch((error) => {
  console.error(error.message);
  if (error.stderr) console.error(error.stderr);
  process.exitCode = 1;
});
