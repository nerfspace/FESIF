'use strict';
/**
 * api/index.js
 * Express HTTP API that exposes the top deals stored in the database.
 *
 * Endpoints:
 *   GET /deals?min_score=<number>   – returns listings with deal_score >= min_score
 *   GET /health                      – liveness probe
 */

require('dotenv').config();

const express = require('express');
const { getTopDeals } = require('../shared/db');

const PORT = Number(process.env.API_PORT) || 3000;
const DEFAULT_MIN_SCORE = Number(process.env.MIN_DEAL_SCORE) || 80;
const MAX_RESULTS = 100;

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// GET /deals
// ---------------------------------------------------------------------------
/**
 * Query params:
 *   min_score  {number}  Minimum deal score (default: 80)
 *   limit      {number}  Max results to return (default: 50, max: 100)
 *
 * Response JSON array, each element:
 *   {
 *     listing_id:       string,
 *     title:            string,
 *     price:            number,
 *     deal_score:       number,
 *     estimated_profit: number,
 *     listing_url:      string
 *   }
 */
app.get('/deals', (req, res) => {
  // Parse and validate min_score
  let minScore = DEFAULT_MIN_SCORE;
  if (req.query.min_score !== undefined) {
    const parsed = Number(req.query.min_score);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
      minScore = parsed;
    } else {
      return res
        .status(400)
        .json({ error: 'min_score must be a number between 0 and 100' });
    }
  }

  // Parse and validate limit
  let limit = 50;
  if (req.query.limit !== undefined) {
    const parsed = Number(req.query.limit);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_RESULTS) {
      limit = parsed;
    } else {
      return res
        .status(400)
        .json({ error: `limit must be an integer between 1 and ${MAX_RESULTS}` });
    }
  }

  try {
    const deals = getTopDeals(minScore, limit);
    res.json(deals);
  } catch (err) {
    console.error('[api] Error fetching deals:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
let server;

if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`[api] Listening on port ${PORT}`);
  });
}

module.exports = { app };
