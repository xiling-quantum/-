import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(rootDir, ".env");

dotenv.config({ path: envPath });

function parseSocksProxy(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const protocol = parsed.protocol.replace(":", "").toLowerCase();
  if (!["socks4", "socks5"].includes(protocol)) {
    throw new Error("TELEGRAM_PROXY_URL must be socks4:// or socks5://");
  }
  return {
    ip: parsed.hostname,
    port: Number(parsed.port),
    socksType: protocol === "socks4" ? 4 : 5,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    timeout: 20,
  };
}

function upsertEnvValue(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.trimEnd()}\n${line}\n`;
}

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
if (!apiId || !apiHash) {
  throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env before logging in.");
}

const rl = readline.createInterface({ input, output });
const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
  proxy: parseSocksProxy(process.env.TELEGRAM_PROXY_URL),
});

await client.start({
  phoneNumber: async () => rl.question("Telegram phone number: "),
  password: async () => rl.question("Two-step password, if any: "),
  phoneCode: async () => rl.question("Telegram login code: "),
  onError: (error) => console.error(error.message),
});

const session = client.session.save();
let envText = await fs.readFile(envPath, "utf8");
envText = upsertEnvValue(envText, "TELEGRAM_STRING_SESSION", session);
envText = upsertEnvValue(envText, "TELEGRAM_SEND_MODE", "user");
await fs.writeFile(envPath, envText, "utf8");

console.log("");
console.log(`Updated ${envPath} with a fresh TELEGRAM_STRING_SESSION.`);
console.log("Restart the monitor after this script exits.");

await client.disconnect();
rl.close();
