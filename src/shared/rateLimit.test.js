'use strict';
/**
 * Tests for src/shared/rateLimit.js
 * Uses a simple in-memory Redis mock so no real Redis connection is needed.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('./rateLimit');

// ---------------------------------------------------------------------------
// Minimal in-memory Redis mock
// ---------------------------------------------------------------------------
function makeRedisMock() {
  const store = new Map();
  return {
    async incr(key) {
      const val = (store.get(key) || 0) + 1;
      store.set(key, val);
      return val;
    },
    async expire() {
      return 1;
    },
    async get(key) {
      const v = store.get(key);
      return v !== undefined ? String(v) : null;
    },
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// createRateLimiter() tests
// ---------------------------------------------------------------------------
describe('createRateLimiter', () => {
  test('exposes dailyLimit, pollBudget, compsBudget', () => {
    const rl = createRateLimiter(makeRedisMock(), { dailyLimit: 5000 });
    assert.equal(rl.dailyLimit, 5000);
    assert.equal(rl.pollBudget, 1500);   // 30%
    assert.equal(rl.compsBudget, 3500);  // 70%
  });

  test('trackCall increments and callsToday reflects it', async () => {
    const redis = makeRedisMock();
    const rl = createRateLimiter(redis, { dailyLimit: 5000 });
    assert.equal(await rl.callsToday(), 0);
    await rl.trackCall();
    await rl.trackCall();
    assert.equal(await rl.callsToday(), 2);
  });

  test('canPoll returns true when under poll budget', async () => {
    const redis = makeRedisMock();
    const rl = createRateLimiter(redis, { dailyLimit: 5000 });
    assert.equal(await rl.canPoll(), true);
  });

  test('canPoll returns false when poll budget exhausted', async () => {
    const redis = makeRedisMock();
    const rl = createRateLimiter(redis, { dailyLimit: 10 });
    // pollBudget = 3 (floor(10 * 0.3))
    assert.equal(await rl.canPoll(), true, 'should start within budget');
    for (let i = 0; i < 3; i++) await rl.trackCall();
    assert.equal(await rl.canPoll(), false);
  });

  test('canComps returns false when daily limit exhausted', async () => {
    const redis = makeRedisMock();
    const rl = createRateLimiter(redis, { dailyLimit: 5 });
    for (let i = 0; i < 5; i++) await rl.trackCall();
    assert.equal(await rl.canComps(), false);
  });

  test('pollIntervalMs scales with number of keywords', () => {
    const rl = createRateLimiter(makeRedisMock(), { dailyLimit: 5000 });
    // pollBudget = 1500; secondsPerCall = 86400/1500 = 57.6s
    const interval1 = rl.pollIntervalMs(1);
    const interval5 = rl.pollIntervalMs(5);
    assert.ok(interval1 > 0, 'interval should be positive');
    assert.ok(interval5 > interval1, '5 keywords should have longer interval');
    // With 5000 limit and 1 keyword: ~57.6s
    assert.ok(Math.abs(interval1 - 57600) < 1000, `expected ~57600ms, got ${interval1}`);
  });

  test('pollIntervalMs handles 0 keywords without throwing', () => {
    const rl = createRateLimiter(makeRedisMock(), { dailyLimit: 5000 });
    assert.ok(rl.pollIntervalMs(0) > 0);
  });
});
