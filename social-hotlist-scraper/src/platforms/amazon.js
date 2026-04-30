import {
  createStandardRecord,
  dismissCommonOverlays,
  settlePage
} from "../core/scrape-helpers.js";
import {
  normalizePostUrl,
  parseCount,
  pickFirstNonEmpty
} from "../core/utils.js";

const AMAZON_BOARD_URLS = {
  "new-releases": "https://www.amazon.com/gp/new-releases",
  "movers-shakers": "https://www.amazon.com/gp/movers-and-shakers"
};

function forceAmazonUsdUrl(input) {
  if (!input) {
    return input;
  }

  try {
    const parsed = new URL(input);
    if (!/amazon\.com$/i.test(parsed.hostname)) {
      return input;
    }
    parsed.searchParams.set("language", "en_US");
    parsed.searchParams.set("currency", "USD");
    return parsed.toString();
  } catch {
    return input;
  }
}

function buildTargetUrl(target) {
  if (target.type === "search") {
    return forceAmazonUsdUrl(`https://www.amazon.com/s?k=${encodeURIComponent(target.value)}`);
  }

  if (/^https?:\/\//i.test(target.value)) {
    return forceAmazonUsdUrl(target.value);
  }

  const baseUrl = AMAZON_BOARD_URLS[target.type];
  if (!target.value || target.value === "all") {
    return forceAmazonUsdUrl(baseUrl);
  }

  return forceAmazonUsdUrl(`${baseUrl}/${target.value.replace(/^\/+/, "")}`);
}

function cleanBrand(value) {
  return String(value ?? "")
    .replace(/^\s*Brand:\s*/i, "")
    .replace(/^\s*Visit the\s+/i, "")
    .replace(/\s+Store\s*$/i, "")
    .trim();
}

function extractNumber(value) {
  const digits = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return digits ? Number(digits[0]) : null;
}

function parseAmazonSalesCount(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).replace(/,/g, "").trim();
  const compactMatch = normalized.match(/(\d+(?:\.\d+)?)\s*([KMB])?\+?/i);
  if (!compactMatch) {
    return null;
  }

  const amount = Number(compactMatch[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const multiplier = {
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000
  }[String(compactMatch[2] ?? "").toUpperCase()] ?? 1;

  return Math.round(amount * multiplier);
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

async function assertAmazonAccessible(page) {
  const snapshot = await page.evaluate(() => ({
    title: document.title,
    text: document.body.innerText.slice(0, 1600)
  }));

  if (/Enter the characters you see below|Sorry, we just need to make sure you're not a robot/i.test(snapshot.text)) {
    throw new Error("Amazon presented a bot check page. Retry with a slower run or a signed-in browser profile.");
  }

  if (/Looking for something\?|Page Not Found/i.test(snapshot.title)) {
    throw new Error("Amazon page did not load the requested board or product.");
  }
}

async function collectBoardCards(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();

    const toAbsolute = (value) => {
      if (!value) {
        return null;
      }
      try {
        return new URL(value, window.location.origin).toString();
      } catch {
        return null;
      }
    };

    const toNumber = (value) => {
      const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    };

    const metadataByAsin = new Map();
    const carousels = [...document.querySelectorAll("[data-a-carousel-options]")];
    for (const carousel of carousels) {
      const boardName =
        normalize(
          carousel.closest(".a-section.a-spacing-large")?.querySelector("h2.a-carousel-heading")
            ?.textContent
        ) || null;
      const rawOptions = carousel.getAttribute("data-a-carousel-options");
      if (!rawOptions) {
        continue;
      }
      try {
        const parsed = JSON.parse(rawOptions);
        const idList = parsed?.ajax?.id_list ?? [];
        for (const rawItem of idList) {
          const item = JSON.parse(rawItem);
          metadataByAsin.set(item.id, {
            sourceBoard: boardName,
            boardRank: toNumber(item?.metadataMap?.["render.zg.rank"]),
            movementPercent: toNumber(item?.metadataMap?.["render.zg.bsms.percentageChange"]),
            currentSalesRank: toNumber(item?.metadataMap?.["render.zg.bsms.currentSalesRank"]),
            previousSalesRank: toNumber(
              item?.metadataMap?.["render.zg.bsms.twentyFourHourOldSalesRank"]
            )
          });
        }
      } catch {
        continue;
      }
    }

    const roots = [...document.querySelectorAll("[data-asin]")];
    const seen = new Set();
    const items = [];

    for (const root of roots) {
      const asin = normalize(root.getAttribute("data-asin"));
      if (!asin) {
        continue;
      }

      const productAnchor = [...root.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')]
        .find((anchor) => {
          const href = anchor.getAttribute("href") ?? "";
          return !/product-reviews|customerReviews|slredirect/i.test(href);
        });

      const postUrl = toAbsolute(productAnchor?.getAttribute("href"));
      if (!postUrl || seen.has(asin)) {
        continue;
      }

      const metadata = metadataByAsin.get(asin) ?? {};
      const boardNameFromSection =
        normalize(root.closest(".a-section.a-spacing-large")?.querySelector("h2.a-carousel-heading")?.textContent) ||
        null;

      items.push({
        asin,
        postUrl,
        title:
          normalize(
            root.querySelector(".p13n-sc-truncate, h2 span, .a-size-mini .a-link-normal")?.textContent
          ) || null,
        coverImageUrl:
          root.querySelector("img")?.getAttribute("src") ??
          root.querySelector("img")?.getAttribute("data-src") ??
          null,
        priceText:
          normalize(root.querySelector(".p13n-sc-price, .a-price .a-offscreen, .a-color-price")?.textContent) ||
          null,
        ratingText:
          normalize(
            root.querySelector(".a-icon-alt, [aria-label*='out of 5 stars']")?.textContent ||
              root.querySelector(".a-icon-alt, [aria-label*='out of 5 stars']")?.getAttribute("aria-label")
          ) || null,
        reviewCount:
          normalize(root.querySelector(".a-icon-row .a-size-small, .a-size-small")?.textContent) || null,
        boughtText:
          normalize(
            root.querySelector("[class*='bought'], [aria-label*='bought in past month']")?.textContent
          ) || null,
        sourceBoard: metadata.sourceBoard || boardNameFromSection,
        boardRank: metadata.boardRank ?? null,
        movementPercent: metadata.movementPercent ?? null,
        currentSalesRank: metadata.currentSalesRank ?? null,
        previousSalesRank: metadata.previousSalesRank ?? null
      });

      seen.add(asin);
    }

    return items;
  });
}

async function collectSearchCards(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();

    const toAbsolute = (value) => {
      if (!value) {
        return null;
      }
      try {
        return new URL(value, window.location.origin).toString();
      } catch {
        return null;
      }
    };

    return [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')]
      .map((root) => {
        const asin = normalize(root.getAttribute("data-asin"));
        const heading = root.querySelector("h2");
        const productAnchor = heading?.closest("a") ?? root.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
        return {
          asin,
          postUrl: toAbsolute(productAnchor?.getAttribute("href")),
          title: normalize(heading?.textContent || productAnchor?.textContent) || null,
          coverImageUrl:
            root.querySelector("img.s-image")?.getAttribute("src") ??
            root.querySelector("img")?.getAttribute("src") ??
            null,
          priceText:
            normalize(root.querySelector(".a-price .a-offscreen, .a-color-price")?.textContent) ||
            null,
          ratingText:
            normalize(
              root.querySelector(".a-icon-alt, [aria-label*='out of 5 stars']")?.textContent ||
                root.querySelector(".a-icon-alt, [aria-label*='out of 5 stars']")?.getAttribute("aria-label")
            ) || null,
          reviewCount:
            normalize(root.querySelector("[aria-label$='ratings'] + span, .a-size-small")?.textContent) ||
            null,
          boughtText:
            normalize(
              root.querySelector("[class*='bought'], [aria-label*='bought in past month']")?.textContent
            ) || null,
          sourceBoard: "Amazon Search",
          boardRank: null,
          movementPercent: null,
          currentSalesRank: null,
          previousSalesRank: null
        };
      })
      .filter((item) => item.asin && item.postUrl);
  });
}

async function extractAmazonDetail(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();

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

    const bullets = [...document.querySelectorAll("#feature-bullets li span")]
      .map((node) => normalize(node.textContent))
      .filter(
        (item) =>
          item &&
          !/^make sure this fits/i.test(item) &&
          !/^consider a similar item/i.test(item)
      );

    return {
      url: window.location.href,
      title:
        normalize(document.querySelector("#productTitle")?.textContent) ||
        normalize(metaEntries["og:title"]) ||
        null,
      brand:
        normalize(document.querySelector("#bylineInfo")?.textContent) ||
        normalize(metaEntries["brand"]) ||
        null,
      priceText:
        normalize(
          document.querySelector(
            ".apexPriceToPay .a-offscreen, .a-price .a-offscreen, #price_inside_buybox, #priceblock_ourprice, #priceblock_dealprice"
          )?.textContent
        ) || null,
      mainImage:
        document.querySelector("#landingImage")?.getAttribute("src") ??
        document.querySelector("#imgTagWrapperId img")?.getAttribute("src") ??
        metaEntries["og:image"] ??
        null,
      description:
        normalize(document.querySelector("#productDescription")?.textContent) ||
        normalize(metaEntries["description"]) ||
        null,
      ratingText:
        normalize(
          document.querySelector("#acrPopover")?.getAttribute("title") ||
            document.querySelector("#acrPopover .a-size-base")?.textContent ||
            document.querySelector(".a-icon-alt")?.textContent
        ) || null,
      ratingCountText:
        normalize(
          document.querySelector("#acrCustomerReviewText")?.textContent ||
            document.querySelector('[data-hook="total-review-count"]')?.textContent
        ) || null,
      boughtText:
        normalize(
          document.querySelector("#social-proofing-faceout-title-tk_bought")?.textContent ||
            document.querySelector("#social-proofing-faceout-title_feature_div")?.textContent
        ) || null,
      bullets,
      asin:
        normalize(document.querySelector("#ASIN")?.getAttribute("value")) ||
        normalize(document.querySelector('input[name="ASIN"]')?.getAttribute("value")) ||
        null,
      canonicalUrl:
        document.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
        metaEntries["og:url"] ??
        null,
      metaEntries
    };
  });
}

function buildBoardLabel(target) {
  if (target.type === "new-releases") {
    return "Amazon New Releases";
  }
  if (target.type === "movers-shakers") {
    return "Amazon Movers & Shakers";
  }
  return "Amazon Search";
}

export const amazonCollector = {
  platform: "amazon",
  authUrl: "https://www.amazon.com/",
  async discoverPostUrls(page, target, limit) {
    const url = buildTargetUrl(target);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await dismissCommonOverlays(page);
    await settlePage(page);
    await assertAmazonAccessible(page);

    if (target.type === "search") {
      await page
        .waitForSelector('[data-component-type="s-search-result"][data-asin]', {
          timeout: 10000
        })
        .catch(() => {});
      await page.waitForTimeout(1500);
    }

    const cards =
      target.type === "search" ? await collectSearchCards(page) : await collectBoardCards(page);

    return cards.slice(0, limit);
  },
  async scrapePost(page, postReference, target) {
    const seed = typeof postReference === "string" ? { postUrl: postReference } : postReference;
    const postUrl = seed?.postUrl;

    await page.goto(postUrl, { waitUntil: "domcontentloaded" });
    await dismissCommonOverlays(page);
    await settlePage(page);
    await assertAmazonAccessible(page);

    const detail = await extractAmazonDetail(page);
    const title = pickFirstNonEmpty([detail.title, seed.title]);
    const productCaption = pickFirstNonEmpty([
      detail.bullets.join(" "),
      detail.description,
      title
    ]);
    const canonicalUrl = forceAmazonUsdUrl(
      pickFirstNonEmpty([detail.canonicalUrl, seed.postUrl, postUrl])
    );
    const brand = cleanBrand(detail.brand);
    const priceText = pickFirstNonEmpty([detail.priceText, seed.priceText]);
    const salesCount = pickFirstNonEmpty([
      parseAmazonSalesCount(detail.boughtText),
      parseAmazonSalesCount(seed.boughtText)
    ]);
    const unitPrice = parseUnitPrice(priceText);
    const salesAmount =
      Number.isFinite(Number(salesCount)) && Number.isFinite(Number(unitPrice))
        ? Math.round(Number(salesCount) * Number(unitPrice) * 100) / 100
        : null;

    return createStandardRecord("amazon", target, {
      postId: pickFirstNonEmpty([detail.asin, seed.asin]),
      postUrl: normalizePostUrl(canonicalUrl),
      title,
      coverImageUrl: pickFirstNonEmpty([detail.mainImage, seed.coverImageUrl]),
      authorHandle: null,
      authorName: brand || null,
      productHint: title,
      caption: productCaption,
      hashtags: [],
      publishedAt: null,
      sourceBoard: pickFirstNonEmpty([seed.sourceBoard, buildBoardLabel(target)]),
      boardRank: seed.boardRank ?? null,
      movementPercent: seed.movementPercent ?? null,
      priceText,
      salesCount,
      salesAmount,
      ratingValue: pickFirstNonEmpty([
        extractNumber(detail.ratingText),
        extractNumber(seed.ratingText)
      ]),
      ratingCount: pickFirstNonEmpty([
        parseCount(detail.ratingCountText),
        parseCount(seed.reviewCount)
      ]),
      likeCount: parseCount(seed.reviewCount),
      commentCount: null,
      shareCount: null,
      viewCount: null,
      shoppingSignalScore: 10,
      isLikelyProductPost: true,
      rawMeta: {
        metaEntries: detail.metaEntries,
        bullets: detail.bullets.slice(0, 8),
        ratingText: pickFirstNonEmpty([detail.ratingText, seed.ratingText]),
        ratingCountText: detail.ratingCountText ?? null,
        boughtText: pickFirstNonEmpty([detail.boughtText, seed.boughtText]),
        derivedUnitPrice: unitPrice,
        currentSalesRank: seed.currentSalesRank ?? null,
        previousSalesRank: seed.previousSalesRank ?? null
      }
    });
  }
};
