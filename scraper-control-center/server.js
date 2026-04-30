import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 49031);

const appDefs = [
  {
    id: "x-meme",
    name: "X 抓取",
    group: "内容监控",
    description: "独立 X meme 页面",
    url: "http://127.0.0.1:48931/",
    healthUrl: "http://127.0.0.1:48931/api/status",
    mode: "live"
  },
  {
    id: "telegram-meme",
    name: "Telegram 抓取",
    group: "内容监控",
    description: "公开频道 / 群组 meme 抓取",
    url: "",
    healthUrl: "",
    mode: "placeholder"
  },
  {
    id: "social-hotlist",
    name: "TikTok 榜单",
    group: "榜单监控",
    description: "TikTok / Instagram / Amazon / X 榜单面板",
    url: "http://127.0.0.1:47831/",
    healthUrl: "http://127.0.0.1:47831/api/status",
    mode: "live"
  },
  {
    id: "binance-daily",
    name: "币安抓取",
    group: "行情监控",
    description: "Binance 每日涨跌与连涨面板",
    url: "http://127.0.0.1:47832/",
    healthUrl: "http://127.0.0.1:47832/api/status",
    mode: "live"
  }
];

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
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function serveStatic(requestPath, response) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const targetPath = path.normalize(path.join(publicDir, normalizedPath));
  if (!targetPath.startsWith(publicDir)) {
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

async function checkApp(app) {
  if (app.mode !== "live" || !app.healthUrl) {
    return {
      ...app,
      status: "pending",
      statusText: "待接入",
      reachable: false
    };
  }

  try {
    const response = await fetch(app.healthUrl, {
      method: "GET",
      headers: { "User-Agent": "scraper-control-center/0.1" },
      signal: AbortSignal.timeout(1200)
    });

    if (!response.ok) {
      return {
        ...app,
        status: "offline",
        statusText: `离线 (${response.status})`,
        reachable: false
      };
    }

    return {
      ...app,
      status: "online",
      statusText: "在线",
      reachable: true
    };
  } catch {
    return {
      ...app,
      status: "offline",
      statusText: "离线",
      reachable: false
    };
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/apps") {
    const apps = await Promise.all(appDefs.map(checkApp));
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      apps
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

server.listen(port, "127.0.0.1", () => {
  console.log(`scraper control center ready: http://127.0.0.1:${port}`);
});
