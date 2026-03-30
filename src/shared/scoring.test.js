'use strict';
/**
 * Tests for src/shared/scoring.js
 * Uses Node.js built-in test runner (node:test) – no external test framework.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractBrandModel,
  median,
  calculateProfit,
  riskMultiplier,
  sellThroughRate,
  ignoranceBoost,
  computeDealScore,
  scoreListingFull,
} = require('./scoring');

// ---------------------------------------------------------------------------
// median()
// ---------------------------------------------------------------------------
describe('median', () => {
  test('returns 0 for empty array', () => {
    assert.equal(median([]), 0);
  });

  test('single element', () => {
    assert.equal(median([42]), 42);
  });

  test('odd count', () => {
    assert.equal(median([3, 1, 4, 1, 5]), 3);
  });

  test('even count', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  test('does not mutate input', () => {
    const arr = [5, 3, 1];
    median(arr);
    assert.deepEqual(arr, [5, 3, 1]);
  });
});

// ---------------------------------------------------------------------------
// extractBrandModel()
// ---------------------------------------------------------------------------
describe('extractBrandModel', () => {
  test('detects Apple', () => {
    const { brand } = extractBrandModel('Apple iPhone 14 Pro 256GB Space Black');
    assert.equal(brand, 'Apple');
  });

  test('detects model number pattern', () => {
    const { model } = extractBrandModel('Sony WH1000XM5 Headphones');
    assert.match(model, /WH1000XM5/i);
  });

  test('returns empty strings for unknown brand/model', () => {
    const { brand, model } = extractBrandModel('some random old thing');
    assert.equal(brand, '');
    assert.equal(model, '');
  });
});

// ---------------------------------------------------------------------------
// calculateProfit()
// ---------------------------------------------------------------------------
describe('calculateProfit', () => {
  test('basic profit calculation', () => {
    const { trueCost, netResaleValue, profit } = calculateProfit(50, 10, 100, 'electronics');
    // trueCost = 50 + 10 = 60
    assert.equal(trueCost, 60);
    // estimatedFees = 16% of 100 = 16
    // outbound shipping (electronics) = 8.99
    // netResaleValue = 100 - 16 - 8.99 = 75.01
    assert.equal(netResaleValue, 100 - 16 - 8.99);
    // profit = 75.01 - 60 = 15.01
    assert.equal(profit, 75.01 - 60);
  });

  test('profit is negative when listing price is too high', () => {
    const { profit } = calculateProfit(200, 20, 100, 'default');
    assert.ok(profit < 0);
  });
});

// ---------------------------------------------------------------------------
// riskMultiplier()
// ---------------------------------------------------------------------------
describe('riskMultiplier', () => {
  test('returns 1 for safe listing', () => {
    assert.equal(riskMultiplier({ sellerFeedback: 500, title: 'Great item' }), 1);
  });

  test('penalty for low feedback', () => {
    const mult = riskMultiplier({ sellerFeedback: 5, title: 'Great item' });
    assert.ok(mult < 1);
    assert.ok(mult >= 0.5);
  });

  test('penalty for "untested" keyword', () => {
    const mult = riskMultiplier({ sellerFeedback: 200, title: 'Laptop untested sold as-is' });
    assert.ok(mult < 1);
  });

  test('never goes below 0.5', () => {
    const mult = riskMultiplier({ sellerFeedback: 0, title: 'untested for parts broken' });
    assert.ok(mult >= 0.5);
  });
});

// ---------------------------------------------------------------------------
// sellThroughRate()
// ---------------------------------------------------------------------------
describe('sellThroughRate', () => {
  test('defaults to 0.6 when no data', () => {
    assert.equal(sellThroughRate(0, 0), 0.6);
  });

  test('calculates rate correctly', () => {
    assert.equal(sellThroughRate(3, 5), 0.6);
  });

  test('caps at 1', () => {
    assert.equal(sellThroughRate(10, 5), 1);
  });
});

// ---------------------------------------------------------------------------
// ignoranceBoost()
// ---------------------------------------------------------------------------
describe('ignoranceBoost', () => {
  test('zero boost for clean listing', () => {
    const boost = ignoranceBoost({
      title: 'Apple iPhone 14 Pro 256GB',
      medianCompPrice: 800,
      listingPrice: 700,
      brand: 'Apple',
      model: 'iPhone14Pro',
    });
    assert.ok(boost >= 0);
  });

  test('boosts for vague title and low price', () => {
    const boost = ignoranceBoost({
      title: 'old lot of stuff',
      medianCompPrice: 100,
      listingPrice: 20,
      brand: '',
      model: '',
    });
    assert.ok(boost > 0.3);
  });

  test('never exceeds 1', () => {
    const boost = ignoranceBoost({
      title: 'old junk lot misc bundle',
      medianCompPrice: 100,
      listingPrice: 5,
      brand: '',
      model: '',
    });
    assert.ok(boost <= 1);
  });
});

// ---------------------------------------------------------------------------
// computeDealScore()
// ---------------------------------------------------------------------------
describe('computeDealScore', () => {
  test('score is within 0–100', () => {
    const { dealScore } = computeDealScore({
      profit: 50,
      medianCompPrice: 100,
      listingPrice: 40,
      sellThrough: 0.7,
      riskMult: 0.9,
      ignoranceBoostValue: 0.1,
    });
    assert.ok(dealScore >= 0 && dealScore <= 100);
  });

  test('higher profit produces higher score', () => {
    const base = computeDealScore({
      profit: 10,
      medianCompPrice: 100,
      listingPrice: 80,
      sellThrough: 0.5,
      riskMult: 1,
      ignoranceBoostValue: 0,
    });
    const better = computeDealScore({
      profit: 60,
      medianCompPrice: 100,
      listingPrice: 30,
      sellThrough: 0.5,
      riskMult: 1,
      ignoranceBoostValue: 0,
    });
    assert.ok(better.dealScore > base.dealScore);
  });

  test('high risk reduces score', () => {
    const low = computeDealScore({
      profit: 30,
      medianCompPrice: 100,
      listingPrice: 60,
      sellThrough: 0.6,
      riskMult: 0.5,
      ignoranceBoostValue: 0,
    });
    const high = computeDealScore({
      profit: 30,
      medianCompPrice: 100,
      listingPrice: 60,
      sellThrough: 0.6,
      riskMult: 1.0,
      ignoranceBoostValue: 0,
    });
    assert.ok(high.dealScore >= low.dealScore);
  });
});

// ---------------------------------------------------------------------------
// scoreListingFull() – integration test of the entire pipeline
// ---------------------------------------------------------------------------
describe('scoreListingFull', () => {
  const listing = {
    listing_id: 'TEST001',
    title: 'Apple iPhone 14 Pro 256GB Space Black',
    price: 400,
    shipping_cost: 0,
    seller_feedback: 250,
    category: 'Electronics',
    listing_url: 'https://www.ebay.com/itm/TEST001',
    timestamp_detected: '2024-01-01T00:00:00.000Z',
  };
  const soldPrices = [800, 820, 780, 810, 795, 805, 790, 815, 800, 800];

  test('returns required fields', () => {
    const result = scoreListingFull(listing, soldPrices);
    assert.ok('listing_id' in result);
    assert.ok('deal_score' in result);
    assert.ok('estimated_profit' in result);
    assert.ok('risk_score' in result);
    assert.ok('sell_through_rate' in result);
    assert.ok('confidence' in result);
  });

  test('listing_id is preserved', () => {
    const result = scoreListingFull(listing, soldPrices);
    assert.equal(result.listing_id, 'TEST001');
  });

  test('deal_score is a number in 0–100', () => {
    const result = scoreListingFull(listing, soldPrices);
    assert.ok(typeof result.deal_score === 'number');
    assert.ok(result.deal_score >= 0 && result.deal_score <= 100);
  });

  test('profitable listing gets a high deal score', () => {
    // Selling at $400 when comps are ~$800 is a strong deal
    const result = scoreListingFull(listing, soldPrices);
    assert.ok(result.deal_score > 70, `Expected score > 70, got ${result.deal_score}`);
  });

  test('empty soldPrices results in low confidence', () => {
    const result = scoreListingFull(listing, []);
    assert.ok(result.confidence < 0.5);
  });
});
