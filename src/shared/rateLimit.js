'use strict';
/**
 * shared/rateLimit.js
 * Daily eBay API call counter – Redis-backed with in-memory fallback.
 *
 * Shared by the poller (Browse API) and analyzer (Finding API) to enforce
 * EBAY_DAILY_API_LIMIT across containers.  When Redis is unavailable each
 * container maintains its own counter (less accurate, still functional).
 *
 * Exported functions:
 *   incrementApiCounter()    – increment and return new daily total
 *   getApiCallsRemaining()   – calls left today
 *   canMakeApiCall()         – true when budget remains
 */

const Redis = require('ioredis');

const DAILY_LIMIT = Number(process.env.EBAY_DAILY_API_LIMIT) || 5000;

// Redis key TTL: 25 hours ensures the key outlives the full UTC day even if
// written just before midnight, while still expiring well within the next day.
const REDIS_KEY_TTL_SECONDS = 90000;

// ---------------------------------------------------------------------------
// Redis client (lazy singleton)
// ---------------------------------------------------------------------------
let _redis = null;

function getRedisClient() {
  if (_redis) return _redis;
  _redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    // Stop reconnecting after the first failed attempt so the process can
    // exit cleanly (important for tests and for graceful shutdown).
    retryStrategy: () => null,
  });
  // Suppress unhandled-error events – failures are caught per-command
  _redis.on('error', () => {});
  return _redis;
}

// ---------------------------------------------------------------------------
// In-memory fallback counter
// ---------------------------------------------------------------------------
/** @type {{ date: string, count: number }} */
const _mem = { date: '', count: 0 };

function _today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function _memGet() {
  const d = _today();
  if (_mem.date !== d) { _mem.date = d; _mem.count = 0; }
  return _mem.count;
}

function _memIncr() {
  const d = _today();
  if (_mem.date !== d) { _mem.date = d; _mem.count = 0; }
  return ++_mem.count;
}

// ---------------------------------------------------------------------------
// Redis key (rotates daily)
// ---------------------------------------------------------------------------
function _redisKey() {
  return `fesif:api_calls:${_today()}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Increment the daily API call counter.
 * @returns {Promise<number>} New total for today
 */
async function incrementApiCounter() {
  try {
    const client = getRedisClient();
    const key = _redisKey();
    const count = await client.incr(key);
    // Set expiry on first write (25 h ensures the key outlives the UTC day)
    if (count === 1) await client.expire(key, REDIS_KEY_TTL_SECONDS);
    return count;
  } catch {
    return _memIncr();
  }
}

/**
 * Return the number of API calls remaining today.
 * @returns {Promise<number>}
 */
async function getApiCallsRemaining() {
  try {
    const client = getRedisClient();
    const val = await client.get(_redisKey());
    return Math.max(0, DAILY_LIMIT - (Number(val) || 0));
  } catch {
    return Math.max(0, DAILY_LIMIT - _memGet());
  }
}

/**
 * Returns true when there is still budget for at least one API call today.
 * @returns {Promise<boolean>}
 */
async function canMakeApiCall() {
  return (await getApiCallsRemaining()) > 0;
}

module.exports = {
  incrementApiCounter,
  getApiCallsRemaining,
  canMakeApiCall,
  DAILY_LIMIT,
  _mem,   // exposed for unit tests
};
