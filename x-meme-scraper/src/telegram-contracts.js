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
      messageIds: unique(posts.filter((post) => (post.contractAddresses || []).includes(address)).map((post) => String(post.id)))
    }))
    .sort((left, right) => right.count - left.count);
}
