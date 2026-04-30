import {
  coerceIsoDate,
  extractHashtags,
  parseCount,
  pickFirstNonEmpty,
  safeJsonParse
} from "./utils.js";
import { enrichRecord } from "./enrichment.js";

export async function settlePage(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);
}

export async function dismissCommonOverlays(page) {
  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("Allow all cookies")',
    'button:has-text("Not now")'
  ];

  for (const selector of selectors) {
    const element = page.locator(selector).first();
    if (await element.isVisible().catch(() => false)) {
      await element.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

export async function autoScrollForDiscovery(page, options = {}) {
  const {
    maxRounds = 8,
    delayMs = 1200,
    stopWhenEnough
  } = options;

  for (let round = 0; round < maxRounds; round += 1) {
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(delayMs);
    if (stopWhenEnough?.()) {
      break;
    }
  }
}

export function hydrateJsonLd(rawItems) {
  return rawItems
    .map((item) => safeJsonParse(item))
    .flatMap((item) => {
      if (!item) {
        return [];
      }
      if (Array.isArray(item)) {
        return item;
      }
      if (Array.isArray(item["@graph"])) {
        return item["@graph"];
      }
      return [item];
    });
}

export function resolveInteractionCount(jsonLdItems, interactionName) {
  for (const item of jsonLdItems) {
    const stats = Array.isArray(item?.interactionStatistic)
      ? item.interactionStatistic
      : item?.interactionStatistic
        ? [item.interactionStatistic]
        : [];

    for (const stat of stats) {
      const statType = stat?.interactionType?.name ?? stat?.interactionType?.["@type"];
      if (!statType) {
        continue;
      }
      if (String(statType).toLowerCase().includes(interactionName.toLowerCase())) {
        const parsed = parseCount(stat.userInteractionCount);
        if (parsed !== null) {
          return parsed;
        }
      }
    }
  }
  return null;
}

export function createStandardRecord(platform, target, detail) {
  const caption = pickFirstNonEmpty([detail.caption, detail.description]);
  return enrichRecord({
    platform,
    targetType: target.type,
    targetValue: target.value,
    postId: detail.postId ?? null,
    postUrl: detail.postUrl ?? null,
    title: detail.title ?? null,
    coverImageUrl: detail.coverImageUrl ?? null,
    authorHandle: detail.authorHandle ?? null,
    authorName: detail.authorName ?? null,
    sourceBoard: detail.sourceBoard ?? null,
    boardRank: detail.boardRank ?? null,
    movementPercent: detail.movementPercent ?? null,
    priceText: detail.priceText ?? null,
    ratingValue: detail.ratingValue ?? null,
    ratingCount: detail.ratingCount ?? null,
    salesCount: detail.salesCount ?? null,
    salesAmount: detail.salesAmount ?? null,
    creatorCount: detail.creatorCount ?? null,
    salesSignal: detail.salesSignal ?? null,
    caption: caption ?? null,
    hashtags: detail.hashtags?.length ? detail.hashtags : extractHashtags(caption),
    publishedAt: coerceIsoDate(detail.publishedAt),
    likeCount: detail.likeCount ?? null,
    commentCount: detail.commentCount ?? null,
    shareCount: detail.shareCount ?? null,
    viewCount: detail.viewCount ?? null,
    collectedAt: new Date().toISOString(),
    rawMeta: detail.rawMeta ?? {},
    productHint: detail.productHint ?? null,
    englishSummary: detail.englishSummary ?? null,
    shoppingSignalScore: detail.shoppingSignalScore ?? null,
    hotScore: detail.hotScore ?? null,
    isLikelyProductPost: detail.isLikelyProductPost ?? null
  });
}
