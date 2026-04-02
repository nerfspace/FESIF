'use strict';
/**
 * analyzer/index.js
 * BullMQ worker that consumes listing jobs and scores them.
 *
 * For each job:
 *   1. Fetch comparable sold prices from eBay (skipped if daily API budget exhausted)
 *   2. Run the full scoring pipeline
 *   3. Persist listing + score to SQLite
 */

require('dotenv').config();

const Redis = require('ioredis');
const { createWorker } = require('../shared/queue');
const { fetchSoldPrices } = require('../shared/scraper');
const { scoreListingFull } = require('../shared/scoring');
const { upsertListing, upsertScore } = require('../shared/db');
const { incrementApiCounter, canMakeApiCall } = require('../shared/rateLimit');

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
 * Process a single listing job.
 * @param {import('bullmq').Job} job
 */
async function processJob(job) {
  const listing = job.data;
  const {
    listing_id,
    title,
    price,
    shipping_cost,
    seller_feedback,
    category,
    listing_url,
    timestamp_detected,
  } = listing;

  console.log(`[analyzer] Processing ${listing_id}: "${title}" $${price}`);

  // Step 3 – Fetch comparable sold prices
  let soldPrices = [];
  const appId = process.env.EBAY_APP_ID;
  try {
    // Build a focused query from the title (first 6 words often captures brand + model)
    const query = title.split(/\s+/).slice(0, 6).join(' ');

    // When using the API, check whether the comps budget is still available
    if (appId) {
      const redis = getRedisClient();
      const ok = await canMakeApiCall(redis);
      if (!ok) {
        console.warn(
          `[analyzer] ${listing_id}: comps skipped – daily API budget exhausted`
        );
      } else {
        soldPrices = await fetchSoldPrices(query);
        await incrementApiCounter(redis);
        console.log(
          `[analyzer] ${listing_id}: ${soldPrices.length} comps found (query="${query}")`
        );
      }
    } else {
      soldPrices = await fetchSoldPrices(query);
      console.log(
        `[analyzer] ${listing_id}: ${soldPrices.length} comps found (query="${query}")`
      );
    }
  } catch (err) {
    console.warn(`[analyzer] Could not fetch comps for ${listing_id}: ${err.message}`);
    // Continue with empty soldPrices – score will reflect low confidence
  }

  // Steps 4–11 – full scoring pipeline
  const result = scoreListingFull(listing, soldPrices);

  console.log(
    `[analyzer] ${listing_id}: deal_score=${result.deal_score} profit=$${result.estimated_profit}`
  );

  // Step 11 – Persist to database
  upsertListing({
    listing_id,
    title,
    price,
    shipping_cost,
    seller_feedback,
    category,
    listing_url,
    timestamp_detected,
  });

  upsertScore({
    listing_id,
    deal_score:        result.deal_score,
    estimated_profit:  result.estimated_profit,
    risk_score:        result.risk_score,
    sell_through_rate: result.sell_through_rate,
    confidence:        result.confidence,
  });
}

// Start the worker when run as the main module
if (require.main === module) {
  const worker = createWorker(processJob);
  console.log('[analyzer] Worker started, waiting for jobs…');

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[analyzer] Shutting down…');
    await worker.close();
    process.exit(0);
  });
}

module.exports = { processJob };
