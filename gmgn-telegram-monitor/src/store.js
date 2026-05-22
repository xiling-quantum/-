import fs from "node:fs/promises";
import path from "node:path";

export async function loadState(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return {
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      firstRunComplete: Boolean(parsed.firstRunComplete),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { seen: [], firstRunComplete: false };
    throw error;
  }
}

export async function saveState(file, state, seenLimit) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const compact = {
    ...state,
    seen: state.seen.slice(-seenLimit),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(compact, null, 2), "utf8");
}

export function tradeKey(trade) {
  return (
    trade.id ||
    [
      trade.chain,
      trade.transaction_hash,
      trade.maker,
      trade.side,
      trade.base_address,
      trade.timestamp,
    ]
      .filter(Boolean)
      .join(":")
  );
}
