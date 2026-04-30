const PLATFORM_COOKIE_RULES = {
  tiktok: {
    defaultDomain: ".tiktok.com",
    allowedDomainFragments: ["tiktok.com", "tiktokv.com"]
  },
  instagram: {
    defaultDomain: ".instagram.com",
    allowedDomainFragments: ["instagram.com", "facebook.com"]
  }
};

function normalizeSameSite(value) {
  if (!value) {
    return undefined;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["none", "no_restriction", "unspecified"].includes(normalized)) {
    return "None";
  }
  if (normalized === "strict") {
    return "Strict";
  }
  if (normalized === "lax") {
    return "Lax";
  }
  return undefined;
}

function normalizeExpires(value) {
  if (value === null || value === undefined || value === "") {
    return -1;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }

  const parsedDate = Date.parse(String(value));
  if (!Number.isNaN(parsedDate)) {
    return Math.floor(parsedDate / 1000);
  }

  return -1;
}

function getCookieCandidates(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.cookies)) {
      return payload.cookies;
    }
    if (Array.isArray(payload.data)) {
      return payload.data;
    }
    if (Array.isArray(payload.items)) {
      return payload.items;
    }
  }

  throw new Error("Unsupported cookie JSON format");
}

function parseCookieHeaderString(rawText) {
  return rawText
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) {
        return null;
      }
      return {
        name: part.slice(0, separatorIndex).trim(),
        value: part.slice(separatorIndex + 1).trim()
      };
    })
    .filter(Boolean);
}

function isAllowedDomain(domain, platform) {
  const rules = PLATFORM_COOKIE_RULES[platform];
  if (!rules) {
    return true;
  }

  const normalizedDomain = String(domain || "").toLowerCase().replace(/^\./, "");
  return rules.allowedDomainFragments.some((fragment) => normalizedDomain.includes(fragment));
}

export function normalizeImportedCookies(cookies, platform) {
  const rules = PLATFORM_COOKIE_RULES[platform];
  if (!rules) {
    throw new Error(`Unsupported platform "${platform}" for cookie import`);
  }

  const deduped = new Map();

  for (const cookie of cookies) {
    const name = String(cookie?.name ?? cookie?.key ?? "").trim();
    const value = String(cookie?.value ?? "");
    if (!name || !value) {
      continue;
    }

    const domain = String(cookie?.domain || rules.defaultDomain).trim() || rules.defaultDomain;
    if (!isAllowedDomain(domain, platform)) {
      continue;
    }

    const normalized = {
      name,
      value,
      domain,
      path: String(cookie?.path || "/"),
      expires: normalizeExpires(cookie?.expires ?? cookie?.expirationDate ?? cookie?.expiry),
      httpOnly: Boolean(cookie?.httpOnly ?? cookie?.httponly),
      secure: cookie?.secure === undefined ? true : Boolean(cookie.secure)
    };

    const sameSite = normalizeSameSite(cookie?.sameSite ?? cookie?.same_site);
    if (sameSite) {
      normalized.sameSite = sameSite;
    }

    const dedupeKey = `${normalized.name}|${normalized.domain}|${normalized.path}`;
    deduped.set(dedupeKey, normalized);
  }

  return [...deduped.values()];
}

export function buildStorageStateFromCookieText(rawText, platform) {
  const trimmed = String(rawText ?? "").trim();
  if (!trimmed) {
    throw new Error("Cookie input file is empty");
  }

  let cookies;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    cookies = normalizeImportedCookies(getCookieCandidates(parsed), platform);
  } else {
    cookies = normalizeImportedCookies(parseCookieHeaderString(trimmed), platform);
  }

  if (!cookies.length) {
    throw new Error(`No usable ${platform} cookies were found in the input`);
  }

  return {
    cookies,
    origins: []
  };
}
