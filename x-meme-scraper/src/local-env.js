import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

export function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    const envPath = path.join(projectRoot, file);
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

export function parseSocksProxy(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const protocol = parsed.protocol.replace(":", "").toLowerCase();
  if (!["socks4", "socks5"].includes(protocol)) {
    throw new Error("Telegram proxy must be socks4:// or socks5://");
  }
  return {
    ip: parsed.hostname,
    port: Number(parsed.port),
    socksType: protocol === "socks4" ? 4 : 5,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    timeout: 20
  };
}
