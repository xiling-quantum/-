function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value, maxLength) {
  if (!value) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trim()}...`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTitleCase(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sanitizeCandidate(value) {
  return normalizeWhitespace(value)
    .replace(/^(?:is|are|was|were)\s+/i, "")
    .replace(/^(?:a|an|the|this|these|my|our)\s+/i, "")
    .trim();
}

const PRODUCT_TERMS = [
  "flip flops",
  "water bottle",
  "phone case",
  "phone charger",
  "portable charger",
  "charging cable",
  "cable organizer",
  "storage bins",
  "storage bin",
  "shoe rack",
  "fabric dresser",
  "dresser",
  "vacuum cleaner",
  "mini vacuum",
  "car vacuum",
  "coffee maker",
  "blender bottle",
  "travel pillow",
  "makeup bag",
  "kitchen gadget",
  "cleaning gadget",
  "cleaning tool",
  "home decor",
  "wall art",
  "desk organizer",
  "drawer organizer",
  "sneakers",
  "sandals",
  "slippers",
  "shoes",
  "bag",
  "tote",
  "lamp",
  "light",
  "mug",
  "tumbler",
  "bottle",
  "organizer",
  "shelf",
  "rack",
  "tray",
  "basket",
  "container",
  "vacuum",
  "mop",
  "cleaner",
  "spray",
  "scrubber",
  "blanket",
  "pillow",
  "chair",
  "desk",
  "mirror",
  "rug",
  "curtain",
  "planner",
  "headphones",
  "earbuds",
  "charger",
  "stand",
  "holder",
  "tripod",
  "accessory",
  "accessories",
  "gadget",
  "gadgets",
  "fan",
  "humidifier",
  "air fryer",
  "knife set",
  "cutting board",
  "pan",
  "cookware",
  "kendama",
  "lip gloss",
  "skincare",
  "serum",
  "beauty essentials",
  "beauty product",
  "beauty products",
  "beauty tool",
  "beauty tools",
  "body care",
  "makeup brush",
  "makeup sponge",
  "hair dryer",
  "curling iron",
  "hair tool",
  "fitness band",
  "resistance band",
  "yoga mat",
  "pet feeder",
  "pet brush",
  "dog toy",
  "cat toy",
  "car organizer",
  "car accessory",
  "car accessories",
  "seat gap filler",
  "dorm room essentials",
  "laundry hamper",
  "portable fan",
  "mini fridge",
  "hat",
  "clothing",
  "clothing line",
  "dress",
  "jacket"
];

const BROAD_PRODUCT_TERMS = [
  "accessory",
  "accessories",
  "gadget",
  "gadgets",
  "home decor",
  "skincare",
  "beauty product",
  "beauty products",
  "beauty tool",
  "beauty tools",
  "body care",
  "clothing",
  "clothing line"
];

const GENERIC_PHRASES = [
  "amazon finds",
  "amazon must haves",
  "found it on amazon",
  "must haves",
  "life hacks",
  "travel must haves",
  "home decor hacks",
  "content creation",
  "viral videos",
  "travel vlog",
  "dance videos"
];

const NOISY_PRODUCT_WORDS = [
  "website",
  "bio",
  "link",
  "links",
  "page",
  "pages",
  "blog",
  "click",
  "product",
  "products",
  "favorite",
  "favorites",
  "find",
  "finds",
  "post",
  "posts",
  "creator",
  "content"
];

const NON_PRODUCT_CANDIDATE_PHRASES = [
  "group chat",
  "five dancers",
  "one silhouette",
  "video by",
  "music by",
  "in the moment"
];

const CATEGORY_HINTS = [
  {
    tags: ["amazongadgets", "kitchengadgets", "kitchen", "kitchenfinds", "kitchenmusthaves", "viralfinds"],
    label: "kitchen or household gadget"
  },
  {
    tags: ["amazonhome", "homedecor", "homedecorhacks", "home", "ltkhome", "homehacks", "homefinds", "homeorganization", "organizationhacks", "homeessentials", "amazonhomefinds"],
    label: "home decor or home organization product"
  },
  {
    tags: ["travelmusthaves", "onthegoessentials", "travel", "travelfinds", "travelessentials", "packinghacks"],
    label: "travel accessory"
  },
  {
    tags: ["amazonfashion", "getstyledwithamazon", "amazonstyle", "amazondripcheck", "shoes", "sandals", "flipflops", "fashion", "fashionfinds", "accessories", "styletips"],
    label: "footwear or fashion accessory"
  },
  {
    tags: ["skincare", "beauty", "makeup", "makeupfinds", "bodycare", "beautyfinds", "beautyhacks", "beautyproducts", "beautytools", "haircare", "selfcare", "glowup", "wellness"],
    label: "beauty product"
  },
  {
    tags: ["cleaning", "cleaninghacks", "organization", "cleaningproducts", "cleaningtips", "cleanwithme"],
    label: "cleaning or organization product"
  },
  {
    tags: ["phoneaccessories", "techfinds", "techgadgets", "gadgets", "digitalproducts", "amazontech", "desksetup"],
    label: "phone or digital accessory"
  },
  {
    tags: ["tiktokshopfinds", "viralproducts", "musthaveproducts", "gadgetfinds"],
    label: "viral consumer product"
  },
  {
    tags: ["fitnessfinds", "homegym", "workoutgear", "gymfinds"],
    label: "fitness accessory"
  },
  {
    tags: ["petfinds", "dogproducts", "catproducts", "petproducts"],
    label: "pet product"
  },
  {
    tags: ["caraccessories", "carfinds", "cartok", "automotiveaccessories"],
    label: "car accessory"
  },
  {
    tags: ["dormroomessentials", "collegefinds", "dormfinds"],
    label: "dorm room essential"
  }
];

const SHOPPING_TAGS = [
  "amazonfinds",
  "amazonmusthaves",
  "founditonamazon",
  "amazonhome",
  "amazongadgets",
  "amazonfavorites",
  "amazonfashion",
  "amazonstyle",
  "amazoninfluencer",
  "kitchengadgets",
  "amazonmusthaves",
  "beautyfinds",
  "beautyproducts",
  "homeorganization",
  "homefinds",
  "homeessential",
  "homeupdates",
  "cleaninghacks",
  "cleaningproducts",
  "travelmusthaves",
  "travelfinds",
  "travelessentials",
  "phoneaccessories",
  "techgadgets",
  "techfinds",
  "amazonhome",
  "amazonhomefinds",
  "selfcare",
  "viralfinds",
  "tiktokshopfinds",
  "viralproducts",
  "musthaveproducts",
  "gadgetfinds",
  "beautytools",
  "makeupfinds",
  "haircare",
  "fitnessfinds",
  "petfinds",
  "caraccessories",
  "dormroomessentials",
  "beautyhacks",
  "beautyproducts",
  "cleanwithme",
  "packinghacks",
  "desksetup",
  "organizationhacks",
  "shop",
  "shopnow",
  "ltk",
  "ltkhome"
];

const SHOPPING_PHRASES = [
  "link in bio",
  "shop my",
  "shop now",
  "shop this",
  "amazon finds",
  "amazon favorites",
  "amazon must haves",
  "found it on amazon",
  "storefront",
  "buy again",
  "must haves",
  "product recommendation",
  "comment",
  "dm",
  "links"
];

const EDITORIAL_PHRASES = [
  "video by",
  "music by",
  "artist",
  "creator",
  "dancing",
  "dance",
  "inspire others",
  "inspiration",
  "photo by",
  "made with",
  "prompt bar",
  "restyle your pics"
];

function splitKeywords(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => normalizeWhitespace(item).toLowerCase())
    .filter(Boolean);
}

function extractCandidatesFromKeywords(record) {
  const keywords = splitKeywords(record.rawMeta?.metaEntries?.keywords);
  return keywords.filter((item) => item.length >= 3);
}

function extractCandidatesFromTitle(title) {
  const normalized = normalizeWhitespace(title);
  if (!normalized) {
    return [];
  }

  return [normalized];
}

function compactToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function extractCandidatesFromCaption(text) {
  const candidates = [];
  const normalized = normalizeWhitespace(text).toLowerCase();

  for (const term of PRODUCT_TERMS.sort((left, right) => right.length - left.length)) {
    const safeTerm = escapeRegExp(term).replace(/\s+/g, "\\s+");
    const regex = new RegExp(
      `\\b(?:[a-z0-9&'/-]+\\s+){0,3}${safeTerm}\\b`,
      "i"
    );
    const match = normalized.match(regex);
    if (match?.[0]) {
      candidates.push(sanitizeCandidate(match[0]));
    }
  }

  const patternMatches = normalized.matchAll(
    /\b(?:these|this|the|my|our|a|an)\s+([a-z][a-z0-9&'/-]*(?:\s+[a-z0-9&'/-]+){0,4}?)(?=\s+(?:is|are|for|with|whose|that|which|who)\b|[.!?,:\n]|$)/gi
  );
  for (const match of patternMatches) {
    candidates.push(sanitizeCandidate(match[1]));
  }

  return candidates;
}

function extractCandidatesFromHashtags(hashtags) {
  const candidates = [];
  const sortedTerms = [...PRODUCT_TERMS].sort((left, right) => right.length - left.length);

  for (const hashtag of hashtags ?? []) {
    const compactHashtag = compactToken(hashtag);
    if (!compactHashtag) {
      continue;
    }

    for (const term of sortedTerms) {
      const compactTerm = compactToken(term);
      if (compactTerm.length < 4) {
        continue;
      }
      if (compactHashtag.includes(compactTerm)) {
        candidates.push(term);
      }
    }
  }

  return unique(candidates);
}

function inferCategoryFromTags(hashtags) {
  const tags = (hashtags ?? []).map((item) => String(item).toLowerCase());
  for (const group of CATEGORY_HINTS) {
    if (group.tags.some((tag) => tags.includes(tag))) {
      return group.label;
    }
  }
  return null;
}

function countKeywordMatches(haystack, patterns) {
  return patterns.reduce((count, pattern) => {
    const safePattern = escapeRegExp(pattern).replace(/\s+/g, "\\s+");
    const regex = new RegExp(`(^|[^a-z0-9])${safePattern}(?=$|[^a-z0-9])`, "gi");
    const matches = haystack.match(regex);
    return count + (matches?.length ?? 0);
  }, 0);
}

function getSignalText(record) {
  return [
    record.title,
    record.caption,
    record.authorHandle,
    record.authorName,
    record.priceText,
    record.sourceBoard,
    record.rawMeta?.metaEntries?.keywords,
    record.rawMeta?.metaEntries?.description,
    ...(record.hashtags ?? [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scoreCandidate(candidate) {
  const lower = candidate.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  let score = 0;

  if (!/[a-z]/.test(lower)) {
    return -100;
  }

  if (words.length >= 2 && words.length <= 5) {
    score += 4;
  } else if (words.length === 1) {
    score += 1;
  } else if (words.length > 6) {
    score -= 3;
  }

  if (PRODUCT_TERMS.some((term) => lower.includes(term))) {
    score += 8;
  }

  if (BROAD_PRODUCT_TERMS.some((term) => lower.includes(term))) {
    score -= 4;
  }

  if (NON_PRODUCT_CANDIDATE_PHRASES.some((phrase) => lower.includes(phrase))) {
    score -= 10;
  }

  if (GENERIC_PHRASES.some((phrase) => lower.includes(phrase))) {
    score -= 5;
  }

  if (NOISY_PRODUCT_WORDS.some((word) => lower.includes(word))) {
    score -= 8;
  }

  if (/\b(link|bio|comment|video|music|creator|content)\b/.test(lower)) {
    score -= 3;
  }

  if (/\b(home|travel|beauty|kitchen|cleaning)\b/.test(lower)) {
    score += 1;
  }

  return score;
}

function hasConcreteProductTerm(value) {
  const lower = String(value ?? "").toLowerCase();
  return PRODUCT_TERMS.some(
    (term) => lower.includes(term) && !BROAD_PRODUCT_TERMS.includes(term)
  );
}

export function inferProductHint(record) {
  if (record.platform === "amazon" && record.title) {
    return normalizeWhitespace(record.title);
  }

  const captionCandidates = extractCandidatesFromCaption(record.caption);
  const keywordCandidates = extractCandidatesFromKeywords(record);
  const titleCandidates = extractCandidatesFromTitle(record.title);
  const hashtagCandidates = extractCandidatesFromHashtags(record.hashtags);
  const candidates = unique([
    ...titleCandidates,
    ...keywordCandidates,
    ...hashtagCandidates,
    ...captionCandidates
  ]);

  let bestCandidate = null;
  let bestScore = -100;

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate && bestScore >= 3 && (hasConcreteProductTerm(bestCandidate) || bestScore >= 7)) {
    return toTitleCase(bestCandidate);
  }

  const categoryHint = inferCategoryFromTags(record.hashtags);
  if (categoryHint) {
    return toTitleCase(categoryHint);
  }

  return "General Consumer Product";
}

export function computeShoppingSignal(record, productHint) {
  if (record.platform === "amazon") {
    return 10;
  }

  const tags = (record.hashtags ?? []).map((item) => String(item).toLowerCase());
  const signalText = getSignalText(record);
  const handleText = `${record.authorHandle ?? ""} ${record.authorName ?? ""}`.toLowerCase();
  let score = 0;

  const shoppingTagMatches = tags.filter((tag) => SHOPPING_TAGS.includes(tag)).length;
  const shoppingPhraseMatches = countKeywordMatches(signalText, SHOPPING_PHRASES);
  const editorialMatches = countKeywordMatches(signalText, EDITORIAL_PHRASES);

  score += shoppingTagMatches * 2;
  score += shoppingPhraseMatches * 2;

  if (/\bcomment\b[^.!?\n]{0,50}\b(link|links|shop|dm)\b/i.test(signalText)) {
    score += 2;
  }

  if (/(amazon|storefront|shop|finds|favorites)/i.test(handleText)) {
    score += 2;
  }

  if (productHint && productHint !== "General Consumer Product") {
    score += 2;
  }

  if (/(beauty|skincare|kitchen|home|gadget|organization|fashion)/i.test(signalText)) {
    score += 1;
  }

  if (editorialMatches && shoppingTagMatches === 0 && shoppingPhraseMatches === 0) {
    score -= editorialMatches * 2;
  }

  return score;
}

export function computeHotScore(record) {
  if (record.platform === "amazon") {
    const boardRank = Number(record.boardRank ?? 999);
    const movementPercent = Number(record.movementPercent ?? 0);
    const boardLabel = String(record.sourceBoard ?? "").toLowerCase();
    const baseScore = boardLabel.includes("movers") ? 2600 : boardLabel.includes("new releases") ? 2200 : 1800;
    const rankScore = Math.max(0, 1400 - Math.max(boardRank, 1) * 14);
    const movementScore = Math.max(0, movementPercent) * 18;
    return Math.round(baseScore + rankScore + movementScore);
  }

  const likes = record.likeCount ?? 0;
  const comments = record.commentCount ?? 0;
  const shares = record.shareCount ?? 0;
  const views = record.viewCount ?? 0;
  let score = likes + comments * 8 + shares * 12 + views * 0.02;

  if (record.publishedAt) {
    const publishedAt = new Date(record.publishedAt);
    if (!Number.isNaN(publishedAt.getTime())) {
      const ageDays = Math.max(0, (Date.now() - publishedAt.getTime()) / 86_400_000);
      if (ageDays <= 7) {
        score *= 1.2;
      } else if (ageDays <= 30) {
        score *= 1.1;
      }
    }
  }

  return Math.round(score);
}

export function computeSalesSignal(record) {
  if (record.platform !== "amazon") {
    return null;
  }

  const ratingCount = Number(record.ratingCount ?? 0);
  const boardRank = Number(record.boardRank ?? 999);
  const movementPercent = Number(record.movementPercent ?? 0);
  const ratingValue = Number(record.ratingValue ?? 0);
  const reviewSignal = Math.min(50, Math.round(Math.log10(Math.max(ratingCount, 1)) * 14));
  const rankSignal = Math.max(0, 35 - Math.min(boardRank, 35)) * 1.2;
  const movementSignal = Math.min(35, Math.max(0, movementPercent) * 0.45);
  const ratingSignal = ratingValue >= 4 ? 12 : ratingValue >= 3.5 ? 7 : ratingValue > 0 ? 3 : 0;
  const score = Math.round(reviewSignal + rankSignal + movementSignal + ratingSignal);

  if (score >= 85) {
    return "Very High";
  }
  if (score >= 60) {
    return "High";
  }
  if (score >= 35) {
    return "Medium";
  }
  if (score > 0) {
    return "Low";
  }
  return "Unknown";
}

function stripCallsToAction(value) {
  const cleanedLines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .filter(
      (line) =>
        !/\b(link in bio|find this on my website|all products are linked|linked on my page|just tap the link|click on my blog|click on product|please note|follow\s+@|comment\b.*\b(link|links|shop|dm)\b|dm\b|message me\b)\b/i.test(
          line
        )
    )
    .map((line) => line.replace(/#[a-z0-9_]+/gi, "").replace(/@[a-z0-9._]+/gi, "").trim())
    .filter(Boolean);

  return cleanedLines
    .join(" ")
    .replace(/\s*([.?!])\s*(?=[.?!])/g, "$1 ")
    .replace(/^[^a-z0-9]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickSummaryBody(record) {
  const caption = stripCallsToAction(record.caption ?? "");
  if (caption && /[a-z]/i.test(caption)) {
    return truncateText(caption, 180);
  }

  const keywords = extractCandidatesFromKeywords(record)
    .filter((item) => !GENERIC_PHRASES.includes(item))
    .slice(0, 3);

  if (keywords.length) {
    return `The post highlights keywords such as ${keywords.join(", ")}.`;
  }

  return "";
}

function withArticle(value) {
  const normalized = value.trim();
  if (!normalized) {
    return "a product";
  }
  const article = /^[aeiou]/i.test(normalized) ? "an" : "a";
  return `${article} ${normalized}`;
}

export function buildEnglishSummary(record, productHint, isLikelyProductPost = true) {
  if (record.platform === "amazon") {
    const fragments = [];
    if (record.sourceBoard && record.boardRank) {
      fragments.push(`Ranked #${record.boardRank} in ${record.sourceBoard}.`);
    } else if (record.sourceBoard) {
      fragments.push(`Listed in ${record.sourceBoard}.`);
    }
    if (record.movementPercent) {
      fragments.push(`Current board movement is up ${record.movementPercent}%.`);
    }
    if (record.priceText) {
      fragments.push(`Visible price: ${record.priceText}.`);
    }

    const body = pickSummaryBody(record);
    if (body) {
      fragments.push(body);
    } else if (record.title) {
      fragments.push(`Product title: ${record.title}.`);
    }

    return truncateText(
      fragments.join(" ") || "Amazon product listing captured for board monitoring.",
      240
    );
  }

  if (!isLikelyProductPost) {
    const body = pickSummaryBody(record);
    if (body) {
      return truncateText(`No clear product is being sold here. ${body}`, 240);
    }
    return "No clear product is being sold here. This looks more like editorial, entertainment, or creator content.";
  }

  const body = pickSummaryBody(record);
  const prefix = `Likely promoting ${withArticle(productHint)}.`;

  if (body) {
    return truncateText(`${prefix} ${body}`, 240);
  }

  return `${prefix} The creator is using this post to drive attention to a product recommendation.`;
}

export function enrichRecord(record) {
  const inferredProductHint = record.productHint ?? inferProductHint(record);
  const shoppingSignalScore =
    record.shoppingSignalScore ?? computeShoppingSignal(record, inferredProductHint);
  const isLikelyProductPost =
    record.isLikelyProductPost ?? (record.platform === "amazon" || shoppingSignalScore >= 4);
  const hotScore = record.hotScore ?? computeHotScore(record);
  const salesSignal = record.salesSignal ?? computeSalesSignal(record);
  const productHint = isLikelyProductPost ? inferredProductHint : "No Clear Product";
  const englishSummary =
    record.englishSummary ??
    buildEnglishSummary(record, productHint, isLikelyProductPost);

  return {
    ...record,
    productHint,
    englishSummary,
    shoppingSignalScore,
    hotScore,
    salesSignal,
    isLikelyProductPost
  };
}
