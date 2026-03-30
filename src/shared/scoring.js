'use strict';
/**
 * shared/scoring.js
 * The full 12-step deal-scoring pipeline described in the spec.
 * All pure functions – no I/O – so the module is easy to unit-test.
 */

// ---------------------------------------------------------------------------
// Step 1 helpers – known brands and risk keywords
// ---------------------------------------------------------------------------
const KNOWN_BRANDS = [
  'Apple', 'Samsung', 'Sony', 'Microsoft', 'Nintendo', 'LG', 'Bose',
  'Dyson', 'DeWalt', 'Milwaukee', 'Canon', 'Nikon', 'Lego', 'Funko',
  'Rolex', 'Omega', 'Seiko', 'Casio', 'Patagonia', 'North Face',
  'Supreme', 'Jordan', 'Nike', 'Adidas', 'Louis Vuitton', 'Gucci',
  'Coach', 'Tiffany', 'Vitamix', 'KitchenAid', 'Instant Pot', 'Roomba',
  'GoPro', 'DJI', 'Garmin', 'Leatherman', 'Benchmade',
];

// Regex to detect a model number: letters + digits or digits + letters
const MODEL_PATTERN = /\b([A-Z]{1,4}\d{2,}[\w-]*|\d{2,}[A-Z]{1,4}[\w-]*)\b/g;

const RISK_KEYWORDS = [
  'untested', 'for parts', 'as-is', 'as is', 'parts only',
  'not working', 'broken', 'damaged', 'read description',
  'spares or repair',
];

const IGNORANCE_SIGNALS = [
  'old thing', 'stuff', 'misc', 'lot', 'junk', 'bundle',
  'vintage', 'antique', 'unknown', 'found',
];

// ---------------------------------------------------------------------------
// Category-specific outbound shipping estimates (USD)
// ---------------------------------------------------------------------------
const CATEGORY_SHIPPING = {
  electronics:   8.99,
  clothing:      4.99,
  shoes:         6.99,
  collectibles:  6.99,
  books:         3.99,
  toys:          5.99,
  tools:         9.99,
  jewelry:       4.99,
  sports:        7.99,
  health:        5.99,
  default:       6.99,
};

function categoryShipping(category) {
  const key = (category || '').toLowerCase();
  for (const [cat, cost] of Object.entries(CATEGORY_SHIPPING)) {
    if (key.includes(cat)) return cost;
  }
  return CATEGORY_SHIPPING.default;
}

// ---------------------------------------------------------------------------
// Step 2 – Product identification
// ---------------------------------------------------------------------------
/**
 * Extract brand and model number from a listing title.
 * @param {string} title
 * @returns {{ brand: string, model: string }}
 */
function extractBrandModel(title) {
  let brand = '';
  const upper = title.toUpperCase();
  for (const b of KNOWN_BRANDS) {
    if (upper.includes(b.toUpperCase())) {
      brand = b;
      break;
    }
  }

  const models = title.match(MODEL_PATTERN) || [];
  const model = models[0] || '';

  return { brand, model };
}

// ---------------------------------------------------------------------------
// Step 3 – Median comparable price
// ---------------------------------------------------------------------------
/**
 * Calculate the median of a numeric array.
 * Returns 0 for an empty array.
 * @param {number[]} prices
 * @returns {number}
 */
function median(prices) {
  if (!prices || prices.length === 0) return 0;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ---------------------------------------------------------------------------
// Steps 4–6 – Cost, resale value, and raw profit
// ---------------------------------------------------------------------------
const EBAY_FEE_RATE = 0.16;

/**
 * @param {number} listingPrice
 * @param {number} shippingCost   (inbound – cost to buy the item)
 * @param {number} medianCompPrice
 * @param {string} category
 * @returns {{ trueCost, netResaleValue, profit }}
 */
function calculateProfit(listingPrice, shippingCost, medianCompPrice, category) {
  const trueCost = listingPrice + shippingCost;
  const estimatedFees = EBAY_FEE_RATE * medianCompPrice;
  const estimatedOutboundShipping = categoryShipping(category);
  const netResaleValue = medianCompPrice - estimatedFees - estimatedOutboundShipping;
  const profit = netResaleValue - trueCost;
  return { trueCost, netResaleValue, profit };
}

// ---------------------------------------------------------------------------
// Step 7 – Risk adjustment
// ---------------------------------------------------------------------------
/**
 * Returns a risk multiplier in [0.5, 1.0].
 * @param {{ sellerFeedback: number, title: string }} params
 * @returns {number}
 */
function riskMultiplier({ sellerFeedback, title }) {
  let penalty = 0;

  if (sellerFeedback < 10) penalty += 0.3;
  else if (sellerFeedback < 50) penalty += 0.15;

  const lower = (title || '').toLowerCase();
  for (const kw of RISK_KEYWORDS) {
    if (lower.includes(kw)) {
      penalty += 0.1;
      break;         // only apply once even if multiple keywords match
    }
  }

  return Math.max(0.5, 1 - penalty);
}

// ---------------------------------------------------------------------------
// Step 8 – Liquidity / sell-through rate
// ---------------------------------------------------------------------------
/**
 * Estimate a sell-through rate from the number of sold vs listed comps.
 * When only sold prices are available, assume a moderate sell-through of 0.6.
 *
 * @param {number} itemsSold
 * @param {number} itemsListed
 * @returns {number}  Value in [0, 1]
 */
function sellThroughRate(itemsSold, itemsListed) {
  if (!itemsListed || itemsListed === 0) return 0.6;   // default moderate
  return Math.min(1, itemsSold / itemsListed);
}

// ---------------------------------------------------------------------------
// Step 9 – Ignorance signal boost
// ---------------------------------------------------------------------------
/**
 * Boost factor in [0, 1] indicating how likely the seller under-prices.
 * @param {{ title: string, medianCompPrice: number, listingPrice: number, brand: string, model: string }} params
 * @returns {number}
 */
function ignoranceBoost({ title, medianCompPrice, listingPrice, brand, model }) {
  let boost = 0;
  const lower = (title || '').toLowerCase();

  // Vague title
  for (const sig of IGNORANCE_SIGNALS) {
    if (lower.includes(sig)) { boost += 0.2; break; }
  }

  // Missing model number
  if (!model) boost += 0.1;

  // Unusually low price relative to comps (< 60 % of median)
  if (medianCompPrice > 0 && listingPrice < medianCompPrice * 0.6) boost += 0.2;

  // No recognized brand in listing
  if (!brand) boost += 0.1;

  return Math.min(1, boost);
}

// ---------------------------------------------------------------------------
// Step 10 – Deal score (0–100)
// ---------------------------------------------------------------------------
/**
 * Combine all factors into a 0–100 deal score.
 *
 * Formula:
 *   deal_score = (0.4 * normalizedProfit)
 *              + (0.3 * discountVsMarket)
 *              + (0.2 * sellThrough)
 *              - (0.1 * riskPenalty)
 *
 * Each sub-score is normalised to [0, 1] before weighting.
 *
 * @param {object} params
 * @returns {{ dealScore: number, riskScore: number, confidence: number }}
 */
function computeDealScore({
  profit,
  medianCompPrice,
  listingPrice,
  sellThrough,
  riskMult,
  ignoranceBoostValue,
}) {
  // Normalized profit: profit as a fraction of median comp price.
  // A net profit of 30 % or more of the comp price is treated as a perfect 1.0.
  const profitRatio = medianCompPrice > 0 ? profit / medianCompPrice : 0;
  const normalizedProfit = Math.max(0, Math.min(1, profitRatio / 0.3));

  // Discount vs market: how much below median is the listing price (clamp 0–1)
  const discountRatio =
    medianCompPrice > 0
      ? Math.max(0, (medianCompPrice - listingPrice) / medianCompPrice)
      : 0;

  // Risk penalty: 1 - multiplier (so 0 = no risk, 0.5 = max risk)
  const riskPenalty = 1 - riskMult;

  // Raw score in [0, 1]
  let raw =
    0.4 * normalizedProfit +
    0.3 * discountRatio +
    0.2 * sellThrough -
    0.1 * riskPenalty;

  // Apply ignorance boost (up to +10 points)
  raw += 0.1 * ignoranceBoostValue;

  // Scale to 0–100
  const dealScore = Math.max(0, Math.min(100, raw * 100));

  // risk_score is expressed as the penalty percentage (0–100)
  const riskScore = riskPenalty * 100;

  // confidence: higher when we have comps and a known brand/model
  const confidence = medianCompPrice > 0 ? 0.8 : 0.3;

  return { dealScore, riskScore, confidence };
}

// ---------------------------------------------------------------------------
// Master scoring function
// ---------------------------------------------------------------------------
/**
 * Run the full scoring pipeline for a listing.
 *
 * @param {object} listing   Listing message from the queue
 * @param {number[]} soldPrices  Sold prices for comps (from scraper)
 * @param {number}  [itemsSold]    How many of those comps are sold (default: soldPrices.length)
 * @param {number}  [itemsListed]  Total listings found (default: soldPrices.length * 1.2 estimate)
 * @returns {object}  Full analysis result
 */
function scoreListingFull(listing, soldPrices, itemsSold, itemsListed) {
  const {
    title = '',
    price: listingPrice = 0,
    shipping_cost: shippingCost = 0,
    seller_feedback: sellerFeedback = 0,
    category = '',
  } = listing;

  // Step 1 – feature extraction (already provided in the listing object)
  // Step 2 – product identification
  const { brand, model } = extractBrandModel(title);

  // Step 3 – comparable sales
  const medianCompPrice = median(soldPrices);

  // Steps 4–6 – profit
  const { trueCost, netResaleValue, profit } = calculateProfit(
    listingPrice,
    shippingCost,
    medianCompPrice,
    category
  );

  // Step 7 – risk
  const riskMult = riskMultiplier({ sellerFeedback, title });

  // Adjusted profit
  const adjustedProfit = profit * riskMult;

  // Step 8 – liquidity
  const sold = itemsSold !== undefined ? itemsSold : soldPrices.length;
  const listed = itemsListed !== undefined ? itemsListed : Math.ceil(sold * 1.5);
  const sellThrough = sellThroughRate(sold, listed);

  // Step 9 – ignorance signals
  const ignoranceBoostValue = ignoranceBoost({
    title,
    medianCompPrice,
    listingPrice,
    brand,
    model,
  });

  // Step 10 – deal score
  const { dealScore, riskScore, confidence } = computeDealScore({
    profit,
    medianCompPrice,
    listingPrice,
    sellThrough,
    riskMult,
    ignoranceBoostValue,
  });

  return {
    listing_id: listing.listing_id,
    deal_score: Math.round(dealScore * 100) / 100,
    estimated_profit: Math.round(adjustedProfit * 100) / 100,
    risk_score: Math.round(riskScore * 100) / 100,
    sell_through_rate: Math.round(sellThrough * 1000) / 1000,
    confidence: Math.round(confidence * 100) / 100,
    // debug info (not stored)
    _debug: {
      brand,
      model,
      medianCompPrice,
      trueCost,
      netResaleValue,
      profit,
      adjustedProfit,
      riskMult,
      ignoranceBoostValue,
    },
  };
}

module.exports = {
  // exposed for testing
  extractBrandModel,
  median,
  calculateProfit,
  riskMultiplier,
  sellThroughRate,
  ignoranceBoost,
  computeDealScore,
  // main entry point
  scoreListingFull,
  // constants
  CATEGORY_SHIPPING,
};
