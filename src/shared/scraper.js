'use strict';
/**
 * shared/scraper.js
 * Low-level eBay HTTP helpers: user-agent rotation, proxy support,
 * search-result parsing, and sold-listing (comps) fetching.
 */

const axios = require('axios');
const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// User-agent pool
// ---------------------------------------------------------------------------
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ---------------------------------------------------------------------------
// Optional proxy pool
// ---------------------------------------------------------------------------
const PROXIES = process.env.PROXIES
  ? process.env.PROXIES.split(',').map((p) => p.trim()).filter(Boolean)
  : [];

function randomProxy() {
  if (PROXIES.length === 0) return undefined;
  return PROXIES[Math.floor(Math.random() * PROXIES.length)];
}

// ---------------------------------------------------------------------------
// HTTP client factory
// ---------------------------------------------------------------------------
function buildAxiosConfig() {
  const config = {
    timeout: 15_000,
    headers: {
      'User-Agent': randomUserAgent(),
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      DNT: '1',
    },
  };

  const proxy = randomProxy();
  if (proxy) {
    try {
      const url = new URL(proxy);
      config.proxy = {
        protocol: url.protocol.replace(':', ''),
        host: url.hostname,
        port: Number(url.port) || 8080,
        auth:
          url.username && url.password
            ? { username: url.username, password: url.password }
            : undefined,
      };
    } catch {
      // Malformed proxy URL – ignore
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Parse price text → float
// ---------------------------------------------------------------------------
function parsePrice(text) {
  if (!text) return 0;
  // Handle price ranges like "$10.00 to $20.00" – take the lower bound
  const match = text.replace(/,/g, '').match(/[\d]+\.?\d*/);
  return match ? parseFloat(match[0]) : 0;
}

// ---------------------------------------------------------------------------
// Parse seller feedback score text → integer
// ---------------------------------------------------------------------------
function parseFeedback(text) {
  if (!text) return 0;
  const match = text.replace(/,/g, '').match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

// ---------------------------------------------------------------------------
// Fetch and parse the first page of eBay search results sorted by newest
// ---------------------------------------------------------------------------
/**
 * @param {string} [keyword='']  eBay search keyword
 * @returns {Promise<Array<{
 *   listing_id: string,
 *   title: string,
 *   price: number,
 *   shipping_cost: number,
 *   seller_feedback: number,
 *   category: string,
 *   listing_url: string
 * }>>}
 */
async function fetchNewListings(keyword = '') {
  const params = new URLSearchParams({
    _nkw: keyword,
    _sop: '10',   // sort by newly listed
    _pgn: '1',
    _ipg: '60',
  });
  const url = `https://www.ebay.com/sch/i.html?${params}`;

  const { data: html } = await axios.get(url, buildAxiosConfig());
  return parseSearchResults(html);
}

/**
 * Parse cheerio HTML from an eBay search results page.
 * Exported separately so it can be unit-tested without live HTTP calls.
 *
 * @param {string} html
 * @returns {Array<object>}
 */
function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const listings = [];

  // eBay wraps each result in .s-item (skip the first phantom item)
  $('.s-item').each((_, el) => {
    const $el = $(el);

    // listing_id is embedded in the item link
    const href = $el.find('.s-item__link').attr('href') || '';
    const idMatch = href.match(/\/(\d{10,})\?/);
    if (!idMatch) return;          // skip phantom / ad items

    const listing_id = idMatch[1];
    const title = $el.find('.s-item__title').text().trim();

    // Skip the "Shop on eBay" placeholder row
    if (!title || title.toLowerCase().includes('shop on ebay')) return;

    const priceText = $el.find('.s-item__price').first().text();
    const price = parsePrice(priceText);
    if (price <= 0) return;

    const shippingText = $el.find('.s-item__shipping, .s-item__freeXDays').text();
    let shipping_cost = 0;
    if (/free/i.test(shippingText)) {
      shipping_cost = 0;
    } else {
      shipping_cost = parsePrice(shippingText);
    }

    const feedbackText = $el.find('.s-item__seller-info-text').text();
    const seller_feedback = parseFeedback(feedbackText);

    // Category is not always present on the search page – use empty string
    const category = $el.find('.s-item__subtitle').text().trim() || '';

    const listing_url = href.split('?')[0] + '?' + href.split('?').slice(1).join('?');

    listings.push({
      listing_id,
      title,
      price,
      shipping_cost,
      seller_feedback,
      category,
      listing_url,
    });
  });

  return listings;
}

// ---------------------------------------------------------------------------
// Fetch sold / completed listings for comparable sales (comps)
// ---------------------------------------------------------------------------
/**
 * @param {string} query  Search string (brand + model)
 * @returns {Promise<number[]>}  Array of sold prices
 */
async function fetchSoldPrices(query) {
  const params = new URLSearchParams({
    _nkw: query,
    LH_Sold: '1',
    LH_Complete: '1',
    _sop: '13',   // most recent sold first
    _pgn: '1',
    _ipg: '40',
  });
  const url = `https://www.ebay.com/sch/i.html?${params}`;

  const { data: html } = await axios.get(url, buildAxiosConfig());
  return parseSoldPrices(html);
}

/**
 * Parse sold prices from HTML.
 * Exported for unit testing.
 *
 * @param {string} html
 * @returns {number[]}
 */
function parseSoldPrices(html) {
  const $ = cheerio.load(html);
  const prices = [];

  $('.s-item').each((_, el) => {
    const $el = $(el);
    // Sold price typically has a green colour class or is marked "Sold"
    const priceText =
      $el.find('.s-item__price').first().text() ||
      $el.find('.POSITIVE').text();
    const p = parsePrice(priceText);
    if (p > 0) prices.push(p);
  });

  return prices;
}

module.exports = {
  fetchNewListings,
  fetchSoldPrices,
  parseSearchResults,
  parseSoldPrices,
  parsePrice,
  parseFeedback,
  randomUserAgent,
};
