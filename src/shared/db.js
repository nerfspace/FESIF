'use strict';
/**
 * shared/db.js
 * SQLite database initialization and helpers.
 * Uses the built-in node:sqlite module (Node >= 22.5).
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = (() => {
  const raw = process.env.DB_PATH;
  if (raw === ':memory:') return ':memory:';
  if (raw) return path.resolve(raw);
  return path.resolve(__dirname, '../../fesif.db');
})();

let db;

/**
 * Return the singleton database connection.
 * Creates and migrates the schema on first call.
 */
function getDb() {
  if (db) return db;

  db = new DatabaseSync(DB_PATH);

  // WAL mode allows concurrent reads and writes across processes.
  // busy_timeout tells SQLite to retry for up to 10s before giving up.
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=10000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      listing_id        TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      price             REAL NOT NULL,
      shipping_cost     REAL NOT NULL DEFAULT 0,
      seller_feedback   INTEGER NOT NULL DEFAULT 0,
      category          TEXT NOT NULL DEFAULT '',
      listing_url       TEXT NOT NULL DEFAULT '',
      timestamp_detected TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scores (
      listing_id        TEXT PRIMARY KEY REFERENCES listings(listing_id),
      deal_score        REAL NOT NULL,
      estimated_profit  REAL NOT NULL,
      risk_score        REAL NOT NULL,
      sell_through_rate REAL NOT NULL,
      confidence        REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scores_deal_score ON scores(deal_score DESC);
  `);

  return db;
}

/**
 * Run a database write with retry logic for "database is locked" errors.
 * Docker volume mounts can cause transient locking even with WAL mode,
 * so we retry up to 5 times with exponential backoff.
 * @param {function} fn  Function that performs the DB write
 * @param {number} [maxRetries=5]
 */
function withRetry(fn, maxRetries) {
  if (maxRetries === undefined) maxRetries = 5;
  var lastErr;
  for (var attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (err.message && err.message.indexOf('database is locked') !== -1) {
        var waitMs = Math.pow(2, attempt) * 50 + Math.floor(Math.random() * 100);
        var start = Date.now();
        while (Date.now() - start < waitMs) { /* spin */ }
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Upsert a listing row.
 * @param {object} listing  Fields matching the listings table.
 */
function upsertListing(listing) {
  withRetry(function () {
    getDb().prepare(`
      INSERT INTO listings (listing_id, title, price, shipping_cost, seller_feedback,
                            category, listing_url, timestamp_detected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(listing_id) DO UPDATE SET
        title              = excluded.title,
        price              = excluded.price,
        shipping_cost      = excluded.shipping_cost,
        seller_feedback    = excluded.seller_feedback,
        category           = excluded.category,
        listing_url        = excluded.listing_url,
        timestamp_detected = excluded.timestamp_detected
    `).run(
      listing.listing_id,
      listing.title,
      listing.price,
      listing.shipping_cost,
      listing.seller_feedback,
      listing.category,
      listing.listing_url,
      listing.timestamp_detected
    );
  });
}

/**
 * Upsert a score row.
 * @param {object} score  Fields matching the scores table.
 */
function upsertScore(score) {
  withRetry(function () {
    getDb().prepare(`
      INSERT INTO scores (listing_id, deal_score, estimated_profit, risk_score,
                          sell_through_rate, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(listing_id) DO UPDATE SET
        deal_score        = excluded.deal_score,
        estimated_profit  = excluded.estimated_profit,
        risk_score        = excluded.risk_score,
        sell_through_rate = excluded.sell_through_rate,
        confidence        = excluded.confidence
    `).run(
      score.listing_id,
      score.deal_score,
      score.estimated_profit,
      score.risk_score,
      score.sell_through_rate,
      score.confidence
    );
  });
}

/**
 * Retrieve top deals above a minimum score.
 * @param {number} [minScore=80]
 * @param {number} [limit=50]
 * @returns {Array<object>}
 */
function getTopDeals(minScore, limit) {
  if (minScore === undefined) minScore = 80;
  if (limit === undefined) limit = 50;
  return getDb()
    .prepare(
      `SELECT l.listing_id, l.title, l.price, l.listing_url,
              s.deal_score, s.estimated_profit
       FROM   listings l
       JOIN   scores   s ON s.listing_id = l.listing_id
       WHERE  s.deal_score >= ?
       ORDER  BY s.deal_score DESC
       LIMIT  ?`
    )
    .all(minScore, limit);
}

module.exports = { getDb, upsertListing, upsertScore, getTopDeals };