import {
  createStandardRecord,
  autoScrollForDiscovery,
  dismissCommonOverlays,
  hydrateJsonLd,
  resolveInteractionCount,
  settlePage
} from "../core/scrape-helpers.js";
import {
  ensureLeadingAt,
  ensureNoLeadingHash,
  extractHashtags,
  normalizePostUrl,
  parseCount,
  pickFirstNonEmpty
} from "../core/utils.js";

export function buildTikTokDiscoveryUrls(target) {
  if (target.type === "hashtag") {
    const hashtag = ensureNoLeadingHash(target.value);
    return [
      `https://www.tiktok.com/search/video?q=${encodeURIComponent(`#${hashtag}`)}`,
      `https://www.tiktok.com/tag/${encodeURIComponent(hashtag)}`
    ];
  }
  if (target.type === "keyword") {
    return [`https://www.tiktok.com/search/video?q=${encodeURIComponent(target.value)}`];
  }
  return [`https://www.tiktok.com/${ensureLeadingAt(target.value)}`];
}

function compareDiscoveryEntries(left, right) {
  const leftCount = Number.isFinite(Number(left?.commentCount)) ? Number(left.commentCount) : -1;
  const rightCount = Number.isFinite(Number(right?.commentCount)) ? Number(right.commentCount) : -1;
  return rightCount - leftCount;
}

function pickThumbnail(jsonLdItems) {
  for (const item of jsonLdItems) {
    const thumbnail = item?.thumbnailUrl;
    if (Array.isArray(thumbnail) && thumbnail[0]) {
      return thumbnail[0];
    }
    if (typeof thumbnail === "string" && thumbnail) {
      return thumbnail;
    }
  }
  return null;
}

function toIsoFromUnixSeconds(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function toNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function extractTikTokRehydrationData(rawText) {
  if (!rawText) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawText);
    const item =
      parsed?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;

    if (!item) {
      return null;
    }

    const challenges = Array.isArray(item.challenges)
      ? item.challenges
          .map((challenge) => challenge?.title)
          .filter(Boolean)
          .map((title) => String(title).replace(/^#/, "").toLowerCase())
      : [];

    const textExtraTags = Array.isArray(item.textExtra)
      ? item.textExtra
          .map((entry) => entry?.hashtagName)
          .filter(Boolean)
          .map((title) => String(title).replace(/^#/, "").toLowerCase())
      : [];

    const video = item.video ?? {};
    const stats = item.stats ?? item.statsV2 ?? {};
    const author = item.author ?? {};

    return {
      caption: item.desc ?? null,
      coverImageUrl: pickFirstNonEmpty([
        video.cover,
        video.dynamicCover,
        video.originCover,
        Array.isArray(video.shareCover) ? video.shareCover[0] : null,
        Array.isArray(video.cover) ? video.cover[0] : null
      ]),
      authorHandle: author.uniqueId ? ensureLeadingAt(author.uniqueId) : null,
      authorName: author.nickname ?? null,
      authorAvatarUrl: pickFirstNonEmpty([
        author.avatarLarger,
        author.avatarMedium,
        author.avatarThumb
      ]),
      authorSignature: author.signature ?? null,
      publishedAt: toIsoFromUnixSeconds(item.createTime),
      hashtags: [...new Set([...challenges, ...textExtraTags])],
      likeCount: toNumberOrNull(stats.diggCount),
      commentCount: toNumberOrNull(stats.commentCount),
      shareCount: toNumberOrNull(stats.shareCount),
      viewCount: toNumberOrNull(stats.playCount)
    };
  } catch {
    return null;
  }
}

async function collectVideoLinks(page) {
  return page.evaluate(() => {
    const entries = new Map();
    const parseCompactCount = (input) => {
      if (!input) return null;
      const normalized = String(input).trim().replace(/,/g, "").replace(/\s+/g, "").toUpperCase();
      const match = normalized.match(/^(-?\d+(?:\.\d+)?)([KMB])?$/);
      if (!match) return null;
      const value = Number(match[1]);
      const multiplier = { K: 1000, M: 1000000, B: 1000000000 }[match[2] ?? ""] ?? 1;
      return Math.round(value * multiplier);
    };

    const anchors = document.querySelectorAll('a[href*="/video/"]');
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href");
      if (!href) {
        continue;
      }
      try {
        const absolute = new URL(href, window.location.origin).toString();
        const container =
          anchor.closest('[data-e2e="search_top-item"]') ??
          anchor.closest('[data-e2e="challenge-item"]') ??
          anchor.closest('[data-e2e="user-post-item"]') ??
          anchor.closest("div");
        const commentElement =
          container?.querySelector('[data-e2e="video-comment-count"]') ??
          container?.querySelector('[data-e2e="comment-count"]') ??
          container?.querySelector('[data-e2e*="comment"]');
        const commentText =
          commentElement?.textContent?.trim() ??
          container?.innerText
            ?.split(/\n+/)
            .map((line) => line.trim())
            .find((line) => /^\d+(?:\.\d+)?[KMB]?$/i.test(line)) ??
          null;

        entries.set(absolute, {
          postUrl: absolute,
          commentCount: parseCompactCount(commentText)
        });
      } catch {
        continue;
      }
    }
    return [...entries.values()];
  });
}

async function extractTikTokDetail(page) {
  return page.evaluate(() => {
    const readText = (selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const value = element?.textContent?.trim();
        if (value) {
          return value;
        }
      }
      return null;
    };

    const readAttr = (selectors, attribute) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const value = element?.getAttribute(attribute)?.trim();
        if (value) {
          return value;
        }
      }
      return null;
    };

    const metaEntries = {};
    for (const meta of document.querySelectorAll("meta")) {
      const key =
        meta.getAttribute("property") ??
        meta.getAttribute("name") ??
        meta.getAttribute("itemprop");
      if (!key) {
        continue;
      }
      metaEntries[key] = meta.getAttribute("content");
    }

    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((script) => script.textContent)
      .filter(Boolean);

    const universalDataRaw =
      document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent ?? null;

    const countEntries = [...document.querySelectorAll("[data-e2e*='count']")]
      .map((element) => ({
        key: element.getAttribute("data-e2e"),
        value: element.textContent?.trim()
      }))
      .filter((entry) => entry.key && entry.value);

    const hashtags = [...document.querySelectorAll('a[href*="/tag/"]')]
      .map((element) => element.textContent?.trim())
      .filter(Boolean);

    const imageCandidates = [...document.images]
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean);

    const videoPosterCandidates = [...document.querySelectorAll("video")]
      .map((video) => video.getAttribute("poster"))
      .filter(Boolean);

    return {
      url: window.location.href,
      title: document.title,
      caption: readText([
        '[data-e2e="browse-video-desc"]',
        '[data-e2e="video-desc"]',
        'meta[property="og:description"]'
      ]),
      authorHandle: readText([
        '[data-e2e="browse-username"]',
        '[data-e2e="video-author-uniqueid"]'
      ]),
      authorName: readText([
        '[data-e2e="browser-nickname"]',
        '[data-e2e="video-author-nickname"]'
      ]),
      publishedAt: readAttr(["time[datetime]"], "datetime"),
      metaEntries,
      jsonLd,
      universalDataRaw,
      countEntries,
      hashtags,
      imageCandidates,
      videoPosterCandidates
    };
  });
}

async function assertTikTokAccessible(page) {
  const snapshot = await page.evaluate(() => ({
    url: window.location.href,
    text: document.body.innerText.slice(0, 1200)
  }));

  if (
    snapshot.url.includes("/hk/notfound") ||
    snapshot.text.includes("discontinued operating TikTok in Hong Kong")
  ) {
    throw new Error(
      "TikTok is unavailable from the current network region or IP. The page redirected to the Hong Kong notfound page."
    );
  }

  if (snapshot.text.includes("Log in to TikTok")) {
    throw new Error(
      "TikTok returned a login wall before discovery completed. Save a TikTok storage state and retry."
    );
  }
}

export const tiktokCollector = {
  platform: "tiktok",
  authUrl: "https://www.tiktok.com/login",
  async discoverPostUrls(page, target, limit, helpers) {
    const minCommentCount = helpers.globalConfig.minCommentCount ?? 0;
    const discovered = new Map();
    for (const url of buildTikTokDiscoveryUrls(target)) {
      if (discovered.size >= limit) {
        break;
      }

      await page.goto(url, { waitUntil: "domcontentloaded" });
      await dismissCommonOverlays(page);
      await settlePage(page);
      await assertTikTokAccessible(page);

      const seedEntries = await collectVideoLinks(page);
      for (const item of seedEntries) {
        if (item.commentCount === null || Number(item.commentCount || 0) >= minCommentCount) {
          discovered.set(item.postUrl, item);
        }
      }

      await autoScrollForDiscovery(page, {
        maxRounds: target.type === "hashtag" ? 14 : 10,
        delayMs: Math.max(900, helpers.globalConfig.delayMs - 300),
        stopWhenEnough: () => discovered.size >= limit
      });

      const additional = await collectVideoLinks(page);
      for (const item of additional) {
        if (item.commentCount === null || Number(item.commentCount || 0) >= minCommentCount) {
          discovered.set(item.postUrl, item);
        }
      }
    }

    return [...discovered.values()].sort(compareDiscoveryEntries).slice(0, limit);
  },
  async scrapePost(page, postReference, target) {
    const postUrl = typeof postReference === "string" ? postReference : postReference?.postUrl;
    await page.goto(postUrl, { waitUntil: "domcontentloaded" });
    await dismissCommonOverlays(page);
    await settlePage(page);
    await assertTikTokAccessible(page);

    const detail = await extractTikTokDetail(page);
    const rehydrated = extractTikTokRehydrationData(detail.universalDataRaw);
    const jsonLdItems = hydrateJsonLd(detail.jsonLd);
    const countMap = Object.fromEntries(
      detail.countEntries.map((entry) => [entry.key, entry.value])
    );
    const postId = normalizePostUrl(postUrl)?.match(/\/video\/(\d+)/)?.[1] ?? null;
    const caption = pickFirstNonEmpty([
      rehydrated?.caption,
      detail.caption,
      detail.metaEntries.description,
      detail.metaEntries["og:description"],
      jsonLdItems.find((item) => item?.description)?.description
    ]);

    return createStandardRecord("tiktok", target, {
      postId,
      postUrl: normalizePostUrl(postUrl),
      coverImageUrl: pickFirstNonEmpty([
        rehydrated?.coverImageUrl,
        detail.videoPosterCandidates[0],
        detail.imageCandidates[0],
        detail.metaEntries["og:image"],
        detail.metaEntries["twitter:image"],
        pickThumbnail(jsonLdItems)
      ]),
      authorHandle: pickFirstNonEmpty([
        rehydrated?.authorHandle,
        detail.authorHandle,
        detail.metaEntries["og:url"]?.match(/tiktok\.com\/(@[^/?]+)/)?.[1]
      ]),
      authorName: pickFirstNonEmpty([rehydrated?.authorName, detail.authorName]),
      caption,
      hashtags: rehydrated?.hashtags?.length
        ? rehydrated.hashtags
        : detail.hashtags.length
          ? detail.hashtags.map((item) => item.replace(/^#/, "").toLowerCase())
          : extractHashtags(caption),
      publishedAt: pickFirstNonEmpty([
        rehydrated?.publishedAt,
        detail.publishedAt,
        detail.metaEntries["video:release_date"],
        jsonLdItems.find((item) => item?.uploadDate)?.uploadDate
      ]),
      likeCount:
        rehydrated?.likeCount ??
        parseCount(countMap["like-count"]) ??
        resolveInteractionCount(jsonLdItems, "Like"),
      commentCount:
        rehydrated?.commentCount ??
        parseCount(countMap["comment-count"]) ??
        resolveInteractionCount(jsonLdItems, "Comment"),
      shareCount:
        rehydrated?.shareCount ??
        parseCount(countMap["share-count"]) ??
        resolveInteractionCount(jsonLdItems, "Share"),
      viewCount:
        rehydrated?.viewCount ??
        parseCount(countMap["undefined-count"]) ??
        parseCount(countMap["video-view-count"]) ??
        resolveInteractionCount(jsonLdItems, "Watch"),
      rawMeta: {
        title: detail.title,
        metaEntries: detail.metaEntries,
        countEntries: detail.countEntries,
        jsonLdCount: jsonLdItems.length,
        rehydrationAvailable: Boolean(rehydrated),
        authorAvatarUrl: rehydrated?.authorAvatarUrl ?? null,
        authorSignature: rehydrated?.authorSignature ?? null,
        pageImageCandidates: detail.imageCandidates.slice(0, 5),
        videoPosterCandidates: detail.videoPosterCandidates.slice(0, 3)
      }
    });
  }
};
