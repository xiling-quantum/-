import fs from "node:fs/promises";
import { enrichRecord } from "./enrichment.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return escapeHtml(String(value));
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

function truncateText(value, maxLength = 96) {
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

function containsChinese(value) {
  return /[\u4e00-\u9fff]/.test(String(value ?? ""));
}

function toChinesePlatformName(value) {
  if (value === "tiktok") return "\u6296\u97f3\u56fd\u9645\u7248";
  if (value === "instagram") return "\u56fe\u7247\u793e\u5a92";
  if (value === "amazon") return "\u4e9a\u9a6c\u900a";
  if (value === "fastmoss") return "\u699c\u5355\u6570\u636e\u6e90";
  return value || "-";
}

function toDisplayPlatform(value) {
  return toChinesePlatformName(value);
}

function toBoardLabel(value) {
  if (value === "overall") return "热推榜";
  if (value === "new-releases") return "新品榜";
  if (value === "movers-shakers") return "飙升榜";
  if (value === "saleslist") return "销量榜";
  if (value === "new-products") return "新品榜";
  if (value === "hotlist") return "热榜";
  return value || "-";
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

const TERM_TRANSLATIONS = [
  [/comment finds?/gi, "评论区爆款"],
  [/kitchen gadget/gi, "厨房小工具"],
  [/home decor/gi, "家居装饰"],
  [/home organization/gi, "家居收纳"],
  [/organization product/gi, "收纳用品"],
  [/apple iphone/gi, "苹果手机"],
  [/iphone/gi, "苹果手机"],
  [/pro max/gi, "高配版"],
  [/blue/gi, "蓝色"],
  [/unlocked/gi, "无锁版"],
  [/hydrojug traveler/gi, "随行水壶"],
  [/leak-proof insulated/gi, "防漏保温款"],
  [/toplux magnesium complex/gi, "复合镁补充剂"],
  [/essential/gi, "基础款"],
  [/carpenter bee trap/gi, "木蜂诱捕器"],
  [/outside/gi, "户外"],
  [/shed/gi, "工具棚"],
  [/creeping thyme seeds?/gi, "匍匐百里香种子"],
  [/pink collagen/gi, "粉胶原蛋白"],
  [/authentic jersey/gi, "正版球衣"],
  [/pick your player/gi, "可选球员款"],
  [/rep\/auth\/flex/gi, "球星卡"],
  [/player break/gi, "拆卡专场"],
  [/declutter/gi, "整理收纳"],
  [/core steps you need to/gi, "核心步骤"],
  [/finds?/gi, "好物"],
  [/medicube/gi, "美迪恺护肤"],
  [/pdrn/gi, "PDRN"],
  [/collagen/gi, "胶原蛋白"],
  [/us version/gi, "美版"],
  [/pcs/gi, "个"],
  [/new/gi, "新品"]
];

const EXACT_TITLE_TRANSLATIONS = new Map([
  ["comment finds and i’ll send over the full list! ☀️ if you have a toddler… you need to...", "\u8bc4\u8bba\u533a\u7206\u6b3e\u6e05\u5355"],
  ["kitchen gadget", "\u53a8\u623f\u5c0f\u5de5\u5177"],
  ["apple iphone 11 pro max, us version, 64gb, gold - at&t (renewed)", "\u82f9\u679c\u624b\u673a 11 Pro Max \u7f8e\u7248 64G \u91d1\u8272\u7ffb\u65b0\u673a"],
  ["apple iphone 13, 128gb, blue - unlocked (renewed)", "\u82f9\u679c\u624b\u673a 13 128G \u84dd\u8272\u65e0\u9501\u7ffb\u65b0\u673a"],
  ["20000+pcs creeping thyme seeds for planting, perennial ground cover plants heirloom flowers seeds fragrant herb seeds for lawns & paths garden", "\u532d\u530d\u767e\u91cc\u9999\u79cd\u5b50\u56ed\u827a\u5957\u88c5"],
  ["carpenter bee trap for outside - shed style nature hanging wood trap for outdoor with removable bee vault plastic jar (1 pack)", "\u6237\u5916\u6728\u8702\u8bf1\u6355\u5668"],
  ["[new] [medicube] pdrn pink collagen volume multi balm | all in one volufiline, pdrn, nad stick for youthful-looking, helping look of fine lines, firming care, anti-aging care | for under-eyes, neck, forehead, smile lines, lip care | korean skincare", "\u7f8e\u8fea\u607a PDRN \u80f6\u539f\u86cb\u767d\u591a\u6548\u62a4\u80a4\u68d2"],
  ["home decor or home organization product", "\u5bb6\u5c45\u88c5\u9970\u6216\u6536\u7eb3\u7528\u54c1"],
  ["toplux magnesium complex 8 essential magnesium supplement 1000mg", "\u590d\u5408\u9541\u8425\u517b\u8865\u5145\u5242"],
  ["hydrojug traveler | leak-proof insulated tumbler with flip straw & cup holder fit flasks lid drinkware", "\u9632\u6f0f\u4fdd\u6e29\u5438\u7ba1\u968f\u884c\u676f"],
  ["rep/auth/flex pick your player break ...", "\u7403\u661f\u5361\u62c6\u5361\u4e13\u573a"],
  ["authentic jersey pick your player bre...", "\u6b63\u7248\u7403\u8863\u53ef\u9009\u7403\u5458\u6b3e"],
  ["the 4 core steps you need to declutter & ...", "\u5bb6\u5c45\u6574\u7406\u56db\u4e2a\u6838\u5fc3\u6b65\u9aa4"]
]);

const EXACT_SUMMARY_TRANSLATIONS = new Map([
  ["comment finds and i’ll send over the full list! ☀️ if you have a toddler… you need to see these 19 amazon finds that made everyday l...", "\u8fd9\u6761\u5185\u5bb9\u4e3b\u63a8\u80b2\u513f\u573a\u666f\u7684\u4e9a\u9a6c\u900a\u597d\u7269\u6e05\u5355\u3002"],
  ["likely promoting a kitchen gadget. this peeler is of exceptionally high quality; it peels quickly and thinly. at this price, it's absolutely irresistible!", "\u8fd9\u6761\u5185\u5bb9\u4e3b\u63a8\u4e00\u6b3e\u53a8\u623f\u5265\u76ae\u5c0f\u5de5\u5177\uff0c\u4ee5\u9ad8\u6027\u4ef7\u6bd4\u4e3a\u5356\u70b9\u3002"],
  ["ranked #2 in movers & shakers in amazon renewed. current board movement is up 4252%. visible price: $246.00. this device is locked to at&t only and not compatible with any other carrier. please check with your carrier to verify compati...", "\u8be5\u5546\u54c1\u5728\u4e9a\u9a6c\u900a\u98d9\u5347\u699c\u6392\u540d\u7b2c 2\uff0c\u4e3a\u7f8e\u7248\u7ffb\u65b0\u624b\u673a\u3002"],
  ["ranked #1 in movers & shakers in amazon renewed. visible price: $269.00. 6.1\" super retina xdr display. 5g superfast downloads, high?quality streaming cinematic mode in 1080p at 30 fps. dolby vision hdr video recording up to 4k at 60 fps...", "\u8be5\u5546\u54c1\u5728\u4e9a\u9a6c\u900a\u98d9\u5347\u699c\u6392\u540d\u7b2c 1\uff0c\u4e3a 128G \u84dd\u8272\u65e0\u9501\u7ffb\u65b0\u624b\u673a\u3002"]
]);

function localizeEnglishFragments(value) {
  let result = String(value ?? "").trim();
  for (const [pattern, replacement] of TERM_TRANSLATIONS) {
    result = result.replace(pattern, replacement);
  }
  result = result
    .replace(/\bfor\b/gi, "适用")
    .replace(/\band\b/gi, "和")
    .replace(/\bwith\b/gi, "带")
    .replace(/\bover\b/gi, "")
    .replace(/\bthe\b/gi, "")
    .replace(/\bneed\b/gi, "需要")
    .replace(/\bstep(s)?\b/gi, "步骤")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,./-])/g, "$1")
    .trim();

  return result;
}

function toLocalizedText(value, fallback = "-") {
  const normalized = cleanText(value);
  if (!normalized) {
    return fallback;
  }
  if (containsChinese(normalized)) {
    return normalized;
  }

  const localized = localizeEnglishFragments(normalized);
  if (containsChinese(localized)) {
    return localized;
  }

  return `商品：${localized}`;
}

function getLocalizedDisplayName(entry) {
  const candidate = cleanText(entry.displayName || entry.productHint || entry.caption);
  const exact = EXACT_TITLE_TRANSLATIONS.get(candidate.toLowerCase());
  if (exact) {
    return exact;
  }
  return toLocalizedText(candidate, "未命名条目");
}

function getLocalizedProductHint(entry) {
  const hint =
    entry.productHint && !["No Clear Product", "General Consumer Product"].includes(entry.productHint)
      ? entry.productHint
      : "";
  return toLocalizedText(hint || entry.displayName, "未明确识别");
}

function getLocalizedSummary(entry) {
  const candidate = entry.summary || entry.caption || entry.rawMeta?.description || entry.displayName;
  const normalized = cleanText(candidate).toLowerCase();
  const exact = EXACT_SUMMARY_TRANSLATIONS.get(normalized);
  if (exact) {
    return exact;
  }
  return toLocalizedText(candidate, "暂无简介");
}

function normalizeIntensity(score, maxScore) {
  const safeMax = Math.max(1, Number(maxScore || 0));
  const value = Number(score || 0);
  return Math.min(1, Math.max(0.08, value / safeMax));
}

function buildArtifactLinks(summary) {
  const links = [
    { href: "./report.html", label: "当前页面" },
    { href: "./run-summary.json", label: "运行摘要" },
    { href: "./combined.csv", label: "原始数据 CSV" }
  ];

  if (summary?.files?.leaderboardsJson) {
    links.push({ href: "./leaderboards.json", label: "榜单 JSON" });
  }

  if (summary?.files?.leaderboardsCsv) {
    links.push({ href: "./leaderboards.csv", label: "榜单 CSV" });
  }

  return links
    .map(
      (link) =>
        `<a href="${escapeHtml(link.href)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`
    )
    .join("");
}

function buildWarnings(summary) {
  const warnings = [
    ...(summary.warnings ?? []),
    ...Object.values(summary.platforms ?? {}).flatMap((platform) => platform.warnings ?? []),
    ...Object.values(summary.platforms ?? {}).flatMap((platform) =>
      (platform.targets ?? [])
        .filter((target) => target.targetError)
        .map((target) => ({
          message: `${target.value}: ${target.targetError.message}`
        }))
    )
  ];

  if (!warnings.length) {
    return "";
  }

  return `
    <section class="warning-card">
      <div class="warning-head">
        <strong>运行告警</strong>
        <span>以下项目在本轮抓取中出现限制或异常</span>
      </div>
      <ul>
        ${warnings.map((warning) => `<li>${escapeHtml(warning.message)}</li>`).join("")}
      </ul>
    </section>
  `;
}

function buildStatsGrid(leaderboards, summary, recordsWithImage) {
  const totals = leaderboards?.totals ?? {};
  const completedPlatforms = Object.values(summary.platforms ?? {}).filter(
    (platform) => platform?.status === "completed"
  ).length;

  return `
    <section class="stats-grid">
      <article class="stat-card">
        <span>采集记录</span>
        <strong>${escapeHtml(String(totals.records ?? 0))}</strong>
        <small>本轮已完成 ${escapeHtml(String(completedPlatforms))} 个平台</small>
      </article>
      <article class="stat-card">
        <span>商品候选</span>
        <strong>${escapeHtml(String(totals.productRecords ?? 0))}</strong>
        <small>已识别为商品导向内容</small>
      </article>
      <article class="stat-card">
        <span>图片可视化率</span>
        <strong>${escapeHtml(formatNumber(recordsWithImage))}</strong>
        <small>带图片或封面的条目数量</small>
      </article>
      <article class="stat-card">
        <span>重点榜单</span>
        <strong>${escapeHtml(
          `${totals.overall ?? 0} / ${totals.newReleases ?? 0} / ${totals.moversShakers ?? 0}`
        )}</strong>
        <small>热推 / 新品 / 飙升</small>
      </article>
    </section>
  `;
}

function buildTopHero(leaderboards) {
  const top = leaderboards?.boards?.overall?.[0];
  if (!top) {
    return `
      <section class="hero-card">
        <div class="hero-copy">
          <span class="hero-badge">今日总览</span>
          <h1>热卖榜单中心</h1>
          <p>当前还没有可展示的榜单条目。</p>
        </div>
      </section>
    `;
  }

  const media = resolveMedia(top);
  const localizedTitle = truncateText(getLocalizedDisplayName(top), 88);
  const localizedSummary = truncateText(getLocalizedSummary(top), 180);
  return `
    <section class="hero-card">
      <div class="hero-copy">
        <span class="hero-badge">今日热推 Top 1</span>
        <h1>${escapeHtml(localizedTitle)}</h1>
        <p>${escapeHtml(localizedSummary)}</p>
        <div class="hero-meta">
          <span>${escapeHtml(toDisplayPlatform(top.platform))}</span>
          <span>${escapeHtml(top.priceText || "未标注价格")}</span>
          <span>总评分 ${escapeHtml(formatNumber(top.score))}</span>
          <span>热度分 ${escapeHtml(formatNumber(top.hotScore))}</span>
        </div>
      </div>
      <div class="hero-media">
        ${
          media
            ? `<img src="${escapeHtml(media)}" alt="${escapeHtml(localizedTitle)}" loading="lazy" />`
            : `<div class="hero-placeholder">榜单第一</div>`
        }
      </div>
    </section>
  `;
}

function buildPlatformOverview(summary, leaderboards) {
  const overall = leaderboards?.boards?.overall ?? [];
  const maxScore = Math.max(...overall.map((entry) => Number(entry.score || 0)), 1);
  const platformCards = ["tiktok", "instagram", "amazon", "fastmoss"]
    .map((platform) => {
      const platformSummary = summary.platforms?.[platform] ?? {};
      const records = platformSummary.records ?? 0;
      const entries = overall.filter((entry) => entry.platform === platform);
      const best = entries[0];
      const score = best?.score ?? 0;
      const intensity = normalizeIntensity(score, maxScore);
      const sessionLabel =
        platformSummary.storageStateLoaded === true
          ? "已加载登录态"
          : platformSummary.sessionModeUsed
            ? `会话模式：${platformSummary.sessionModeUsed}`
            : "公开抓取";

      return `
        <article class="platform-card">
          <div class="platform-head">
            <span class="platform-name">${escapeHtml(toDisplayPlatform(platform))}</span>
            <span class="platform-dot" style="opacity:${intensity.toFixed(2)}"></span>
          </div>
          <strong>${escapeHtml(formatNumber(records))}</strong>
          <p>${escapeHtml(best ? truncateText(getLocalizedDisplayName(best), 54) : "本轮暂无入榜条目")}</p>
          <small>${escapeHtml(sessionLabel)}</small>
          <div class="mini-bar">
            <span style="width:${Math.max(10, intensity * 100).toFixed(0)}%"></span>
          </div>
        </article>
      `;
    })
    .join("");

  return `<section class="platform-grid">${platformCards}</section>`;
}

function buildBoardSpotlights(leaderboards) {
  const cards = [
    { key: "overall", label: "热推榜", accent: "hot" },
    { key: "new-releases", label: "新品榜", accent: "new" },
    { key: "movers-shakers", label: "飙升榜", accent: "rise" }
  ]
    .map(({ key, label, accent }) => {
      const top = leaderboards?.boards?.[key]?.[0];
      return `
        <article class="spotlight-card ${accent}">
          <div class="spotlight-label">${escapeHtml(label)}</div>
          <div class="spotlight-title">${escapeHtml(truncateText(top ? getLocalizedDisplayName(top) : "暂无条目", 72))}</div>
          <div class="spotlight-meta">
            <span>${escapeHtml(toDisplayPlatform(top?.platform || "-"))}</span>
            <span>评分 ${escapeHtml(formatNumber(top?.score))}</span>
          </div>
        </article>
      `;
    })
    .join("");

  return `<section class="spotlight-grid">${cards}</section>`;
}

function buildHeatmap(leaderboards) {
  const rows = (leaderboards?.boards?.overall ?? []).slice(0, 12);
  const maxScore = Math.max(...rows.map((entry) => Number(entry.score || 0)), 1);

  const cells = rows
    .map((entry) => {
      const intensity = normalizeIntensity(entry.score, maxScore);
      const hue =
        entry.platform === "tiktok"
          ? 338
          : entry.platform === "instagram"
            ? 18
            : entry.platform === "amazon"
              ? 210
              : 155;
      return `
        <div class="heat-cell" style="--heat-alpha:${intensity.toFixed(2)}; --heat-hue:${hue}">
          <span class="heat-rank">#${escapeHtml(entry.rank)}</span>
          <strong>${escapeHtml(truncateText(getLocalizedDisplayName(entry), 40))}</strong>
          <small>${escapeHtml(toDisplayPlatform(entry.platform))} · ${escapeHtml(formatNumber(entry.score))}</small>
        </div>
      `;
    })
    .join("");

  return `
    <section class="viz-grid">
      <article class="viz-card heatmap-card">
        <div class="section-head">
          <div>
            <div class="section-title">热力分布</div>
            <div class="section-subtitle">颜色强度映射总评分，便于快速观察高压商品区间。</div>
          </div>
        </div>
        <div class="heat-grid">${cells || '<div class="empty-box">暂无热力图数据</div>'}</div>
      </article>
      ${buildMomentumPanel(leaderboards)}
    </section>
  `;
}

function buildMomentumPanel(leaderboards) {
  const entries = (leaderboards?.boards?.moversShakers ?? []).slice(0, 6);
  const maxHot = Math.max(...entries.map((entry) => Number(entry.hotScore || 0)), 1);
  const lines = entries
    .map((entry) => {
      const width = Math.max(8, (Number(entry.hotScore || 0) / maxHot) * 100);
      return `
        <div class="momentum-row">
          <div class="momentum-copy">
            <strong>${escapeHtml(truncateText(getLocalizedDisplayName(entry), 44))}</strong>
            <span>${escapeHtml(toDisplayPlatform(entry.platform))}</span>
          </div>
          <div class="momentum-bar"><span style="width:${width.toFixed(0)}%"></span></div>
          <div class="momentum-value">${escapeHtml(formatNumber(entry.hotScore))}</div>
        </div>
      `;
    })
    .join("");

  return `
    <article class="viz-card momentum-card">
      <div class="section-head">
        <div>
          <div class="section-title">飙升动量</div>
          <div class="section-subtitle">按热度分展示飙升榜头部条目的动量强弱。</div>
        </div>
      </div>
      <div class="momentum-list">${lines || '<div class="empty-box">暂无飙升数据</div>'}</div>
    </article>
  `;
}

function buildBoardRows(leaderboards) {
  const rows = Object.entries(leaderboards?.boards ?? {}).flatMap(([boardKey, entries]) =>
    (entries ?? []).map((entry) => ({
      ...entry,
      boardKey
    }))
  );

  const maxScore = Math.max(...rows.map((entry) => Number(entry.score || 0)), 1);

  return rows
    .map((entry) => {
      const image = resolveMedia(entry);
      const matchedBoards = entry.matchedAmazonBoards?.length
        ? entry.matchedAmazonBoards.map((item) => toBoardLabel(item)).join(" / ")
        : toBoardLabel(entry.sourceBoard) || "-";
      const scoreClass =
        entry.rank === 1 ? "top-1" : entry.rank === 2 ? "top-2" : entry.rank === 3 ? "top-3" : "";
      const productHint = truncateText(getLocalizedProductHint(entry), 48);
      const summary = truncateText(getLocalizedSummary(entry), 110);
      const displayName = truncateText(getLocalizedDisplayName(entry), 72);
      const scoreWidth = Math.max(10, normalizeIntensity(entry.score, maxScore) * 100);

      return `
        <tr
          data-board="${escapeHtml(entry.boardKey)}"
          data-platform="${escapeHtml(entry.platform)}"
          data-search="${escapeHtml(
            [
              entry.displayName,
              entry.productHint,
              entry.authorHandle,
              entry.summary,
              ...(entry.matchedAmazonTitles ?? [])
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
          )}"
        >
          <td class="rank-cell">
            <div class="rank-badge ${scoreClass}">${escapeHtml(String(entry.rank))}</div>
          </td>
          <td class="product-cell">
            <div class="product-wrap">
              ${
                image
                  ? `<img class="product-thumb" src="${escapeHtml(image)}" alt="${escapeHtml(
                      displayName
                    )}" loading="lazy" referrerpolicy="no-referrer" />`
                  : `<div class="product-thumb placeholder">暂无图片</div>`
              }
              <div class="product-copy">
                <div class="product-title">${escapeHtml(displayName)}</div>
                <div class="product-subtitle">${escapeHtml(truncateText(productHint, 48))}</div>
                <div class="product-summary">${escapeHtml(summary)}</div>
              </div>
            </div>
          </td>
          <td>${escapeHtml(toDisplayPlatform(entry.platform))}</td>
          <td>${escapeHtml(matchedBoards)}</td>
          <td>${escapeHtml(entry.priceText || "-")}</td>
          <td class="number-cell">${escapeHtml(formatNumber(entry.salesCount))}</td>
          <td class="number-cell">${escapeHtml(formatNumber(entry.salesAmount))}</td>
          <td class="number-cell">${escapeHtml(formatNumber(entry.creatorCount))}</td>
          <td>${escapeHtml(entry.ratingValue ? `${entry.ratingValue}/5` : "-")}</td>
          <td class="number-cell">${escapeHtml(formatNumber(entry.ratingCount))}</td>
          <td><span class="signal-pill">${escapeHtml(entry.salesSignal || "-")}</span></td>
          <td class="number-cell">${escapeHtml(formatNumber(entry.hotScore))}</td>
          <td class="score-cell">
            <div class="score-stack">
              <strong>${escapeHtml(formatNumber(entry.score))}</strong>
              <div class="score-bar"><span style="width:${scoreWidth.toFixed(0)}%"></span></div>
            </div>
          </td>
          <td>
            <a class="table-link" href="${escapeHtml(entry.postUrl ?? "#")}" target="_blank" rel="noreferrer">查看原帖</a>
          </td>
        </tr>
      `;
    })
    .join("");
}

function buildHtml(summary, records, leaderboards) {
  const enrichedRecords = records.map((record) => enrichRecord(record));
  const reportDate = formatDate(summary.finishedAt || leaderboards?.generatedAt || new Date().toISOString());
  const successfulPlatforms = Object.entries(summary.platforms ?? {})
    .filter(([, platform]) => platform.records > 0)
    .map(([platform]) => toDisplayPlatform(platform))
    .join(" / ");
  const rowsMarkup = buildBoardRows(leaderboards);
  const tiktokRecords = summary.platforms?.tiktok?.records ?? 0;
  const instagramRecords = summary.platforms?.instagram?.records ?? 0;
  const amazonRecords = summary.platforms?.amazon?.records ?? 0;
  const fastmossRecords = summary.platforms?.fastmoss?.records ?? 0;
  const withImageCount = enrichedRecords.filter((record) => resolveMedia(record)).length;

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>热卖榜单中心</title>
    <style>
      :root {
        --bg: #f6f8fc;
        --bg-soft: #eef3fb;
        --surface: rgba(255, 255, 255, 0.88);
        --surface-strong: #ffffff;
        --surface-soft: #f8fbff;
        --text: #172033;
        --muted: #71809d;
        --border: rgba(131, 146, 179, 0.2);
        --primary: #ff4d7d;
        --primary-soft: rgba(255, 77, 125, 0.12);
        --blue: #4f8cff;
        --blue-soft: rgba(79, 140, 255, 0.12);
        --mint: #16c79a;
        --mint-soft: rgba(22, 199, 154, 0.12);
        --gold: #ffb648;
        --gold-soft: rgba(255, 182, 72, 0.16);
        --shadow: 0 18px 48px rgba(34, 60, 110, 0.12);
      }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body {
        margin: 0;
        color: var(--text);
        font: 14px/1.6 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(255, 77, 125, 0.12), transparent 22%),
          radial-gradient(circle at top right, rgba(79, 140, 255, 0.12), transparent 26%),
          linear-gradient(180deg, #f8fbff 0%, #f3f6fc 44%, #eef2f9 100%);
      }
      a { color: inherit; }
      .layout { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; }
      .sidebar {
        position: sticky;
        top: 0;
        height: 100vh;
        padding: 24px 18px;
        background: rgba(255, 255, 255, 0.82);
        border-right: 1px solid rgba(131, 146, 179, 0.16);
        backdrop-filter: blur(22px);
      }
      .brand { display: flex; align-items: center; gap: 14px; margin-bottom: 28px; }
      .brand-logo {
        width: 48px; height: 48px; border-radius: 16px; display: grid; place-items: center;
        background: linear-gradient(135deg, #ff5b8a, #ff8e5d 58%, #4f8cff);
        color: white; font-size: 20px; font-weight: 800;
        box-shadow: 0 14px 26px rgba(255, 91, 138, 0.22);
      }
      .brand-copy strong { display: block; font-size: 20px; line-height: 1.1; }
      .brand-copy span { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; }
      .menu-title {
        margin: 0 0 12px;
        color: #8491aa;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: .08em;
      }
      .menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        padding: 14px 16px;
        border-radius: 18px;
        text-decoration: none;
        color: #33415f;
        border: 1px solid transparent;
        background: transparent;
        font-weight: 700;
      }
      .menu-item.active {
        color: #1d2742;
        background: linear-gradient(90deg, rgba(255, 77, 125, 0.12), rgba(79, 140, 255, 0.08));
        border-color: rgba(255, 77, 125, 0.12);
      }
      .menu-badge {
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 800;
        color: white;
        background: linear-gradient(135deg, #ff5b8a, #ff8e5d);
      }
      .main { min-width: 0; }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 18px 28px;
        background: rgba(246, 248, 252, 0.88);
        border-bottom: 1px solid rgba(131, 146, 179, 0.14);
        backdrop-filter: blur(20px);
      }
      .search-wrap {
        flex: 1;
        max-width: 520px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px 10px 18px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.84);
        border: 1px solid rgba(131, 146, 179, 0.18);
        box-shadow: 0 8px 24px rgba(34, 60, 110, 0.08);
      }
      .search-wrap input {
        flex: 1;
        border: 0;
        outline: none;
        background: transparent;
        color: var(--text);
        font: inherit;
      }
      .search-wrap input::placeholder { color: #98a3b8; }
      .search-btn, .pill-btn {
        border: 0;
        cursor: pointer;
        font: inherit;
      }
      .search-btn {
        width: 40px;
        height: 40px;
        border-radius: 999px;
        color: white;
        background: linear-gradient(135deg, #ff5b8a, #ff8e5d);
      }
      .pill-group { display: flex; gap: 10px; }
      .pill-btn {
        padding: 10px 16px;
        border-radius: 999px;
        color: #2d3c59;
        background: rgba(255, 255, 255, 0.84);
        border: 1px solid rgba(131, 146, 179, 0.18);
        box-shadow: 0 8px 22px rgba(34, 60, 110, 0.06);
      }
      .content { padding: 26px 28px 40px; }
      .hero-card,
      .platform-card,
      .spotlight-card,
      .viz-card,
      .filter-card,
      .table-shell,
      .warning-card,
      .stat-card {
        background: var(--surface);
        border: 1px solid rgba(131, 146, 179, 0.16);
        box-shadow: var(--shadow);
        backdrop-filter: blur(16px);
      }
      .hero-card {
        display: grid;
        grid-template-columns: 1.3fr .88fr;
        gap: 24px;
        padding: 28px;
        border-radius: 28px;
        background:
          radial-gradient(circle at top left, rgba(255, 77, 125, 0.12), transparent 24%),
          radial-gradient(circle at right center, rgba(79, 140, 255, 0.1), transparent 30%),
          linear-gradient(135deg, rgba(255, 255, 255, 0.92), rgba(246, 249, 255, 0.84));
      }
      .hero-badge {
        display: inline-flex;
        align-items: center;
        padding: 6px 12px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(255, 77, 125, 0.14), rgba(79, 140, 255, 0.14));
        color: #d03666;
        font-size: 12px;
        font-weight: 800;
      }
      .hero-copy h1 {
        margin: 14px 0 0;
        font-size: 36px;
        line-height: 1.08;
        max-width: 760px;
      }
      .hero-copy p {
        margin: 14px 0 0;
        color: var(--muted);
        max-width: 720px;
      }
      .hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }
      .hero-meta span {
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.82);
        border: 1px solid rgba(131, 146, 179, 0.16);
      }
      .hero-media {
        min-height: 260px;
        border-radius: 24px;
        overflow: hidden;
        background: linear-gradient(135deg, rgba(79, 140, 255, 0.12), rgba(255, 77, 125, 0.12));
        border: 1px solid rgba(131, 146, 179, 0.18);
      }
      .hero-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .hero-placeholder {
        width: 100%;
        height: 100%;
        min-height: 260px;
        display: grid;
        place-items: center;
        color: #9aa7be;
        font-size: 38px;
        font-weight: 800;
      }
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 16px;
        margin-top: 18px;
      }
      .stat-card {
        padding: 20px;
        border-radius: 22px;
      }
      .stat-card span { color: var(--muted); }
      .stat-card strong {
        display: block;
        margin-top: 10px;
        font-size: 30px;
        line-height: 1.1;
      }
      .stat-card small {
        display: block;
        margin-top: 8px;
        color: #93a0b8;
      }
      .platform-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 16px;
        margin-top: 18px;
      }
      .platform-card {
        padding: 20px;
        border-radius: 24px;
        min-height: 172px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(247, 250, 255, 0.84));
      }
      .platform-head { display: flex; align-items: center; justify-content: space-between; }
      .platform-name { font-weight: 800; }
      .platform-dot {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: linear-gradient(90deg, #16c79a, #4f8cff);
        box-shadow: 0 0 14px rgba(79, 140, 255, 0.3);
      }
      .platform-card strong {
        display: block;
        margin-top: 14px;
        font-size: 30px;
      }
      .platform-card p {
        margin: 10px 0 10px;
        color: var(--muted);
        min-height: 42px;
      }
      .platform-card small { color: #97a3b7; }
      .mini-bar {
        height: 8px;
        border-radius: 999px;
        overflow: hidden;
        margin-top: 12px;
        background: rgba(139, 152, 178, 0.14);
      }
      .mini-bar span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, #ff5b8a, #4f8cff, #16c79a);
      }
      .spotlight-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
        margin-top: 18px;
      }
      .spotlight-card {
        padding: 20px;
        border-radius: 24px;
        min-height: 148px;
      }
      .spotlight-card.hot { background: linear-gradient(135deg, rgba(255, 77, 125, 0.16), rgba(255, 255, 255, 0.82)); }
      .spotlight-card.new { background: linear-gradient(135deg, rgba(22, 199, 154, 0.14), rgba(255, 255, 255, 0.82)); }
      .spotlight-card.rise { background: linear-gradient(135deg, rgba(79, 140, 255, 0.14), rgba(255, 255, 255, 0.82)); }
      .spotlight-label { color: #8d98ad; font-size: 12px; font-weight: 700; letter-spacing: .08em; }
      .spotlight-title { margin-top: 14px; font-size: 18px; font-weight: 800; line-height: 1.3; }
      .spotlight-meta { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; color: var(--muted); }
      .viz-grid {
        display: grid;
        grid-template-columns: 1.35fr .95fr;
        gap: 18px;
        margin-top: 18px;
      }
      .viz-card { padding: 22px; border-radius: 28px; }
      .section-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 16px; }
      .section-title { font-size: 20px; font-weight: 800; }
      .section-subtitle { margin-top: 6px; color: var(--muted); }
      .heat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
      .heat-cell {
        min-height: 112px;
        padding: 14px;
        border-radius: 18px;
        background: linear-gradient(
          135deg,
          hsla(var(--heat-hue), 90%, 72%, calc(var(--heat-alpha) * 0.8)),
          rgba(255, 255, 255, 0.94)
        );
        border: 1px solid rgba(131, 146, 179, 0.12);
      }
      .heat-rank {
        display: inline-flex;
        margin-bottom: 10px;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.72);
        color: #4e5e7b;
        font-size: 12px;
        font-weight: 800;
      }
      .heat-cell strong { display: block; line-height: 1.35; }
      .heat-cell small { display: block; margin-top: 8px; color: #52627f; }
      .momentum-list { display: grid; gap: 14px; }
      .momentum-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 160px 72px;
        gap: 12px;
        align-items: center;
      }
      .momentum-copy strong { display: block; }
      .momentum-copy span { display: block; margin-top: 4px; color: var(--muted); }
      .momentum-bar {
        height: 10px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(131, 146, 179, 0.16);
      }
      .momentum-bar span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, #4f8cff, #16c79a);
      }
      .momentum-value { text-align: right; font-weight: 800; }
      .filter-card {
        margin-top: 18px;
        padding: 22px;
        border-radius: 28px;
      }
      .filter-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 16px;
      }
      .filter-line {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }
      .filter-label {
        min-width: 76px;
        color: #7c89a2;
        font-weight: 700;
      }
      .filter-pill {
        padding: 9px 14px;
        border: 1px solid rgba(131, 146, 179, 0.18);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.84);
        color: #3b4a66;
        font-weight: 700;
        cursor: pointer;
      }
      .filter-pill.active {
        color: white;
        border-color: transparent;
        background: linear-gradient(135deg, #ff5b8a, #ff8e5d);
      }
      .table-shell {
        margin-top: 18px;
        padding: 22px;
        border-radius: 28px;
      }
      .table-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 16px;
      }
      .table-title { font-size: 22px; font-weight: 800; }
      .table-meta { margin-top: 6px; color: var(--muted); max-width: 760px; }
      .artifact-links { display: flex; flex-wrap: wrap; gap: 10px; }
      .artifact-links a {
        padding: 9px 12px;
        border-radius: 999px;
        background: var(--surface-strong);
        border: 1px solid rgba(131, 146, 179, 0.16);
        text-decoration: none;
      }
      .table-wrap {
        overflow: auto;
        border-radius: 20px;
        border: 1px solid rgba(131, 146, 179, 0.16);
        background: rgba(255, 255, 255, 0.76);
      }
      table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        min-width: 1450px;
      }
      thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 18px 14px;
        text-align: left;
        background: rgba(248, 251, 255, 0.96);
        color: #6f7d97;
        font-size: 12px;
        letter-spacing: .04em;
        border-bottom: 1px solid rgba(131, 146, 179, 0.14);
      }
      tbody td {
        padding: 16px 14px;
        border-bottom: 1px solid rgba(131, 146, 179, 0.1);
        background: rgba(255, 255, 255, 0.72);
      }
      tbody tr:hover td { background: rgba(245, 248, 255, 0.96); }
      .rank-cell { width: 92px; }
      .rank-badge {
        width: 42px;
        height: 42px;
        display: grid;
        place-items: center;
        border-radius: 14px;
        background: rgba(131, 146, 179, 0.12);
        font-weight: 800;
      }
      .rank-badge.top-1 { color: white; background: linear-gradient(135deg, #ff8c42, #ff5b8a); }
      .rank-badge.top-2 { color: white; background: linear-gradient(135deg, #5c7cff, #4f8cff); }
      .rank-badge.top-3 { color: white; background: linear-gradient(135deg, #ffb648, #ffd36b); }
      .product-wrap { display: flex; gap: 14px; min-width: 320px; }
      .product-thumb {
        width: 78px;
        height: 78px;
        border-radius: 20px;
        object-fit: cover;
        background: #edf2fb;
        flex: 0 0 auto;
      }
      .product-thumb.placeholder {
        display: grid;
        place-items: center;
        color: #95a2b8;
        font-size: 12px;
        font-weight: 700;
        text-align: center;
      }
      .product-title { font-weight: 800; line-height: 1.35; }
      .product-subtitle { margin-top: 4px; color: #4a5a78; font-weight: 700; }
      .product-summary { margin-top: 6px; color: var(--muted); }
      .number-cell { font-variant-numeric: tabular-nums; }
      .signal-pill {
        display: inline-flex;
        align-items: center;
        padding: 7px 10px;
        border-radius: 999px;
        color: #127f62;
        background: rgba(22, 199, 154, 0.12);
        font-weight: 800;
      }
      .score-stack strong { display: block; }
      .score-bar {
        margin-top: 8px;
        height: 8px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(131, 146, 179, 0.14);
      }
      .score-bar span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, #ff5b8a, #4f8cff, #16c79a);
      }
      .table-link {
        display: inline-flex;
        align-items: center;
        padding: 9px 12px;
        border-radius: 999px;
        text-decoration: none;
        color: #d63c69;
        background: rgba(255, 77, 125, 0.1);
        font-weight: 800;
      }
      .warning-card {
        margin-top: 18px;
        padding: 18px 20px;
        border-radius: 22px;
        background: linear-gradient(135deg, rgba(255, 182, 72, 0.14), rgba(255, 255, 255, 0.82));
      }
      .warning-head span { display: block; margin-top: 4px; color: var(--muted); }
      .warning-card ul { margin: 14px 0 0; padding-left: 18px; color: #7a5c24; }
      .empty-box {
        padding: 16px;
        border-radius: 16px;
        background: rgba(245, 248, 255, 0.88);
        color: var(--muted);
      }
      @media (max-width: 1400px) {
        .platform-grid,
        .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .heat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      }
      @media (max-width: 1200px) {
        .layout { grid-template-columns: 1fr; }
        .sidebar { position: static; height: auto; }
        .hero-card,
        .viz-grid { grid-template-columns: 1fr; }
        .spotlight-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 760px) {
        .content,
        .topbar { padding-left: 16px; padding-right: 16px; }
        .platform-grid,
        .stats-grid,
        .heat-grid { grid-template-columns: 1fr; }
        .table-head,
        .topbar { flex-direction: column; align-items: stretch; }
        .pill-group { flex-wrap: wrap; }
        .momentum-row { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-logo">榜</div>
          <div class="brand-copy">
            <strong>热卖榜单中心</strong>
            <span>社媒发现与电商验证一体化看板</span>
          </div>
        </div>

        <div class="menu-title">榜单导航</div>
        <a class="menu-item active" href="#" data-board-nav="overall"><span>热推榜</span><span class="menu-badge">热</span></a>
        <a class="menu-item" href="#" data-board-nav="new-releases"><span>新品榜</span></a>
        <a class="menu-item" href="#" data-board-nav="movers-shakers"><span>飙升榜</span></a>
      </aside>

      <main class="main">
        <div class="topbar">
          <label class="search-wrap">
            <input id="searchInput" type="search" placeholder="输入商品、关键词、作者或标签" />
            <button class="search-btn" type="button">搜</button>
          </label>
          <div class="pill-group">
            <button class="pill-btn" type="button">导出数据</button>
            <button class="pill-btn" type="button">运行日期 ${escapeHtml(reportDate)}</button>
          </div>
        </div>

        <section class="content">
          ${buildTopHero(leaderboards)}
          ${buildStatsGrid(leaderboards, summary, withImageCount)}
          ${buildPlatformOverview(summary, leaderboards)}
          ${buildBoardSpotlights(leaderboards)}
          ${buildHeatmap(leaderboards)}

          <section class="filter-card">
            <div class="section-head">
              <div>
                <div class="section-title">筛选面板</div>
                <div class="section-subtitle">当前成功平台：${escapeHtml(successfulPlatforms || "暂无成功平台")}</div>
              </div>
            </div>
            <div class="filter-grid">
              <div class="filter-line">
                <span class="filter-label">榜单筛选</span>
                <button class="filter-pill active" type="button" data-board-filter="overall">热推榜</button>
                <button class="filter-pill" type="button" data-board-filter="new-releases">新品榜</button>
                <button class="filter-pill" type="button" data-board-filter="movers-shakers">飙升榜</button>
                <button class="filter-pill" type="button" data-board-filter="all">全部</button>
              </div>
              <div class="filter-line">
                <span class="filter-label">平台筛选</span>
                <button class="filter-pill active" type="button" data-platform-filter="all">全部</button>
                <button class="filter-pill" type="button" data-platform-filter="tiktok">TikTok 平台</button>
                <button class="filter-pill" type="button" data-platform-filter="instagram">Instagram 平台</button>
                <button class="filter-pill" type="button" data-platform-filter="amazon">亚马逊</button>
                <button class="filter-pill" type="button" data-platform-filter="fastmoss">FastMoss</button>
              </div>
              <div class="filter-line">
                <span class="filter-label">平台记录</span>
                <button class="filter-pill" type="button">TikTok 平台：${escapeHtml(String(tiktokRecords))}</button>
                <button class="filter-pill" type="button">Instagram 平台：${escapeHtml(String(instagramRecords))}</button>
                <button class="filter-pill" type="button">亚马逊：${escapeHtml(String(amazonRecords))}</button>
                <button class="filter-pill" type="button">FastMoss：${escapeHtml(String(fastmossRecords))}</button>
              </div>
            </div>
          </section>

          ${buildWarnings(summary)}

          <section class="table-shell">
            <div class="table-head">
              <div>
                <div class="table-title">统一榜单视图</div>
                <div class="table-meta">
                  该表融合社媒热度、电商榜单验证与商品信号。热推榜、新品榜、飙升榜共用同一数据底座，可通过上方筛选快速切换。
                </div>
              </div>
              <div class="artifact-links">${buildArtifactLinks(summary)}</div>
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>排名</th>
                    <th>商品</th>
                    <th>平台</th>
                    <th>榜单命中</th>
                    <th>价格</th>
                    <th>销量</th>
                    <th>销售额</th>
                    <th>达人数</th>
                    <th>评分</th>
                    <th>评价数</th>
                    <th>销售强度</th>
                    <th>热度分</th>
                    <th>总评分</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody id="leaderboardBody">${rowsMarkup}</tbody>
              </table>
            </div>
          </section>
        </section>
      </main>
    </div>
    <script>
      const boardButtons = [...document.querySelectorAll("[data-board-filter]")];
      const platformButtons = [...document.querySelectorAll("[data-platform-filter]")];
      const navButtons = [...document.querySelectorAll("[data-board-nav]")];
      const searchInput = document.getElementById("searchInput");
      const rows = [...document.querySelectorAll("#leaderboardBody tr")];
      let boardFilter = "overall";
      let platformFilter = "all";

      function toggleActive(buttons, activeButton) {
        buttons.forEach((button) => button.classList.toggle("active", button === activeButton));
      }

      function updateRows() {
        const keyword = (searchInput.value || "").trim().toLowerCase();
        rows.forEach((row) => {
          const matchedBoard = boardFilter === "all" || row.dataset.board === boardFilter;
          const matchedPlatform = platformFilter === "all" || row.dataset.platform === platformFilter;
          const matchedKeyword = !keyword || (row.dataset.search || "").includes(keyword);
          row.style.display = matchedBoard && matchedPlatform && matchedKeyword ? "" : "none";
        });
      }

      boardButtons.forEach((button) => {
        button.addEventListener("click", () => {
          boardFilter = button.dataset.boardFilter;
          toggleActive(boardButtons, button);
          navButtons.forEach((nav) => nav.classList.toggle("active", nav.dataset.boardNav === boardFilter));
          if (boardFilter === "all") {
            navButtons.forEach((nav) => nav.classList.remove("active"));
          }
          updateRows();
        });
      });

      platformButtons.forEach((button) => {
        button.addEventListener("click", () => {
          platformFilter = button.dataset.platformFilter;
          toggleActive(platformButtons, button);
          updateRows();
        });
      });

      navButtons.forEach((button) => {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          boardFilter = button.dataset.boardNav;
          toggleActive(navButtons, button);
          boardButtons.forEach((filterButton) => {
            filterButton.classList.toggle("active", filterButton.dataset.boardFilter === boardFilter);
          });
          updateRows();
        });
      });

      searchInput.addEventListener("input", updateRows);
      updateRows();
    </script>
  </body>
</html>`;
}

export async function writeHtmlReport(filePath, summary, records, leaderboards) {
  await fs.writeFile(filePath, buildHtml(summary, records, leaderboards), "utf8");
}
