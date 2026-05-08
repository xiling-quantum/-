import process from "node:process";
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { loadLocalEnv, parseSocksProxy } from "./local-env.js";

loadLocalEnv();

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
const proxy = parseSocksProxy(process.env.TELEGRAM_PROXY_URL);

if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH before logging in.");
  process.exit(1);
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
  proxy
});

await client.start({
  phoneNumber: async () => input.text("Telegram phone number: "),
  password: async () => input.text("Two-step password, if any: "),
  phoneCode: async () => input.text("Telegram login code: "),
  onError: (error) => console.error(error.message)
});

console.log("");
console.log("TELEGRAM_STRING_SESSION=");
console.log(client.session.save());
await client.disconnect();
