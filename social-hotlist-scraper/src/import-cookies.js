import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStorageStateFromCookieText } from "./core/cookie-import.js";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const SUPPORTED_PLATFORMS = ["tiktok", "instagram"];

function printHelp() {
  console.log(`Usage: npm run import-cookies -- --platform tiktok --input ./storage/manual/tiktok-cookies.json

Options:
  --platform <name>    tiktok | instagram
  --input <path>       Path to a local cookie file (JSON export or raw Cookie header string)
  --output <path>      Optional output storageState path
  --help               Show this message`);
}

function resolveMaybeRelative(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.resolve(PROJECT_ROOT, inputPath);
}

function parseArgs(argv) {
  const args = {
    platform: null,
    input: null,
    output: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next) {
      throw new Error(`Missing value for ${current}`);
    }

    if (current === "--platform") {
      args.platform = next.toLowerCase();
      index += 1;
      continue;
    }

    if (current === "--input") {
      args.input = next;
      index += 1;
      continue;
    }

    if (current === "--output") {
      args.output = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  if (!args.help && !SUPPORTED_PLATFORMS.includes(args.platform)) {
    throw new Error(`Platform must be one of: ${SUPPORTED_PLATFORMS.join(", ")}`);
  }

  if (!args.help && !args.input) {
    throw new Error("Missing value for --input");
  }

  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = resolveMaybeRelative(args.input);
  const outputPath = resolveMaybeRelative(args.output || `./storage/${args.platform}-state.json`);
  const rawText = await fs.readFile(inputPath, "utf8");
  const storageState = buildStorageStateFromCookieText(rawText, args.platform);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(storageState, null, 2), "utf8");

  const domains = [...new Set(storageState.cookies.map((cookie) => cookie.domain))];
  console.log(`Imported ${storageState.cookies.length} ${args.platform} cookies.`);
  console.log(`Saved storage state to ${outputPath}`);
  console.log(`Domains: ${domains.join(", ")}`);
}

await main();
