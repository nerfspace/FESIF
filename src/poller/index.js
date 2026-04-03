'use strict';
/**
 * poller/index.js
 * Continuously polls eBay for newly listed items and pushes them to the queue.
 *
 * Configuration (via environment variables):
 *   EBAY_SEARCH_KEYWORD  – comma-separated search terms (REQUIRED for Browse API)
 *                          e.g. "iphone,gpu,macbook pro" cycles round-robin across keywords
 *   POLL_INTERVAL_MIN    – minimum seconds between polls  (default: 5)
 *   POLL_INTERVAL_MAX    – maximum seconds between polls  (default: 15)
 *   REDIS_HOST / REDIS_PORT
 */

require('dotenv').config();

const { fetchNewListings } = require('../shared/scraper');
const { createQueue, enqueueListings } = require('../shared/queue');
const { checkAndIncrement, getDailyCounts, POLL_BUDGET, COMPS_BUDGET } = require('../shared/rateLimiter');

/**
 * Parse EBAY_SEARCH_KEYWORD into an array of trimmed, non-empty keywords.
 * Returns an empty array if no keywords are configured (caller must handle).
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseKeywords(raw) {
  return (raw || '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

const KEYWORDS = parseKeywords(process.env.EBAY_SEARCH_KEYWORD);
const POLL_MIN = Number(process.env.POLL_INTERVAL_MIN) || 5;
const POLL_MAX = Number(process.env.POLL_INTERVAL_MAX) || 15;

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
 *   1. Pick the next keyword (round-robin)
 *   2. Fetch eBay search results (first page, sorted by newest)
 *   3. Find listings not seen before
 *   4. Enqueue each new listing
 */
async function pollOnce() {
  if (KEYWORDS.length === 0) {
    console.error(
      '[poller] No keywords configured! Set EBAY_SEARCH_KEYWORD in your .env file.
' +
      '         Example: EBAY_SEARCH_KEYWORD=iphone,gpu,macbook pro,ps5'
    );
    return;
  }

  const keyword = KEYWORDS[keywordIndex];
  keywordIndex = (keywordIndex + 1) % KEYWORDS.length;

  console.log(`[poller] Polling keyword=\