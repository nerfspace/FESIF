'use strict';
/**
 * shared/rateLimit.js
 * Redis-backed daily API call counter for eBay API rate limiting.
 *
 * The daily limit is split between two budgets:
 *   - 30% for polling (Browse API – new listing discovery)
 *   - 70% for comps  (Finding API – sold-price lookups)
 *
 * Keys:
 *   fesif:api_calls:YYYY-MM-DD  – running total of all API calls today (48h TTL)
 *
 * Usage:
 *   const rl = createRateLimiter(redisClient);
 *   await rl.trackCall();            // increment counter
 *   const ok = await rl.canPoll();   // false when polling budget exhausted
 *   const ok = await rl.canComps();  // false when comps budget exhausted
 *   const interval = rl.pollIntervalMs(numKeywords); // recommended poll delay
 */

const DAILY_LIMIT_DEFAULT = 5000;
const POLL_BUDGET_RATIO   = 0.30;   // 30% of daily limit reserved for polling
const COMPS_BUDGET_RATIO  = 0.70;   // 70% of daily limit reserved for comps
const TTL_SECONDS         = 48 * 60 * 60; // 48-hour TTL so the key outlasts midnight

/**
 * @param {import('ioredis').Redis} redis
 * @param {object}  [opts]
 * @param {number}  [opts.dailyLimit]  Total API calls allowed per day (default: EBAY_DAILY_API_LIMIT env or 5000)
 */
function createRateLimiter(redis, opts = {}) {
  const dailyLimit =
    opts.dailyLimit ||
    Number(process.env.EBAY_DAILY_API_LIMIT) ||
    DAILY_LIMIT_DEFAULT;

  const pollBudget  = Math.floor(dailyLimit * POLL_BUDGET_RATIO);
  const compsBudget = Math.floor(dailyLimit * COMPS_BUDGET_RATIO);

  /** Redis key for today's counter (UTC date). */
  function todayKey(now = new Date()) {
    return `fesif:api_calls:${now.toISOString().slice(0, 10)}`;
  }

  /**
   * Increment the daily call counter by 1.
   * Sets a 48-hour TTL on first creation so the key auto-expires.
   * @returns {Promise<number>}  New value after increment.
   */
  async function trackCall() {
    const key = todayKey();
    const val = await redis.incr(key);
    if (val === 1) {
      // First increment of the day – set TTL
      await redis.expire(key, TTL_SECONDS);
    }
    return val;
  }

  /**
   * Return the number of API calls recorded today.
   * @returns {Promise<number>}
   */
  async function callsToday() {
    const raw = await redis.get(todayKey());
    return raw ? parseInt(raw, 10) : 0;
  }

  /**
   * Return true if the polling budget has not been exceeded today.
   * @returns {Promise<boolean>}
   */
  async function canPoll() {
    const used = await callsToday();
    return used < pollBudget;
  }

  /**
   * Return true if the comps budget has not been exceeded today.
   * @returns {Promise<boolean>}
   */
  async function canComps() {
    const used = await callsToday();
    return used < dailyLimit;
  }

  /**
   * Calculate the recommended polling interval in milliseconds so that
   * polling stays within budget across a full 24-hour day.
   *
   * Formula: (86400 seconds / pollBudget) * numKeywords
   * Each poll cycle covers one keyword, so we multiply by the number of
   * keywords to get the per-keyword interval.
   *
   * @param {number} numKeywords  Number of search keywords being cycled.
   * @returns {number}  Interval in milliseconds.
   */
  function pollIntervalMs(numKeywords = 1) {
    const n = Math.max(1, numKeywords);
    // seconds per API call for polls: (24h * 3600s) / pollBudget
    // one full keyword rotation = n calls, so wait n * secondsPerCall
    const secondsPerCall = (24 * 3600) / pollBudget;
    return Math.round(secondsPerCall * n * 1000);
  }

  return {
    trackCall,
    callsToday,
    canPoll,
    canComps,
    pollIntervalMs,
    dailyLimit,
    pollBudget,
    compsBudget,
  };
}

module.exports = { createRateLimiter };
