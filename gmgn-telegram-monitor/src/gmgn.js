import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function cliPath(rootDir) {
  return path.join(rootDir, "node_modules", "gmgn-cli", "dist", "index.js");
}

export async function fetchFollowWalletTrades(config) {
  const args = [
    "track",
    "follow-wallet",
    "--chain",
    config.chain,
    "--limit",
    String(config.limit),
    "--raw",
  ];

  if (config.side !== "all") args.push("--side", config.side);
  if (config.walletFilter) args.push("--wallet", config.walletFilter);
  if (config.minAmountUsd) args.push("--min-amount-usd", config.minAmountUsd);
  if (config.maxAmountUsd) args.push("--max-amount-usd", config.maxAmountUsd);

  const env = {
    ...process.env,
    GMGN_API_KEY: config.gmgnApiKey,
    GMGN_PRIVATE_KEY: config.gmgnPrivateKey,
  };

  const { stdout } = await execFileAsync(process.execPath, [cliPath(config.rootDir), ...args], {
    cwd: config.rootDir,
    env,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });

  const parsed = JSON.parse(stdout.trim());
  return Array.isArray(parsed?.list) ? parsed.list : [];
}
