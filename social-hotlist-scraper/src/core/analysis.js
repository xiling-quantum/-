import { enrichRecord } from "./enrichment.js";

const GENERIC_PRODUCT_HINTS = new Set(["no clear product", "general consumer product"]);
const TOKEN_STOPWORDS = new Set([
  "amazon",
  "find",
  "finds",
  "shop",
  "viral",
  "product",
  "products",
  "gadget",
  "gadgets",
  "home",
  "kitchen",
  "tiktok",
  "instagram",
  "video",
  "small",
  "easy",
  "good",
  "best"
]);

function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !TOKEN_STOPWORDS.has(token));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeDisplayName(record) {
  if (record.platform === "amazon" && record.title) {
    return record.title;
  }

  if (record.productHint && !GENERIC_PRODUCT_HINTS.has(record.productHint.toLowerCase())) {
    return record.productHint;
  }

  if (record.title) {
    return record.title;
  }

  if (record.caption) {
    return record.caption;
  }

  return record.authorName || record.authorHandle || "Unknown item";
}

function buildRecordTokens(record) {
  return unique([
    ...tokenize(record.productHint),
    ...tokenize(record.title),
    ...tokenize(record.caption),
    ...tokenize(record.rawMeta?.metaEntries?.keywords)
  ]);
}

function hasMeaningfulProductHint(record) {
  return Boolean(
    record.productHint && !GENERIC_PRODUCT_HINTS.has(String(record.productHint).toLowerCase())
  );
}

function computeTokenOverlap(leftTokens, rightTokens) {
  if (!leftTokens.length || !rightTokens.length) {
    return 0;
  }

  const rightSet = new Set(rightTokens);
  return leftTokens.filter((token) => rightSet.has(token)).length;
}

function isAmazonBoardRecord(record, boardType) {
  return record.platform === "amazon" && record.targetType === boardType;
}

function isCommerceRecord(record) {
  return record.platform === "amazon" || record.platform === "fastmoss";
}

function isRecentRecord(record, maxAgeDays = 60) {
  if (!record.publishedAt) {
    return false;
  }

  const ageMs = Date.now() - new Date(record.publishedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return false;
  }

  return ageMs <= maxAgeDays * 86_400_000;
}

function flattenEvidence(record) {
  return {
    platform: record.platform,
    postUrl: record.postUrl,
    authorHandle: record.authorHandle,
    sourceBoard: record.sourceBoard,
    boardRank: record.boardRank,
    movementPercent: record.movementPercent,
    hotScore: record.hotScore,
    priceText: record.priceText,
    ratingValue: record.ratingValue,
    ratingCount: record.ratingCount,
    salesCount: record.salesCount,
    salesAmount: record.salesAmount,
    creatorCount: record.creatorCount,
    salesSignal: record.salesSignal
  };
}

function parseUnitPrice(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).replace(/,/g, "");
  const matches = [...normalized.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const valid = matches.filter((item) => Number.isFinite(item) && item > 0);
  if (!valid.length) {
    return null;
  }
  return Math.min(...valid);
}

function deriveDisplaySalesAmount(record) {
  const unitPrice = parseUnitPrice(record.priceText);
  const salesCount = Number(record.salesCount || 0);
  if (Number.isFinite(unitPrice) && Number.isFinite(salesCount) && salesCount > 0) {
    return Math.round(unitPrice * salesCount * 100) / 100;
  }
  return Number(record.salesAmount || 0) || null;
}

function computeStableRandomBonus(record, board = "overall") {
  const seed = `${board}|${record.platform}|${record.postUrl || ""}|${record.title || ""}|${record.productHint || ""}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return 20_000 + (hash % 180_001);
}

export function analyzeRecords(records) {
  const enrichedRecords = records.map((record) => enrichRecord(record));
  const amazonRecords = enrichedRecords.filter((record) => record.platform === "amazon");
  const socialRecords = enrichedRecords.filter((record) => !isCommerceRecord(record));
  const socialProductCounts = new Map();

  for (const record of socialRecords) {
    if (!record.isLikelyProductPost) {
      continue;
    }
    const key = normalizeDisplayName(record).toLowerCase();
    socialProductCounts.set(key, (socialProductCounts.get(key) ?? 0) + 1);
  }

  const analyzedRecords = enrichedRecords.map((record) => {
    const displayName = normalizeDisplayName(record);
    const recordTokens = buildRecordTokens(record);
    const matchedAmazonRecords = amazonRecords.filter((amazonRecord) => {
      const amazonTokens = buildRecordTokens(amazonRecord);
      const overlap = computeTokenOverlap(recordTokens, amazonTokens);
      return overlap >= 2 || (overlap >= 1 && recordTokens.some((token) => token.length >= 8 && amazonTokens.includes(token)));
    });
    const matchedAmazonBoards = unique(
      matchedAmazonRecords.map((item) => item.targetType)
    );
    const matchedPlatforms = unique(
      socialRecords
        .filter((item) => normalizeDisplayName(item).toLowerCase() === displayName.toLowerCase())
        .map((item) => item.platform)
    );
    const recurringSocialCount = socialProductCounts.get(displayName.toLowerCase()) ?? 0;

    const socialBase = isCommerceRecord(record) ? 0 : record.hotScore ?? 0;
    const productBonus = record.isLikelyProductPost ? 600 : 0;
    const recurringBonus = recurringSocialCount > 1 ? recurringSocialCount * 180 : 0;
    const crossPlatformBonus = matchedPlatforms.length > 1 ? matchedPlatforms.length * 220 : 0;
    const amazonValidationBonus =
      (matchedAmazonBoards.includes("new-releases") ? 1200 : 0) +
      (matchedAmazonBoards.includes("movers-shakers") ? 1500 : 0);
    const amazonBoardNativeBonus =
      (isAmazonBoardRecord(record, "new-releases") ? 2400 : 0) +
      (isAmazonBoardRecord(record, "movers-shakers") ? 2800 : 0);
    const fastmossBoardNativeBonus =
      (record.platform === "fastmoss" && record.targetType === "saleslist" ? 2600 : 0) +
      (record.platform === "fastmoss" && record.targetType === "new-products" ? 2300 : 0) +
      (record.platform === "fastmoss" && record.targetType === "hotlist" ? 2500 : 0);
    const boardRankBonus = record.boardRank ? Math.max(0, 900 - record.boardRank * 28) : 0;
    const movementBonus = Math.max(0, Number(record.movementPercent ?? 0)) * 14;
    const recencyBonus = isRecentRecord(record, 45) ? 320 : 0;
    const meaningfulHintBonus = hasMeaningfulProductHint(record) ? 180 : 0;
    const overallRandomBonus = computeStableRandomBonus(record, "overall");
    const newRandomBonus = computeStableRandomBonus(record, "new-releases");
    const riseRandomBonus = computeStableRandomBonus(record, "movers-shakers");

    const analysisScore = Math.round(
      (record.hotScore ?? 0) + overallRandomBonus
    );

    const newReleaseScore = Math.round(
      (record.hotScore ?? 0) +
        newRandomBonus +
        ((record.targetType === "new-releases" || record.targetType === "new-products") ? 6000 : 0)
    );

    const moversShakersScore = Math.round(
      (record.hotScore ?? 0) +
        riseRandomBonus +
        ((record.targetType === "movers-shakers" || record.targetType === "hotlist") ? 8000 : 0)
    );

    const displaySalesAmount = deriveDisplaySalesAmount(record);

    return {
      ...record,
      salesAmount: displaySalesAmount,
      displayName,
      analysisScore,
      newReleaseScore,
      moversShakersScore,
      matchedAmazonBoards,
      matchedAmazonTitles: unique(matchedAmazonRecords.map((item) => item.title || item.productHint)).slice(0, 4),
      matchedPlatforms,
      recurringSocialCount,
      analysisEvidence: flattenEvidence(record)
    };
  });

  const overall = analyzedRecords
    .sort(
      (left, right) =>
        right.analysisScore - left.analysisScore ||
        (right.hotScore ?? 0) - (left.hotScore ?? 0)
    )
    .slice(0, 50)
    .map((record, index) => ({
      rank: index + 1,
      board: "overall",
      score: record.analysisScore,
      postUrl: record.postUrl,
      platform: record.platform,
      displayPlatform: record.rawMeta?.sourcePlatform || record.platform,
      displayName: record.displayName,
      productHint: record.productHint,
      authorName: record.authorName,
      authorHandle: record.authorHandle,
      sellerId: record.rawMeta?.rawApiItem?.shop_info?.seller_id ?? null,
      fastmossInfluencerUid: record.rawMeta?.fastmossShopAuthor?.uid ?? null,
      fastmossInfluencerUrl: record.rawMeta?.fastmossShopAuthor?.influencerUrl ?? null,
      tiktokCreatorUrl:
        record.rawMeta?.tiktokCreatorUrl ??
        record.rawMeta?.fastmossShopAuthor?.tiktokUrl ??
        null,
      tiktokCreatorHandle:
        record.rawMeta?.primaryVideo?.author_unique_id ??
        record.rawMeta?.fastmossShopAuthor?.handle ??
        null,
      primaryImageUrl: record.coverImageUrl ?? record.rawMeta?.pageImageCandidates?.[0] ?? null,
      matchedAmazonBoards: record.matchedAmazonBoards,
      matchedAmazonTitles: record.matchedAmazonTitles,
      recurringSocialCount: record.recurringSocialCount,
      hotScore: record.hotScore,
      sourceBoard: record.sourceBoard,
      boardRank: record.boardRank,
      movementPercent: record.movementPercent,
      priceText: record.priceText,
      ratingValue: record.ratingValue,
      ratingCount: record.ratingCount,
      salesCount: record.salesCount,
      salesAmount: record.salesAmount,
      creatorCount: record.creatorCount,
      salesSignal: record.salesSignal,
      summary: record.englishSummary
    }));

  const newReleases = analyzedRecords
    .filter(
      (record) =>
        record.targetType === "new-releases" ||
        record.targetType === "new-products" ||
        record.matchedAmazonBoards.includes("new-releases") ||
        (!isCommerceRecord(record) && record.isLikelyProductPost && isRecentRecord(record, 60))
    )
    .sort((left, right) => right.newReleaseScore - left.newReleaseScore)
    .slice(0, 20)
    .map((record, index) => ({
      rank: index + 1,
      board: "new-releases",
      score: record.newReleaseScore,
      postUrl: record.postUrl,
      platform: record.platform,
      displayPlatform: record.rawMeta?.sourcePlatform || record.platform,
      displayName: record.displayName,
      productHint: record.productHint,
      authorName: record.authorName,
      authorHandle: record.authorHandle,
      sellerId: record.rawMeta?.rawApiItem?.shop_info?.seller_id ?? null,
      fastmossInfluencerUid: record.rawMeta?.fastmossShopAuthor?.uid ?? null,
      fastmossInfluencerUrl: record.rawMeta?.fastmossShopAuthor?.influencerUrl ?? null,
      tiktokCreatorUrl:
        record.rawMeta?.tiktokCreatorUrl ??
        record.rawMeta?.fastmossShopAuthor?.tiktokUrl ??
        null,
      tiktokCreatorHandle:
        record.rawMeta?.primaryVideo?.author_unique_id ??
        record.rawMeta?.fastmossShopAuthor?.handle ??
        null,
      primaryImageUrl: record.coverImageUrl ?? record.rawMeta?.pageImageCandidates?.[0] ?? null,
      matchedAmazonBoards: record.matchedAmazonBoards,
      matchedAmazonTitles: record.matchedAmazonTitles,
      recurringSocialCount: record.recurringSocialCount,
      hotScore: record.hotScore,
      sourceBoard: record.sourceBoard,
      boardRank: record.boardRank,
      movementPercent: record.movementPercent,
      priceText: record.priceText,
      ratingValue: record.ratingValue,
      ratingCount: record.ratingCount,
      salesCount: record.salesCount,
      salesAmount: record.salesAmount,
      creatorCount: record.creatorCount,
      salesSignal: record.salesSignal,
      summary: record.englishSummary
    }));

  const moversShakers = analyzedRecords
    .filter(
      (record) =>
        record.targetType === "movers-shakers" ||
        record.targetType === "hotlist" ||
        record.matchedAmazonBoards.includes("movers-shakers") ||
        (!isCommerceRecord(record) && record.isLikelyProductPost && (record.hotScore ?? 0) >= 100000)
    )
    .sort((left, right) => right.moversShakersScore - left.moversShakersScore)
    .slice(0, 20)
    .map((record, index) => ({
      rank: index + 1,
      board: "movers-shakers",
      score: record.moversShakersScore,
      postUrl: record.postUrl,
      platform: record.platform,
      displayPlatform: record.rawMeta?.sourcePlatform || record.platform,
      displayName: record.displayName,
      productHint: record.productHint,
      authorName: record.authorName,
      authorHandle: record.authorHandle,
      sellerId: record.rawMeta?.rawApiItem?.shop_info?.seller_id ?? null,
      fastmossInfluencerUid: record.rawMeta?.fastmossShopAuthor?.uid ?? null,
      fastmossInfluencerUrl: record.rawMeta?.fastmossShopAuthor?.influencerUrl ?? null,
      tiktokCreatorUrl:
        record.rawMeta?.tiktokCreatorUrl ??
        record.rawMeta?.fastmossShopAuthor?.tiktokUrl ??
        null,
      tiktokCreatorHandle:
        record.rawMeta?.primaryVideo?.author_unique_id ??
        record.rawMeta?.fastmossShopAuthor?.handle ??
        null,
      primaryImageUrl: record.coverImageUrl ?? record.rawMeta?.pageImageCandidates?.[0] ?? null,
      matchedAmazonBoards: record.matchedAmazonBoards,
      matchedAmazonTitles: record.matchedAmazonTitles,
      recurringSocialCount: record.recurringSocialCount,
      hotScore: record.hotScore,
      sourceBoard: record.sourceBoard,
      boardRank: record.boardRank,
      movementPercent: record.movementPercent,
      priceText: record.priceText,
      ratingValue: record.ratingValue,
      ratingCount: record.ratingCount,
      salesCount: record.salesCount,
      salesAmount: record.salesAmount,
      creatorCount: record.creatorCount,
      salesSignal: record.salesSignal,
      summary: record.englishSummary
    }));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      records: analyzedRecords.length,
      productRecords: analyzedRecords.filter((record) => record.isLikelyProductPost).length,
      overall: overall.length,
      newReleases: newReleases.length,
      moversShakers: moversShakers.length
    },
    boards: {
      overall,
      newReleases,
      moversShakers
    },
    analyzedRecords
  };
}

export function flattenLeaderboardsForCsv(leaderboards) {
  return Object.values(leaderboards.boards)
    .flatMap((entries) => entries)
    .map((entry) => ({
      board: entry.board,
      rank: entry.rank,
      score: entry.score,
      platform: entry.platform,
      displayName: entry.displayName,
      productHint: entry.productHint,
      postUrl: entry.postUrl,
      authorHandle: entry.authorHandle,
      hotScore: entry.hotScore,
      sourceBoard: entry.sourceBoard,
      boardRank: entry.boardRank,
      movementPercent: entry.movementPercent,
      priceText: entry.priceText,
      ratingValue: entry.ratingValue,
      ratingCount: entry.ratingCount,
      salesCount: entry.salesCount,
      salesAmount: entry.salesAmount,
      creatorCount: entry.creatorCount,
      salesSignal: entry.salesSignal,
      matchedAmazonBoards: entry.matchedAmazonBoards.join("|"),
      matchedAmazonTitles: entry.matchedAmazonTitles.join(" | "),
      recurringSocialCount: entry.recurringSocialCount,
      summary: entry.summary
    }));
}
