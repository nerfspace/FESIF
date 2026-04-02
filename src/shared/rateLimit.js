'use strict';
/**
 * shared/rateLimit.js
 * Shared daily API call counter stored in Redis.
 *
 * Every eBay API call (Browse API + Finding API) should call
 * incrementApiCounter() so the total stays within the daily quota.
 *
 * Redis key format: fesif:api_calls:YYYY-MM-DD  (TTL 48 h)
 * Falls back to a simple in-memory counter when Redis is unavailable.
 */

const DAILY_LIMIT = Number(process.env.EBAY_DAILY_API_LIMIT) || 5000;

// In-memory fallback counter (used when Redis is not reachable)
let _memCounter = 0;
let _memDate = _todayKey();

function _todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function _redisKey() {
  return `fesif:api_calls:${_todayKey()}`;
}

/**
 * Increment the daily API call counter.
 * @param {import('ioredis').Redis|null} redisClient  Pass null to use in-memory fallback.
 * @returns {Promise<number>}  New total for today
 */
async function incrementApiCounter(redisClient) {
  if (redisClient) {
    try {
      const key   = _redisKey();
      const count = await redisClient.incr(key);
      // Set TTL to 48 h on first write so the key auto-expires
      if (count === 1) {
        await redisClient.expire(key, 48 * 60 * 60);
      }
      return count;
    } catch {
      // Redis unavailable – fall through to in-memory
    }
  }

  const today = _todayKey();
  if (_memDate !== today) {
    _memCounter = 0;
    _memDate    = today;
  }
  _memCounter += 1;
  return _memCounter;
}

/**
 * Read how many API calls have been made today.
 * @param {import('ioredis').Redis|null} redisClient
 * @returns {Promise<number>}
 */
async function getApiCallsUsed(redisClient) {
  if (redisClient) {
    try {
      const val = await redisClient.get(_redisKey());
      return val ? parseInt(val, 10) : 0;
    } catch {
      // Fall through
    }
  }

  const today = _todayKey();
  if (_memDate !== today) return 0;
  return _memCounter;
}

/**
 * Returns true when there is still budget to make another API call today.
 * @param {import('ioredis').Redis|null} redisClient
 * @returns {Promise<boolean>}
 */
async function canMakeApiCall(redisClient) {
  const used = await getApiCallsUsed(redisClient);
  return used < DAILY_LIMIT;
}

module.exports = {
  incrementApiCounter,
  getApiCallsUsed,
  canMakeApiCall,
  DAILY_LIMIT,
};
