import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBinanceUniverse,
  chunkItems,
  countConsecutiveTopListAppearances,
  selectTopMovers,
  toMoverRow
} from "./core/binance-analysis.js";
import { buildBinanceSite } from "./core/binance-site.js";
import { writeObjectsCsv, writeRunSummary } from "./core/output.js";
import { slugifyTimestamp, withRetries } from "./core/utils.js";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, "data", "binance");
const DEFAULT_OPTIONS = {
  baseUrl: "https://data-api.binance.vision",
  quoteAsset: "USDT",
  top: 10,
  timezoneOffset: "8",
  labelTimeZone: "Asia/Shanghai",
  historyDays: 10,
  retentionDays: 30,
  minStreakDays: 2,
  excludeLeveraged: true,
  outputDir: DEFAULT_OUTPUT_DIR
};

function printHelp() {
  console.log(`Binance daily movers

Usage:
  npm run binance-daily -- [options]

Options:
  --top <number>                Top gainers / losers count, default 10
  --quote-asset <symbol>        Quote asset filter, default USDT
  --timezone-offset <offset>    Binance trading day timezone, default 8
  --label-timezone <iana>       Output label timezone, default Asia/Shanghai
  --history-days <number>       Historical snapshot lookback for repeat labels, default 10
  --retention-days <number>     Number of dated snapshots to keep, default 30
  --min-streak-days <number>    Repeat label threshold, default 2
  --include-leveraged           Keep leveraged tokens like BTCUP/BTCDOWN
  --output-dir <path>           Output directory, default ./data/binance
  --help                        Show help
`);
}

function parseArgs(argv) {
  const options = { ...DEFAULT_OPTIONS };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--include-leveraged") {
      options.excludeLeveraged = false;
      continue;
    }

    const nextValue = argv[index + 1];

    if (!nextValue || nextValue.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    switch (arg) {
      case "--top":
        options.top = Number(nextValue);
        index += 1;
        break;
      case "--quote-asset":
        options.quoteAsset = nextValue.toUpperCase();
        index += 1;
        break;
      case "--timezone-offset":
        options.timezoneOffset = nextValue;
        index += 1;
        break;
      case "--label-timezone":
        options.labelTimeZone = nextValue;
        index += 1;
        break;
      case "--history-days":
        options.historyDays = Number(nextValue);
        index += 1;
        break;
      case "--retention-days":
        options.retentionDays = Number(nextValue);
        index += 1;
        break;
      case "--min-streak-days":
        options.minStreakDays = Number(nextValue);
        index += 1;
        break;
      case "--output-dir":
        options.outputDir = path.resolve(PROJECT_ROOT, nextValue);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.top) || options.top <= 0) {
    throw new Error("--top must be a positive integer");
  }

  if (!Number.isInteger(options.historyDays) || options.historyDays < 2) {
    throw new Error("--history-days must be an integer >= 2");
  }

  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) {
    throw new Error("--retention-days must be an integer >= 1");
  }

  if (!Number.isInteger(options.minStreakDays) || options.minStreakDays < 1) {
    throw new Error("--min-streak-days must be an integer >= 1");
  }

  return options;
}

async function fetchJson(baseUrl, pathname, params = {}) {
  const url = new URL(pathname, baseUrl);

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return withRetries(
    async () => {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Binance API ${response.status} for ${url.pathname}: ${body.slice(0, 200)}`);
      }

      return response.json();
    },
    {
      retries: 2,
      label: `fetch ${url.pathname}`
    }
  );
}

async function fetchSpotUniverse(options) {
  const payload = await fetchJson(options.baseUrl, "/api/v3/exchangeInfo", {
    permissions: "SPOT",
    symbolStatus: "TRADING"
  });

  return buildBinanceUniverse(payload?.symbols ?? [], {
    quoteAsset: options.quoteAsset,
    excludeLeveraged: options.excludeLeveraged
  });
}

async function fetchTradingDayTickers(symbols, options) {
  const rows = [];

  for (const chunk of chunkItems(symbols, 100)) {
    const payload = await fetchJson(options.baseUrl, "/api/v3/ticker/tradingDay", {
      symbols: JSON.stringify(chunk.map((item) => item.symbol)),
      type: "FULL",
      timeZone: options.timezoneOffset,
      symbolStatus: "TRADING"
    });

    rows.push(...(Array.isArray(payload) ? payload : [payload]));
  }

  return rows;
}

function formatDateLabel(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((item) => item.type === "year")?.value;
  const month = parts.find((item) => item.type === "month")?.value;
  const day = parts.find((item) => item.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadHistoricalSummaries(outputDir) {
  if (!(await pathExists(outputDir))) {
    return [];
  }

  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const summaries = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "latest") {
      continue;
    }

    const summaryPath = path.join(outputDir, entry.name, "summary.json");
    try {
      const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
      if (summary?.dateLabel) {
        summaries.push(summary);
      }
    } catch {
      // Ignore incomplete historical runs.
    }
  }

  return summaries.sort((left, right) => left.dateLabel.localeCompare(right.dateLabel));
}

async function pruneOldSnapshots(outputDir, keepDays) {
  if (!(await pathExists(outputDir))) {
    return [];
  }

  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const datedDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort();
  const toDelete = datedDirs.slice(0, Math.max(0, datedDirs.length - keepDays));

  for (const dateDir of toDelete) {
    await fs.rm(path.join(outputDir, dateDir), { recursive: true, force: true });
  }

  return toDelete;
}

function annotateRepeats(rows, side, previousSummaries, currentDateLabel, minRepeatDays) {
  return rows.map((row) => {
    const repeatDays = countConsecutiveTopListAppearances({
      symbol: row.symbol,
      side,
      currentDateLabel,
      previousSummaries
    });
    return {
      ...row,
      streakDays: repeatDays,
      isRisingStreak: repeatDays >= minRepeatDays,
      streakLabel: repeatDays >= minRepeatDays ? `repeat ${repeatDays} days` : "",
      repeatDays,
      isRepeated: repeatDays >= minRepeatDays,
      repeatLabel: repeatDays >= minRepeatDays ? `连续出现 ${repeatDays} 天` : ""
    };
  });
}

function buildHistoryArchive(summaries, limit) {
  return summaries
    .slice(-limit)
    .map((summary) => ({
      dateLabel: summary.dateLabel,
      generatedAt: summary.generatedAt,
      quoteAsset: summary.quoteAsset,
      top: summary.top,
      universe: summary.universe,
      gainers: summary.gainers ?? [],
      losers: summary.losers ?? []
    }));
}

function createConsoleTable(title, rows) {
  const lines = [title];

  for (const row of rows) {
    const streak = row.isRisingStreak ? ` | ${row.streakLabel}` : "";
    lines.push(
      `${String(row.rank).padStart(2, "0")}. ${row.symbol} ${row.priceChangePercent?.toFixed(2)}%${streak}`
    );
  }

  return lines.join("\n");
}

export async function runBinanceDaily(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exitCode = 1;
    return null;
  }

  if (options.help) {
    printHelp();
    return null;
  }

  const generatedAt = new Date();
  const dateLabel = formatDateLabel(generatedAt, options.labelTimeZone);
  const runDir = path.join(options.outputDir, dateLabel);
  const latestDir = path.join(options.outputDir, "latest");

  await fs.mkdir(runDir, { recursive: true });

  const universe = await fetchSpotUniverse(options);
  const tickers = await fetchTradingDayTickers(universe, options);
  const metaBySymbol = new Map(universe.map((item) => [item.symbol, item]));
  const selectedSymbols = new Set(tickers.map((item) => item.symbol));
  const availableUniverse = universe.filter((item) => selectedSymbols.has(item.symbol));

  const allRows = tickers.map((ticker) =>
    toMoverRow(ticker, metaBySymbol.get(ticker.symbol), 1, options.minStreakDays)
  );
  const leaders = selectTopMovers(allRows, options.top);
  const historicalSummaries = (await loadHistoricalSummaries(options.outputDir))
    .filter((summary) => summary.dateLabel !== dateLabel);
  const previousSummaries = historicalSummaries.filter((summary) => summary.dateLabel < dateLabel);
  const annotatedGainers = annotateRepeats(
    leaders.gainers,
    "gainers",
    previousSummaries,
    dateLabel,
    options.minStreakDays
  );
  const annotatedLosers = annotateRepeats(
    leaders.losers,
    "losers",
    previousSummaries,
    dateLabel,
    options.minStreakDays
  );
  const summary = {
    runId: slugifyTimestamp(generatedAt),
    generatedAt: generatedAt.toISOString(),
    dateLabel,
    baseUrl: options.baseUrl,
    quoteAsset: options.quoteAsset,
    timezoneOffset: options.timezoneOffset,
    labelTimeZone: options.labelTimeZone,
    top: options.top,
    minStreakDays: options.minStreakDays,
    historyDays: options.historyDays,
    retentionDays: options.retentionDays,
    excludeLeveraged: options.excludeLeveraged,
    universe: {
      eligibleSymbols: universe.length,
      symbolsWithTradingDayData: availableUniverse.length
    },
    gainers: annotatedGainers,
    losers: annotatedLosers
  };
  summary.history = buildHistoryArchive([...historicalSummaries, summary], options.historyDays);

  await writeRunSummary(path.join(runDir, "summary.json"), summary);
  await writeObjectsCsv(path.join(runDir, "gainers.csv"), leaders.gainers);
  await writeObjectsCsv(path.join(runDir, "losers.csv"), leaders.losers);
  const siteBuild = await buildBinanceSite({ outputDir: runDir, summary });

  await fs.rm(latestDir, { recursive: true, force: true });
  await fs.mkdir(latestDir, { recursive: true });
  await fs.copyFile(path.join(runDir, "summary.json"), path.join(latestDir, "summary.json"));
  await fs.copyFile(path.join(runDir, "gainers.csv"), path.join(latestDir, "gainers.csv"));
  await fs.copyFile(path.join(runDir, "losers.csv"), path.join(latestDir, "losers.csv"));
  await fs.mkdir(path.join(latestDir, "site"), { recursive: true });
  await fs.copyFile(siteBuild.entryFile, path.join(latestDir, "site", "index.html"));
  const prunedSnapshots = await pruneOldSnapshots(options.outputDir, options.retentionDays);

  console.log(createConsoleTable("Top Gainers", leaders.gainers));
  console.log("");
  console.log(createConsoleTable("Top Losers", leaders.losers));
  console.log("");
  console.log(`summary written: ${path.join(runDir, "summary.json")}`);
  console.log(`site written: ${siteBuild.entryFile}`);
  if (prunedSnapshots.length) {
    console.log(`pruned snapshots: ${prunedSnapshots.join(", ")}`);
  }

  return {
    runDir,
    latestDir,
    summary,
    prunedSnapshots,
    siteEntryFile: siteBuild.entryFile
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await runBinanceDaily();
}
