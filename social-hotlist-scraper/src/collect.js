import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs, printCollectHelp } from "./core/args.js";
import { analyzeRecords, flattenLeaderboardsForCsv } from "./core/analysis.js";
import { createBrowserSession } from "./core/browser.js";
import { applyRuntimeOverrides, getPlatformsToRun, loadConfig } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import {
  buildPlatformOutputPaths,
  runPlatformCollection
} from "./core/platform-runner.js";
import {
  createRunDirectory,
  syncLatestOutput,
  writeCsv,
  writeJsonl,
  writeObjectsCsv,
  writeRunSummary
} from "./core/output.js";
import { writeHtmlReport } from "./core/report.js";
import { buildStaticSite } from "./core/site-builder.js";
import { amazonCollector } from "./platforms/amazon.js";
import { fastmossCollector } from "./platforms/fastmoss.js";
import { instagramCollector } from "./platforms/instagram.js";
import { tiktokCollector } from "./platforms/tiktok.js";
import { xCollector } from "./platforms/x.js";

function getBackfillMetric(platform, record) {
  if (platform === "tiktok" || platform === "instagram" || platform === "x") {
    return Number(record.commentCount || 0);
  }

  if (platform === "amazon") {
    return Number(record.salesCount || 0);
  }

  return Number(record.hotScore || 0);
}

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

  return ageMs <= Number(globalConfig.maxSocialPostAgeDays || 0) * 24 * 60 * 60 * 1000;
}

function meetsPrimaryThreshold(platform, record, globalConfig) {
  if (isSocialPlatform(platform)) {
    return (
      Number(record.commentCount || 0) >= Number(globalConfig.minCommentCount || 0) &&
      isFreshSocialRecord(record, globalConfig)
    );
  }

  if (platform === "amazon") {
    return Number(record.salesCount || 0) >= Number(globalConfig.minAmazonSalesCount || 0);
  }

  return true;
}

function allowsBelowThresholdBackfill(platform) {
  return platform === "instagram";
}

function getMaxRecordsForPlatform(config, platform) {
  const platformLimit = config[platform]?.maxRecordsPerPlatform;
  return Number.isInteger(platformLimit) && platformLimit > 0
    ? platformLimit
    : config.global.maxRecordsPerPlatform;
}

async function loadHistoricalPlatformBackfill({
  runDir,
  outputDir,
  platform,
  existingRecords,
  globalConfig,
  maxRecordsPerPlatform
}) {
  if (existingRecords.length >= maxRecordsPerPlatform) {
    return [];
  }

  const seen = new Set(existingRecords.map((record) => record.postUrl).filter(Boolean));
  const runsRoot = path.resolve(outputDir);
  let runEntries = [];

  try {
    runEntries = await fs.readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidateRuns = [];
  for (const entry of runEntries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(runsRoot, entry.name);
    if (path.resolve(fullPath) === path.resolve(runDir)) continue;
    try {
      const stat = await fs.stat(fullPath);
      candidateRuns.push({ fullPath, mtimeMs: stat.mtimeMs });
    } catch {
      // ignore unreadable run directories
    }
  }

  candidateRuns.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const pool = [];
  for (const run of candidateRuns) {
    const jsonlPath = path.join(run.fullPath, `${platform}.jsonl`);
    let content;
    try {
      content = await fs.readFile(jsonlPath, "utf8");
    } catch {
      continue;
    }

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const normalizedUrl = record.postUrl;
        if (!normalizedUrl || seen.has(normalizedUrl)) continue;
        pool.push(record);
        seen.add(normalizedUrl);
      } catch {
        // ignore malformed historical rows
      }
    }
  }

  const thresholdQualified = pool
    .filter((record) => meetsPrimaryThreshold(platform, record, globalConfig))
    .sort((left, right) => getBackfillMetric(platform, right) - getBackfillMetric(platform, left));

  if (!allowsBelowThresholdBackfill(platform)) {
    const needed = maxRecordsPerPlatform - existingRecords.length;
    return thresholdQualified.slice(0, needed);
  }

  const nearestAvailable = pool
    .filter((record) => !thresholdQualified.some((item) => item.postUrl === record.postUrl))
    .sort((left, right) => getBackfillMetric(platform, right) - getBackfillMetric(platform, left));

  const needed = maxRecordsPerPlatform - existingRecords.length;
  return [...thresholdQualified, ...nearestAvailable].slice(0, needed);
}

const COLLECTORS = {
  tiktok: tiktokCollector,
  instagram: instagramCollector,
  amazon: amazonCollector,
  fastmoss: fastmossCollector,
  x: xCollector
};

export async function runCollect(argv = process.argv.slice(2)) {
  let cliArgs;
  try {
    cliArgs = parseCliArgs(argv);
  } catch (error) {
    console.error(error.message);
    printCollectHelp();
    process.exitCode = 1;
    return null;
  }

  if (cliArgs.help) {
    printCollectHelp();
    return null;
  }

  const rootLogger = createLogger("collect");

  let config;
  try {
    const loaded = await loadConfig(cliArgs.config);
    config = applyRuntimeOverrides(loaded, cliArgs);
  } catch (error) {
    console.error(`Failed to load config: ${error.message}`);
    process.exitCode = 1;
    return null;
  }

  const { runId, runDir } = await createRunDirectory(config.global.outputDir, new Date());
  const summary = {
    runId,
    startedAt: new Date().toISOString(),
    configPath: config.path,
    outputDir: runDir,
    requestedPlatform: cliArgs.platform,
    warnings: [],
    platforms: {}
  };

  const allRecords = [];
  const platformsToRun = getPlatformsToRun(config, cliArgs.platform);

  if (!platformsToRun.length) {
    rootLogger.warn("No enabled platforms to run");
  }

  for (const platform of platformsToRun) {
    const platformConfig = config[platform];
    const collector = COLLECTORS[platform];

    if (!platformConfig.enabled) {
      summary.platforms[platform] = {
        status: "skipped",
        reason: "disabled in config"
      };
      continue;
    }

    if (!platformConfig.targets.length) {
      summary.platforms[platform] = {
        status: "skipped",
        reason: "no targets configured"
      };
      continue;
    }

    rootLogger.info(`Starting platform ${platform}`);

    let session;
    const requiresBrowser = collector.requiresBrowser !== false;
    try {
      if (requiresBrowser) {
        session = await createBrowserSession({
          headless: config.global.headless,
          navigationTimeoutMs: config.global.navigationTimeoutMs,
          storageStatePath: platformConfig.storageState,
          sessionMode: platformConfig.sessionMode,
          persistentProfile: platformConfig.persistentProfile
        });
      }
    } catch (error) {
      summary.platforms[platform] = {
        status: "failed",
        sessionModeUsed: platformConfig.sessionMode,
        error: {
          name: error.name,
          message: error.message
        }
      };
      summary.warnings.push({
        platform,
        message: error.message
      });
      continue;
    }

    try {
      const result = await runPlatformCollection({
        collector,
        context: session?.context ?? null,
        globalConfig: config.global,
        platformConfig,
        storageStateLoaded: session?.storageStateLoaded ?? false,
        shouldWarnOnMissingLoginState:
          requiresBrowser &&
          (Boolean(platformConfig.storageState) || platformConfig.sessionMode === "persistentProfile")
      });

      const maxRecordsForPlatform = getMaxRecordsForPlatform(config, platform);
      if (result.records.length < maxRecordsForPlatform) {
        const historicalBackfill = await loadHistoricalPlatformBackfill({
          runDir,
          outputDir: config.global.outputDir,
          platform,
          existingRecords: result.records,
          globalConfig: config.global,
          maxRecordsPerPlatform: maxRecordsForPlatform
        });

        if (historicalBackfill.length) {
          result.records.push(...historicalBackfill);
          result.warnings.push({
            code: "HISTORICAL_BACKFILLED",
            message: `${platform} was supplemented from previous runs to reach the platform cap with the closest available records.`
          });
        }
      }

      const platformPaths = buildPlatformOutputPaths(runDir, platform);
      await writeJsonl(platformPaths.jsonl, result.records);
      await writeCsv(platformPaths.csv, result.records);

      allRecords.push(...result.records);
      summary.platforms[platform] = {
        status: "completed",
        storageStateLoaded: session?.storageStateLoaded ?? false,
        sessionModeUsed: session?.sessionModeUsed ?? "api",
        warnings: result.warnings,
        targets: result.targets,
        records: result.records.length,
        files: {
          jsonl: path.basename(platformPaths.jsonl),
          csv: path.basename(platformPaths.csv)
        }
      };
    } catch (error) {
      summary.platforms[platform] = {
        status: "failed",
        sessionModeUsed: session?.sessionModeUsed ?? "api",
        error: {
          name: error.name,
          message: error.message
        }
      };
      summary.warnings.push({
        platform,
        message: error.message
      });
    } finally {
      await session?.close();
    }
  }

  const completedPlatforms = new Set(platformsToRun);
  for (const platform of getPlatformsToRun(config, "all")) {
    if (completedPlatforms.has(platform)) {
      continue;
    }

    const platformConfig = config[platform];
    if (!platformConfig?.enabled || !platformConfig.targets?.length) {
      continue;
    }

    const maxRecordsForPlatform = getMaxRecordsForPlatform(config, platform);
    const carriedRecords = await loadHistoricalPlatformBackfill({
      runDir,
      outputDir: config.global.outputDir,
      platform,
      existingRecords: [],
      globalConfig: config.global,
      maxRecordsPerPlatform: maxRecordsForPlatform
    });

    if (!carriedRecords.length) {
      summary.platforms[platform] = {
        status: "carried_forward_empty",
        reason: "no historical records available"
      };
      continue;
    }

    const platformPaths = buildPlatformOutputPaths(runDir, platform);
    await writeJsonl(platformPaths.jsonl, carriedRecords);
    await writeCsv(platformPaths.csv, carriedRecords);
    allRecords.push(...carriedRecords);
    summary.platforms[platform] = {
      status: "carried_forward",
      warnings: [
        {
          code: "CARRIED_FORWARD",
          message: `${platform} was carried forward from historical runs because this collection ran a different platform.`
        }
      ],
      targets: [],
      records: carriedRecords.length,
      files: {
        jsonl: path.basename(platformPaths.jsonl),
        csv: path.basename(platformPaths.csv)
      }
    };
  }

  await writeCsv(path.join(runDir, "combined.csv"), allRecords);
  const leaderboards = analyzeRecords(allRecords);
  await writeRunSummary(path.join(runDir, "leaderboards.json"), leaderboards);
  await writeObjectsCsv(
    path.join(runDir, "leaderboards.csv"),
    flattenLeaderboardsForCsv(leaderboards)
  );
  summary.finishedAt = new Date().toISOString();
  summary.totalRecords = allRecords.length;
  summary.files = {
    combinedCsv: "combined.csv",
    leaderboardsJson: "leaderboards.json",
    leaderboardsCsv: "leaderboards.csv",
    runSummary: "run-summary.json",
    reportHtml: "report.html",
    siteEntry: "site/index.html",
    latestDir: "../latest"
  };
  await writeRunSummary(path.join(runDir, "run-summary.json"), summary);
  await writeHtmlReport(path.join(runDir, "report.html"), summary, allRecords, leaderboards);
  const siteBuild = await buildStaticSite({
    outputDir: runDir,
    summary,
    records: allRecords,
    leaderboards
  });
  const latestDir = path.join(path.dirname(path.dirname(runDir)), "latest");
  await syncLatestOutput(runDir, latestDir);

  rootLogger.info("Collection finished", {
    runId,
    totalRecords: allRecords.length,
    outputDir: runDir
  });

  return {
    runId,
    runDir,
    latestDir,
    siteDir: siteBuild.siteDir,
    siteEntryFile: siteBuild.entryFile,
    totalRecords: allRecords.length,
    summary,
    leaderboards
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await runCollect();
}
