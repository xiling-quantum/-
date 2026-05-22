function short(value, left = 6, right = 4) {
  if (!value || value.length <= left + right + 3) return value ?? "";
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function moneyCompact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return `$${number.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function decimal(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return number.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tradeTime(timestamp) {
  const number = Number(timestamp);
  if (!Number.isFinite(number)) return "n/a";
  return new Date(number * 1000).toISOString();
}

function tradeTimeShanghai(timestamp) {
  const number = Number(timestamp);
  if (!Number.isFinite(number)) return "n/a";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(number * 1000));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function tradeTimeShanghaiShort(timestamp) {
  const number = Number(timestamp);
  if (!Number.isFinite(number)) return "n/a";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(number * 1000));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function tableValue(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}

function directionLabel(side) {
  const value = String(side || "").toLowerCase();
  if (value === "buy") return "买入";
  if (value === "sell") return "卖出";
  return value.toUpperCase() || "-";
}

function tokenLabel(trade) {
  return trade.base_token?.symbol || short(trade.base_address);
}

function walletAlias(walletAliases, address) {
  if (!walletAliases || !address) return "";
  return walletAliases.get(address) || walletAliases.get(String(address).toLowerCase()) || "";
}

function walletLabel(trade, walletAliases = new Map()) {
  const alias = walletAlias(walletAliases, trade.maker);
  if (alias) return `${alias} / ${short(trade.maker)}`;
  const name = trade.maker_info?.name || trade.maker_info?.twitter_username;
  if (name) return `${name} / ${short(trade.maker)}`;
  return short(trade.maker);
}

function tradeLinks(trade) {
  const links = [];
  if (trade.base_address) {
    links.push(`<a href="${html(`https://gmgn.ai/${trade.chain}/token/${trade.base_address}`)}">GMGN</a>`);
  }
  if (trade.chain === "sol" && trade.transaction_hash) {
    links.push(`<a href="${html(`https://solscan.io/tx/${trade.transaction_hash}`)}">Tx</a>`);
  }
  return links.join(" | ");
}

export function formatTrade(trade) {
  const token = tokenLabel(trade);
  const makerName = trade.maker_info?.name || trade.maker_info?.twitter_username || short(trade.maker);
  const side = directionLabel(trade.side);
  const txUrl =
    trade.chain === "sol"
      ? `https://solscan.io/tx/${trade.transaction_hash}`
      : undefined;
  const gmgnUrl = trade.base_address
    ? `https://gmgn.ai/${trade.chain}/token/${trade.base_address}`
    : undefined;
  const fullEvent = trade.is_open_or_close === 1 ? "full open/close" : "partial add/reduce";

  const lines = [
    `<b>GMGN Follow Wallet ${html(side)}</b>`,
    `Token: <b>${html(token)}</b>`,
    `Amount: ${html(money(trade.amount_usd))}`,
    `Wallet: ${html(makerName)} (${html(short(trade.maker))})`,
    `Event: ${html(fullEvent)}`,
    `Time: ${html(tradeTime(trade.timestamp))}`,
    `Price: ${html(money(trade.price_usd))} | Now: ${html(money(trade.price_now))}`,
    `Change: ${html(decimal(trade.price_change, 4))}x`,
  ];

  if (trade.launchpad) lines.push(`Launchpad: ${html(trade.launchpad)}`);
  if (trade.base_address) lines.push(`CA: <code>${html(trade.base_address)}</code>`);
  if (txUrl) lines.push(`<a href="${html(txUrl)}">Transaction</a>`);
  if (gmgnUrl) lines.push(`<a href="${html(gmgnUrl)}">GMGN Token Page</a>`);

  return lines.join("\n");
}

export function formatTradeTable(trades, title = "结果摘要：", walletAliases = new Map()) {
  const rows = trades.map((trade, index) => ({
    index: String(index + 1),
    side: String(trade.side || "-").toLowerCase(),
    token: tableValue(tokenLabel(trade), 14),
    amount: moneyCompact(trade.amount_usd),
    wallet: tableValue(walletLabel(trade, walletAliases), 14),
    time: tradeTimeShanghai(trade.timestamp),
  }));

  const widths = {
    index: Math.max(1, ...rows.map((row) => row.index.length)),
    side: Math.max(2, ...rows.map((row) => row.side.length)),
    token: Math.max(5, ...rows.map((row) => row.token.length)),
    amount: Math.max(4, ...rows.map((row) => row.amount.length)),
    wallet: Math.max(4, ...rows.map((row) => row.wallet.length)),
  };

  const pad = (value, width) => String(value).padEnd(width, " ");
  const lines = [
    title,
    "",
    `${pad("#", widths.index)}  ${pad("方向", widths.side)}  ${pad("Token", widths.token)}  ${pad("金额", widths.amount)}  ${pad("钱包", widths.wallet)}  时间 北京/上海`,
    `${"-".repeat(widths.index)}  ${"-".repeat(widths.side)}  ${"-".repeat(widths.token)}  ${"-".repeat(widths.amount)}  ${"-".repeat(widths.wallet)}  -------------------`,
  ];

  for (const row of rows) {
    lines.push(
      `${pad(row.index, widths.index)}  ${pad(row.side, widths.side)}  ${pad(row.token, widths.token)}  ${pad(row.amount, widths.amount)}  ${pad(row.wallet, widths.wallet)}  ${row.time}`
    );
  }

  return lines.join("\n");
}

function narrativeForTrade(trade, narratives) {
  if (!narratives || !trade.base_address) return "";
  const item = narratives.get(trade.base_address) || narratives.get(trade.base_address.toLowerCase());
  if (!item) return "";
  if (typeof item === "string") return item;
  return item.briefNarrative || item.narrative || item.metadataDescription || "";
}

export function formatTradeCards(trades, title = "GMGN Follow Wallet", narratives = new Map(), walletAliases = new Map()) {
  const now = tradeTimeShanghaiShort(Date.now() / 1000);
  const lines = [
    `<b>${html(title)}</b>`,
    `<code>SOL / ${trades.length} 条 / ${html(now)} 北京时间</code>`,
    "",
  ];

  trades.forEach((trade, index) => {
    const direction = directionLabel(trade.side);
    const token = tableValue(tokenLabel(trade), 18);
    const amount = moneyCompact(trade.amount_usd);
    const wallet = walletLabel(trade, walletAliases);
    const time = tradeTimeShanghaiShort(trade.timestamp);
    const links = tradeLinks(trade);

    lines.push(`<b>${index + 1}. ${html(direction)} ${html(token)}</b>  <code>${html(amount)}</code>`);
    lines.push(`<code>${html(wallet)}</code>  ${html(time)}`);
    const narrative = compactText(narrativeForTrade(trade, narratives), 96);
    if (narrative) lines.push(`叙事：${html(narrative)}`);
    if (trade.base_address) lines.push(`CA <code>${html(short(trade.base_address, 5, 5))}</code>  ${links}`);
    if (index !== trades.length - 1) lines.push("");
  });

  return lines.join("\n");
}
