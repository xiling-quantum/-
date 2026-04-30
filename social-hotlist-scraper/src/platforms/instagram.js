import {
  createStandardRecord,
  autoScrollForDiscovery,
  dismissCommonOverlays,
  hydrateJsonLd,
  resolveInteractionCount,
  settlePage
} from "../core/scrape-helpers.js";
import {
  ensureNoLeadingHash,
  extractHashtags,
  normalizePostUrl,
  parseCount,
  pickFirstNonEmpty
} from "../core/utils.js";

function buildTargetUrl(target) {
  if (target.type === "hashtag") {
    return `https://www.instagram.com/explore/tags/${encodeURIComponent(ensureNoLeadingHash(target.value))}/`;
  }
  return `https://www.instagram.com/${target.value.replace(/^@/, "")}/`;
}

async function collectPostLinks(page) {
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
    const anchors = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href");
      if (!href) {
        continue;
      }
      try {
        const absolute = new URL(href, window.location.origin).toString();
        const container = anchor.closest("article") ?? anchor.closest("div");
        const ariaLabel =
          anchor.getAttribute("aria-label") ??
          anchor.querySelector("img")?.getAttribute("alt") ??
          container?.getAttribute("aria-label") ??
          "";
        const text = `${ariaLabel}\n${container?.innerText ?? ""}`;
        const commentMatch =
          text.match(/([\d.,KMB]+)\s+comments?/i) ??
          text.match(/comments?\s*[:：]?\s*([\d.,KMB]+)/i);

        entries.set(absolute, {
          postUrl: absolute,
          commentCount: parseCompactCount(commentMatch?.[1] ?? null)
        });
      } catch {
        continue;
      }
    }
    return [...entries.values()];
  });
}

async function extractInstagramDetail(page) {
  return page.evaluate(() => {
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

    const captionCandidates = [
      ...document.querySelectorAll("h1, article ul li span, article h2")
    ]
      .map((element) => element.textContent?.trim())
      .filter(Boolean);

    return {
      url: window.location.href,
      title: document.title,
      metaEntries,
      jsonLd,
      captionCandidates,
      publishedAt: document.querySelector("time[datetime]")?.getAttribute("datetime") ?? null
    };
  });
}

async function assertInstagramAccessible(page) {
  const snapshot = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 1200)
  }));

  if (
    snapshot.title.includes("Login") &&
    snapshot.text.includes("Log in to continue")
  ) {
    throw new Error(
      "Instagram returned a login wall before discovery completed. Save an Instagram storage state and retry."
    );
  }

  if (snapshot.text.includes("Sorry, this page isn't available")) {
    throw new Error("Instagram target page is unavailable or blocked from the current session.");
  }
}

function parseOgDescription(text) {
  if (!text) {
    return {
      likeCount: null,
      commentCount: null,
      caption: null
    };
  }

  const likeMatch = text.match(/([\d.,KMB]+)\s+Likes?/i);
  const commentMatch = text.match(/([\d.,KMB]+)\s+Comments?/i);
  const captionMatch = text.match(/:\s*([\s\S]+)$/);

  return {
    likeCount: parseCount(likeMatch?.[1] ?? null),
    commentCount: parseCount(commentMatch?.[1] ?? null),
    caption: captionMatch?.[1]?.trim() ?? null
  };
}

function cleanInstagramCaption(text) {
  if (!text) {
    return null;
  }

  let cleaned = text.trim();
  if (cleaned.startsWith("\"") && cleaned.endsWith("\".")) {
    cleaned = cleaned.slice(1, -2);
  } else if (cleaned.startsWith("\"") && cleaned.endsWith("\"")) {
    cleaned = cleaned.slice(1, -1);
  }

  return cleaned.trim();
}

function extractHandleFromInstagramUrl(url) {
  if (!url) {
    return null;
  }

  const match = url.match(/instagram\.com\/([^/?#]+)\/(p|reel)\//i);
  return match?.[1] ?? null;
}

export const instagramCollector = {
  platform: "instagram",
  authUrl: "https://www.instagram.com/accounts/login/",
  async discoverPostUrls(page, target, limit, helpers) {
    const url = buildTargetUrl(target);
    const minCommentCount = helpers.globalConfig.minCommentCount ?? 0;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await dismissCommonOverlays(page);
    await settlePage(page);
    await assertInstagramAccessible(page);

    const discovered = new Map();
    const seedEntries = await collectPostLinks(page);
    for (const item of seedEntries) {
      if (item.commentCount === null || Number(item.commentCount || 0) >= minCommentCount) {
        discovered.set(item.postUrl, item);
      }
    }
    await autoScrollForDiscovery(page, {
      maxRounds: 8,
      delayMs: Math.max(900, helpers.globalConfig.delayMs - 300),
      stopWhenEnough: () => discovered.size >= limit
    });

    const additional = await collectPostLinks(page);
    for (const item of additional) {
      if (item.commentCount === null || Number(item.commentCount || 0) >= minCommentCount) {
        discovered.set(item.postUrl, item);
      }
    }

    return [...discovered.values()].slice(0, limit);
  },
  async scrapePost(page, postReference, target) {
    const postUrl = typeof postReference === "string" ? postReference : postReference?.postUrl;
    await page.goto(postUrl, { waitUntil: "domcontentloaded" });
    await dismissCommonOverlays(page);
    await settlePage(page);
    await assertInstagramAccessible(page);

    const detail = await extractInstagramDetail(page);
    const jsonLdItems = hydrateJsonLd(detail.jsonLd);
    const ogParsed = parseOgDescription(detail.metaEntries["og:description"]);
    const authorDisplayName =
      detail.metaEntries["og:title"]?.split(" on Instagram")[0]?.trim() ??
      detail.title?.split(" • Instagram")[0]?.trim() ??
      null;
    const caption = cleanInstagramCaption(
      pickFirstNonEmpty([
        ogParsed.caption,
        detail.captionCandidates[0],
        detail.metaEntries["description"]
      ])
    );
    const canonicalUrl =
      detail.metaEntries["og:url"]?.replace(/\/$/, "") ??
      postUrl;
    const authorHandle = extractHandleFromInstagramUrl(canonicalUrl);

    return createStandardRecord("instagram", target, {
      postId: normalizePostUrl(postUrl)?.match(/\/(p|reel)\/([^/?]+)/)?.[2] ?? null,
      postUrl: normalizePostUrl(canonicalUrl),
      coverImageUrl:
        detail.metaEntries["og:image"] ??
        detail.metaEntries["twitter:image"] ??
        null,
      authorHandle,
      authorName:
        jsonLdItems.find((item) => item?.author?.name)?.author?.name ??
        authorDisplayName ??
        authorHandle,
      caption,
      hashtags: extractHashtags(caption),
      publishedAt: pickFirstNonEmpty([
        detail.publishedAt,
        jsonLdItems.find((item) => item?.dateCreated)?.dateCreated,
        jsonLdItems.find((item) => item?.uploadDate)?.uploadDate
      ]),
      likeCount: ogParsed.likeCount ?? resolveInteractionCount(jsonLdItems, "Like"),
      commentCount: ogParsed.commentCount ?? resolveInteractionCount(jsonLdItems, "Comment"),
      shareCount: null,
      viewCount: resolveInteractionCount(jsonLdItems, "Watch"),
      rawMeta: {
        title: detail.title,
        metaEntries: detail.metaEntries,
        captionCandidates: detail.captionCandidates.slice(0, 5),
        jsonLdCount: jsonLdItems.length
      }
    });
  }
};
