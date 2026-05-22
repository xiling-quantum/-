import { loadConfig, validateConfig } from "./config.js";
import { fetchFollowWalletTrades } from "./gmgn.js";
import { formatTradeCards } from "./format.js";
import { sendTelegramMessage } from "./telegram.js";
import { loadState, saveState, tradeKey } from "./store.js";
import { configureProxy } from "./proxy.js";
import { enrichTradeNarratives } from "./narrative.js";
import { ensureAutoWalletAliases, loadWalletAliases } from "./walletAliases.js";

const once = process.argv.includes("--once");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortOldestFirst(trades) {
  return [...trades].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

async function poll(config, state) {
  const trades = await fetchFollowWalletTrades(config);
  const seen = new Set(state.seen);
  const keys = trades.map(tradeKey).filter(Boolean);

  if (!state.firstRunComplete && config.startupSuppressExisting) {
    if (config.walletAutoNumberAliases) {
      await ensureAutoWalletAliases(config.walletAliasFile, trades);
    }
    for (const key of keys) seen.add(key);
    state.seen = [...seen];
    state.firstRunComplete = true;
    await saveState(config.stateFile, state, config.seenLimit);
    console.log(`Startup baseline saved: ${keys.length} existing trades suppressed.`);
    return;
  }

  const fresh = sortOldestFirst(trades)
    .filter((trade) => {
      const key = tradeKey(trade);
      return key && !seen.has(key);
    })
    .slice(0, config.maxMessagesPerPoll);

  if (fresh.length > 0) {
    let narratives = new Map();
    try {
      narratives = await enrichTradeNarratives(config, fresh);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Narrative enrichment failed: ${error.message}`);
    }
    const walletAliases = config.walletAutoNumberAliases
      ? await ensureAutoWalletAliases(config.walletAliasFile, trades)
      : await loadWalletAliases(config.walletAliasFile);
    await sendTelegramMessage(config, formatTradeCards(fresh, "GMGN Follow Wallet", narratives, walletAliases));
    for (const trade of fresh) {
      const key = tradeKey(trade);
      seen.add(key);
    }
    console.log(`Forwarded ${fresh.length} trades as cards.`);
  }

  state.seen = [...seen];
  state.firstRunComplete = true;
  await saveState(config.stateFile, state, config.seenLimit);
  console.log(`Poll complete: fetched=${trades.length}, forwarded=${fresh.length}.`);
}

async function main() {
  const config = loadConfig();
  validateConfig(config);
  configureProxy();

  const state = await loadState(config.stateFile);
  console.log(`GMGN Telegram monitor started. chain=${config.chain}, interval=${config.pollIntervalMs / 1000}s`);

  if (once) {
    await poll(config, state);
    return;
  }

  while (true) {
    try {
      await poll(config, state);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${error.message}`);
    }
    await sleep(config.pollIntervalMs);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
