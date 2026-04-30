import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  SUPPORTED_PLATFORMS,
  TARGET_TYPES_BY_PLATFORM
} from "./constants.js";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SESSION_MODES = ["storageState", "persistentProfile"];

function mergeConfig(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override ?? base;
  }

  const next = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base?.[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      next[key] = mergeConfig(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function resolveMaybeRelative(baseDir, inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.resolve(baseDir, inputPath);
}

function normalizeTarget(target, defaultLimit) {
  return {
    ...target,
    type: target.type,
    value: String(target.value ?? "").trim(),
    limit: target.limit ? Number(target.limit) : defaultLimit
  };
}

function normalizePersistentProfileConfig(baseDir, persistentProfile) {
  const next = {
    enabled: Boolean(persistentProfile?.enabled),
    userDataDir: persistentProfile?.userDataDir
      ? resolveMaybeRelative(baseDir, persistentProfile.userDataDir)
      : "",
    profileDirectory: persistentProfile?.profileDirectory || "Default",
    channel: persistentProfile?.channel || "chrome"
  };

  return next;
}

export async function loadConfig(configPath) {
  const resolvedConfigPath = resolveMaybeRelative(PROJECT_ROOT, configPath);
  const raw = await fs.readFile(resolvedConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const merged = mergeConfig(DEFAULT_CONFIG, parsed);

  merged.global.outputDir = resolveMaybeRelative(PROJECT_ROOT, merged.global.outputDir);

  for (const platform of SUPPORTED_PLATFORMS) {
    merged[platform].storageState = merged[platform].storageState
      ? resolveMaybeRelative(PROJECT_ROOT, merged[platform].storageState)
      : null;
    merged[platform].sessionMode = merged[platform].sessionMode || "storageState";
    merged[platform].persistentProfile = normalizePersistentProfileConfig(
      PROJECT_ROOT,
      merged[platform].persistentProfile
    );
    merged[platform].targets = (merged[platform].targets ?? []).map((target) =>
      normalizeTarget(target, merged.global.maxPostsPerTarget)
    );
  }

  validateConfig(merged);

  return {
    path: resolvedConfigPath,
    projectRoot: PROJECT_ROOT,
    ...merged
  };
}

export function validateConfig(config) {
  if (!Number.isInteger(config.global.maxPostsPerTarget) || config.global.maxPostsPerTarget <= 0) {
    throw new Error("global.maxPostsPerTarget must be a positive integer");
  }

  if (!Number.isInteger(config.global.maxRecordsPerPlatform) || config.global.maxRecordsPerPlatform <= 0) {
    throw new Error("global.maxRecordsPerPlatform must be a positive integer");
  }

  if (!Number.isInteger(config.global.minCommentCount) || config.global.minCommentCount < 0) {
    throw new Error("global.minCommentCount must be an integer >= 0");
  }

  if (!Number.isInteger(config.global.maxSocialPostAgeDays) || config.global.maxSocialPostAgeDays <= 0) {
    throw new Error("global.maxSocialPostAgeDays must be a positive integer");
  }

  if (!Number.isInteger(config.global.minHotScore) || config.global.minHotScore < 0) {
    throw new Error("global.minHotScore must be an integer >= 0");
  }

  if (!Number.isInteger(config.global.minAmazonSalesCount) || config.global.minAmazonSalesCount < 0) {
    throw new Error("global.minAmazonSalesCount must be an integer >= 0");
  }

  if (!Number.isInteger(config.global.delayMs) || config.global.delayMs < 250) {
    throw new Error("global.delayMs must be an integer >= 250");
  }

  if (!Number.isInteger(config.global.navigationTimeoutMs) || config.global.navigationTimeoutMs < 1000) {
    throw new Error("global.navigationTimeoutMs must be an integer >= 1000");
  }

  if (!Number.isInteger(config.global.retries) || config.global.retries < 0) {
    throw new Error("global.retries must be an integer >= 0");
  }

  for (const platform of SUPPORTED_PLATFORMS) {
    if (typeof config[platform].enabled !== "boolean") {
      throw new Error(`${platform}.enabled must be a boolean`);
    }
    if (!SESSION_MODES.includes(config[platform].sessionMode)) {
      throw new Error(
        `${platform}.sessionMode must be one of: ${SESSION_MODES.join(", ")}`
      );
    }
    if (
      config[platform].sessionMode === "persistentProfile" &&
      !config[platform].persistentProfile.userDataDir
    ) {
      throw new Error(
        `${platform}.persistentProfile.userDataDir is required when sessionMode is persistentProfile`
      );
    }
    for (const target of config[platform].targets) {
      if (!TARGET_TYPES_BY_PLATFORM[platform].includes(target.type)) {
        throw new Error(
          `${platform} target type "${target.type}" is not supported. Supported: ${TARGET_TYPES_BY_PLATFORM[platform].join(", ")}`
        );
      }
      if (!target.value) {
        throw new Error(`${platform} target value cannot be empty`);
      }
      if (!Number.isInteger(target.limit) || target.limit <= 0) {
        throw new Error(`${platform} target limit must be a positive integer`);
      }
    }
  }
}

export function applyRuntimeOverrides(config, cliArgs) {
  const next = structuredClone(config);

  if (typeof cliArgs.headless === "boolean") {
    next.global.headless = cliArgs.headless;
  }

  if (cliArgs.limit) {
    for (const platform of SUPPORTED_PLATFORMS) {
      next[platform].targets = next[platform].targets.map((target) => ({
        ...target,
        limit: cliArgs.limit
      }));
    }
    next.global.maxPostsPerTarget = cliArgs.limit;
  }

  if (typeof cliArgs.minHotScore === "number") {
    next.global.minHotScore = cliArgs.minHotScore;
  }

  if (typeof cliArgs.minAmazonSalesCount === "number") {
    next.global.minAmazonSalesCount = cliArgs.minAmazonSalesCount;
  }

  if (typeof cliArgs.minCommentCount === "number") {
    next.global.minCommentCount = cliArgs.minCommentCount;
  }

  return next;
}

export function getPlatformsToRun(config, requestedPlatform) {
  if (requestedPlatform !== "all") {
    return [requestedPlatform];
  }

  return SUPPORTED_PLATFORMS.filter((platform) => config[platform].enabled);
}

export function getProjectRoot() {
  return PROJECT_ROOT;
}
