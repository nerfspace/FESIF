'use strict';
/**
 * Tests for src/shared/db.js
 * Uses an in-memory database to avoid file-system side-effects.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Use an in-memory DB for all tests
process.env.DB_PATH = ':memory:';

// Re-require to reset the singleton
let db;
function freshDb() {
  // Clear the module cache so getDb() starts fresh with :memory:
  delete require.cache[require.resolve('./db')];
  db = require('./db');
  return db;
}

describe('db – upsertListing and upsertScore', () => {
  const listing = {
    listing_id: 'LID001',
    title: 'Test Listing',
    price: 49.99,
    shipping_cost: 5.99,
    seller_feedback: 200,
    category: 'Electronics',
    listing_url: 'https://www.ebay.com/itm/LID001',
    timestamp_detected: '2024-01-01T00:00:00.000Z',
  };

  const score = {
    listing_id: 'LID001',
    deal_score: 85,
    estimated_profit: 22.5,
    risk_score: 10,
    sell_through_rate: 0.7,
    confidence: 0.8,
  };

  test('upsertListing does not throw', () => {
    const { upsertListing } = freshDb();
    assert.doesNotThrow(() => upsertListing(listing));
  });

  test('upsertScore does not throw after listing exists', () => {
    const { upsertListing, upsertScore } = freshDb();
    upsertListing(listing);
    assert.doesNotThrow(() => upsertScore(score));
  });

  test('getTopDeals returns inserted deal', () => {
    const { upsertListing, upsertScore, getTopDeals } = freshDb();
    upsertListing(listing);
    upsertScore(score);

    const deals = getTopDeals(80);
    assert.equal(deals.length, 1);
    assert.equal(deals[0].listing_id, 'LID001');
    assert.equal(deals[0].deal_score, 85);
  });

  test('getTopDeals filters by min_score', () => {
    const { upsertListing, upsertScore, getTopDeals } = freshDb();
    upsertListing(listing);
    upsertScore({ ...score, deal_score: 75 });

    const deals = getTopDeals(80);
    assert.equal(deals.length, 0);
  });

  test('upsertListing is idempotent (no duplicate error)', () => {
    const { upsertListing } = freshDb();
    upsertListing(listing);
    // Second call with updated price should not throw
    assert.doesNotThrow(() => upsertListing({ ...listing, price: 55 }));
  });
});
