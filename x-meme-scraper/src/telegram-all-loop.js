import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./local-env.js";

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const configPath = path.join(projectRoot, "config", "telegram-special-groups.json");
const dataDir = path.join(projectRoot, "data");
const loopLockPath = path.join(dataDir, "telegram-all-loop.lock");

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function safeNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

async function readLoopConfig() {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const contractsStartDelay =
    argValue("contractsStartDelayMinutes", config.contractsStartDelayMinutes ?? process.env.TELEGRAM_CONTRACTS_START_DELAY_MINUTES ?? 0);
  return {
    intervalMinutes: safeNumber(argValue("intervalMinutes", config.cycleIntervalMinutes ?? 35), 35, 1, 240),
    jitterMinutes: safeNumber(argValue("jitterMinutes", config.cycleIntervalJitterMinutes ?? 5), 5, 0, 60),
    contractsStartDelayMinutes: safeNumber(contractsStartDelay, 0, 0, 30)
  };
}

function nextIntervalMs(intervalMinutes, jitterMinutes) {
  if (!jitterMinutes) return intervalMinutes * 60 * 1000;
  const min = Math.max(1, intervalMinutes - jitterMinutes);
  const max = intervalMinutes + jitterMinutes;
  const minutes = min + Math.random() * (max - min);
  return Math.round(minutes * 60 * 1000);
}

function timestamp() {
  return new Date().toISOString();
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

async function acquireLoopLock() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const existing = JSON.parse(await fs.readFile(loopLockPath, "utf8"));
    if (processAlive(existing.pid)) {
      console.log(`[${timestamp()}] Telegram all loop already running: pid=${existing.pid}; exiting.`);
      return null;
    }
    await fs.rm(loopLockPath, { force: true });
  } catch {
    await fs.rm(loopLockPath, { force: true });
  }

  try {
    const handle = await fs.open(loopLockPath, "wx");
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString()
    }, null, 2));
    await handle.close();
    return async () => {
      try {
        const current = JSON.parse(await fs.readFile(loopLockPath, "utf8"));
        if (current.pid === process.pid) await fs.rm(loopLockPath, { force: true });
      } catch {
        // The lock may already be removed during shutdown.
      }
    };
  } catch (error) {
    if (error.code === "EEXIST") {
      console.log(`[${timestamp()}] Telegram all loop lock exists; exiting.`);
      return null;
    }
    throw error;
  }
}

function preparedPath(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dataDir, `telegram-prepared-${label}-${stamp}.json`);
}

function runChild(label, args, options = {}) {
  return new Promise((resolve) => {
    console.log(`[${timestamp()}] Telegram all loop: starting ${label}.`);
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: "inherit",
      windowsHide: true
    });
    child.on("exit", (code, signal) => {
      console.log(`[${timestamp()}] Telegram all loop: ${label} finished code=${code ?? ""}${signal ? ` signal=${signal}` : ""}.`);
      resolve({ label, code, signal });
    });
    child.on("error", (error) => {
      console.error(`[${timestamp()}] Telegram all loop: ${label} launch failed: ${error.message}`);
      resolve({ label, code: 1, signal: "" });
    });
    if (options.detached) resolve({ label, code: 0, signal: "", child });
  });
}

async function runPrepare(label, script) {
  const outputPath = preparedPath(label);
  const result = await runChild(`${label} prepare`, [script, "--prepareOnly", "true", "--preparedOutput", outputPath]);
  if (result.code) return "";
  try {
    await fs.access(outputPath);
    return outputPath;
  } catch {
    console.log(`[${timestamp()}] Telegram all loop: ${label} prepare did not produce ${outputPath}.`);
    return "";
  }
}

async function runSpecialStream() {
  const batchSize = safeNumber(process.env.TELEGRAM_SPECIAL_BATCH_SIZE ?? process.env.TELEGRAM_STREAM_BATCH_SIZE ?? 20, 20, 20, 250);
  return runChild("special stream", ["./src/telegram-special-cycle.js", "--streamBatches", "true", "--batchSize", String(batchSize)]);
}

async function runContractsStream() {
  const batchSize = safeNumber(process.env.TELEGRAM_CONTRACT_BATCH_SIZE ?? process.env.TELEGRAM_STREAM_BATCH_SIZE ?? 20, 20, 20, 250);
  return runChild("contracts stream", ["./src/telegram-contract-cycle.js", "--streamBatches", "true", "--batchSize", String(batchSize)]);
}

function launchSender(label, inputPath) {
  if (!inputPath) return;
  console.log(`[${timestamp()}] Telegram all loop: launching sender for ${label}: ${inputPath}`);
  const child = spawn(process.execPath, ["./src/telegram-prepared-sender.js", "--input", inputPath], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true
  });
  child.on("exit", (code, signal) => {
    console.log(`[${timestamp()}] Telegram all loop: sender ${label} exited code=${code ?? ""}${signal ? ` signal=${signal}` : ""}.`);
  });
  child.on("error", (error) => {
    console.error(`[${timestamp()}] Telegram all loop: sender ${label} launch failed: ${error.message}`);
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const releaseLoopLock = await acquireLoopLock();
  if (!releaseLoopLock) return;
  process.once("exit", () => {
    fs.rm(loopLockPath, { force: true }).catch(() => {});
  });

  while (true) {
    const startedAt = Date.now();
    const config = await readLoopConfig();
    const targetIntervalMs = nextIntervalMs(config.intervalMinutes, config.jitterMinutes);
    const targetMinutes = Math.round(targetIntervalMs / 60000);
    console.log(`[${timestamp()}] Telegram all loop: cycle start; target interval ~${targetMinutes}m.`);

    const specialStreamDone = runSpecialStream();
    const contractsDelayMs = config.contractsStartDelayMinutes * 60 * 1000;
    if (contractsDelayMs > 0) {
      console.log(`[${timestamp()}] Telegram all loop: starting contracts prepare in ${config.contractsStartDelayMinutes}m while special continues.`);
      await sleep(contractsDelayMs);
    }

    await runContractsStream();
    await specialStreamDone;

    const elapsedMs = Date.now() - startedAt;
    const sleepMs = Math.max(0, targetIntervalMs - elapsedMs);
    console.log(
      `[${timestamp()}] Telegram all loop: cycle took ${Math.round(elapsedMs / 1000)}s; ` +
      `sleeping ${Math.round(sleepMs / 60000)}m.`
    );
    await sleep(sleepMs);
  }

  await releaseLoopLock();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
