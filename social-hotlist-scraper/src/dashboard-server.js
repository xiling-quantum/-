import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const latestSiteDir = path.join(projectRoot, "data", "latest", "site");
const runsRootDir = path.join(projectRoot, "data", "runs");
const defaultPort = Number(process.env.DASHBOARD_PORT || 47831);
const collectConfigPath = process.env.DASHBOARD_CONFIG || "./config/sources.example.json";
const collectPlatform = process.env.DASHBOARD_PLATFORM || "all";

let activeRun = null;
let lastRun = {
  status: "idle",
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
    response.end("Not Found");
  }
}

async function serveRunStatic(requestPath, response) {
  const normalizedPath = path.posix.normalize(requestPath);
  const trimmed = normalizedPath.replace(/^\/+/, "");
  const [runsSegment, runId, ...rest] = trimmed.split("/");

  if (runsSegment !== "runs" || !runId || !rest.length) {
    response.writeHead(404);
    response.end("Not Found");
    return;
  }

  const targetPath = path.normalize(path.join(runsRootDir, runId, ...rest));
  const runRoot = path.normalize(path.join(runsRootDir, runId));
  if (!targetPath.startsWith(runRoot)) {
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
    response.end("Not Found");
  }
}

async function listRunArchives() {
  let entries = [];
  try {
    entries = await fs.readdir(runsRootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const summaryPath = path.join(runsRootDir, runId, "run-summary.json");
    try {
      const raw = await fs.readFile(summaryPath, "utf8");
      const summary = JSON.parse(raw);
      runs.push({
        runId,
        startedAt: summary.startedAt || null,
        finishedAt: summary.finishedAt || null,
        totalRecords: summary.totalRecords ?? 0,
        url: `/runs/${encodeURIComponent(runId)}/site/index.html`
      });
    } catch {
      // Ignore incomplete runs.
    }
  }

  const perDay = new Map();
  const sortedRuns = runs.sort((left, right) => {
    return String(right.startedAt || right.runId).localeCompare(String(left.startedAt || left.runId));
  });

  for (const run of sortedRuns) {
    const dateKey = String(run.startedAt || run.runId).slice(0, 10);
    if (!perDay.has(dateKey)) {
      perDay.set(dateKey, {
        ...run,
        dateKey,
        label: dateKey,
        contentUrl: `/runs/${encodeURIComponent(run.runId)}/site/content.html`
      });
    }
  }

  const earliestDateKey = "2026-04-23";
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const recentWeekKey = weekAgo.toISOString().slice(0, 10);
  const lowerBoundKey = recentWeekKey > earliestDateKey ? recentWeekKey : earliestDateKey;

  return [...perDay.values()]
    .filter((item) => item.dateKey >= lowerBoundKey)
    .sort((left, right) => right.dateKey.localeCompare(left.dateKey));
}

function parseRunDir(stdoutText) {
  const match = stdoutText.match(/daily run completed:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

function startDailyRun() {
  if (activeRun) {
    return false;
  }

  const child = spawn(process.execPath, ["./src/daily.js", "--config", collectConfigPath, "--platform", collectPlatform], {
    cwd: projectRoot,
    windowsHide: true
  });

  const stdoutChunks = [];
  const stderrChunks = [];

  lastRun = {
    status: "running",
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, {
      running: Boolean(activeRun),
      ...lastRun
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    const runs = await listRunArchives();
    sendJson(response, 200, {
      currentRunId: lastRun.runDir ? path.basename(lastRun.runDir) : null,
      runs
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/run") {
    const started = startDailyRun();
    sendJson(response, started ? 202 : 409, {
      accepted: started,
      running: Boolean(activeRun),
      ...lastRun
    });
    return;
  }

  if (request.method === "GET") {
    if (url.pathname.startsWith("/runs/")) {
      await serveRunStatic(url.pathname, response);
      return;
    }

    await serveStatic(url.pathname, response);
    return;
  }

  response.writeHead(405);
  response.end("Method Not Allowed");
});

server.listen(defaultPort, "127.0.0.1", () => {
  console.log(`dashboard ready: http://127.0.0.1:${defaultPort}`);
  console.log(`dashboard collect target: ${collectPlatform} via ${collectConfigPath}`);
});
