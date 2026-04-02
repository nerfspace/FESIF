'use strict';
/**
 * Tests for src/shared/scraper.js (parsing functions only – no live HTTP)
 * Uses Node.js built-in test runner.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePrice,
  parseFeedback,
  parseSearchResults,
  parseSoldPrices,
  parseFindingApiResponse,
  parseApiResponse,
  randomUserAgent,
  _tokenCache,
} = require('./scraper');

// ---------------------------------------------------------------------------
// parsePrice()
// ---------------------------------------------------------------------------
describe('parsePrice', () => {
  test('returns 0 for empty/null input', () => {
    assert.equal(parsePrice(''), 0);
    assert.equal(parsePrice(null), 0);
    assert.equal(parsePrice(undefined), 0);
  });

  test('parses simple dollar amount', () => {
    assert.equal(parsePrice('$12.99'), 12.99);
  });

  test('parses amount with comma', () => {
    assert.equal(parsePrice('$1,234.56'), 1234.56);
  });

  test('takes lower bound of price range', () => {
    // "$10.00 to $20.00" → 10.00
    assert.equal(parsePrice('$10.00 to $20.00'), 10);
  });
});

// ---------------------------------------------------------------------------
// parseFeedback()
// ---------------------------------------------------------------------------
describe('parseFeedback', () => {
  test('returns 0 for no feedback text', () => {
    assert.equal(parseFeedback(''), 0);
  });

  test('parses numeric feedback', () => {
    assert.equal(parseFeedback('Seller with 1234 feedback'), 1234);
  });

  test('strips commas', () => {
    assert.equal(parseFeedback('10,000 feedback'), 10000);
  });
});

// ---------------------------------------------------------------------------
// randomUserAgent()
// ---------------------------------------------------------------------------
describe('randomUserAgent', () => {
  test('returns a non-empty string', () => {
    const ua = randomUserAgent();
    assert.ok(typeof ua === 'string' && ua.length > 0);
  });

  test('returns different agents over multiple calls (probabilistic)', () => {
    const agents = new Set(Array.from({ length: 20 }, () => randomUserAgent()));
    assert.ok(agents.size > 1, 'Expected more than one unique user-agent');
  });
});

// ---------------------------------------------------------------------------
// parseSearchResults() – tested with minimal synthetic HTML
// ---------------------------------------------------------------------------

function makeItemHtml(id, title, price, shipping = '', feedback = '') {
  return `
    <li class="s-item">
      <a class="s-item__link" href="https://www.ebay.com/itm/${id}?hash=item1"></a>
      <div class="s-item__title">${title}</div>
      <span class="s-item__price">${price}</span>
      <span class="s-item__shipping">${shipping}</span>
      <span class="s-item__seller-info-text">${feedback}</span>
    </li>`;
}

describe('parseSearchResults', () => {
  test('parses a single valid listing', () => {
    const html = `<ul>${makeItemHtml('123456789012', 'Test Widget', '$29.99', '$5.00 shipping', '100 feedback')}</ul>`;
    const results = parseSearchResults(html);
    assert.equal(results.length, 1);
    assert.equal(results[0].listing_id, '123456789012');
    assert.equal(results[0].title, 'Test Widget');
    assert.equal(results[0].price, 29.99);
    assert.equal(results[0].shipping_cost, 5);
    assert.equal(results[0].seller_feedback, 100);
  });

  test('skips the phantom "Shop on eBay" row', () => {
    const html = `<ul>
      ${makeItemHtml('111111111111', 'Shop on eBay', '$9.99')}
      ${makeItemHtml('222222222222', 'Real Item', '$19.99')}
    </ul>`;
    const results = parseSearchResults(html);
    assert.equal(results.length, 1);
    assert.equal(results[0].listing_id, '222222222222');
  });

  test('treats "Free shipping" as 0 shipping cost', () => {
    const html = `<ul>${makeItemHtml('333333333333', 'Widget', '$50.00', 'Free shipping')}</ul>`;
    const results = parseSearchResults(html);
    assert.equal(results[0].shipping_cost, 0);
  });

  test('returns empty array for empty HTML', () => {
    const results = parseSearchResults('<html><body></body></html>');
    assert.equal(results.length, 0);
  });
});

// ---------------------------------------------------------------------------
// parseSoldPrices() – tested with minimal synthetic HTML
// ---------------------------------------------------------------------------
describe('parseSoldPrices', () => {
  test('parses multiple sold prices', () => {
    const html = `
      <ul>
        <li class="s-item"><span class="s-item__price">$100.00</span></li>
        <li class="s-item"><span class="s-item__price">$120.00</span></li>
        <li class="s-item"><span class="s-item__price">$90.00</span></li>
      </ul>`;
    const prices = parseSoldPrices(html);
    assert.equal(prices.length, 3);
    assert.ok(prices.includes(100));
    assert.ok(prices.includes(120));
    assert.ok(prices.includes(90));
  });

  test('returns empty array for no matches', () => {
    const prices = parseSoldPrices('<html></html>');
    assert.equal(prices.length, 0);
  });
});

// ---------------------------------------------------------------------------
// parseApiResponse() – eBay Browse API JSON parsing
// ---------------------------------------------------------------------------
describe('parseApiResponse', () => {
  test('returns empty array for missing itemSummaries', () => {
    assert.deepEqual(parseApiResponse({}), []);
    assert.deepEqual(parseApiResponse({ itemSummaries: [] }), []);
  });

  test('parses a typical Browse API item', () => {
    const data = {
      itemSummaries: [
        {
          itemId: 'v1|123456789012|0',
          title: 'Apple iPhone 14 Pro 256GB',
          price: { value: '399.99', currency: 'USD' },
          shippingOptions: [{ shippingCost: { value: '5.00', currency: 'USD' } }],
          seller: { feedbackScore: 2500 },
          categories: [{ categoryId: '9355', categoryName: 'Cell Phones & Smartphones' }],
          itemWebUrl: 'https://www.ebay.com/itm/123456789012',
        },
      ],
    };
    const results = parseApiResponse(data);
    assert.equal(results.length, 1);
    assert.equal(results[0].listing_id, '123456789012');
    assert.equal(results[0].title, 'Apple iPhone 14 Pro 256GB');
    assert.equal(results[0].price, 399.99);
    assert.equal(results[0].shipping_cost, 5);
    assert.equal(results[0].seller_feedback, 2500);
    assert.equal(results[0].category, 'Cell Phones & Smartphones');
    assert.equal(results[0].listing_url, 'https://www.ebay.com/itm/123456789012');
  });

  test('treats missing shippingOptions as 0 shipping cost', () => {
    const data = {
      itemSummaries: [
        {
          itemId: 'v1|222222222222|0',
          title: 'Test Item',
          price: { value: '50.00', currency: 'USD' },
          itemWebUrl: 'https://www.ebay.com/itm/222222222222',
        },
      ],
    };
    const results = parseApiResponse(data);
    assert.equal(results[0].shipping_cost, 0);
  });

  test('treats zero-value shippingCost as free shipping', () => {
    const data = {
      itemSummaries: [
        {
          itemId: 'v1|333333333333|0',
          title: 'Free Ship Item',
          price: { value: '25.00', currency: 'USD' },
          shippingOptions: [{ shippingCost: { value: '0.00', currency: 'USD' } }],
          itemWebUrl: 'https://www.ebay.com/itm/333333333333',
        },
      ],
    };
    const results = parseApiResponse(data);
    assert.equal(results[0].shipping_cost, 0);
  });

  test('skips items with no price', () => {
    const data = {
      itemSummaries: [
        {
          itemId: 'v1|444444444444|0',
          title: 'No Price Item',
          itemWebUrl: 'https://www.ebay.com/itm/444444444444',
        },
      ],
    };
    assert.equal(parseApiResponse(data).length, 0);
  });

  test('skips items with zero or negative price', () => {
    const data = {
      itemSummaries: [
        {
          itemId: 'v1|555555555555|0',
          title: 'Zero Price',
          price: { value: '0.00', currency: 'USD' },
          itemWebUrl: 'https://www.ebay.com/itm/555555555555',
        },
      ],
    };
    assert.equal(parseApiResponse(data).length, 0);
  });

  test('defaults missing seller and category fields to safe values', () => {
    const data = {
      itemSummaries: [
        {
          itemId: 'v1|666666666666|0',
          title: 'Sparse Item',
          price: { value: '10.00', currency: 'USD' },
          itemWebUrl: 'https://www.ebay.com/itm/666666666666',
        },
      ],
    };
    const results = parseApiResponse(data);
    assert.equal(results[0].seller_feedback, 0);
    assert.equal(results[0].category, '');
  });

  test('parses multiple items correctly', () => {
    const data = {
      itemSummaries: [
        {
          itemId: 'v1|100000000001|0',
          title: 'Item A',
          price: { value: '10.00', currency: 'USD' },
          itemWebUrl: 'https://www.ebay.com/itm/100000000001',
        },
        {
          itemId: 'v1|100000000002|0',
          title: 'Item B',
          price: { value: '20.00', currency: 'USD' },
          itemWebUrl: 'https://www.ebay.com/itm/100000000002',
        },
      ],
    };
    const results = parseApiResponse(data);
    assert.equal(results.length, 2);
    assert.equal(results[0].listing_id, '100000000001');
    assert.equal(results[1].listing_id, '100000000002');
  });
});

// ---------------------------------------------------------------------------
// parseFindingApiResponse() – eBay Finding API JSON parsing
// ---------------------------------------------------------------------------
describe('parseFindingApiResponse', () => {
  test('returns empty array for empty/missing response', () => {
    assert.deepEqual(parseFindingApiResponse({}), []);
    assert.deepEqual(parseFindingApiResponse(null), []);
    assert.deepEqual(
      parseFindingApiResponse({ findCompletedItemsResponse: [{}] }),
      []
    );
  });

  test('parses sold prices from a typical Finding API response', () => {
    const data = {
      findCompletedItemsResponse: [
        {
          searchResult: [
            {
              item: [
                { sellingStatus: [{ currentPrice: [{ __value__: '299.99' }] }] },
                { sellingStatus: [{ currentPrice: [{ __value__: '349.00' }] }] },
                { sellingStatus: [{ currentPrice: [{ __value__: '275.50' }] }] },
              ],
            },
          ],
        },
      ],
    };
    const prices = parseFindingApiResponse(data);
    assert.equal(prices.length, 3);
    assert.ok(prices.includes(299.99));
    assert.ok(prices.includes(349));
    assert.ok(prices.includes(275.5));
  });

  test('skips items with zero or invalid prices', () => {
    const data = {
      findCompletedItemsResponse: [
        {
          searchResult: [
            {
              item: [
                { sellingStatus: [{ currentPrice: [{ __value__: '0.00' }] }] },
                { sellingStatus: [{ currentPrice: [{ __value__: 'N/A' }] }] },
                { sellingStatus: [{ currentPrice: [{ __value__: '100.00' }] }] },
              ],
            },
          ],
        },
      ],
    };
    const prices = parseFindingApiResponse(data);
    assert.equal(prices.length, 1);
    assert.equal(prices[0], 100);
  });
});

// ---------------------------------------------------------------------------
// _tokenCache – OAuth2 token caching state
// ---------------------------------------------------------------------------
describe('_tokenCache', () => {
  beforeEach(() => {
    // Reset cache before each test in this suite
    _tokenCache.token     = null;
    _tokenCache.expiresAt = 0;
  });

  test('starts empty', () => {
    assert.equal(_tokenCache.token, null);
    assert.equal(_tokenCache.expiresAt, 0);
  });

  test('can be primed with a valid token', () => {
    const ONE_HOUR_MS = 3_600_000;
    _tokenCache.token     = 'fake-access-token';
    _tokenCache.expiresAt = Date.now() + ONE_HOUR_MS;
    assert.equal(_tokenCache.token, 'fake-access-token');
    assert.ok(_tokenCache.expiresAt > Date.now());
  });

  test('expiresAt in the past signals a stale cache', () => {
    _tokenCache.token     = 'old-token';
    _tokenCache.expiresAt = Date.now() - 1; // already expired
    assert.ok(_tokenCache.expiresAt < Date.now(), 'Token should be considered expired');
  });
});
