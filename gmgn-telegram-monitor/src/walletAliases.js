import fs from "node:fs/promises";
import path from "node:path";

const ADDRESS_RE = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const ADDRESS_KEYS = ["address", "wallet", "wallet_address", "maker", "\u94b1\u5305", "\u5730\u5740"];
const ALIAS_KEYS = [
  "alias",
  "name",
  "remark",
  "note",
  "nick_name",
  "nickname",
  "\u5907\u6ce8",
  "\u522b\u540d",
  "\u540d\u79f0",
  "\u94b1\u5305\u540d",
];

function clean(value) {
  return String(value ?? "").trim();
}

function isAddress(value) {
  return ADDRESS_RE.test(clean(value));
}

function addAlias(map, address, alias) {
  const key = clean(address);
  const value = clean(alias);
  if (!key || !value || !isAddress(key)) return;
  map.set(key, value);
  map.set(key.toLowerCase(), value);
}

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] != null && clean(row[key])) return row[key];
  }

  const lowerMap = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));
  for (const key of candidates) {
    const actual = lowerMap.get(key.toLowerCase());
    if (actual && clean(row[actual])) return row[actual];
  }

  return "";
}

function loadJsonAliases(text) {
  const parsed = JSON.parse(text);
  const map = new Map();

  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const address = pickField(row, ADDRESS_KEYS);
      const alias = pickField(row, ALIAS_KEYS);
      addAlias(map, address, alias);
    }
    return map;
  }

  if (parsed && typeof parsed === "object") {
    for (const [address, alias] of Object.entries(parsed)) {
      addAlias(map, address, alias);
    }
  }

  return map;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((items) => items.some((item) => clean(item)));
}

function loadTableAliases(text, delimiter) {
  const rows = parseDelimited(text, delimiter);
  const map = new Map();
  if (rows.length === 0) return map;

  const header = rows[0].map((item) => clean(item).toLowerCase());
  const addressIndex = header.findIndex((item) => ADDRESS_KEYS.includes(item));
  const aliasIndex = header.findIndex((item) => ALIAS_KEYS.includes(item));
  const dataRows = addressIndex >= 0 && aliasIndex >= 0 ? rows.slice(1) : rows;

  for (const row of dataRows) {
    if (addressIndex >= 0 && aliasIndex >= 0) {
      addAlias(map, row[addressIndex], row[aliasIndex]);
      continue;
    }

    const addrIndex = row.findIndex(isAddress);
    if (addrIndex < 0) continue;
    const alias = row.find((item, index) => index !== addrIndex && clean(item) && !isAddress(item));
    addAlias(map, row[addrIndex], alias);
  }

  return map;
}

export async function loadWalletAliases(filePath) {
  if (!filePath) return new Map();

  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return loadTableAliases(text, ",");
  if (ext === ".tsv" || ext === ".txt") return loadTableAliases(text, "\t");
  return loadJsonAliases(text);
}
