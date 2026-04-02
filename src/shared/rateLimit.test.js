'use strict';
/**
 * Tests for src/shared/rateLimit.js
 * Uses Node.js built-in test runner.
 * All tests use the in-memory fallback (null redisClient).
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Load the module fresh for each describe block by clearing the module cache
// ---------------------------------------------------------------------------
function freshRateLimit(dailyLimit) {
  // Set env var before requiring so DAILY_LIMIT is picked up
  if (dailyLimit !== undefined) {
    process.env.EBAY_DAILY_API_LIMIT = String(dailyLimit);
  } else {
    delete process.env.EBAY_DAILY_API_LIMIT;
  }
  delete require.cache[require.resolve('./rateLimit')];
  return require('./rateLimit');
}

describe('rateLimit – in-memory fallback (no Redis)', () => {
  let rl;

  beforeEach(() => {
    rl = freshRateLimit(10); // small limit for tests
  });

  test('getApiCallsUsed returns 0 initially', async () => {
    const used = await rl.getApiCallsUsed(null);
    assert.equal(used, 0);
  });

  test('incrementApiCounter increments the counter', async () => {
    const n1 = await rl.incrementApiCounter(null);
    const n2 = await rl.incrementApiCounter(null);
    assert.equal(n1, 1);
    assert.equal(n2, 2);
  });

  test('canMakeApiCall returns true when under limit', async () => {
    assert.equal(await rl.canMakeApiCall(null), true);
  });

  test('canMakeApiCall returns false when limit is reached', async () => {
    // Exhaust the limit of 10
    for (let i = 0; i < 10; i++) {
      await rl.incrementApiCounter(null);
    }
    assert.equal(await rl.canMakeApiCall(null), false);
  });

  test('DAILY_LIMIT reflects EBAY_DAILY_API_LIMIT env var', () => {
    const rl2 = freshRateLimit(1234);
    assert.equal(rl2.DAILY_LIMIT, 1234);
  });

  test('DAILY_LIMIT defaults to 5000 when env var is not set', () => {
    const rl3 = freshRateLimit(undefined);
    assert.equal(rl3.DAILY_LIMIT, 5000);
  });
});
