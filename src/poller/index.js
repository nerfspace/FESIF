'use strict';
require('dotenv').config();

const { fetchNewListings } = require('../shared/scraper');
const { createQueue, enqueueListings } = require('../shared/queue');
const { checkAndIncrement, POLL_BUDGET, COMPS_BUDGET } = require('../shared/rateLimiter');

function parseKeywords(raw) {
  return (raw || '')
    .split(',')
    .map(function (k) { return k.trim(); })
    .filter(function (k) { return k.length > 0; });
}

const KEYWORDS = parseKeywords(process.env.EBAY_SEARCH_KEYWORD);
const POLL_MIN = Number(process.env.POLL_INTERVAL_MIN) || 5;
const POLL_MAX = Number(process.env.POLL_INTERVAL_MAX) || 15;

let keywordIndex = 0;
const seenIds = new Set();
let queue;

function randomSleep(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function pollOnce() {
  if (KEYWORDS.length === 0) {
    console.error('[poller] No keywords configured! Set EBAY_SEARCH_KEYWORD in .env');
    return;
  }

  const keyword = KEYWORDS[keywordIndex];
  keywordIndex = (keywordIndex + 1) % KEYWORDS.length;
  console.log('[poller] Polling keyword="' + keyword + '"');

  if (process.env.EBAY_APP_ID) {
    const allowed = await checkAndIncrement('poll');
    if (!allowed) {
      console.warn('[poller] Polling budget exhausted for today - skipping');
      return;
    }
  }

  let listings;
  try {
    listings = await fetchNewListings(keyword);
  } catch (err) {
    console.error('[poller] Failed to fetch "' + keyword + '":', err.message);
    return;
  }

  const newListings = listings.filter(function (l) { return !seenIds.has(l.listing_id); });
  if (newListings.length === 0) {
    console.log('[poller] No new listings found');
    return;
  }

  const timestamp_detected = new Date().toISOString();
  if (!queue) queue = createQueue();

  let enqueued = 0;
  for (const listing of newListings) {
    seenIds.add(listing.listing_id);
    try {
      await enqueueListings(queue, Object.assign({}, listing, { timestamp_detected: timestamp_detected }));
      enqueued++;
    } catch (err) {
      console.error('[poller] Failed to enqueue ' + listing.listing_id + ':', err.message);
    }
  }

  console.log('[poller] Detected ' + newListings.length + ' new listing(s), enqueued ' + enqueued);
}

async function run() {
  if (KEYWORDS.length === 0) {
    console.error('ERROR: EBAY_SEARCH_KEYWORD is empty!');
    console.error('The eBay API requires at least one keyword to search.');
    console.error('Add keywords to your .env file:');
    console.error('  EBAY_SEARCH_KEYWORD=iphone,gpu,macbook pro,ps5');
    console.error('Then restart: docker compose down && docker compose up');
    process.exit(1);
  }

  var numKW = KEYWORDS.length;
  var cyclesPerDay = Math.floor(POLL_BUDGET / numKW);
  var recInterval = Math.ceil(86400 / cyclesPerDay);

  console.log('[poller] Starting with ' + numKW + ' keywords');
  console.log('[poller] API budget: ' + (POLL_BUDGET + COMPS_BUDGET) + ' calls/day');
  console.log('[poller]   Polling: ' + POLL_BUDGET + ' calls (' + numKW + ' keywords, ~' + cyclesPerDay + ' cycles/day)');
  console.log('[poller]   Comps:   ' + COMPS_BUDGET + ' calls reserved for sold-price lookups');
  console.log('[poller]   Recommended interval: ~' + recInterval + 's (using ' + POLL_MIN + '-' + POLL_MAX + 's)');
  console.log('[poller] Keywords: ' + JSON.stringify(KEYWORDS));

  while (true) {
    await pollOnce();
    await randomSleep(POLL_MIN * 1000, POLL_MAX * 1000);
  }
}

if (require.main === module) {
  run().catch(function (err) {
    console.error('[poller] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { pollOnce: pollOnce, randomSleep: randomSleep, parseKeywords: parseKeywords, KEYWORDS: Object.freeze([].concat(KEYWORDS)) };