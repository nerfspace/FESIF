'use strict';
/**
 * analyzer/index.js
 * BullMQ worker that consumes listing jobs and scores them.
 *
 * For each job:
 *   1. Fetch comparable sold prices from eBay (via Finding API when key is set)
 *   2. Run the full scoring pipeline
 *   3. Persist listing + score to SQLite
 */

require('dotenv').config();

const { createWorker } = require('../shared/queue');
const { fetchSoldPrices } = require('../shared/scraper');
const { scoreListingFull } = require('../shared/scoring');
const { upsertListing, upsertScore } = require('../shared/db');
const { checkAndIncrement } = require('../shared/rateLimiter');

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

  // Step 3 – Fetch comparable sold prices (respecting the daily API budget)
  let soldPrices = [];
  try {
    // Build a focused query from the title (first 6 words often captures brand + model)
    const query = title.split(/\s+/).slice(0, 6).join(' ');

    // Only make the API call if we're still within the comps budget for today.
    const allowed = process.env.EBAY_APP_ID
      ? await checkAndIncrement('comps')
      : true;   // HTML scraping has no daily cap

    if (allowed) {
      soldPrices = await fetchSoldPrices(query);
      console.log(
        `[analyzer] ${listing_id}: ${soldPrices.length} comps found (query="${query}")`
      );
    } else {
      console.warn(
        `[analyzer] ${listing_id}: comps budget exhausted for today — scoring without comps`
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
