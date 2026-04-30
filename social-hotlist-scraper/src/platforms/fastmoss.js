import {
  createStandardRecord,
  dismissCommonOverlays,
  settlePage
} from "../core/scrape-helpers.js";
import { normalizePostUrl, parseCount, pickFirstNonEmpty } from "../core/utils.js";

const FASTMOSS_ROUTE_BY_TARGET = {
  saleslist: "saleslist",
  "new-products": "newProducts",
  hotlist: "hotlist",
  hotvideo: "hotvideo"
};

function buildTargetUrl(target) {
  const route = FASTMOSS_ROUTE_BY_TARGET[target.type];
  const region = encodeURIComponent(target.value || "US");
  return `https://www.fastmoss.com/zh/e-commerce/${route}?region=${region}`;
}

function buildApiEndpoint(target, limit) {
  const region = encodeURIComponent(target.value || "US");
  const pageSize = Math.max(10, limit);

  if (target.type === "saleslist") {
    return `https://www.fastmoss.com/api/goods/saleRank?page=1&pagesize=${pageSize}&order=1,2&region=${region}`;
  }

  if (target.type === "new-products") {
    return `https://www.fastmoss.com/api/goods/newProduct?rank_type=11&page=1&order=1,2&pagesize=${pageSize}&region=${region}`;
  }

  if (target.type === "hotvideo") {
    return `https://www.fastmoss.com/api/video/hotGoodsVideoGroupByProduct?page=1&pagesize=${pageSize}&order=1,2&rank_type=7&region=${region}`;
  }

  return `https://www.fastmoss.com/api/goods/popRank?page=1&pagesize=${pageSize}&order=4,2&region=${region}`;
}

function toBoardLabel(targetType) {
  if (targetType === "saleslist") {
    return "FastMoss Sales List";
  }
  if (targetType === "new-products") {
    return "FastMoss New Products";
  }
  if (targetType === "hotlist") {
    return "FastMoss Hotlist";
  }
  if (targetType === "hotvideo") {
    return "FastMoss Hot Video Products";
  }
  return "FastMoss";
}

function parseLooseNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value)
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .toUpperCase();

  const compact = parseCount(normalized);
  if (compact !== null) {
    return compact;
  }

  const match = normalized.match(/^(-?\d+(?:\.\d+)?)(W|Y)?$/i);
  if (!match) {
    return null;
  }

  const valueNumber = Number(match[1]);
  const suffix = (match[2] || "").toUpperCase();
  if (suffix === "W") {
    return Math.round(valueNumber * 10_000);
  }
  if (suffix === "Y") {
    return Math.round(valueNumber * 100_000_000);
  }
  return Math.round(valueNumber);
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

function computeFastmossHotScore(item, targetType) {
  const sales = parseLooseNumber(item.salesText) ?? 0;
  const revenue = parseLooseNumber(item.gmvText) ?? 0;
  const creators = parseLooseNumber(item.creatorCountText) ?? 0;
  const growth = parseLooseNumber(item.growthText) ?? 0;
  const boardBoost =
    targetType === "saleslist"
      ? 2600
      : targetType === "new-products"
        ? 2200
        : targetType === "hotvideo"
          ? 2800
          : 2400;

  return Math.round(
    boardBoost + sales * 0.8 + revenue * 0.00002 + creators * 25 + Math.max(0, growth) * 12
  );
}

function decodeHtmlText(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    }
  });

  if (!response.ok) {
    throw new Error(`FastMoss page request failed with status ${response.status}`);
  }

  return response.text();
}

async function fetchFastmossShopAuthor(sellerId) {
  if (!sellerId) {
    return null;
  }

  const shopUrl = `https://www.fastmoss.com/zh/shop-marketing/detail/${encodeURIComponent(sellerId)}`;
  const shopHtml = await fetchText(shopUrl);
  const uid = shopHtml.match(/shop_author[^]{0,500}?uid\\?":\\?"(\d+)/)?.[1];
  const nickname =
    shopHtml.match(/shop_author[^]{0,700}?nickname\\?":\\?"([^"\\]+)/)?.[1] ?? null;

  if (!uid) {
    return null;
  }

  const influencerUrl = `https://www.fastmoss.com/zh/influencer/detail/${encodeURIComponent(uid)}`;
  let handle = null;
  try {
    const influencerHtml = await fetchText(influencerUrl);
    const title = decodeHtmlText(influencerHtml.match(/<title>(.*?)<\/title>/)?.[1]);
    handle = title.match(/@([A-Za-z0-9._]+)/)?.[1] ?? null;
  } catch {
    // The FastMoss influencer page is an optional convenience link; keep the shop row if it fails.
  }

  return {
    uid,
    nickname: nickname ? decodeHtmlText(nickname.replace(/\\u0026/g, "&")) : null,
    handle,
    influencerUrl,
    tiktokUrl: handle ? `https://www.tiktok.com/@${handle}` : null
  };
}

function flattenJsonPayload(input, items = []) {
  if (Array.isArray(input)) {
    if (
      input.length &&
      input.every((row) => row && typeof row === "object") &&
      input.some((row) =>
        [
          "product_title",
          "title",
          "productName",
          "goods_title",
          "gmv",
          "sales",
          "sales_num",
          "product_id"
        ].some((key) => key in row)
      )
    ) {
      items.push(input);
    }
    for (const value of input) {
      flattenJsonPayload(value, items);
    }
    return items;
  }

  if (input && typeof input === "object") {
    for (const value of Object.values(input)) {
      flattenJsonPayload(value, items);
    }
  }

  return items;
}

export function extractFastmossApiItems(payload, targetType = "saleslist") {
  const arrays = flattenJsonPayload(payload);
  const candidates = arrays
    .flat()
    .map((item, index) => {
      const looksLikeRankedProduct =
        item &&
        typeof item === "object" &&
        ("product_id" in item || "detail_url" in item) &&
        ("title" in item || "product_title" in item) &&
        ("sold_count" in item ||
          "sale_amount" in item ||
          "sold_amount" in item ||
          "author_count" in item ||
          "video_count" in item);

      if (!looksLikeRankedProduct) {
        return null;
      }

      const primaryVideo = Array.isArray(item.video_list) ? item.video_list[0] ?? null : null;
      const authorUniqueId = primaryVideo?.author_unique_id ?? null;
      const videoUrl =
        primaryVideo?.video_id && authorUniqueId
          ? `https://www.tiktok.com/@${authorUniqueId}/video/${primaryVideo.video_id}`
          : null;

      const title = pickFirstNonEmpty([
        item.product_title,
        item.goods_title,
        item.productName,
        item.product_name,
        item.title,
        item.name
      ]);
      if (!title) {
        return null;
      }

      return {
        postId: pickFirstNonEmpty([item.product_id, item.id, item.item_id, `${targetType}-${index}`]),
        postUrl: normalizePostUrl(
          pickFirstNonEmpty([
            videoUrl,
            item.detail_url,
            item.product_url,
            item.goods_url,
            item.url,
            item.share_url,
            item.product_id
              ? `https://shop.tiktok.com/view/product/${item.product_id}?region=${item.region || "US"}`
              : null
          ])
        ),
        title,
        coverImageUrl: pickFirstNonEmpty([
          primaryVideo?.cover,
          item.cover,
          item.product_image,
          item.goods_image,
          item.image
        ]),
        authorName: pickFirstNonEmpty([
          item.shop_info?.name,
          item.shop_info?.shop_name,
          item.shop_name,
          item.store_name,
          item.author_name
        ]),
        priceText: pickFirstNonEmpty([item.real_price, item.price, item.price_text, item.sale_price]),
        salesText: pickFirstNonEmpty([
          item.sold_count_show,
          item.sold_count,
          item.sales,
          item.sales_num,
          item.sale_count
        ]),
        growthText: pickFirstNonEmpty([
          item.sold_count_inc_rate,
          item.sales_change,
          item.sales_growth,
          item.growth_rate
        ]),
        gmvText: pickFirstNonEmpty([
          item.sold_amount_show,
          item.sold_amount,
          item.sale_amount,
          item.total_sale_amount,
          item.gmv,
          item.revenue
        ]),
        creatorCountText: pickFirstNonEmpty([
          item.video_count_show,
          item.video_count,
          item.author_count,
          item.total_author_count,
          item.creator_count,
          item.influencer_count
        ]),
        likeCountText: pickFirstNonEmpty([item.digg_count_show, item.digg_count]),
        commentCountText: pickFirstNonEmpty([item.comment_count_show, item.comment_count]),
        shareCountText: pickFirstNonEmpty([item.share_count_show, item.share_count]),
        playCountText: pickFirstNonEmpty([item.play_count_show, item.play_count]),
        boardRank: index + 1,
        authorHandle: authorUniqueId ? `@${authorUniqueId}` : null,
        authorDisplayName: primaryVideo?.author_nickname ?? null,
        primaryVideo,
        rawApiItem: item
      };
    })
    .filter(Boolean);

  const unique = new Map();
  for (const item of candidates) {
    unique.set(item.postUrl || `${item.postId}-${item.title}`, item);
  }
  return [...unique.values()];
}

async function assertFastmossAccessible(page) {
  const snapshot = await page.evaluate(() => ({
    title: document.title,
    text: document.body.innerText.slice(0, 2000)
  }));

  if (/请求已被拦截|安全策略拦截|EdgeOne|Request blocked/i.test(snapshot.title + snapshot.text)) {
    throw new Error("FastMoss blocked the automated request with its WAF. Try a signed-in persistent browser profile.");
  }
}

async function collectFastmossDomRows(page) {
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

    const rows = [...document.querySelectorAll("tbody tr")];
    return rows
      .map((row, index) => {
        const cells = [...row.querySelectorAll("td")].map((cell) => normalize(cell.textContent));
        const image = row.querySelector("img");
        const links = [...row.querySelectorAll("a[href]")].map((anchor) => toAbsolute(anchor.getAttribute("href")));
        const title = cells.find((cell) => cell.length > 8) || null;

        return {
          postId: `fastmoss-row-${index + 1}`,
          postUrl: links.find(Boolean),
          title,
          coverImageUrl: image?.getAttribute("src") ?? null,
          priceText: cells.find((cell) => /[$€£¥Rp฿₫]/.test(cell)) || null,
          salesText: cells[5] || null,
          growthText: cells.find((cell) => /%/.test(cell)) || null,
          gmvText: cells.find((cell) => /[$€£¥Rp฿₫]/.test(cell)) || null,
          creatorCountText: cells.find((cell) => /\d+/.test(cell)) || null,
          authorName: null,
          rawDomCells: cells
        };
      })
      .filter((item) => item.title);
  });
}

async function fetchFastmossApiPayload(page, target, limit) {
  const endpoint = buildApiEndpoint(target, limit);
  return page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*"
      }
    });
    if (!response.ok) {
      throw new Error(`FastMoss API request failed with status ${response.status}`);
    }
    return response.json();
  }, endpoint);
}

export const fastmossCollector = {
  platform: "fastmoss",
  authUrl: "https://www.fastmoss.com/zh/e-commerce/saleslist?region=US",
  async discoverPostUrls(page, target, limit, { logger } = {}) {
    const url = buildTargetUrl(target);
    const apiResponses = [];
    const onResponse = async (response) => {
      try {
        const request = response.request();
        if (!["xhr", "fetch"].includes(request.resourceType())) {
          return;
        }

        const headers = response.headers();
        if (!String(headers["content-type"] || "").includes("application/json")) {
          return;
        }

        const payload = await response.json();
        apiResponses.push({
          url: response.url(),
          payload
        });
      } catch {
        // ignore
      }
    };

    page.on("response", onResponse);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await dismissCommonOverlays(page);
      await settlePage(page);
      await page.waitForTimeout(4000);
      await assertFastmossAccessible(page);

      const apiItems = apiResponses.flatMap((entry) => extractFastmossApiItems(entry.payload, target.type));
      if (apiItems.length) {
        logger?.info(`FastMoss API data captured for ${target.type}:${target.value}`, {
          responses: apiResponses.length,
          items: apiItems.length
        });
        return apiItems.slice(0, limit);
      }

      const fetchedPayload = await fetchFastmossApiPayload(page, target, limit).catch(() => null);
      const fetchedItems = fetchedPayload ? extractFastmossApiItems(fetchedPayload, target.type) : [];
      if (fetchedItems.length) {
        logger?.info(`FastMoss API fetch fallback used for ${target.type}:${target.value}`, {
          items: fetchedItems.length
        });
        return fetchedItems.slice(0, limit);
      }

      const domItems = await collectFastmossDomRows(page);
      if (domItems.length) {
        logger?.info(`FastMoss DOM fallback used for ${target.type}:${target.value}`, {
          items: domItems.length
        });
      }
      return domItems.slice(0, limit);
    } finally {
      page.off("response", onResponse);
    }
  },
  async scrapePost(page, postReference, target) {
    const seed = typeof postReference === "string" ? { postUrl: postReference } : postReference;
    const sellerId = seed.rawApiItem?.shop_info?.seller_id ?? null;
    const shopAuthor =
      target.type === "hotvideo"
        ? null
        : await fetchFastmossShopAuthor(sellerId).catch(() => null);
    const hotScore = computeFastmossHotScore(seed, target.type);
    const salesCount = parseLooseNumber(seed.salesText);
    const unitPrice = parseUnitPrice(seed.priceText);
    const salesAmount =
      Number.isFinite(Number(salesCount)) && Number.isFinite(Number(unitPrice))
        ? Math.round(Number(salesCount) * Number(unitPrice) * 100) / 100
        : parseLooseNumber(seed.gmvText);
    const creatorCount = parseLooseNumber(seed.creatorCountText);

    return createStandardRecord("fastmoss", target, {
      postId: seed.postId ?? null,
      postUrl: normalizePostUrl(seed.postUrl || buildTargetUrl(target)),
      title: seed.title ?? null,
      coverImageUrl: seed.coverImageUrl ?? null,
      authorHandle: seed.authorHandle ?? null,
      authorName: seed.authorName ?? null,
      productHint: seed.title ?? null,
      caption: pickFirstNonEmpty([seed.primaryVideo?.video_desc, seed.title]) ?? null,
      hashtags: [],
      publishedAt: null,
      sourceBoard: toBoardLabel(target.type),
      boardRank: seed.boardRank ?? null,
      movementPercent: parseLooseNumber(seed.growthText),
      priceText: seed.priceText ?? null,
      ratingValue: null,
      ratingCount: creatorCount,
      salesCount,
      salesAmount,
      creatorCount,
      salesSignal: "High",
      likeCount: parseLooseNumber(seed.likeCountText),
      commentCount: parseLooseNumber(seed.commentCountText),
      shareCount: parseLooseNumber(seed.shareCountText),
      viewCount: parseLooseNumber(seed.playCountText),
      shoppingSignalScore: 10,
      hotScore,
      isLikelyProductPost: true,
      rawMeta: {
        sourcePlatform: target.type === "hotvideo" ? "tiktok" : "fastmoss",
        salesText: seed.salesText ?? null,
        growthText: seed.growthText ?? null,
        gmvText: seed.gmvText ?? null,
        derivedUnitPrice: unitPrice,
        creatorCountText: seed.creatorCountText ?? null,
        productDetailUrl: seed.rawApiItem?.detail_url ?? null,
        regionName: seed.rawApiItem?.region_name ?? null,
        categoryName: seed.rawApiItem?.category_name ?? null,
        primaryVideo: seed.primaryVideo ?? null,
        tiktokCreatorUrl: seed.primaryVideo?.author_unique_id
          ? `https://www.tiktok.com/@${seed.primaryVideo.author_unique_id}`
          : null,
        fastmossShopAuthor: shopAuthor,
        rawApiItem: seed.rawApiItem ?? null,
        rawDomCells: seed.rawDomCells ?? null
      }
    });
  }
};
