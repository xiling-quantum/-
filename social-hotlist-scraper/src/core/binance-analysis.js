function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function isLeveragedToken(baseAsset) {
  return /(?:UP|DOWN|BULL|BEAR)$/i.test(String(baseAsset ?? ""));
}

export function buildBinanceUniverse(symbols, options = {}) {
  const {
    quoteAsset = "USDT",
    excludeLeveraged = true
  } = options;

  return symbols
    .filter((item) => item?.status === "TRADING")
    .filter((item) => item?.isSpotTradingAllowed !== false)
    .filter((item) => item?.quoteAsset === quoteAsset)
    .filter((item) => !excludeLeveraged || !isLeveragedToken(item?.baseAsset))
    .map((item) => ({
      symbol: item.symbol,
      status: item.status,
      baseAsset: item.baseAsset,
      quoteAsset: item.quoteAsset
    }));
}

export function countPositiveDailyStreak(klines) {
  let streakDays = 0;

  for (let index = klines.length - 1; index >= 0; index -= 1) {
    const candle = klines[index];
    if (!Array.isArray(candle) || candle.length < 5) {
      break;
    }

    const openPrice = toNumber(candle[1]);
    const closePrice = toNumber(candle[4]);

    if (openPrice === null || closePrice === null || closePrice <= openPrice) {
      break;
    }

    streakDays += 1;
  }

  return streakDays;
}

export function computeTopGainerStreaks({ dailyKlinesBySymbol, currentTopSymbols, top = 10 }) {
  const movesByDay = new Map();

  for (const [symbol, klines] of dailyKlinesBySymbol.entries()) {
    for (const candle of klines) {
      if (!Array.isArray(candle) || candle.length < 5) {
        continue;
      }

      const dayKey = Number(candle[0]);
      const openPrice = toNumber(candle[1]);
      const closePrice = toNumber(candle[4]);

      if (!Number.isFinite(dayKey) || !openPrice || closePrice === null) {
        continue;
      }

      const priceChangePercent = ((closePrice - openPrice) / openPrice) * 100;
      const moves = movesByDay.get(dayKey) ?? [];
      moves.push({
        symbol,
        priceChangePercent
      });
      movesByDay.set(dayKey, moves);
    }
  }

  const dayKeys = [...movesByDay.keys()].sort((left, right) => left - right);
  const topSymbolsByDay = dayKeys.map((dayKey) => {
    const topSymbols = movesByDay
      .get(dayKey)
      .sort((left, right) => right.priceChangePercent - left.priceChangePercent)
      .slice(0, top)
      .map((item) => item.symbol);

    return new Set(topSymbols);
  });

  if (topSymbolsByDay.length && currentTopSymbols?.length) {
    topSymbolsByDay[topSymbolsByDay.length - 1] = new Set(currentTopSymbols.slice(0, top));
  }

  const streaks = new Map();

  for (const symbol of currentTopSymbols ?? []) {
    let streakDays = 0;

    for (let index = topSymbolsByDay.length - 1; index >= 0; index -= 1) {
      if (!topSymbolsByDay[index].has(symbol)) {
        break;
      }
      streakDays += 1;
    }

    streaks.set(symbol, streakDays);
  }

  return streaks;
}

export function toMoverRow(ticker, symbolMeta, streakDays, minStreakDays = 2) {
  const priceChangePercent = toNumber(ticker?.priceChangePercent);
  const priceChange = toNumber(ticker?.priceChange);
  const quoteVolume = toNumber(ticker?.quoteVolume);
  const volume = toNumber(ticker?.volume);
  const openPrice = toNumber(ticker?.openPrice);
  const lastPrice = toNumber(ticker?.lastPrice);
  const highPrice = toNumber(ticker?.highPrice);
  const lowPrice = toNumber(ticker?.lowPrice);
  const tradeCount = toNumber(ticker?.count);

  return {
    symbol: ticker?.symbol ?? symbolMeta?.symbol ?? null,
    baseAsset: symbolMeta?.baseAsset ?? null,
    quoteAsset: symbolMeta?.quoteAsset ?? null,
    priceChange,
    priceChangePercent,
    openPrice,
    lastPrice,
    highPrice,
    lowPrice,
    volume,
    quoteVolume,
    tradeCount,
    openTime: ticker?.openTime ?? null,
    closeTime: ticker?.closeTime ?? null,
    streakDays,
    isRisingStreak: streakDays >= minStreakDays,
    streakLabel: streakDays >= minStreakDays ? `top10 ${streakDays} days` : ""
  };
}

function parseDateLabel(dateLabel) {
  const match = String(dateLabel ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateLabelUtc(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function previousDateLabel(dateLabel) {
  const date = parseDateLabel(dateLabel);
  if (!date) {
    return null;
  }

  date.setUTCDate(date.getUTCDate() - 1);
  return formatDateLabelUtc(date);
}

export function countConsecutiveTopListAppearances({
  symbol,
  side,
  currentDateLabel,
  previousSummaries
}) {
  const summariesByDate = new Map(
    (previousSummaries ?? [])
      .filter((summary) => summary?.dateLabel)
      .map((summary) => [summary.dateLabel, summary])
  );
  let repeatDays = 1;
  let expectedDateLabel = previousDateLabel(currentDateLabel);

  while (expectedDateLabel) {
    const summary = summariesByDate.get(expectedDateLabel);
    if (!summary) {
      break;
    }

    const rows = summary?.[side] ?? [];
    if (!rows.some((item) => item.symbol === symbol)) {
      break;
    }

    repeatDays += 1;
    expectedDateLabel = previousDateLabel(expectedDateLabel);
  }

  return repeatDays;
}

export function selectTopMovers(rows, top = 10) {
  const gainers = [...rows]
    .sort((left, right) => (right.priceChangePercent ?? -Infinity) - (left.priceChangePercent ?? -Infinity))
    .slice(0, top)
    .map((item, index) => ({ ...item, rank: index + 1, side: "gainer" }));

  const losers = [...rows]
    .sort((left, right) => (left.priceChangePercent ?? Infinity) - (right.priceChangePercent ?? Infinity))
    .slice(0, top)
    .map((item, index) => ({ ...item, rank: index + 1, side: "loser" }));

  return {
    gainers,
    losers
  };
}
