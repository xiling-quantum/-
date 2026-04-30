export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeDelay(baseMs) {
  const jitter = Math.max(250, Math.round(baseMs * 0.3));
  const min = Math.max(250, baseMs - jitter);
  const max = baseMs + jitter;
  return min + Math.floor(Math.random() * (max - min + 1));
}

export async function waitWithJitter(baseMs) {
  await sleep(computeDelay(baseMs));
}

export async function withRetries(task, options) {
  const {
    retries = 0,
    label = "task",
    logger
  } = options ?? {};

  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      logger?.warn(`${label} failed, retrying`, {
        attempt: attempt + 1,
        retries,
        error: error.message
      });
      await waitWithJitter(1200);
      attempt += 1;
    }
  }

  throw lastError;
}

export function parseCount(input) {
  if (input === null || input === undefined) {
    return null;
  }

  const normalized = String(input)
    .trim()
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .toUpperCase();

  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(-?\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  const multiplier = {
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000
  }[match[2] ?? ""] ?? 1;

  return Math.round(value * multiplier);
}

export function safeJsonParse(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function normalizePostUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    parsed.hash = "";

    const keepSearchParams = new URLSearchParams();
    for (const [key, value] of parsed.searchParams.entries()) {
      if (key.startsWith("lang") || key === "language" || key === "currency") {
        keepSearchParams.set(key, value);
      }
    }
    parsed.search = keepSearchParams.toString();

    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname) {
      pathname = "/";
    }
    parsed.pathname = pathname;

    return parsed.toString();
  } catch {
    return null;
  }
}

export function extractHashtags(text) {
  if (!text) {
    return [];
  }

  const matches = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(matches.map((item) => item.slice(1).toLowerCase()))];
}

export function coerceIsoDate(input) {
  if (!input) {
    return null;
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function pickFirstNonEmpty(values) {
  for (const item of values) {
    if (item === null || item === undefined) {
      continue;
    }
    const normalized = typeof item === "string" ? item.trim() : item;
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function slugifyTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error)
  };
}

export function ensureLeadingAt(value) {
  if (!value) {
    return value;
  }
  return value.startsWith("@") ? value : `@${value}`;
}

export function ensureNoLeadingHash(value) {
  if (!value) {
    return value;
  }
  return value.startsWith("#") ? value.slice(1) : value;
}
