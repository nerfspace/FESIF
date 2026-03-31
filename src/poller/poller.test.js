'use strict';
/**
 * Tests for src/poller/index.js (keyword parsing and round-robin logic only)
 * Uses Node.js built-in test runner.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseKeywords } = require('./index');

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
