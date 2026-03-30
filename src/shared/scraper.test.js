'use strict';
/**
 * Tests for src/shared/scraper.js (parsing functions only – no live HTTP)
 * Uses Node.js built-in test runner.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePrice,
  parseFeedback,
  parseSearchResults,
  parseSoldPrices,
  randomUserAgent,
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
