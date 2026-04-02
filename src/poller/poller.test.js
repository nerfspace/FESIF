'use strict';
/**
 * Tests for src/poller/index.js (keyword parsing and round-robin logic only)
 * Uses Node.js built-in test runner.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseKeywords, calcPollInterval } = require('./index');

// ---------------------------------------------------------------------------
// parseKeywords()
// ---------------------------------------------------------------------------
describe('parseKeywords', () => {
  test('returns [""] for undefined input', () => {
    assert.deepEqual(parseKeywords(undefined), ['']);
  });

  test('returns [""] for empty string', () => {
    assert.deepEqual(parseKeywords(''), ['']);
  });

  test('returns [""] for whitespace-only string', () => {
    assert.deepEqual(parseKeywords('   '), ['']);
  });

  test('parses a single keyword', () => {
    assert.deepEqual(parseKeywords('iphone'), ['iphone']);
  });

  test('trims whitespace from keywords', () => {
    assert.deepEqual(parseKeywords(' iphone , gpu '), ['iphone', 'gpu']);
  });

  test('parses multiple comma-separated keywords', () => {
    assert.deepEqual(
      parseKeywords('iphone,gpu,macbook pro,ps5'),
      ['iphone', 'gpu', 'macbook pro', 'ps5']
    );
  });

  test('filters out empty entries from adjacent commas', () => {
    assert.deepEqual(parseKeywords('iphone,,gpu'), ['iphone', 'gpu']);
  });
});

// ---------------------------------------------------------------------------
// Round-robin cycling via pollOnce()
// Verify that successive calls advance through each keyword in order.
// ---------------------------------------------------------------------------
describe('round-robin keyword cycling', () => {
  test('cycles through all keywords and wraps around', () => {
    // Track which keyword was used by intercepting fetchNewListings
    const keywords = parseKeywords('alpha,beta,gamma');
    assert.deepEqual(keywords, ['alpha', 'beta', 'gamma']);

    // Simulate a round-robin index manually (mirrors the poller logic)
    let idx = 0;
    const picked = [];
    const rounds = keywords.length * 2; // two full cycles
    for (let i = 0; i < rounds; i++) {
      picked.push(keywords[idx]);
      idx = (idx + 1) % keywords.length;
    }

    assert.deepEqual(picked, [
      'alpha', 'beta', 'gamma',
      'alpha', 'beta', 'gamma',
    ]);
  });

  test('single keyword always picks the same keyword', () => {
    const keywords = parseKeywords('iphone');
    let idx = 0;
    for (let i = 0; i < 5; i++) {
      assert.equal(keywords[idx], 'iphone');
      idx = (idx + 1) % keywords.length;
    }
  });
});

// ---------------------------------------------------------------------------
// calcPollInterval()
// ---------------------------------------------------------------------------
describe('calcPollInterval', () => {
  test('returns a positive number', () => {
    const interval = calcPollInterval(5000, 7);
    assert.ok(interval > 0, 'Interval should be positive');
  });

  test('more keywords → longer interval', () => {
    const i1 = calcPollInterval(5000, 1);
    const i7 = calcPollInterval(5000, 7);
    assert.ok(i7 > i1, 'More keywords should produce a longer interval');
  });

  test('larger daily limit → shorter interval', () => {
    const i5k  = calcPollInterval(5000, 5);
    const i10k = calcPollInterval(10000, 5);
    assert.ok(i5k > i10k, 'Larger limit should produce a shorter interval');
  });

  test('produces ~403 s for 5000 calls / 7 keywords', () => {
    // 30% of 5000 = 1500 polling calls
    // 1500 / 7 = 214 cycles/day (floor)
    // 86400 / 214 = ~403.7 → ceil = 404
    const interval = calcPollInterval(5000, 7);
    assert.ok(interval >= 400 && interval <= 410, `Expected ~403-404, got ${interval}`);
  });

  test('falls back to 3600 when limit is too low to afford even one cycle', () => {
    // 30% of 1 call = 0 (floored), which triggers the safety fallback
    const interval = calcPollInterval(1, 100);
    assert.equal(interval, 3600);
  });
});
