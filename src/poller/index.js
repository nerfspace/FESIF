'use strict';
/**
 * poller/index.js
 * Continuously polls eBay for newly listed items and pushes them to the queue.
 *
 * Configuration (via environment variables):
 *   EBAY_SEARCH_KEYWORD    – comma-separated search terms (default: empty → all categories)
 *                            e.g. "iphone,gpu,macbook pro" cycles round-robin across keywords
 *   POLL_INTERVAL_MIN      – minimum seconds between polls when in HTML-scraping mode (default: 5)
 *   POLL_INTERVAL_MAX      – maximum seconds between polls when in HTML-scraping mode (default: 15)
 *   EBAY_DAILY_API_LIMIT   – total API calls allowed per day (default: 5000)
 *   REDIS_HOST / REDIS_PORT
 */

require('dotenv').config();

const Redis = require('ioredis');
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
// API rate-limit budget (only relevant when EBAY_APP_ID is set)
// ---------------------------------------------------------------------------

/** 30 % of the daily budget is reserved for Browse API polling */
const POLL_BUDGET_FRACTION = 0.30;

/**
 * Calculate the poll interval in seconds based on the daily API budget.
 * Ensures the poller does not exhaust its 30 % share of API calls in a day.
 *
 * @param {number} dailyLimit  Total API calls per day
 * @param {number} numKeywords Number of keywords being polled
 * @returns {number}  Poll interval in seconds (rounded up)
 */
function calcPollInterval(dailyLimit, numKeywords) {
  const pollBudget   = Math.floor(dailyLimit * POLL_BUDGET_FRACTION);
  // One API call per keyword per cycle; budget determines how many cycles fit in a day
  const cyclesPerDay = Math.floor(pollBudget / Math.max(numKeywords, 1));
  if (cyclesPerDay <= 0) return 3600; // safety fallback: once per hour
  return Math.ceil(86400 / cyclesPerDay);
}

/** Round-robin index into KEYWORDS */
let keywordIndex = 0;

/** IDs seen during the current process lifetime (in-memory deduplication) */
const seenIds = new Set();

/** BullMQ queue – created lazily so tests can require this module without Redis */
let queue;

/** Redis client for rate limiting – created lazily */
let redisClient;

function getRedisClient() {
  if (!redisClient) {
    redisClient = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT) || 6379,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    redisClient.on('error', () => {
      // Silently ignore connection errors; rate limiting falls back to in-memory
    });
  }
  return redisClient;
}

/**
 * Sleep for a given duration.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep for a random duration between [minMs, maxMs].
 * @param {number} minMs
 * @param {number} maxMs
 * @returns {Promise<void>}
 */
function randomSleep(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(ms);
}

/**
 * Run one poll cycle:
 *   1. Check API budget (skip if polling budget exhausted)
 *   2. Pick the next keyword (round-robin)
 *   3. Fetch eBay search results (first page, sorted by newest)
 *   4. Find listings not seen before
 *   5. Enqueue each new listing
 */
async function pollOnce() {
  const appId = process.env.EBAY_APP_ID;

  // When using the API, check the rate limit before polling
  if (appId) {
    const redis = getRedisClient();
    const ok = await canMakeApiCall(redis);
    if (!ok) {
      console.warn('[poller] Daily API budget exhausted – skipping poll cycle');
      return;
    }
  }

  const keyword = KEYWORDS[keywordIndex];
  keywordIndex = (keywordIndex + 1) % KEYWORDS.length;

  console.log(`[poller] Polling keyword="${keyword}"`);

  let listings;
  try {
    listings = await fetchNewListings(keyword);
    // Count this Browse API call against the daily budget
    if (appId) {
      await incrementApiCounter(getRedisClient());
    }
  } catch (err) {
    console.error('[poller] Failed to fetch listings:', err.message);
    return;
  }

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
 * Main polling loop – runs indefinitely with calculated or randomized delays.
 */
async function run() {
  const appId = process.env.EBAY_APP_ID;

  if (appId) {
    // API mode: auto-calculate interval from daily budget
    const pollBudget  = Math.floor(DAILY_LIMIT * POLL_BUDGET_FRACTION);
    const compsBudget = DAILY_LIMIT - pollBudget;
    const intervalSec = calcPollInterval(DAILY_LIMIT, KEYWORDS.length);

    console.log(`[poller] API budget: ${DAILY_LIMIT} calls/day`);
    console.log(
      `[poller]   → Polling: ${pollBudget} calls (${KEYWORDS.length} keyword${KEYWORDS.length !== 1 ? 's' : ''}, polling every ~${intervalSec}s)`
    );
    console.log(`[poller]   → Comps: ${compsBudget} calls reserved for sold-price lookups`);
    console.log(`[poller] Starting. keywords=${JSON.stringify(KEYWORDS)}, interval=~${intervalSec}s`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await pollOnce();
      await sleep(intervalSec * 1000);
    }
  } else {
    // HTML scraping mode: use randomised interval (configured via env)
    console.log(
      `[poller] Starting. keywords=${JSON.stringify(KEYWORDS)}, interval=${POLL_MIN}–${POLL_MAX}s`
    );

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await pollOnce();
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

module.exports = {
  pollOnce,
  randomSleep,
  parseKeywords,
  calcPollInterval,
  KEYWORDS: Object.freeze([...KEYWORDS]),
};
