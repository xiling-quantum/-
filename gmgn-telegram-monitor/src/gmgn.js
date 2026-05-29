import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const walletProfileCache = new Map();
const WALLET_PROFILE_CACHE_MS = 6 * 60 * 60 * 1000;

function cliPath(rootDir) {
  return path.join(rootDir, "node_modules", "gmgn-cli", "dist", "index.js");
}

function walletAddressFromTrade(trade) {
  return String(trade?.maker || trade?.maker_info?.address || "").trim();
}

function profileDisplayName(profile) {
  return (
    profile?.name ||
    profile?.nick_name ||
    profile?.twitter_name ||
    profile?.twitter_username ||
    ""
  );
}

function normalizeWalletProfile(address, data) {
  const common = data?.common || {};
  return {
    address: data?.wallet_address || common.wallet_address || address,
    avatar: common.avatar || "",
    tag: common.tag || "",
    tags: Array.isArray(common.tags) ? common.tags : [],
    tag_rank: common.tag_rank || {},
    name: common.name || common.nick_name || "",
    twitter_username: common.twitter_username || "",
    twitter_name: common.twitter_name || "",
  };
}

async function fetchWalletProfile(config, address) {
  const cached = walletProfileCache.get(address);
  if (cached && Date.now() - cached.loadedAt < WALLET_PROFILE_CACHE_MS) return cached.profile;

  const args = [
    "portfolio",
    "stats",
    "--chain",
    config.chain,
    "--wallet",
    address,
    "--raw",
  ];
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

  const profile = normalizeWalletProfile(address, JSON.parse(stdout.trim()));
  walletProfileCache.set(address, { loadedAt: Date.now(), profile });
  return profile;
}

export async function enrichWalletProfiles(config, trades) {
  const addresses = [
    ...new Set(trades.map(walletAddressFromTrade).filter(Boolean)),
  ];
  if (addresses.length === 0) return trades;

  const profiles = new Map();
  for (const address of addresses) {
    try {
      const profile = await fetchWalletProfile(config, address);
      if (profileDisplayName(profile)) profiles.set(address, profile);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Wallet profile lookup failed for ${address.slice(0, 6)}...${address.slice(-4)}: ${error.message}`);
    }
  }

  if (profiles.size === 0) return trades;
  return trades.map((trade) => {
    const address = walletAddressFromTrade(trade);
    const profile = profiles.get(address);
    if (!profile) return trade;
    return {
      ...trade,
      maker_info: {
        ...(trade.maker_info || {}),
        ...profile,
        address,
      },
    };
  });
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
