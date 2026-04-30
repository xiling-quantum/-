import path from "node:path";
import { enrichRecord } from "./enrichment.js";
import { normalizePostUrl, serializeError, waitWithJitter, withRetries } from "./utils.js";
import { createLogger } from "./logger.js";

function isSocialPlatform(platform) {
  return platform === "tiktok" || platform === "instagram" || platform === "x";
}

function isFreshSocialRecord(record, globalConfig) {
  if (!record?.publishedAt) {
    return false;
  }

  const publishedTimestamp = new Date(record.publishedAt).getTime();
  if (!Number.isFinite(publishedTimestamp)) {
    return false;
  }

  const ageMs = Date.now() - publishedTimestamp;
  if (ageMs < 0) {
    return true;
  }

  return ageMs <= globalConfig.maxSocialPostAgeDays * 24 * 60 * 60 * 1000;
}

function shouldKeepRecord(platform, record, globalConfig) {
  if (isSocialPlatform(platform)) {
    const commentCount = Number(record.commentCount || 0);
    if (commentCount < globalConfig.minCommentCount) {
      return {
        keep: false,
        reason: "commentCount",
        threshold: globalConfig.minCommentCount,
        actual: commentCount
      };
    }

    const keep = isFreshSocialRecord(record, globalConfig);
    return {
      keep,
      reason: keep ? null : "publishedAt",
      threshold: globalConfig.maxSocialPostAgeDays,
      actual: record.publishedAt || null
    };
  }

  if (platform === "amazon") {
    return {
      keep: Number(record.salesCount || 0) >= globalConfig.minAmazonSalesCount,
      reason: "salesCount",
      threshold: globalConfig.minAmazonSalesCount,
      actual: Number(record.salesCount || 0)
    };
  }

  return {
    keep: true,
    reason: null,
    threshold: null,
    actual: null
  };
}

function getFallbackMetric(platform, record) {
  if (isSocialPlatform(platform)) {
    const commentCount = Number(record.commentCount || 0);
    if (platform !== "instagram") {
      return commentCount;
    }

    const publishedTimestamp = record?.publishedAt ? new Date(record.publishedAt).getTime() : NaN;
    const ageDays = Number.isFinite(publishedTimestamp)
      ? Math.max(0, (Date.now() - publishedTimestamp) / (24 * 60 * 60 * 1000))
      : 3650;
    const recencyPenalty = Math.min(ageDays, 365) * 2;
    return commentCount - recencyPenalty;
  }

  if (platform === "amazon") {
    return Number(record.salesCount || 0);
  }

  return Number(record.hotScore || 0);
}

function allowsBelowThresholdBackfill(platform) {
  return platform === "instagram";
}

export async function runPlatformCollection(options) {
  const {
    collector,
    context,
    globalConfig,
    platformConfig
  } = options;

  const logger = createLogger(collector.platform);
  const maxRecordsForPlatform =
    Number.isInteger(platformConfig.maxRecordsPerPlatform) && platformConfig.maxRecordsPerPlatform > 0
      ? platformConfig.maxRecordsPerPlatform
      : globalConfig.maxRecordsPerPlatform;
  const discoveryPage = context ? await context.newPage() : null;
  const detailPage = context ? await context.newPage() : null;
  const seen = new Set();
  const records = [];
  const fallbackCandidates = [];
  const warnings = [];
  const targets = [];

  if (options.shouldWarnOnMissingLoginState && !options.storageStateLoaded) {
    warnings.push({
      code: "LOGIN_STATE_MISSING",
      message: `${collector.platform} storage state not found, running in public-only mode`
    });
  }

  try {
    for (const target of platformConfig.targets) {
      if (records.length >= maxRecordsForPlatform) {
        break;
      }

      const targetSummary = {
        type: target.type,
        value: target.value,
        requestedLimit: target.limit,
        discovered: 0,
        collected: 0,
        filteredByCommentCount: 0,
        filteredByPublishedAt: 0,
        filteredByHotScore: 0,
        duplicates: 0,
        failedPosts: [],
        targetError: null
      };

      logger.info(`Discovering posts for ${target.type}:${target.value}`);

      try {
        const discoveredEntries = await withRetries(
              async () =>
                collector.discoverPostUrls(discoveryPage, target, target.limit, {
                  globalConfig,
                  platformConfig,
                  logger
                }),
          {
            retries: globalConfig.retries,
            label: `discover:${target.type}:${target.value}`,
            logger
          }
        );

        targetSummary.discovered = discoveredEntries.length;

        for (const discoveredEntry of discoveredEntries) {
          if (records.length >= maxRecordsForPlatform) {
            break;
          }

          const rawUrl =
            typeof discoveredEntry === "string"
              ? discoveredEntry
              : discoveredEntry?.postUrl ?? discoveredEntry?.url ?? null;
          const normalizedUrl = normalizePostUrl(rawUrl);
          if (!normalizedUrl) {
            continue;
          }

          if (seen.has(normalizedUrl)) {
            targetSummary.duplicates += 1;
            continue;
          }

          try {
            const scraped = await withRetries(
              async () =>
                collector.scrapePost(detailPage, discoveredEntry, target, {
                  globalConfig,
                  platformConfig,
                  logger
                }),
              {
                retries: globalConfig.retries,
                label: `scrape:${normalizedUrl}`,
                logger
              }
            );

            const enriched = enrichRecord(scraped);
            const keepDecision = shouldKeepRecord(collector.platform, enriched, globalConfig);
            if (!keepDecision.keep && keepDecision.reason === "commentCount") {
              targetSummary.filteredByCommentCount += 1;
              fallbackCandidates.push({
                metric: getFallbackMetric(collector.platform, enriched),
                record: enriched
              });
              logger.info("Filtered by commentCount threshold", {
                threshold: keepDecision.threshold,
                commentCount: enriched.commentCount,
                postUrl: normalizedUrl
              });
              continue;
            }

            if (!keepDecision.keep && keepDecision.reason === "publishedAt") {
              targetSummary.filteredByPublishedAt += 1;
              if (collector.platform === "instagram") {
                fallbackCandidates.push({
                  metric: getFallbackMetric(collector.platform, enriched),
                  record: enriched
                });
              }
              logger.info("Filtered by social post age window", {
                maxSocialPostAgeDays: keepDecision.threshold,
                publishedAt: keepDecision.actual,
                postUrl: normalizedUrl
              });
              continue;
            }

            if (!keepDecision.keep && keepDecision.reason === "salesCount") {
              targetSummary.filteredByHotScore += 1;
              fallbackCandidates.push({
                metric: getFallbackMetric(collector.platform, enriched),
                record: enriched
              });
              logger.info("Filtered by amazon salesCount threshold", {
                threshold: keepDecision.threshold,
                salesCount: keepDecision.actual,
                postUrl: normalizedUrl
              });
              continue;
            }

            records.push(scraped);
            seen.add(normalizedUrl);
            targetSummary.collected += 1;
          } catch (error) {
            targetSummary.failedPosts.push({
              postUrl: normalizedUrl,
              error: serializeError(error)
            });
          }

          await waitWithJitter(globalConfig.delayMs);
        }
      } catch (error) {
        targetSummary.targetError = serializeError(error);
      }

      targets.push(targetSummary);
    }
  } finally {
    await discoveryPage?.close();
    await detailPage?.close();
  }

  if (records.length < maxRecordsForPlatform && fallbackCandidates.length) {
    if (!allowsBelowThresholdBackfill(collector.platform)) {
      return {
        platform: collector.platform,
        warnings,
        targets,
        records,
        outputFileNames: {
          jsonl: `${collector.platform}.jsonl`,
          csv: `${collector.platform}.csv`
        }
      };
    }

    const needed = maxRecordsForPlatform - records.length;
    const sortedFallbacks = fallbackCandidates
      .sort((left, right) => right.metric - left.metric)
      .map((item) => item.record)
      .filter((record) => record.postUrl && !seen.has(record.postUrl));

    for (const fallbackRecord of sortedFallbacks.slice(0, needed)) {
      records.push(fallbackRecord);
      seen.add(fallbackRecord.postUrl);
    }

    if (sortedFallbacks.length) {
      warnings.push({
        code: "PLATFORM_BACKFILLED",
        message: `${collector.platform} did not meet the platform cap with threshold-qualified records, so the closest available records were backfilled.`
      });
    }
  }

  return {
    platform: collector.platform,
    warnings,
    targets,
    records,
    outputFileNames: {
      jsonl: `${collector.platform}.jsonl`,
      csv: `${collector.platform}.csv`
    }
  };
}

export function buildPlatformOutputPaths(runDir, platform) {
  return {
    jsonl: path.join(runDir, `${platform}.jsonl`),
    csv: path.join(runDir, `${platform}.csv`)
  };
}
