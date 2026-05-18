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
  return {
    intervalMinutes: safeNumber(argValue("intervalMinutes", config.cycleIntervalMinutes || 35), 35, 1, 240),
    jitterMinutes: safeNumber(argValue("jitterMinutes", config.cycleIntervalJitterMinutes || 5), 5, 0, 60)
  };
}

function nextIntervalMs(intervalMinutes, jitterMinutes) {
  if (!jitterMinutes) return intervalMinutes * 60 * 1000;
  const min = Math.max(1, intervalMinutes - jitterMinutes);
  const max = intervalMinutes + jitterMinutes;
  const minutes = min + Math.random() * (max - min);
  return Math.round(minutes * 60 * 1000);
}

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["./src/telegram-special-cycle.js"], {
      cwd: projectRoot,
      stdio: "inherit",
      windowsHide: true
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (error) => {
      console.error(`telegram-special-cycle launch failed: ${error.message}`);
      resolve({ code: 1, signal: "" });
    });
  });
}

async function main() {
  while (true) {
    const startedAt = Date.now();
    const config = await readLoopConfig();
    const targetIntervalMs = nextIntervalMs(config.intervalMinutes, config.jitterMinutes);
    const targetMinutes = Math.round(targetIntervalMs / 60000);
    console.log(`Telegram special loop: running cycle; next target interval ~${targetMinutes}m.`);
    const result = await runOnce();
    if (result.code) console.log(`Telegram special cycle exited with code ${result.code}${result.signal ? ` (${result.signal})` : ""}.`);
    const elapsedMs = Date.now() - startedAt;
    const sleepMs = Math.max(0, targetIntervalMs - elapsedMs);
    console.log(`Telegram special loop: cycle took ${Math.round(elapsedMs / 1000)}s; sleeping ${Math.round(sleepMs / 60000)}m.`);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
