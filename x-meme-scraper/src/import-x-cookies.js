import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");
const sessionDir = path.join(dataDir, "x-session");
const cookiePath = process.argv[2] || path.join(dataDir, "x-cookies.json");

function normalizeSameSite(value) {
  const raw = String(value || "").toLowerCase();
  if (raw === "lax") return "Lax";
  if (raw === "strict") return "Strict";
  if (raw === "no_restriction" || raw === "none") return "None";
  return undefined;
}

function normalizeCookie(cookie) {
  const sameSite = normalizeSameSite(cookie.sameSite);
  const result = {
    name: String(cookie.name),
    value: String(cookie.value),
    domain: String(cookie.domain || ".x.com"),
    path: String(cookie.path || "/"),
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false
  };
  if (Number.isFinite(Number(cookie.expirationDate))) {
    result.expires = Number(cookie.expirationDate);
  }
  if (sameSite) {
    result.sameSite = sameSite;
  }
  return result;
}

const raw = await fs.readFile(cookiePath, "utf8");
const exportedCookies = JSON.parse(raw);
if (!Array.isArray(exportedCookies)) {
  throw new Error("Cookie file must be a JSON array exported by Cookie-Editor.");
}

const cookies = exportedCookies
  .filter((cookie) => cookie?.name && cookie?.value)
  .filter((cookie) => String(cookie.domain || "").includes("x.com") || String(cookie.domain || "").includes("twitter.com"))
  .map(normalizeCookie);

const names = new Set(cookies.map((cookie) => cookie.name));
for (const requiredName of ["auth_token", "ct0", "twid"]) {
  if (!names.has(requiredName)) {
    throw new Error(`Missing required X cookie: ${requiredName}`);
  }
}

await fs.mkdir(sessionDir, { recursive: true });

const context = await chromium.launchPersistentContext(sessionDir, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  locale: "zh-CN"
});

try {
  await context.addCookies(cookies);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(3000);
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const loggedIn = !/log in|sign in|登录|注册|create account/i.test(bodyText);
  console.log(`Imported ${cookies.length} X cookies into ${sessionDir}`);
  console.log(loggedIn ? "X login appears active." : "X still appears logged out; open the browser window and finish login once.");
} finally {
  await context.close();
}
