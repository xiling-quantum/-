import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { enrichRecord } from "./enrichment.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  return new Intl.NumberFormat("zh-CN", {
    notation: Math.abs(numericValue) >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(numericValue);
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function truncateText(value, maxLength = 80) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "-";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toPlatformLabel(platform) {
  if (platform === "tiktok") return "抖音国际版";
  if (platform === "instagram") return "图片社媒";
  if (platform === "amazon") return "亚马逊";
  if (platform === "fastmoss") return "榜单数据源";
  if (platform === "x") return "X / 推特";
  return platform || "-";
}

function resolvePlatformLabel(item) {
  if ((item?.displayPlatform || item?.rawMeta?.sourcePlatform) === "tiktok") {
    return toPlatformLabel("tiktok");
  }

  return toPlatformLabel(item?.platform || item);
}

function isFastmossTiktokItem(item) {
  return item?.platform === "fastmoss" && (item?.displayPlatform === "tiktok" || item?.rawMeta?.sourcePlatform === "tiktok");
}

function getPlatformFilterLabels() {
  return ["抖音国际版", "图片社媒", "亚马逊", "榜单数据源"];
}

function deriveCategoryLabel(item) {
  const source = `${item.productHint || ""} ${item.displayName || ""} ${item.summary || ""}`.toLowerCase();
  if (/beauty|skincare|collagen|lip|serum|magnesium|supplement|health/.test(source)) {
    return "美妆个护";
  }
  if (/kitchen|dishcloth|oil|sprayer|paper towel|vacuum|cleaner|organizer|home|decor/.test(source)) {
    return "居家日用";
  }
  if (/iphone|phone|charger|cable|earbuds|headphones/.test(source)) {
    return "手机与数码";
  }
  if (/drink|tea|tumbler|bottle|cup|food/.test(source)) {
    return "食品饮料";
  }
  if (/jersey|fashion|dress|jacket|hat|shoe|slipper|flip flop/.test(source)) {
    return "服饰配件";
  }
  return "综合商品";
}

function deriveRegionLabel(item) {
  const targetValue = String(item.targetValue || item.sourceBoard || "").toUpperCase();
  if (targetValue.includes("US")) return "美国";
  if (targetValue.includes("UK")) return "英国";
  if (targetValue.includes("JP")) return "日本";
  if (targetValue.includes("SG")) return "新加坡";
  if (item.platform === "amazon" || item.platform === "fastmoss") return "美国";
  return "全球";
}

function deriveStoreLabel(item) {
  return item.authorName || item.authorHandle || "\u672a\u6807\u6ce8\u5e97\u94fa";
}

function getStoreUrl(item) {
  const store = deriveStoreLabel(item);

  if (item.platform === "fastmoss") {
    if (isFastmossTiktokItem(item) && item.sellerId) {
      return `https://www.fastmoss.com/zh/shop-marketing/detail/${encodeURIComponent(item.sellerId)}`;
    }

    if (item.sellerId) {
      return `https://www.fastmoss.com/zh/shop-marketing/detail/${encodeURIComponent(item.sellerId)}`;
    }

    if (!store || store === "\u672a\u6807\u6ce8\u5e97\u94fa") {
      return null;
    }

    return `https://www.fastmoss.com/zh/search?keyword=${encodeURIComponent(store)}`;
  }

  return null;
}

function renderStoreLink(item) {
  const store = truncateText(deriveStoreLabel(item), 28);
  const storeUrl = getStoreUrl(item);
  if (!storeUrl) {
    return escapeHtml(store);
  }
  return `<a href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(store)}</a>`;
}

function getActionUrl(item) {
  if (isFastmossTiktokItem(item)) {
    return item.postUrl || item.tiktokCreatorUrl || "#";
  }

  if (item.platform === "tiktok" || item.platform === "instagram" || item.platform === "x") {
    return item.postUrl || "#";
  }

  return getStoreUrl(item) || item.postUrl || "#";
}

function getActionLabel(item) {
  if (isFastmossTiktokItem(item)) return "\u67e5\u770b\u539f\u5e16";
  if (item.platform === "fastmoss") return "\u67e5\u770b\u5e97\u94fa";
  if (item.platform === "tiktok" || item.platform === "instagram" || item.platform === "x") return "\u67e5\u770b\u539f\u5e16";
  return "\u67e5\u770b\u6765\u6e90";
}

function getFastmossCreatorUrl(item) {
  if (item.platform !== "fastmoss") {
    return null;
  }

  return item.tiktokCreatorUrl || item.fastmossInfluencerUrl || null;
}

function renderActionLinks(item) {
  const primaryUrl = getActionUrl(item);
  const primaryLabel = getActionLabel(item);
  const creatorUrl = getFastmossCreatorUrl(item);

  if (isFastmossTiktokItem(item)) {
    return `<a href="${escapeHtml(primaryUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(primaryLabel)}</a>`;
  }

  if (item.platform === "fastmoss" && creatorUrl) {
    const label = item.tiktokCreatorHandle
      ? `TikTok\u8d26\u53f7 @${item.tiktokCreatorHandle}`
      : "TikTok\u8d26\u53f7";
    return `<a href="${escapeHtml(creatorUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  const links = [
    `<a href="${escapeHtml(primaryUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(primaryLabel)}</a>`
  ];

  if (creatorUrl && creatorUrl !== primaryUrl) {
    const label = item.tiktokCreatorHandle
      ? `TikTok\u8d26\u53f7 @${item.tiktokCreatorHandle}`
      : "TikTok\u8d26\u53f7";
    links.push(
      `<a href="${escapeHtml(creatorUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    );
  }

  return links.join('<span class="action-separator"> / </span>');
}

function renderThumb(imageUrl, label) {
  const fallbackText = truncateText(label || "商品", 2);
  const fallback = `<span class="thumb-fallback">${escapeHtml(fallbackText)}</span>`;
  if (!imageUrl) {
    return `<div class="thumb">${fallback}</div>`;
  }

  return `<div class="thumb">
    <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(label || "商品图片")}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove(); this.parentElement.classList.add('thumb-missing');" />
    ${fallback}
  </div>`;
}

function resolveMedia(record) {
  return (
    record.primaryImageUrl ??
    record.coverImageUrl ??
    record.rawMeta?.pageImageCandidates?.[0] ??
    record.rawMeta?.videoPosterCandidates?.[0] ??
    record.rawMeta?.authorAvatarUrl ??
    null
  );
}

function isRemoteImageUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function getImageExtension(url, contentType) {
  const normalizedType = String(contentType || "").toLowerCase();
  if (normalizedType.includes("image/avif")) return ".avif";
  if (normalizedType.includes("image/webp")) return ".webp";
  if (normalizedType.includes("image/png")) return ".png";
  if (normalizedType.includes("image/gif")) return ".gif";
  if (normalizedType.includes("image/jpeg") || normalizedType.includes("image/jpg")) return ".jpg";

  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".avif", ".webp", ".png", ".gif", ".jpg", ".jpeg"].includes(ext)) {
      return ext === ".jpeg" ? ".jpg" : ext;
    }
  } catch {
    // fall through to a safe default
  }

  return ".jpg";
}

function getDataRoot(outputDir) {
  const parentDir = path.dirname(outputDir);
  if (path.basename(parentDir) === "runs") {
    return path.dirname(parentDir);
  }
  if (path.basename(outputDir) === "latest") {
    return parentDir;
  }
  return parentDir;
}

async function cacheRemoteImage(url, { outputDir, siteDir, cacheMap }) {
  if (!isRemoteImageUrl(url)) {
    return url || null;
  }

  if (cacheMap.has(url)) {
    return cacheMap.get(url);
  }

  const dataRoot = getDataRoot(outputDir);
  const longTermCacheDir = path.join(dataRoot, "image-cache");
  const siteCacheDir = path.join(siteDir, "media", "cache");
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 24);
  const existingFiles = await fs.readdir(longTermCacheDir).catch(() => []);
  const existingName = existingFiles.find((fileName) => fileName.startsWith(`${hash}.`));

  if (existingName) {
    await fs.mkdir(siteCacheDir, { recursive: true });
    await fs.copyFile(path.join(longTermCacheDir, existingName), path.join(siteCacheDir, existingName));
    const localUrl = `./media/cache/${existingName}`;
    cacheMap.set(url, localUrl);
    return localUrl;
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });

    if (!response.ok) {
      cacheMap.set(url, url);
      return url;
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      cacheMap.set(url, url);
      return url;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) {
      cacheMap.set(url, url);
      return url;
    }

    const fileName = `${hash}${getImageExtension(url, contentType)}`;
    await fs.mkdir(longTermCacheDir, { recursive: true });
    await fs.mkdir(siteCacheDir, { recursive: true });
    await fs.writeFile(path.join(longTermCacheDir, fileName), bytes);
    await fs.copyFile(path.join(longTermCacheDir, fileName), path.join(siteCacheDir, fileName));

    const localUrl = `./media/cache/${fileName}`;
    cacheMap.set(url, localUrl);
    return localUrl;
  } catch {
    cacheMap.set(url, url);
    return url;
  }
}

async function cacheImageFields(value, cacheOptions, seen = new WeakSet()) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      await cacheImageFields(item, cacheOptions, seen);
    }
    return;
  }

  const imageKeys = [
    "primaryImageUrl",
    "coverImageUrl",
    "imageUrl",
    "avatarUrl",
    "authorAvatarUrl",
    "thumbnailUrl",
    "posterUrl"
  ];

  for (const key of imageKeys) {
    if (isRemoteImageUrl(value[key])) {
      value[key] = await cacheRemoteImage(value[key], cacheOptions);
    }
  }

  for (const nestedValue of Object.values(value)) {
    await cacheImageFields(nestedValue, cacheOptions, seen);
  }
}

async function cacheSiteImages({ outputDir, siteDir, records, leaderboards }) {
  const cacheOptions = {
    outputDir,
    siteDir,
    cacheMap: new Map()
  };

  await cacheImageFields(records, cacheOptions);
  await cacheImageFields(leaderboards, cacheOptions);
}

function normalizeKey(value, fallback = "unknown") {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function guessDisplayName(record) {
  if (record.displayName) return record.displayName;
  if (record.productHint && !["No Clear Product", "General Consumer Product"].includes(record.productHint)) {
    return record.productHint;
  }
  if (record.title) return record.title;
  if (record.caption) return truncateText(cleanText(record.caption), 88);
  return record.authorName || record.authorHandle || "未命名条目";
}

function guessSummary(record) {
  return (
    record.englishSummary ??
    record.summary ??
    truncateText(cleanText(record.caption || record.title || record.productHint), 120)
  );
}

function buildOverview(summary, leaderboards, records) {
  return {
    generatedAt: summary.finishedAt,
    runId: summary.runId,
    totalRecords: records.length,
    platformStats: Object.entries(summary.platforms ?? {}).map(([platform, data]) => ({
      platform,
      label: toPlatformLabel(platform),
      records: data.records ?? 0,
      status: data.status ?? "unknown"
    })),
    leaderboards: {
      overall: ensureArray(leaderboards?.boards?.overall).length,
      newReleases: ensureArray(leaderboards?.boards?.newReleases).length,
      moversShakers: ensureArray(leaderboards?.boards?.moversShakers).length
    }
  };
}

function buildProductDataset(records, leaderboards) {
  const groups = new Map();
  const sourceItems = [
    ...ensureArray(leaderboards?.boards?.overall),
    ...ensureArray(leaderboards?.boards?.newReleases),
    ...ensureArray(leaderboards?.boards?.moversShakers)
  ];

  for (const record of records) {
    const enriched = enrichRecord(record);
    const displayName = guessDisplayName(enriched);
    const key = normalizeKey(displayName);
    const group =
      groups.get(key) ??
      {
        id: key,
        name: displayName,
        productHint: enriched.productHint || "",
        summary: guessSummary(enriched),
        imageUrl: resolveMedia(enriched),
        priceText: enriched.priceText || "-",
        platforms: new Set(),
        sourceBoards: new Set(),
        hotScore: 0,
        salesCount: 0,
        salesAmount: 0,
        creatorCount: 0,
        recordCount: 0,
        links: []
      };

    group.platforms.add(resolvePlatformLabel(enriched));
    if (enriched.sourceBoard) {
      group.sourceBoards.add(enriched.sourceBoard);
    }
    group.hotScore = Math.max(group.hotScore, Number(enriched.hotScore || 0));
    group.salesCount += Number(enriched.salesCount || 0);
    group.salesAmount += Number(enriched.salesAmount || 0);
    group.creatorCount += Number(enriched.creatorCount || 0);
    group.recordCount += 1;
    group.imageUrl ||= resolveMedia(enriched);
    group.summary ||= guessSummary(enriched);
    if (group.priceText === "-" && enriched.priceText) {
      group.priceText = enriched.priceText;
    }
    if (enriched.postUrl && group.links.length < 5) {
      group.links.push({
        platform: resolvePlatformLabel(enriched),
        url: enriched.postUrl
      });
    }

    groups.set(key, group);
  }

  for (const item of sourceItems) {
    const key = normalizeKey(item.displayName);
    const group = groups.get(key);
    if (!group) {
      continue;
    }

    group.sourceBoards.add(item.board || "热推榜");
    group.hotScore = Math.max(group.hotScore, Number(item.hotScore || 0), Number(item.score || 0));
    group.salesCount += Number(item.salesCount || 0);
    group.salesAmount += Number(item.salesAmount || 0);
    group.creatorCount += Number(item.creatorCount || 0);
    group.imageUrl ||= item.primaryImageUrl || null;
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      platforms: [...group.platforms],
      sourceBoards: [...group.sourceBoards]
    }))
    .sort((left, right) => right.hotScore - left.hotScore || right.recordCount - left.recordCount)
    .slice(0, 200);
}

function buildShopDataset(records) {
  const groups = new Map();

  for (const record of records) {
    const enriched = enrichRecord(record);
    const shopName = enriched.authorName || enriched.authorHandle || "";
    if (!shopName) {
      continue;
    }

    const key = normalizeKey(`${enriched.platform}-${shopName}`);
    const group =
      groups.get(key) ??
      {
        id: key,
        name: shopName,
        platform: enriched.platform,
        platformLabel: resolvePlatformLabel(enriched),
        imageUrl: resolveMedia(enriched),
        hottestProduct: guessDisplayName(enriched),
        recordCount: 0,
        productCount: new Set(),
        hotScore: 0,
        salesCount: 0,
        salesAmount: 0,
        creatorCount: 0,
        links: []
      };

    group.recordCount += 1;
    group.productCount.add(guessDisplayName(enriched));
    group.hotScore = Math.max(group.hotScore, Number(enriched.hotScore || 0));
    group.salesCount += Number(enriched.salesCount || 0);
    group.salesAmount += Number(enriched.salesAmount || 0);
    group.creatorCount += Number(enriched.creatorCount || 0);
    if (enriched.postUrl && group.links.length < 5) {
      group.links.push({ label: guessDisplayName(enriched), url: enriched.postUrl });
    }

    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      productCount: group.productCount.size
    }))
    .sort((left, right) => right.salesAmount - left.salesAmount || right.hotScore - left.hotScore)
    .slice(0, 200);
}

function buildCreatorDataset(records) {
  const groups = new Map();

  for (const record of records) {
    const enriched = enrichRecord(record);
    if (!["tiktok", "instagram", "x"].includes(enriched.platform)) {
      continue;
    }

    const creatorName = enriched.authorHandle || enriched.authorName || "";
    if (!creatorName) {
      continue;
    }

    const key = normalizeKey(`${enriched.platform}-${creatorName}`);
    const group =
      groups.get(key) ??
      {
        id: key,
        name: creatorName,
        displayName: enriched.authorName || creatorName,
        platform: enriched.platform,
        platformLabel: resolvePlatformLabel(enriched),
        avatarUrl: enriched.rawMeta?.authorAvatarUrl || resolveMedia(enriched),
        recordCount: 0,
        hotScore: 0,
        products: new Set(),
        topContent: guessDisplayName(enriched),
        links: []
      };

    group.recordCount += 1;
    group.hotScore = Math.max(group.hotScore, Number(enriched.hotScore || 0));
    group.products.add(guessDisplayName(enriched));
    if (enriched.postUrl && group.links.length < 5) {
      group.links.push({ label: guessDisplayName(enriched), url: enriched.postUrl });
    }

    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      productCount: group.products.size
    }))
    .sort((left, right) => right.hotScore - left.hotScore || right.recordCount - left.recordCount)
    .slice(0, 200);
}

function buildSiteDatasets(summary, records, leaderboards) {
  return {
    overview: buildOverview(summary, leaderboards, records),
    leaderboards,
    products: buildProductDataset(records, leaderboards),
    shops: buildShopDataset(records),
    creators: buildCreatorDataset(records)
  };
}

function buildLayout({ title, pageTitle, subtitle, body, generatedAt, currentRunId }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #f5f7fb;
        --panel: rgba(255,255,255,0.92);
        --text: #1b2335;
        --muted: #7886a3;
        --line: rgba(123, 142, 182, 0.18);
        --pink: #ff4d7d;
        --orange: #ff8c5c;
        --blue: #5d8dff;
        --mint: #16c79a;
        --shadow: 0 16px 40px rgba(40, 65, 120, 0.1);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 14px/1.6 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(255,77,125,.12), transparent 24%),
          radial-gradient(circle at top right, rgba(93,141,255,.11), transparent 24%),
          linear-gradient(180deg, #f9fbff 0%, #f3f6fb 100%);
      }
      .page {
        width: min(1800px, calc(100vw - 32px));
        margin: 16px auto 40px;
      }
      .hero, .panel, .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: var(--shadow);
      }
      .hero {
        padding: 28px 32px;
        margin-bottom: 18px;
      }
      .hero h1 {
        margin: 0;
        font-size: 32px;
      }
      .hero p {
        margin: 10px 0 0;
        color: var(--muted);
      }
      .hero-meta {
        margin-top: 16px;
        color: var(--muted);
        font-size: 13px;
      }
      .hero-actions {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
        margin-top: 16px;
      }
      .run-archive {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .run-archive-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 108px;
        padding: 10px 14px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,.88);
        color: #33415f;
        text-decoration: none;
        font-weight: 700;
      }
      .run-archive-link.active {
        color: #fff;
        border-color: transparent;
        background: linear-gradient(135deg, var(--pink), var(--orange));
      }
      .run-button {
        border: 0;
        border-radius: 14px;
        padding: 12px 18px;
        font: inherit;
        font-weight: 800;
        color: #fff;
        cursor: pointer;
        background: linear-gradient(135deg, var(--pink), var(--orange));
        box-shadow: 0 12px 24px rgba(255,77,125,.18);
      }
      .run-button:disabled {
        cursor: not-allowed;
        opacity: .65;
      }
      .run-status {
        color: var(--muted);
        font-size: 13px;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(5, minmax(0,1fr));
        gap: 18px;
        margin-bottom: 18px;
      }
      .card {
        padding: 20px 24px;
      }
      .card span {
        display: block;
        color: var(--muted);
        font-weight: 700;
      }
      .card strong {
        display: block;
        margin-top: 8px;
        font-size: 28px;
      }
      .panel {
        padding: 24px 26px;
        margin-bottom: 18px;
      }
      .panel h2 {
        margin: 0 0 8px;
        font-size: 22px;
      }
      .panel .sub {
        color: var(--muted);
        margin-bottom: 16px;
      }
      .toolbar {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
        flex-wrap: wrap;
      }
      .search-box {
        width: min(360px, 100%);
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: #fff;
        font: inherit;
      }
      .filter-box {
        display: grid;
        gap: 14px;
      }
      .filter-row {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .filter-label {
        min-width: 76px;
        color: var(--muted);
        font-weight: 700;
      }
      .filter-pill {
        border: 1px solid var(--line);
        background: rgba(255,255,255,.84);
        color: #33415f;
        padding: 8px 12px;
        border-radius: 999px;
        font: inherit;
        cursor: pointer;
        font-weight: 700;
      }
      .filter-pill.active {
        color: #fff;
        border-color: transparent;
        background: linear-gradient(135deg, var(--pink), var(--orange));
      }
      .chips {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      .chip {
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(93,141,255,.1);
        color: #3150a5;
        font-weight: 700;
      }
      .table-wrap {
        overflow: auto;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,.72);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 1350px;
      }
      th, td {
        text-align: left;
        padding: 14px 12px;
        border-bottom: 1px solid rgba(123,142,182,.12);
        vertical-align: middle;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        background: rgba(248,250,255,.96);
        position: sticky;
        top: 0;
      }
      .item {
        display: flex;
        gap: 12px;
        align-items: center;
        min-width: 250px;
      }
      .thumb {
        width: 58px;
        height: 58px;
        border-radius: 16px;
        background: #eef3fb;
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        overflow: hidden;
        color: #536487;
        font-weight: 800;
        text-align: center;
        font-size: 12px;
        line-height: 1.2;
      }
      .thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .thumb .thumb-fallback {
        display: none;
        padding: 4px;
      }
      .thumb-missing .thumb-fallback,
      .thumb:not(:has(img)) .thumb-fallback {
        display: block;
      }
      .title {
        font-weight: 800;
        line-height: 1.35;
      }
      .meta {
        color: var(--muted);
        margin-top: 4px;
      }
      .rank {
        width: 42px;
        height: 42px;
        border-radius: 12px;
        display: grid;
        place-items: center;
        font-weight: 800;
        background: rgba(93,141,255,.12);
      }
      .tag {
        display: inline-flex;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(22,199,154,.12);
        color: #0f7f61;
        font-weight: 700;
      }
      .actions a {
        color: #cf315f;
        text-decoration: none;
        font-weight: 700;
      }
      .action-separator {
        color: var(--muted);
        margin: 0 4px;
      }
      .content-shell {
        padding: 0;
        overflow: visible;
        background: transparent;
        border: 0;
        box-shadow: none;
      }
      .content-frame {
        width: 100%;
        min-height: 1200px;
        border: 0;
        display: block;
        background: transparent;
      }
      @media (max-width: 1200px) {
        .page {
          width: calc(100vw - 24px);
          margin: 12px auto 28px;
        }
        .stats {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <h1>${escapeHtml(pageTitle)}</h1>
        <p>${escapeHtml(subtitle)}</p>
        <div class="hero-meta">最近更新：${escapeHtml(formatDate(generatedAt))}</div>
        <div class="hero-actions">
          <button id="runDailyButton" class="run-button" type="button">开始抓取</button>
          <span id="runDailyStatus" class="run-status">面板未连接本地服务时，此按钮不可用。</span>
        </div>
      </section>
      <section class="panel">
        <h2>按日期切换</h2>
        <div class="sub">每天的抓取结果会单独保留，点击日期即可切换到对应快照。</div>
        <div id="runArchiveBar" class="run-archive" data-current-run-id="${escapeHtml(currentRunId || "")}"></div>
      </section>
      <section class="panel content-shell">
        <iframe id="runContentFrame" class="content-frame" src="./content.html" title="????" loading="eager"></iframe>
      </section>
    </main>
    <script>
      (() => {
        const button = document.getElementById("runDailyButton");
        const status = document.getElementById("runDailyStatus");
        const archiveBar = document.getElementById("runArchiveBar");
        const contentFrame = document.getElementById("runContentFrame");

        const syncContentFrameHeight = () => {
          if (!contentFrame) {
            return;
          }
          try {
            const doc = contentFrame.contentDocument;
            if (!doc) {
              return;
            }
            const nextHeight = Math.max(
              doc.body?.scrollHeight || 0,
              doc.documentElement?.scrollHeight || 0,
              1200
            );
            contentFrame.style.height = nextHeight + "px";
          } catch {}
        };

        const setStatus = (text) => {
          status.textContent = text;
        };

        const renderState = (payload) => {
          if (!payload) {
            button.disabled = true;
            setStatus("当前页面不是通过本地面板服务打开，抓取按钮不可用。");
            return;
          }

          button.disabled = Boolean(payload.running);
          if (payload.running) {
            setStatus("正在抓取，请等待本轮任务完成。");
            return;
          }

          if (payload.status === "completed") {
            setStatus("最近一次抓取已完成，页面可刷新查看最新结果。");
            return;
          }

          if (payload.status === "failed") {
            setStatus("最近一次抓取失败，请查看本地日志。");
            return;
          }

          setStatus("本地面板服务已连接，可以直接点击开始抓取。");
        };

        const loadStatus = async () => {
          if (!location.protocol.startsWith("http")) {
            renderState(null);
            return;
          }

          try {
            const response = await fetch("/api/status", { cache: "no-store" });
            const payload = await response.json();
            renderState(payload);
          } catch {
            renderState(null);
          }
        };

        const loadArchives = async () => {
          if (!archiveBar || !location.protocol.startsWith("http")) {
            return;
          }

          try {
            const response = await fetch("/api/runs", { cache: "no-store" });
            const payload = await response.json();
            const currentRunId = archiveBar.dataset.currentRunId || payload.currentRunId || "";
            const runs = payload.runs || [];
            const defaultRun = runs[0] || null;
            const activeRunId = currentRunId || (defaultRun ? defaultRun.runId : "");
            const defaultContentUrl =
              (runs.find((run) => run.runId === activeRunId) || {}).contentUrl ||
              (defaultRun ? defaultRun.contentUrl : null) ||
              "./content.html";

            if (contentFrame && !contentFrame.dataset.initialized) {
              contentFrame.src = defaultContentUrl;
              contentFrame.dataset.initialized = "true";
            }

            archiveBar.innerHTML = runs
              .map((run) => {
                const isActive = activeRunId && run.runId === activeRunId;
                const className = isActive ? "run-archive-link active" : "run-archive-link";
                return '<button type="button" class="' + className + '" data-content-url="' + run.contentUrl + '" data-run-id="' + run.runId + '">' + (run.label || run.dateKey || run.runId) + '</button>';
              })
              .join("");

            archiveBar.querySelectorAll("[data-content-url]").forEach((node) => {
              node.addEventListener("click", () => {
                archiveBar.querySelectorAll(".run-archive-link").forEach((buttonNode) => {
                  buttonNode.classList.toggle("active", buttonNode === node);
                });
                if (contentFrame) {
                  contentFrame.src = node.dataset.contentUrl || "./content.html";
                }
              });
            });
          } catch {
            archiveBar.innerHTML = "";
          }
        };

        if (contentFrame) {
          contentFrame.addEventListener("load", () => {
            syncContentFrameHeight();
            setTimeout(syncContentFrameHeight, 150);
            setTimeout(syncContentFrameHeight, 800);
          });
        }

        window.addEventListener("message", (event) => {
          if (event.origin !== location.origin) {
            return;
          }
          if (event.data?.type === "dashboard-content-height" && contentFrame) {
            const nextHeight = Math.max(Number(event.data.height) || 0, 1200);
            contentFrame.style.height = nextHeight + "px";
          }
        });

        button.addEventListener("click", async () => {
          if (!location.protocol.startsWith("http")) {
            renderState(null);
            return;
          }

          button.disabled = true;
          setStatus("已发送抓取请求，正在启动。");

          try {
            const response = await fetch("/api/run", {
              method: "POST"
            });
            const payload = await response.json();
            renderState(payload);
          } catch {
            button.disabled = false;
            setStatus("抓取请求发送失败，请确认本地面板服务已启动。");
          }
        });

        loadStatus();
        loadArchives();
        setInterval(loadStatus, 5000);
      })();
    </script>
  </body>
</html>`;
}

function renderLeaderboardTable(boardKey, title, subtitle, entries) {
  const categories = [...new Set(entries.map((entry) => deriveCategoryLabel(entry)))];
  const platforms = getPlatformFilterLabels();
  const totalSales = entries.reduce((sum, entry) => sum + Number(entry.salesCount || 0), 0);
  const totalAmount = entries.reduce((sum, entry) => sum + Number(entry.salesAmount || 0), 0);
  const avgHotScore = entries.length
    ? Math.round(entries.reduce((sum, entry) => sum + Number(entry.hotScore || 0), 0) / entries.length)
    : 0;
  const summaryPlatforms = [...new Set(entries.map((entry) => resolvePlatformLabel(entry)))];

  return `
    <section class="stats">
      <article class="card">
        <span>榜单类型</span>
        <strong>${escapeHtml(title)}</strong>
        <div class="meta">当前共 ${escapeHtml(entries.length)} 条</div>
      </article>
      <article class="card">
        <span>累计销量</span>
        <strong>${escapeHtml(formatNumber(totalSales))}</strong>
        <div class="meta">聚合可见销量代理</div>
      </article>
      <article class="card">
        <span>累计销售额</span>
        <strong>${escapeHtml(formatNumber(totalAmount))}</strong>
        <div class="meta">单价 × 销量的可见估算</div>
      </article>
      <article class="card">
        <span>平均热度</span>
        <strong>${escapeHtml(formatNumber(avgHotScore))}</strong>
        <div class="meta">用于近似衡量内容热度</div>
      </article>
      <article class="card">
        <span>覆盖平台</span>
        <strong>${escapeHtml(summaryPlatforms.length)}</strong>
        <div class="meta">${escapeHtml(summaryPlatforms.join(" / "))}</div>
      </article>
    </section>
    <section class="panel">
      <h2>筛选条件</h2>
      <div class="sub">当前只保留这一个热推榜页面，支持时间、地区、类目、平台的表面筛选。</div>
      <div class="filter-box">
        <div class="filter-row">
          <div class="filter-label">时间筛选</div>
          <button type="button" class="filter-pill active">日榜</button>
        </div>
        <div class="filter-row">
          <div class="filter-label">国家地区</div>
          <button type="button" class="filter-pill active" data-region-filter="all">全部</button>
          <button type="button" class="filter-pill" data-region-filter="美国">美国</button>
          <button type="button" class="filter-pill" data-region-filter="全球">全球</button>
        </div>
        <div class="filter-row">
          <div class="filter-label">商品分类</div>
          <button type="button" class="filter-pill active" data-category-filter="all">全部</button>
          ${categories
            .map(
              (category) =>
                `<button type="button" class="filter-pill" data-category-filter="${escapeHtml(category)}">${escapeHtml(category)}</button>`
            )
            .join("")}
        </div>
        <div class="filter-row">
          <div class="filter-label">平台来源</div>
          <button type="button" class="filter-pill active" data-platform-filter="all">全部</button>
          ${platforms
            .map(
              (platform) =>
                `<button type="button" class="filter-pill" data-platform-filter="${escapeHtml(platform)}">${escapeHtml(platform)}</button>`
            )
            .join("")}
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="toolbar">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <div class="sub">${escapeHtml(subtitle)}</div>
          <div class="chips">
            <span class="chip">榜单视图：热推榜</span>
            <span class="chip">商品分类：${escapeHtml(categories.join(" / ") || "未分类")}</span>
          </div>
        </div>
        <input id="leaderboardSearch-${escapeHtml(boardKey)}" class="search-box" type="search" placeholder="搜索商品、店铺、类目" />
      </div>
      <div class="table-wrap">
        <table id="leaderboardTable-${escapeHtml(boardKey)}">
          <thead>
            <tr>
              <th>排名</th>
              <th>商品</th>
              <th>国家/地区</th>
              <th>所属店铺</th>
              <th>商品分类</th>
              <th>平台</th>
              <th>热度分</th>
              <th>价格</th>
              <th>销量</th>
              <th>销售额</th>
              <th>总评分</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${entries
              .map((entry, index) => {
                const category = deriveCategoryLabel(entry);
                const region = deriveRegionLabel(entry);
                const platform = resolvePlatformLabel(entry);
                const store = deriveStoreLabel(entry);
                const searchText = `${entry.displayName} ${store} ${category} ${platform}`.toLowerCase();
                return `
                  <tr
                    data-platform="${escapeHtml(platform)}"
                    data-category="${escapeHtml(category)}"
                    data-region="${escapeHtml(region)}"
                    data-search="${escapeHtml(searchText)}"
                  >
                    <td><div class="rank">#${escapeHtml(entry.rank || index + 1)}</div></td>
                    <td>
                      <div class="item">
                        ${renderThumb(entry.primaryImageUrl, entry.displayName)}
                        <div>
                          <div class="title">${escapeHtml(truncateText(entry.displayName, 64))}</div>
                          <div class="meta">${escapeHtml(entry.productHint || "-")}</div>
                        </div>
                      </div>
                    </td>
                    <td>${escapeHtml(region)}</td>
                    <td class="actions">${renderStoreLink(entry)}</td>
                    <td><span class="tag">${escapeHtml(category)}</span></td>
                    <td>${escapeHtml(platform)}</td>
                    <td>${escapeHtml(formatNumber(entry.hotScore))}</td>
                    <td>${escapeHtml(entry.priceText || "-")}</td>
                    <td>${escapeHtml(formatNumber(entry.salesCount))}</td>
                    <td>${escapeHtml(formatNumber(entry.salesAmount))}</td>
                    <td>${escapeHtml(formatNumber(entry.score))}</td>
                    <td class="actions">${renderActionLinks(entry)}</td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
      <script>
        (() => {
          const table = document.getElementById("leaderboardTable-${escapeHtml(boardKey)}");
          const rows = [...table.querySelectorAll("tbody tr")];
          const searchInput = document.getElementById("leaderboardSearch-${escapeHtml(boardKey)}");
          let platformFilter = "all";
          let categoryFilter = "all";
          let regionFilter = "all";

          const apply = () => {
            const keyword = (searchInput.value || "").trim().toLowerCase();
            rows.forEach((row) => {
              const matchedPlatform = platformFilter === "all" || row.dataset.platform === platformFilter;
              const matchedCategory = categoryFilter === "all" || row.dataset.category === categoryFilter;
              const matchedRegion = regionFilter === "all" || row.dataset.region === regionFilter;
              const matchedKeyword = !keyword || row.dataset.search.includes(keyword);
              row.style.display = matchedPlatform && matchedCategory && matchedRegion && matchedKeyword ? "" : "none";
            });
          };

          document.querySelectorAll("[data-platform-filter]").forEach((button) => {
            button.addEventListener("click", () => {
              platformFilter = button.dataset.platformFilter;
              document.querySelectorAll("[data-platform-filter]").forEach((node) => node.classList.toggle("active", node === button));
              apply();
            });
          });

          document.querySelectorAll("[data-category-filter]").forEach((button) => {
            button.addEventListener("click", () => {
              categoryFilter = button.dataset.categoryFilter;
              document.querySelectorAll("[data-category-filter]").forEach((node) => node.classList.toggle("active", node === button));
              apply();
            });
          });

          document.querySelectorAll("[data-region-filter]").forEach((button) => {
            button.addEventListener("click", () => {
              regionFilter = button.dataset.regionFilter;
              document.querySelectorAll("[data-region-filter]").forEach((node) => node.classList.toggle("active", node === button));
              apply();
            });
          });

          searchInput.addEventListener("input", apply);
        })();
      </script>
    </section>
  `;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildContentDocument({ title, body }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --panel: rgba(255,255,255,0.92);
        --text: #1b2335;
        --muted: #7886a3;
        --line: rgba(123, 142, 182, 0.18);
        --pink: #ff4d7d;
        --orange: #ff8c5c;
        --blue: #5d8dff;
        --mint: #16c79a;
        --shadow: 0 16px 40px rgba(40, 65, 120, 0.1);
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 0;
        background: transparent;
      }
      body {
        font: 14px/1.6 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--text);
      }
      .embedded-page {
        padding: 0 0 1px;
      }
      .panel, .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: var(--shadow);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(5, minmax(0,1fr));
        gap: 18px;
        margin-bottom: 18px;
      }
      .card {
        padding: 20px 24px;
      }
      .card span {
        display: block;
        color: var(--muted);
        font-weight: 700;
      }
      .card strong {
        display: block;
        margin-top: 8px;
        font-size: 28px;
      }
      .panel {
        padding: 24px 26px;
        margin-bottom: 18px;
      }
      .panel h2 {
        margin: 0 0 8px;
        font-size: 22px;
      }
      .panel .sub {
        color: var(--muted);
        margin-bottom: 16px;
      }
      .toolbar {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
        flex-wrap: wrap;
      }
      .search-box {
        width: min(360px, 100%);
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: #fff;
        font: inherit;
      }
      .filter-box {
        display: grid;
        gap: 14px;
      }
      .filter-row {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .filter-label {
        min-width: 76px;
        color: var(--muted);
        font-weight: 700;
      }
      .filter-pill {
        border: 1px solid var(--line);
        background: rgba(255,255,255,.84);
        color: #33415f;
        padding: 8px 12px;
        border-radius: 999px;
        font: inherit;
        cursor: pointer;
        font-weight: 700;
      }
      .filter-pill.active {
        color: #fff;
        border-color: transparent;
        background: linear-gradient(135deg, var(--pink), var(--orange));
      }
      .chips {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      .chip {
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(93,141,255,.1);
        color: #3150a5;
        font-weight: 700;
      }
      .table-wrap {
        overflow: auto;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,.72);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 1350px;
      }
      th, td {
        text-align: left;
        padding: 14px 12px;
        border-bottom: 1px solid rgba(123,142,182,.12);
        vertical-align: middle;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        background: rgba(248,250,255,.96);
        position: sticky;
        top: 0;
      }
      .item {
        display: flex;
        gap: 12px;
        align-items: center;
        min-width: 250px;
      }
      .thumb {
        width: 58px;
        height: 58px;
        border-radius: 16px;
        background: #eef3fb;
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        overflow: hidden;
        color: #536487;
        font-weight: 800;
        text-align: center;
        font-size: 12px;
        line-height: 1.2;
      }
      .thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .thumb .thumb-fallback {
        display: none;
        padding: 4px;
      }
      .thumb-missing .thumb-fallback,
      .thumb:not(:has(img)) .thumb-fallback {
        display: block;
      }
      .title {
        font-weight: 800;
        line-height: 1.35;
      }
      .meta {
        color: var(--muted);
        margin-top: 4px;
      }
      .rank {
        width: 42px;
        height: 42px;
        border-radius: 12px;
        display: grid;
        place-items: center;
        font-weight: 800;
        background: rgba(93,141,255,.12);
      }
      .tag {
        display: inline-flex;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(22,199,154,.12);
        color: #0f7f61;
        font-weight: 700;
      }
      .actions a {
        color: #cf315f;
        text-decoration: none;
        font-weight: 700;
      }
      .action-separator {
        color: var(--muted);
        margin: 0 4px;
      }
      @media (max-width: 1200px) {
        .stats {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="embedded-page">
      ${body}
    </main>
    <script>
      (() => {
        const notifyParent = () => {
          try {
            parent.postMessage(
              {
                type: "dashboard-content-height",
                height: Math.max(
                  document.body?.scrollHeight || 0,
                  document.documentElement?.scrollHeight || 0
                )
              },
              location.origin
            );
          } catch {}
        };

        window.addEventListener("load", notifyParent);
        window.addEventListener("resize", notifyParent);

        if ("ResizeObserver" in window) {
          const observer = new ResizeObserver(() => notifyParent());
          observer.observe(document.body);
        } else {
          setInterval(notifyParent, 1000);
        }
      })();
    </script>
  </body>
</html>`;
}

async function writeSitePages(siteDir, datasets) {
  const stalePageFiles = [
    "leaderboards-hot.html",
    "leaderboards-new.html",
    "leaderboards-rising.html",
    "products.html",
    "shops.html",
    "creators.html",
    "search.html"
  ];

  await Promise.all(
    stalePageFiles.map((fileName) =>
      fs.rm(path.join(siteDir, fileName), { force: true }).catch(() => {})
    )
  );

  const contentHtml = renderLeaderboardTable(
    "overall",
    "热推榜",
    "每日自动抓取更新，展示当前综合评分最高的商品。",
    ensureArray(datasets.leaderboards?.boards?.overall)
  );

  const html = buildLayout({
    title: "热卖轻后台 - 热推榜",
    pageTitle: "热推榜",
    subtitle: "综合社媒热度、电商验证和商品信号的总榜。",
    generatedAt: datasets.overview.generatedAt,
    currentRunId: datasets.overview.runId,
    body: contentHtml
  });

  const contentDocument = buildContentDocument({
    title: "热卖轻后台 - 热推榜",
    body: contentHtml
  });

  await fs.writeFile(path.join(siteDir, "content.html"), contentDocument, "utf8");
  await fs.writeFile(path.join(siteDir, "index.html"), html, "utf8");
}

export async function buildStaticSite({ outputDir, summary, records, leaderboards }) {
  const siteDir = path.join(outputDir, "site");
  const dataDir = path.join(siteDir, "data");

  await fs.mkdir(dataDir, { recursive: true });
  await cacheSiteImages({ outputDir, siteDir, records, leaderboards });

  const datasets = buildSiteDatasets(summary, records, leaderboards);

  await writeJson(path.join(dataDir, "overview.json"), datasets.overview);
  await writeJson(path.join(dataDir, "leaderboards.json"), datasets.leaderboards);
  await writeJson(path.join(dataDir, "products.json"), datasets.products);
  await writeJson(path.join(dataDir, "shops.json"), datasets.shops);
  await writeJson(path.join(dataDir, "creators.json"), datasets.creators);
  await writeSitePages(siteDir, datasets);

  return {
    siteDir,
    entryFile: path.join(siteDir, "index.html"),
    dataDir
  };
}
