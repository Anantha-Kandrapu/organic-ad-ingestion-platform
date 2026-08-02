import { readFile } from "node:fs/promises";

const STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "for", "from", "have", "into", "looking",
  "need", "that", "the", "their", "this", "under", "want", "with", "you", "your",
]);

export async function loadProductCatalog(filePath) {
  const contents = await readFile(filePath, "utf8");
  const products = JSON.parse(contents);
  if (!Array.isArray(products)) throw new Error("Product catalog must be a JSON array");

  const seenAsins = new Set();

  return products.map((product, index) => {
    if (!product?.asin || !product?.title || !Number.isFinite(product?.price)) {
      throw new Error(`Invalid product at catalog index ${index}`);
    }
    if (seenAsins.has(product.asin)) throw new Error(`Duplicate product ASIN: ${product.asin}`);
    seenAsins.add(product.asin);
    return Object.freeze(product);
  });
}

export function selectSponsoredProduct(products, request) {
  const intent = request.intent?.trim();
  if (!intent) throw new TypeError("intent is required");

  if (request.rejectedAsins != null && !Array.isArray(request.rejectedAsins)) {
    throw new TypeError("rejectedAsins must be an array");
  }
  if (request.shownAsins != null && !Array.isArray(request.shownAsins)) {
    throw new TypeError("shownAsins must be an array");
  }

  const excludedAsins = new Set([
    ...(request.rejectedAsins || []),
    ...(request.shownAsins || []),
  ]);
  const queryTerms = tokenize(intent);
  const maxPrice = request.maxPrice == null ? Infinity : Number(request.maxPrice);
  if (request.maxPrice != null && (!Number.isFinite(maxPrice) || maxPrice < 0)) {
    throw new TypeError("maxPrice must be a non-negative number");
  }

  const ranked = products
    .filter((product) => product.sponsored === true)
    .filter((product) => product.isAvailable !== false)
    .filter((product) => product.price <= maxPrice)
    .filter((product) => !excludedAsins.has(product.asin))
    .map((product) => scoreProduct(product, queryTerms, intent))
    .filter((candidate) => candidate.intentMatched)
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score
      || (right.product.rating || 0) - (left.product.rating || 0)
      || (right.product.reviewsCount || 0) - (left.product.reviewsCount || 0)
      || left.product.asin.localeCompare(right.product.asin));

  if (ranked.length === 0) return null;
  const { product, score, matchedTerms } = ranked[0];
  return buildSelection(product, score, matchedTerms);
}

export function selectRandomSponsoredProduct(products, excludedAsins = []) {
  const excluded = new Set(excludedAsins);
  let eligible = products
    .filter((product) => product.sponsored === true)
    .filter((product) => product.isAvailable !== false)
    .filter((product) => !excluded.has(product.asin));
  if (eligible.length === 0) {
    eligible = products
      .filter((product) => product.sponsored === true)
      .filter((product) => product.isAvailable !== false);
  }
  if (eligible.length === 0) return null;

  const product = eligible[Math.floor(Math.random() * eligible.length)];
  return buildSelection(product, 0, ["random_inventory"]);
}

export function selectSponsoredProductByAsin(products, asin, reason = "semantic_match") {
  const product = products.find((candidate) => candidate.asin === asin
    && candidate.sponsored === true
    && candidate.isAvailable !== false);
  return product ? buildSelection(product, 0, [reason]) : null;
}

function buildSelection(product, score, matchedTerms) {
  const price = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: product.currency || "USD",
  }).format(product.price);
  const spokenTitle = formatSpokenTitle(product.title, product.brand);

  return {
    type: "ad.selection",
    eligible: true,
    disclosure: "Sponsored",
    product: {
      asin: product.asin,
      title: product.title,
      brand: product.brand || null,
      price: product.price,
      currency: product.currency || "USD",
      availability: product.availability || null,
      rating: product.rating || null,
      imageUrl: product.imageUrl || null,
      productUrl: product.productUrl || null,
    },
    spokenCopy: `Sponsored suggestion from ${product.brand || "our partner"}: ${spokenTitle} is currently ${price}.`,
    breakCopy: `While I fetch your results, sponsored by ${product.brand || "our partner"}. ${product.promoCopy || `See today's offer for ${price}.`}`,
    match: { score, matchedTerms },
  };
}

function scoreProduct(product, queryTerms, intent) {
  const normalizedIntent = normalize(intent);
  const matchedKeywords = (product.adKeywords || [])
    .filter((keyword) => normalizedIntent.includes(normalize(keyword)));
  const fields = [
    [product.title, 5],
    [product.brand, 4],
    [(product.categories || []).join(" "), 3],
    [(product.features || []).join(" "), 2],
    [product.description, 1],
  ];
  const scores = new Map();

  for (const [value, weight] of fields) {
    const productTerms = new Set(tokenize(value || ""));
    for (const term of queryTerms) {
      if (productTerms.has(term)) scores.set(term, (scores.get(term) || 0) + weight);
    }
  }

  return {
    product,
    intentMatched: product.adKeywords?.length ? matchedKeywords.length > 0 : scores.size > 0,
    score: [...scores.values()].reduce((sum, value) => sum + value, 0) + matchedKeywords.length * 12,
    matchedTerms: [...new Set([...matchedKeywords, ...scores.keys()])].sort(),
  };
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(value) {
  return [...new Set(value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term)))];
}

function formatSpokenTitle(title, brand) {
  let value = title.replace(/[|\r\n]+/g, ", ").replace(/\s+/g, " ").trim();
  if (brand && value.toLowerCase().startsWith(brand.toLowerCase())) {
    value = value.slice(brand.length).replace(/^[\s,:-]+/, "");
  }
  if (value.length > 160) value = `${value.slice(0, 157).trimEnd()}...`;
  return value;
}
