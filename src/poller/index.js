'use strict';
/**
 * poller/index.js
 * Continuously polls eBay for newly listed items and pushes them to the queue.
 *
 * Configuration (via environment variables):
 *   EBAY_SEARCH_KEYWORD  – comma-separated search terms (default: empty → all categories)
 *                          e.g. "iphone,gpu,macbook pro" cycles round-robin across keywords
 *   POLL_INTERVAL_MIN    – minimum seconds between polls  (default: 5)
 *   POLL_INTERVAL_MAX    – maximum seconds between polls  (default: 15)
 *   REDIS_HOST / REDIS_PORT
 */

require('dotenv').config();

const { fetchNewListings } = require('../shared/scraper');
const { createQueue, enqueueListings } = require('../shared/queue');

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
 * Main polling loop – runs indefinitely with randomized delays.
 */
async function run() {
  console.log(
    `[poller] Starting. keywords=${JSON.stringify(KEYWORDS)}, interval=${POLL_MIN}–${POLL_MAX}s`
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce();
    await randomSleep(POLL_MIN * 1000, POLL_MAX * 1000);
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
