import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const latestSiteDir = path.join(projectRoot, "data", "binance", "latest", "site");
const defaultPort = Number(process.env.BINANCE_DASHBOARD_PORT || 47832);
const dailyHour = Number(process.env.BINANCE_DAILY_HOUR || 8);
const dailyMinute = Number(process.env.BINANCE_DAILY_MINUTE || 30);

let activeRun = null;
let scheduledTimer = null;
let nextScheduledRunAt = null;
let lastRun = {
  status: "idle",
  trigger: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  runDir: null,
  error: null
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

async function serveStatic(requestPath, response) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const targetPath = path.normalize(path.join(latestSiteDir, normalizedPath));

  if (!targetPath.startsWith(latestSiteDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(targetPath);
    response.writeHead(200, {
      "Content-Type": getContentType(targetPath),
      "Cache-Control": "no-store"
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not Found. Run npm run binance-daily first.");
  }
}

function parseRunDir(stdoutText) {
  const match = stdoutText.match(/summary written:\s*(.+?)summary\.json/i);
  return match ? path.dirname(match[1].trim()) : null;
}

function getStatusPayload() {
  return {
    running: Boolean(activeRun),
    nextScheduledRunAt,
    dailySchedule: `${String(dailyHour).padStart(2, "0")}:${String(dailyMinute).padStart(2, "0")}`,
    ...lastRun
  };
}

function startBinanceRun(trigger = "manual") {
  if (activeRun) {
    return false;
  }

  const child = spawn(process.execPath, ["./src/binance-daily.js", "--top", "10"], {
    cwd: projectRoot,
    windowsHide: true
  });

  const stdoutChunks = [];
  const stderrChunks = [];

  lastRun = {
    status: "running",
    trigger,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    runDir: null,
    error: null
  };
  activeRun = child;

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });

  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  child.on("close", (code) => {
    const stdoutText = stdoutChunks.join("");
    const stderrText = stderrChunks.join("");
    lastRun = {
      status: code === 0 ? "completed" : "failed",
      trigger,
      startedAt: lastRun.startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      runDir: parseRunDir(stdoutText),
      error: code === 0 ? null : stderrText || stdoutText || `Process exited with code ${code}`
    };
    activeRun = null;
  });

  child.on("error", (error) => {
    lastRun = {
      status: "failed",
      trigger,
      startedAt: lastRun.startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: null,
      runDir: null,
      error: error.message
    };
    activeRun = null;
  });

  return true;
}

function computeNextDailyRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(dailyHour, dailyMinute, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

function scheduleDailyRun() {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer);
  }

  const next = computeNextDailyRun();
  nextScheduledRunAt = next.toISOString();

  scheduledTimer = setTimeout(() => {
    startBinanceRun("scheduled");
    scheduleDailyRun();
  }, next.getTime() - Date.now());
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, getStatusPayload());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/run") {
    const started = startBinanceRun("manual");
    sendJson(response, started ? 202 : 409, {
      accepted: started,
      ...getStatusPayload()
    });
    return;
  }

  if (request.method === "GET") {
    await serveStatic(url.pathname, response);
    return;
  }

  response.writeHead(405);
  response.end("Method Not Allowed");
});

scheduleDailyRun();

server.listen(defaultPort, "127.0.0.1", () => {
  console.log(`binance dashboard ready: http://127.0.0.1:${defaultPort}`);
  console.log(`daily auto run scheduled at ${String(dailyHour).padStart(2, "0")}:${String(dailyMinute).padStart(2, "0")}`);
});
