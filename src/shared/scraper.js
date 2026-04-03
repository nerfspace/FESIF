'use strict';
/**
 * shared/scraper.js
 * Low-level eBay HTTP helpers: user-agent rotation, proxy support,
 * search-result parsing, and sold-listing (comps) fetching.
 *
 * When EBAY_APP_ID and EBAY_CERT_ID are set, fetchNewListings() uses the
 * official eBay Browse API (more reliable, no HTML scraping).  If the
 * credentials are absent the function falls back to the legacy HTML-scraping
 * path so the app still works without API keys.
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
// eBay Browse API – OAuth2 token management
// ---------------------------------------------------------------------------

/**
 * Cached OAuth2 token.  Mutated in-place so the exported reference stays
 * valid for test code that reads the cache directly.
 * @type {{ token: string|null, expiresAt: number }}
 */
const _tokenCache = { token: null, expiresAt: 0 };

/**
 * Obtain an OAuth2 client-credentials access token from eBay.
 * Returns the cached token if it has not yet expired (60-second buffer).
 *
 * @returns {Promise<string>}
 */
async function getEbayToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }

  const appId  = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');

  const { data } = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15_000,
    }
  );

  _tokenCache.token     = data.access_token;
  _tokenCache.expiresAt = Date.now() + (data.expires_in - 60) * 1000;

  return _tokenCache.token;
}

// ---------------------------------------------------------------------------
// eBay Browse API – response parsing
// ---------------------------------------------------------------------------

/**
 * Convert an eBay Browse API `search` response body into the standard
 * listing shape used by the rest of the app.
 *
 * @param {object} data  Parsed JSON from the Browse API
 * @returns {Array<{ listing_id: string, title: string, price: number, shipping_cost: number, seller_feedback: number, category: string, listing_url: string }>} 
 */
function parseApiResponse(data) {
  const items = data.itemSummaries || [];
  return items
    .map((item) => {
      // itemId format: "v1|123456789012|0"  – extract the numeric part
      const idMatch = (item.itemId || '').match(/v1\|(\d+)/);
      const listing_id = idMatch ? idMatch[1] : (item.itemId || '');
      if (!listing_id) return null;

      const price = item.price ? parseFloat(item.price.value) : 0;
      if (price <= 0) return null;

      const shippingOpts = item.shippingOptions || [];
      let shipping_cost = 0;
      if (shippingOpts.length > 0) {
        const costVal = shippingOpts[0]?.shippingCost?.value;
        shipping_cost = costVal ? parseFloat(costVal) : 0;
      }

      return {
        listing_id,
        title:           item.title || '',
        price,
        shipping_cost,
        seller_feedback: item.seller?.feedbackScore || 0,
        category:        item.categories?.[0]?.categoryName || '',
        listing_url:     item.itemWebUrl || '',
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Fetch and parse the first page of eBay search results sorted by newest
// ---------------------------------------------------------------------------

/**
 * HTML-scraping fallback implementation (used when API keys are absent).
 *
 * @param {string} keyword
 * @returns {Promise<Array<object>>}
 */
async function fetchNewListingsHtml(keyword) {
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
 * Fetch new listings.  Uses the eBay Browse API when EBAY_APP_ID is set,
 * otherwise falls back to HTML scraping.
 *
 * @param {string} [keyword='']  eBay search keyword
 * @returns {Promise<Array<{ listing_id: string, title: string, price: number, shipping_cost: number, seller_feedback: number, category: string, listing_url: string }>>}
 */
async function fetchNewListings(keyword = '') {
  const appId = process.env.EBAY_APP_ID;

  if (!appId) {
    console.warn(
      '[scraper] EBAY_APP_ID not set – falling back to HTML scraping. ' +
      'Set EBAY_APP_ID and EBAY_CERT_ID in .env for better reliability.'
    );
    return fetchNewListingsHtml(keyword);
  }

  const token = await getEbayToken();

  const params = new URLSearchParams({
    sort:  'newlyListed',
    limit: '50',
  });
  if (keyword) params.set('q', keyword);
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`;

  const { data } = await axios.get(url, {
    timeout: 15_000,
    headers: {
      Authorization:              `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
  });

  return parseApiResponse(data);
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
// eBay Finding API – sold / completed listings (comps)
// ---------------------------------------------------------------------------

/**
 * Parse the JSON response from eBay's Finding API `findCompletedItems` call
 * into an array of sold prices.
 *
 * The Finding API returns a peculiar structure where every field is wrapped in
 * a single-element array:
 *   response.findCompletedItemsResponse[0].searchResult[0].item[*]
 *     .sellingStatus[0].convertedCurrentPrice[0].__value__
 *
 * @param {object} data  Parsed JSON from the Finding API
 * @returns {number[]}   Array of sold prices (> 0 only)
 */
function parseFindingApiSoldPrices(data) {
  try {
    const items =
      data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    return items
      .map((item) => {
        const priceObj =
          item?.sellingStatus?.[0]?.convertedCurrentPrice?.[0];
        return priceObj ? parseFloat(priceObj.__value__) : 0;
      })
      .filter((p) => p > 0);
  } catch {
    return [];
  }
}

/**
 * Fetch sold prices using the eBay Finding API `findCompletedItems` endpoint.
 * Requires EBAY_APP_ID to be set.
 *
 * NOTE: findCompletedItems only supports EndTimeNewest sort, NOT EndTimeSoonest.
 * Using EndTimeSoonest causes a 500 Internal Server Error from eBay.
 *
 * @param {string} query  Search string (brand + model)
 * @returns {Promise<number[]>}
 */
async function fetchSoldPricesApi(query) {
  const appId = process.env.EBAY_APP_ID;

  // Build the query string manually so that itemFilter(0) parentheses are
  // NOT percent-encoded — eBay's Finding API requires the literal form.
  const qsParts = [
    'OPERATION-NAME=findCompletedItems',
    'SERVICE-VERSION=1.0.0',
    `SECURITY-APPNAME=${encodeURIComponent(appId)}`,
    'RESPONSE-DATA-FORMAT=JSON',
    `keywords=${encodeURIComponent(query)}`,
    'itemFilter(0).name=SoldItemsOnly',
    'itemFilter(0).value=true',
    'paginationInput.entriesPerPage=40',
    'sortOrder=EndTimeNewest',
  ];
  const url = `https://svcs.ebay.com/services/search/FindingService/v1?${qsParts.join('&')}`;

  const { data } = await axios.get(url, { timeout: 15_000 });
  return parseFindingApiSoldPrices(data);
}

// ---------------------------------------------------------------------------
// Fetch sold / completed listings for comparable sales (comps)
// ---------------------------------------------------------------------------
/**
 * Fetch comparable sold prices.
 * Uses the eBay Finding API when EBAY_APP_ID is set, otherwise falls back to
 * HTML scraping.
 *
 * @param {string} query  Search string (brand + model)
 * @returns {Promise<number[]>}  Array of sold prices
 */
async function fetchSoldPrices(query) {
  if (process.env.EBAY_APP_ID) {
    return fetchSoldPricesApi(query);
  }

  // HTML-scraping fallback (no API keys configured)
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
  parseApiResponse,
  parseFindingApiSoldPrices,
  parsePrice,
  parseFeedback,
  randomUserAgent,
  _tokenCache,
};