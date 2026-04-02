'use strict';
/**
 * analyzer/index.js
 * BullMQ worker that consumes listing jobs and scores them.
 *
 * For each job:
 *   1. Check daily API budget (if EBAY_APP_ID is set)
 *   2. Fetch comparable sold prices from eBay (skipped if budget exhausted)
 *   3. Run the full scoring pipeline
 *   4. Persist listing + score to SQLite
 */

require('dotenv').config();

const { createWorker } = require('../shared/queue');
const { fetchSoldPrices } = require('../shared/scraper');
const { scoreListingFull } = require('../shared/scoring');
const { upsertListing, upsertScore } = require('../shared/db');
const { canMakeApiCall, incrementApiCounter } = require('../shared/rateLimit');

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

  if (appId) {
    // Use Finding API – check budget first
    if (await canMakeApiCall()) {
      // Increment before the call: eBay counts the HTTP request against the
      // quota regardless of the outcome, and pre-incrementing prevents multiple
      // containers from simultaneously exceeding the budget.
      await incrementApiCounter();
      try {
        const query = title.split(/\s+/).slice(0, 6).join(' ');
        soldPrices = await fetchSoldPrices(query);
        console.log(
          `[analyzer] ${listing_id}: ${soldPrices.length} comps found (query="${query}")`
        );
      } catch (err) {
        console.warn(`[analyzer] Could not fetch comps for ${listing_id}: ${err.message}`);
        // Continue with empty soldPrices – score will reflect low confidence
      }
    } else {
      console.warn(
        `[analyzer] Comps budget exhausted, skipping sold price lookup for ${listing_id}`
      );
    }
  } else {
    // HTML scraping fallback – no budget check needed
    try {
      const query = title.split(/\s+/).slice(0, 6).join(' ');
      soldPrices = await fetchSoldPrices(query);
      console.log(
        `[analyzer] ${listing_id}: ${soldPrices.length} comps found (query="${query}")`
      );
    } catch (err) {
      console.warn(`[analyzer] Could not fetch comps for ${listing_id}: ${err.message}`);
    }
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
