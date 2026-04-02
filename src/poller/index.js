'use strict';
/**
 * poller/index.js
 * Continuously polls eBay for newly listed items and pushes them to the queue.
 *
 * Configuration (via environment variables):
 *   EBAY_SEARCH_KEYWORD    – comma-separated search terms (default: empty → all categories)
 *                            e.g. "iphone,gpu,macbook pro" cycles round-robin across keywords
 *   POLL_INTERVAL_MIN      – minimum seconds between polls when using HTML scraping (default: 5)
 *   POLL_INTERVAL_MAX      – maximum seconds between polls when using HTML scraping (default: 15)
 *   EBAY_APP_ID            – when set, uses the Browse API and budget-based polling interval
 *   EBAY_DAILY_API_LIMIT   – total daily API call budget shared with the analyzer (default: 5000)
 *   REDIS_HOST / REDIS_PORT
 */

require('dotenv').config();

const { fetchNewListings } = require('../shared/scraper');
const { createQueue, enqueueListings } = require('../shared/queue');
const { incrementApiCounter, canMakeApiCall, DAILY_LIMIT } = require('../shared/rateLimit');

/**
 * Parse EBAY_SEARCH_KEYWORD into an array of trimmed, non-empty keywords.
 * Falls back to [''] (single empty-string keyword) to preserve blank-keyword behaviour.
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseKeywords(raw) {
  const keywords = (raw || '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return keywords.length > 0 ? keywords : [''];
}

const KEYWORDS = parseKeywords(process.env.EBAY_SEARCH_KEYWORD);
const POLL_MIN = Number(process.env.POLL_INTERVAL_MIN) || 5;
const POLL_MAX = Number(process.env.POLL_INTERVAL_MAX) || 15;

// ---------------------------------------------------------------------------
// API budget calculation (only relevant when EBAY_APP_ID is set)
// ---------------------------------------------------------------------------
// 30 % of the daily limit is reserved for Browse API (polling) calls.
// The remaining 70 % is left for Finding API (comps) calls in the analyzer.
const POLLING_BUDGET = Math.floor(DAILY_LIMIT * 0.30);
const COMPS_BUDGET   = DAILY_LIMIT - POLLING_BUDGET;

// Fixed interval between each poll cycle so we stay within the polling budget.
// keywordInterval = how often the same keyword is polled = pollInterval × numKeywords
const POLL_INTERVAL_SEC     = Math.ceil(86400 / POLLING_BUDGET);
const KEYWORD_INTERVAL_SEC  = POLL_INTERVAL_SEC * KEYWORDS.length;

/** Round-robin index into KEYWORDS */
let keywordIndex = 0;

/** IDs seen during the current process lifetime (in-memory deduplication) */
const seenIds = new Set();

/** BullMQ queue – created lazily so tests can require this module without Redis */
let queue;

/**
 * Sleep for a random duration between [minMs, maxMs].
 * @param {number} minMs
 * @param {number} maxMs
 * @returns {Promise<void>}
 */
function randomSleep(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one poll cycle:
 *   1. Check daily API budget (if EBAY_APP_ID is set)
 *   2. Pick the next keyword (round-robin)
 *   3. Fetch eBay search results (first page, sorted by newest)
 *   4. Find listings not seen before
 *   5. Enqueue each new listing
 */
async function pollOnce() {
  const appId = process.env.EBAY_APP_ID;

  // Guard against exhausted Browse API budget
  if (appId && !(await canMakeApiCall())) {
    console.warn('[poller] Daily polling budget exhausted, skipping cycle');
    return;
  }

  const keyword = KEYWORDS[keywordIndex];
  keywordIndex = (keywordIndex + 1) % KEYWORDS.length;

  console.log(`[poller] Polling keyword="${keyword}"`);

  let listings;
  try {
    listings = await fetchNewListings(keyword);
  } catch (err) {
    console.error('[poller] Failed to fetch listings:', err.message);
    return;
  }

  // Count this Browse API call
  if (appId) await incrementApiCounter();

  const newListings = listings.filter((l) => !seenIds.has(l.listing_id));
  if (newListings.length === 0) {
    console.log('[poller] No new listings found');
    return;
  }

  const timestamp_detected = new Date().toISOString();

  if (!queue) queue = createQueue();

  let enqueued = 0;
  for (const listing of newListings) {
    seenIds.add(listing.listing_id);
    const payload = { ...listing, timestamp_detected };
    try {
      await enqueueListings(queue, payload);
      enqueued++;
    } catch (err) {
      console.error(`[poller] Failed to enqueue ${listing.listing_id}:`, err.message);
    }
  }

  console.log(
    `[poller] Detected ${newListings.length} new listing(s), enqueued ${enqueued}`
  );
}

/**
 * Main polling loop – runs indefinitely.
 * When EBAY_APP_ID is set the interval is calculated from the daily budget;
 * otherwise a randomized interval (POLL_INTERVAL_MIN–POLL_INTERVAL_MAX) is used.
 */
async function run() {
  const appId = process.env.EBAY_APP_ID;

  if (appId) {
    console.log(`[poller] API budget: ${DAILY_LIMIT} calls/day`);
    console.log(
      `[poller]   → Polling: ${POLLING_BUDGET} calls ` +
      `(${KEYWORDS.length} keywords, polling every ~${KEYWORD_INTERVAL_SEC}s)`
    );
    console.log(`[poller]   → Comps: ${COMPS_BUDGET} calls reserved for sold-price lookups`);
  } else {
    console.log(
      `[poller] Starting. keywords=${JSON.stringify(KEYWORDS)}, interval=${POLL_MIN}–${POLL_MAX}s`
    );
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce();
    if (appId) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_SEC * 1000));
    } else {
      await randomSleep(POLL_MIN * 1000, POLL_MAX * 1000);
    }
  }
}

// Allow this file to be required in tests without auto-starting
if (require.main === module) {
  run().catch((err) => {
    console.error('[poller] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { pollOnce, randomSleep, parseKeywords, KEYWORDS: Object.freeze([...KEYWORDS]) };
