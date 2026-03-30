'use strict';
/**
 * poller/index.js
 * Continuously polls eBay for newly listed items and pushes them to the queue.
 *
 * Configuration (via environment variables):
 *   EBAY_SEARCH_KEYWORD  – search term (default: empty → all categories)
 *   POLL_INTERVAL_MIN    – minimum seconds between polls  (default: 5)
 *   POLL_INTERVAL_MAX    – maximum seconds between polls  (default: 15)
 *   REDIS_HOST / REDIS_PORT
 */

require('dotenv').config();

const { fetchNewListings } = require('../shared/scraper');
const { createQueue, enqueueListings } = require('../shared/queue');

const KEYWORD = process.env.EBAY_SEARCH_KEYWORD || '';
const POLL_MIN = Number(process.env.POLL_INTERVAL_MIN) || 5;
const POLL_MAX = Number(process.env.POLL_INTERVAL_MAX) || 15;

/** IDs seen during the current process lifetime (in-memory deduplication) */
const seenIds = new Set();

const queue = createQueue();

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
 *   1. Fetch eBay search results (first page, sorted by newest)
 *   2. Find listings not seen before
 *   3. Enqueue each new listing
 */
async function pollOnce() {
  let listings;
  try {
    listings = await fetchNewListings(KEYWORD);
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
    `[poller] Starting. keyword="${KEYWORD}", interval=${POLL_MIN}–${POLL_MAX}s`
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

module.exports = { pollOnce, randomSleep };
