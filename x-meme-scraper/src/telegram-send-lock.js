import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");
const lockPath = path.resolve(
  projectRoot,
  process.env.TELEGRAM_SESSION_LOCK_FILE ||
    process.env.TELEGRAM_SEND_LOCK_FILE ||
    "../telegram-session.lock"
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  const number = Number(pid);
  if (!Number.isFinite(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock() {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function removeStaleLock(staleMs) {
  const lock = await readLock();
  if (!lock) return false;
  const ageMs = Date.now() - Date.parse(lock.createdAt || "");
  const stale = Number.isFinite(ageMs) && ageMs > staleMs;
  const alive = processAlive(lock.pid);
  if (!stale && alive) return false;
  await fs.rm(lockPath, { force: true });
  console.log(`Removed stale Telegram send lock: owner=${lock.owner || "unknown"} pid=${lock.pid || "unknown"}`);
  return true;
}

export async function acquireTelegramSendLock(owner, options = {}) {
  const staleMs = Number(options.staleMs || 3 * 60 * 60 * 1000);
  const pollMs = Number(options.pollMs || 30_000);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.mkdir(dataDir, { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        owner,
        pid: process.pid,
        token,
        createdAt: new Date().toISOString()
      }, null, 2));
      await handle.close();
      console.log(`Telegram send lock acquired: ${owner}`);
      return async function releaseTelegramSendLock() {
        const lock = await readLock();
        if (lock?.token === token) {
          await fs.rm(lockPath, { force: true });
          console.log(`Telegram send lock released: ${owner}`);
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const removed = await removeStaleLock(staleMs);
      if (removed) continue;
      const lock = await readLock();
      console.log(`Telegram send lock busy: ${lock?.owner || "unknown"} pid=${lock?.pid || "unknown"}; waiting ${Math.round(pollMs / 1000)}s.`);
      await sleep(pollMs);
    }
  }
}
