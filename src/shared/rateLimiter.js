'use strict';
/**
 * shared/rateLimiter.js
 * Redis-backed daily API call budget tracker.
 *
 * Total budget:   EBAY_API_DAILY_LIMIT calls/day  (default 5000)
 * Polling budget: 30 % → used by the poller when Browse API is enabled
 * Comps budget:   70 % → used by the analyzer for Finding API sold lookups
 *
 * Counter keys are named:
 *   ebay:api:poll:{YYYY-MM-DD}
 *   ebay:api:comps:{YYYY-MM-DD}
 *
 * Each key expires after 25 hours so it resets automatically every day even if
 * the Redis server spans midnight in a different timezone.
 */

const Redis = require('ioredis');

const DAILY_LIMIT  = Number(process.env.EBAY_API_DAILY_LIMIT) || 5000;
const POLL_BUDGET  = Math.floor(DAILY_LIMIT * 0.30);   // 1500
const COMPS_BUDGET = Math.floor(DAILY_LIMIT * 0.70);   // 3500

const TTL_SECONDS = 25 * 60 * 60;   // 25 hours — daily reset

let _redis;

function getRedis() {
  if (_redis) return _redis;
  _redis = new Redis({
    host:              process.env.REDIS_HOST || '127.0.0.1',
    port:              Number(process.env.REDIS_PORT) || 6379,
    lazyConnect:       true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  return _redis;
}

/**
 * Return today's UTC date string used as part of the Redis key.
 * `.toISOString()` always returns UTC regardless of local timezone, so the
 * daily budget resets at midnight UTC consistently across all containers.
 * @returns {string}  e.g. "2024-01-15"
 */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Lua script that atomically:
//   1. Increments the daily counter
//   2. Sets a 25-hour TTL on first write (so no INCR+EXPIRE race condition)
//   3. Returns 1 (allowed) or 0 (over budget, counter rolled back)
// Using a script removes the race window where multiple concurrent callers
// could each see count <= budget before any decrement is applied.
const CHECK_AND_INCREMENT_SCRIPT = `
local key    = KEYS[1]
local budget = tonumber(ARGV[1])
local ttl    = tonumber(ARGV[2])
local count  = redis.call('INCR', key)
if count == 1 then
  redis.call('EXPIRE', key, ttl)
end
if count > budget then
  redis.call('DECR', key)
  return 0
end
return 1
`;

/**
 * Atomically check whether we are under budget for `type` and, if so,
 * increment the counter.
 *
 * @param {'poll'|'comps'} type
 * @returns {Promise<boolean>}  true if the call is allowed (counter was incremented)
 */
async function checkAndIncrement(type) {
  const budget = type === 'poll' ? POLL_BUDGET : COMPS_BUDGET;
  const key    = `ebay:api:${type}:${todayKey()}`;
  const redis  = getRedis();

  const result = await redis.eval(
    CHECK_AND_INCREMENT_SCRIPT,
    1,          // number of KEYS arguments
    key,        // KEYS[1]
    budget,     // ARGV[1]
    TTL_SECONDS // ARGV[2]
  );

  return result === 1;
}

/**
 * Get the current daily call counts for monitoring / logging.
 * @returns {Promise<{poll: number, comps: number, pollBudget: number, compsBudget: number}>}
 */
async function getDailyCounts() {
  const redis = getRedis();
  const date  = todayKey();
  const [poll, comps] = await redis.mget(
    `ebay:api:poll:${date}`,
    `ebay:api:comps:${date}`,
  );
  return {
    poll:        Number(poll  || 0),
    comps:       Number(comps || 0),
    pollBudget:  POLL_BUDGET,
    compsBudget: COMPS_BUDGET,
  };
}

module.exports = { checkAndIncrement, getDailyCounts, POLL_BUDGET, COMPS_BUDGET };
