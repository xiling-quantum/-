import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { loadLocalEnv, parseSocksProxy } from "./local-env.js";
import { sendTelegramNotification } from "./telegram-notify.js";

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

function formatRanking(payload) {
  const summary = Array.isArray(payload.contractSummary) ? payload.contractSummary : [];
  const lines = [
    "[Telegram CA Ranking - 30m Update]",
    "Only fields found in messages are shown.",
    `Valid channels: ${payload.targets?.length || 0}`,
    `CA messages: ${payload.totalPosts || 0}`,
    `Repeated CA count: ${summary.length}`,
    `Generated: ${payload.generatedAt || new Date().toISOString()}`,
    ""
  ];

  for (let index = 0; index < Math.min(20, summary.length); index += 1) {
    const item = summary[index];
    lines.push(`#${String(index + 1).padStart(2, "0")} | ${item.count}x | ${item.address}`);
    const details = infoLines(item.info);
    if (details.length) lines.push(...details.map((line) => `  ${line}`));
    lines.push(`  Groups: ${(item.groups || []).join(" / ")}`);
    lines.push("");
  }

  if (!summary.length) {
    lines.push("No repeated CA found in this cycle.");
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
  await notify(`${formatRanking(payload)}\nFull CSV: ${path.basename(duplicateCsv)}`);
  console.log(`Telegram contract cycle complete: ${result.jsonPath}`);
  console.log(`Duplicate CSV: ${duplicateCsv}`);
}

main().catch((error) => {
  console.error(error.message);
  if (error.stderr) console.error(error.stderr);
  process.exitCode = 1;
});
