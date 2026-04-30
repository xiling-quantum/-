import { SUPPORTED_PLATFORMS } from "./constants.js";

function consumeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseBoolean(value) {
  if (value === undefined) {
    return true;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

export function parseCliArgs(argv) {
  const result = {
    platform: "all",
    config: "./config/sources.example.json",
    headless: undefined,
    limit: undefined,
    minCommentCount: undefined,
    minHotScore: undefined,
    minAmazonSalesCount: undefined,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    switch (current) {
      case "--platform":
        result.platform = consumeValue(argv, index, current).toLowerCase();
        index += 1;
        break;
      case "--config":
        result.config = consumeValue(argv, index, current);
        index += 1;
        break;
      case "--headless":
        if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
          result.headless = true;
        } else {
          result.headless = parseBoolean(argv[index + 1]);
          index += 1;
        }
        break;
      case "--limit":
        result.limit = Number(consumeValue(argv, index, current));
        if (!Number.isInteger(result.limit) || result.limit <= 0) {
          throw new Error("--limit must be a positive integer");
        }
        index += 1;
        break;
      case "--min-comment-count":
        result.minCommentCount = Number(consumeValue(argv, index, current));
        if (!Number.isInteger(result.minCommentCount) || result.minCommentCount < 0) {
          throw new Error("--min-comment-count must be an integer >= 0");
        }
        index += 1;
        break;
      case "--min-hot-score":
        result.minHotScore = Number(consumeValue(argv, index, current));
        if (!Number.isInteger(result.minHotScore) || result.minHotScore < 0) {
          throw new Error("--min-hot-score must be an integer >= 0");
        }
        index += 1;
        break;
      case "--min-amazon-sales-count":
        result.minAmazonSalesCount = Number(consumeValue(argv, index, current));
        if (!Number.isInteger(result.minAmazonSalesCount) || result.minAmazonSalesCount < 0) {
          throw new Error("--min-amazon-sales-count must be an integer >= 0");
        }
        index += 1;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  if (result.platform !== "all" && !SUPPORTED_PLATFORMS.includes(result.platform)) {
    throw new Error(`Unsupported platform "${result.platform}"`);
  }

  return result;
}

export function printCollectHelp() {
  console.log(`Usage: npm run collect -- --config ./config/sources.example.json --platform all

Options:
  --config <path>      Path to the JSON config file
  --platform <name>    all | tiktok | instagram | amazon | fastmoss | x
  --headless <bool>    Override config headless value
  --limit <number>     Override max posts per target
  --min-comment-count <n>  Drop social records below the minimum comment count
  --min-hot-score <n>  Drop records below the minimum hotScore
  --min-amazon-sales-count <n>  Drop Amazon records below the minimum sales count proxy
  --help               Show this message`);
}

export function printAuthHelp() {
  console.log(`Usage: npm run auth -- --platform tiktok

Options:
  --platform <name>    tiktok | instagram
  --config <path>      Optional config file path
  --session-mode <s>   storageState | persistentProfile
  --user-data-dir <p>  Browser user data directory for persistentProfile mode
  --profile-directory  Browser profile name, for example Default
  --channel <name>     chrome | msedge | chromium
  --help               Show this message`);
}
