import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBinanceDaily } from "./binance-daily.js";
import {
  loadEmailConfig,
  readLatestBinanceSummary,
  sendBinanceEmail
} from "./core/binance-email.js";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config", "binance-email.local.json");

function printHelp() {
  console.log(`Binance email sender

Usage:
  npm run binance-email -- [options]

Options:
  --config <path>      Email config path, default ./config/binance-email.local.json
  --fetch-first        Run binance-daily before sending email
  --help               Show help
`);
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    fetchFirst: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--fetch-first") {
      options.fetchFirst = true;
      continue;
    }

    const nextValue = argv[index + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === "--config") {
      options.configPath = path.resolve(PROJECT_ROOT, nextValue);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export async function runBinanceEmail(argv = process.argv.slice(2)) {
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

  if (options.fetchFirst) {
    const dailyResult = await runBinanceDaily([]);
    if (!dailyResult) {
      throw new Error("binance-daily failed, email not sent");
    }
  }

  const config = await loadEmailConfig(options.configPath);
  if (!config.smtp.user || !config.smtp.pass) {
    throw new Error("Missing QQ SMTP credentials in config or environment");
  }
  if (!config.mail.to.length) {
    throw new Error("Missing recipient email in config");
  }

  const summary = await readLatestBinanceSummary(PROJECT_ROOT);
  const result = await sendBinanceEmail({
    config,
    summary
  });

  console.log(`email sent: ${result.messageId}`);
  return result;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await runBinanceEmail();
}
