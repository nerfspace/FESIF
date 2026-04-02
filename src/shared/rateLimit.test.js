'use strict';
/**
 * Tests for src/shared/rateLimit.js
 * Uses the in-memory fallback (no Redis required) by running without a Redis server.
 * Uses Node.js built-in test runner.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Set a known daily limit for predictable test expectations
process.env.EBAY_DAILY_API_LIMIT = '10';
// Point at a Redis host that will never connect so tests use the in-memory fallback
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '19999'; // unused port → connection refused → in-memory fallback

// Fresh require so the module picks up the env vars above
let rateLimit;
function freshModule() {
  // Clear the module cache to reset the singleton Redis client and memory counter
  for (const key of Object.keys(require.cache)) {
    if (key.includes('rateLimit')) delete require.cache[key];
  }
  rateLimit = require('./rateLimit');
}

describe('rateLimit – in-memory fallback', () => {
  beforeEach(() => {
    freshModule();
    // Reset the in-memory counter for a clean slate
    rateLimit._mem.date  = '';
    rateLimit._mem.count = 0;
  });

  test('canMakeApiCall() returns true when counter is 0', async () => {
    assert.equal(await rateLimit.canMakeApiCall(), true);
  });

  test('incrementApiCounter() increments the counter', async () => {
    const c1 = await rateLimit.incrementApiCounter();
    const c2 = await rateLimit.incrementApiCounter();
    assert.ok(c2 > c1, 'Second increment should be larger than first');
  });

  test('getApiCallsRemaining() decreases after increments', async () => {
    const before = await rateLimit.getApiCallsRemaining();
    await rateLimit.incrementApiCounter();
    const after = await rateLimit.getApiCallsRemaining();
    assert.equal(after, before - 1);
  });

  test('canMakeApiCall() returns false when daily limit is reached', async () => {
    // Exhaust the limit (set to 10 above)
    for (let i = 0; i < 10; i++) await rateLimit.incrementApiCounter();
    assert.equal(await rateLimit.canMakeApiCall(), false);
  });

  test('getApiCallsRemaining() never returns a negative value', async () => {
    // Exceed the limit
    for (let i = 0; i < 15; i++) await rateLimit.incrementApiCounter();
    const remaining = await rateLimit.getApiCallsRemaining();
    assert.equal(remaining, 0);
  });

  test('DAILY_LIMIT matches the env variable', () => {
    assert.equal(rateLimit.DAILY_LIMIT, 10);
  });

  test('in-memory counter resets when the date changes', async () => {
    // Simulate a prior day's count
    rateLimit._mem.date  = '2000-01-01';
    rateLimit._mem.count = 9999;

    // A call on "today" should start from 1
    const count = await rateLimit.incrementApiCounter();
    assert.equal(count, 1, 'Counter should reset to 1 for a new day');
  });
});
