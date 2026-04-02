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

  // Enable WAL mode for concurrent read/write access across multiple workers,
  // and set a generous busy timeout so writers wait instead of failing immediately.
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');

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
 * Upsert a listing row.
 * @param {object} listing  Fields matching the listings table.
 */
function upsertListing(listing) {
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
    listing.timestamp_detected,
  );
}

/**
 * Upsert a score row.
 * @param {object} score  Fields matching the scores table.
 */
function upsertScore(score) {
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
    score.confidence,
  );
}

/**
 * Retrieve top deals above a minimum score.
 * Joins listings + scores and returns the fields required by the API spec.
 *
 * @param {number} minScore
 * @param {number} [limit=50]
 * @returns {Array<object>}
 */
function getTopDeals(minScore = 80, limit = 50) {
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
