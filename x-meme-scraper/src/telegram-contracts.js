const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/g;
const TRON_ADDRESS = /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g;
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

const BASE58_NOISE = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112"
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function looksLikeSolanaAddress(value) {
  if (!value || BASE58_NOISE.has(value)) return false;
  if (/^0x/i.test(value) || /^T/.test(value)) return false;
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value)) return false;
  return true;
}

export function extractContractAddresses(text) {
  const value = String(text || "");
  const evm = value.match(EVM_ADDRESS) || [];
  const tron = value.match(TRON_ADDRESS) || [];
  const solana = (value.match(SOLANA_ADDRESS) || []).filter(looksLikeSolanaAddress);
  return unique([...evm, ...tron, ...solana]);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractTicker(text) {
  return firstMatch(text, [
    /\$([A-Z][A-Z0-9_]{1,15})\b/,
    /^\s*\$?([A-Z][A-Z0-9_]{1,15})\s*[-—]\s*(?:BSC|ETH|BASE|SOL|SOLANA)\b/im,
    /\(([A-Z][A-Z0-9_]{1,15})\)/,
    /\bTicker[:：\s]+([A-Z][A-Z0-9_]{1,15})\b/i,
    /\bSymbol[:：\s]+([A-Z][A-Z0-9_]{1,15})\b/i
  ]);
}

function extractTokenName(text) {
  return firstMatch(text, [
    /(?:Name|Token|Coin)[:：\s]+([^\n\r|]{2,80})/i,
    /【[^】]+】\s*([^\n\r()]{2,60})\s*\([A-Z][A-Z0-9_]{1,15}\)/,
    /銆[^銆]+銆([^()\n\r]{2,60})\s*\([A-Z][A-Z0-9_]{1,15}\)/
  ]);
}

export function extractTokenInfo(text) {
  const value = String(text || "");
  const info = {
    ticker: extractTicker(value),
    name: extractTokenName(value),
    chain: firstMatch(value, [
      /^\s*\$?[A-Z][A-Z0-9_]{1,15}\s*[-—]\s*(BSC|ETH|BASE|SOL|SOLANA)\b/im,
      /\bChain[:：\s]+(BSC|ETH|BASE|SOL|SOLANA|BNB|ARBITRUM|AVAX|TRON)\b/i,
      /\b(BSC|ETH|BASE|SOLANA|SOL)\s+(?:Pancake|Uniswap|Raydium|Pump)/i
    ]),
    age: firstMatch(value, [
      /开盘时间[:：\s]*([^\n\r]+)/,
      /Opening\s*time[:：\s]*([^\n\r]+)/i,
      /\bAge[:：\s]*([^\n\r]+)/i
    ]),
    marketCap: firstMatch(value, [
      /\b(?:MC|MCap|Market\s*Cap|MarketCap)[:：\s$]*([0-9][0-9.,]*\s*[KMBTkmbt]?)/i,
      /市值[:：\s$]*([0-9][0-9.,]*\s*[KMBTkmbt]?)/,
      /甯傚€.?[:：\s$]*([0-9][0-9.,]*\s*[KMBTkmbt]?)/
    ]),
    liquidity: firstMatch(value, [
      /\b(?:Liquidity|LP)[:：\s$]*([0-9][0-9.,]*\s*[KMBTkmbt]?)/i,
      /流动性[:：\s$]*([0-9][0-9.,]*\s*[KMBTkmbt]?)/,
      /姹犲瓙[:：\s$]*([0-9][0-9.,]*\s*[KMBTkmbt]?)/
    ]),
    holders: firstMatch(value, [
      /\bHolders?[:：\s]*([0-9][0-9,]*)/i,
      /持有人[:：\s]*([0-9][0-9,]*)/,
      /鎸佹湁浜.?[:：\s]*([0-9][0-9,]*)/
    ]),
    volume24h: firstMatch(value, [
      /\b(?:24H|24h)\s*(?:Volume|Vol)[:：\s$]*([0-9][0-9.,]*\s*[KMBTkmbt]?)/i,
      /(?:24H|24h)\s*交易量[:：\s$]*([0-9][0-9.,]*\s*[KMBTkmbt]?)/,
      /\bVol(?:ume)?[:：\s$]*([0-9][0-9.,]*\s*[KMBTkmbt]?)/i
    ]),
    change24h: firstMatch(value, [
      /\b(?:24H|24h)\s*(?:Change|涨跌幅)[:：\s]*([+-]?[0-9][0-9.,]*%)/i,
      /\bChange[:：\s]*([+-]?[0-9][0-9.,]*%)/i
    ]),
    hasGmgn: /\bgmgn\b/i.test(value) ? "yes" : "",
    hasDexscreener: /\bdexscreener\b/i.test(value) ? "yes" : "",
    hasWebsite: /\b(?:官网|website|official\s*site)\b/i.test(value) ? "yes" : "",
    hasTwitter: /\b(?:推特|twitter|x\.com)\b/i.test(value) ? "yes" : "",
    narrative: firstMatch(value, [
      /(?:叙事|Narrative|Story|Summary|总结)[:：\s]+([^\n\r]{6,220})/i,
      /鍙欎簨(?:鎬荤粨)?[:：\s]+([^\n\r]{6,220})/
    ])
  };
  return Object.fromEntries(Object.entries(info).filter(([, item]) => Boolean(item)));
}

export function inferNarrative(text, info = {}) {
  if (info.narrative) return info.narrative;
  const value = String(text || "");
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 10 && !extractContractAddresses(line).length)
    .filter((line) => !/^https?:\/\//i.test(line))
    .filter((line) => !/^(CA|MC|MCap|Market|Liquidity|Holders?|Vol|开盘|市值|流动性)[:：\s]/i.test(line));
  return lines.slice(0, 2).join(" ").slice(0, 220);
}

export function buildContractCards(payload, limit = 20) {
  const posts = Array.isArray(payload?.posts) ? payload.posts : [];
  const summaries = Array.isArray(payload?.contractSummary) ? payload.contractSummary : [];
  return summaries.slice(0, limit).map((summary, index) => {
    const related = posts.filter((post) => (post.contractAddresses || []).includes(summary.address));
    const richest = related
      .slice()
      .sort((left, right) => Object.keys(right.tokenInfo || {}).length - Object.keys(left.tokenInfo || {}).length)[0] || {};
    const info = { ...(summary.info || {}), ...(richest.tokenInfo || {}) };
    return {
      rank: index + 1,
      address: summary.address,
      count: summary.count,
      groups: summary.groups || [],
      ticker: info.ticker || "",
      name: info.name || "",
      chain: (info.chain || "").toUpperCase(),
      age: info.age || "",
      marketCap: info.marketCap || "",
      liquidity: info.liquidity || "",
      holders: info.holders || "",
      volume24h: info.volume24h || "",
      change24h: info.change24h || "",
      hasGmgn: info.hasGmgn || "",
      hasDexscreener: info.hasDexscreener || "",
      hasWebsite: info.hasWebsite || "",
      hasTwitter: info.hasTwitter || "",
      narrative: inferNarrative(richest.text || related[0]?.text || "", info),
      source: richest.group || summary.groups?.[0] || "",
      url: richest.url || related[0]?.url || ""
    };
  });
}

function mergeInfo(posts) {
  const merged = {};
  for (const post of posts) {
    for (const [key, value] of Object.entries(post.tokenInfo || {})) {
      if (!merged[key] && value) merged[key] = value;
    }
  }
  return merged;
}

export function annotateRepeatedContracts(posts) {
  const counts = new Map();
  for (const post of posts) {
    for (const address of post.contractAddresses || []) {
      counts.set(address, (counts.get(address) || 0) + 1);
    }
  }
  for (const post of posts) {
    post.repeatedContracts = (post.contractAddresses || []).filter((address) => (counts.get(address) || 0) > 1);
    post.hasRepeatedContract = post.repeatedContracts.length > 0;
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([address, count]) => ({
      address,
      count,
      groups: unique(posts.filter((post) => (post.contractAddresses || []).includes(address)).map((post) => post.group)),
      messageIds: unique(posts.filter((post) => (post.contractAddresses || []).includes(address)).map((post) => String(post.id))),
      info: mergeInfo(posts.filter((post) => (post.contractAddresses || []).includes(address)))
    }))
    .sort((left, right) => right.count - left.count);
}
