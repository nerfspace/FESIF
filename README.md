# FESIF – eBay Arbitrage Monitor
Finds nice deals on ebay

A real-time system that continuously monitors newly listed eBay items and identifies profitable resale opportunities. Detection latency is **under 20 seconds** by default (randomized polling every 5–15 s).

---

## Architecture

The system is composed of four independent, horizontally-scalable services:

| Service | File | Role |
|---------|------|------|
| **Listing Poller** | `src/poller/index.js` | Scrapes eBay (newest-first, first page only), deduplicates, pushes to queue |
| **Queue** | `src/shared/queue.js` | BullMQ over Redis – decouples scraping from analysis |
| **Deal Analyzer** | `src/analyzer/index.js` | Consumes queue jobs, scores each listing, stores results |
| **API Layer** | `src/api/index.js` | Express – exposes `GET /deals` for the front-end |

```
eBay ──► Poller ──► Redis/BullMQ ──► Analyzer ──► SQLite
                                                      │
                                              Express API ──► Client
```

---

## Quick Start (Docker Compose)

```bash
git clone ...
cd FESIF
cp .env.example .env     # edit as needed
docker-compose up --build
```

The API will be available at `http://localhost:3000`.

---

## Running services individually

> Requires Node ≥ 22.5 and a running Redis instance.

```bash
npm install

# In separate terminals:
npm run start:poller    # fetches new listings → queue
npm run start:analyzer  # analyzes listings ← queue → database
npm run start:api       # serves /deals endpoint
```

---

## API

### `GET /deals`

Returns top deals above a minimum deal score.

**Query parameters**

| Param | Default | Description |
|-------|---------|-------------|
| `min_score` | `80` | Minimum deal score (0–100) |
| `limit` | `50` | Max results (1–100) |

**Response** – JSON array:

```json
[
  {
    "listing_id":       "123456789012",
    "title":            "Apple iPhone 14 Pro 256GB",
    "price":            399.99,
    "deal_score":       87.4,
    "estimated_profit": 214.55,
    "listing_url":      "https://www.ebay.com/itm/123456789012"
  }
]
```

**Score interpretation**

| Range | Meaning |
|-------|---------|
| 90–100 | Elite deal |
| 80–89  | Strong flip opportunity |
| 70–79  | Moderate opportunity |
| < 70   | Ignore |

### `GET /health`

Liveness probe – returns `{ "status": "ok" }`.

---

## Deal Scoring Pipeline (12 steps)

1. **Feature Extraction** – price, shipping, condition, category, seller feedback
2. **Product Identification** – regex/NLP brand & model detection from title
3. **Comparable Sales Lookup** – median of eBay sold listings (avoids outliers)
4. **True Purchase Cost** – `listing_price + shipping_cost`
5. **Net Resale Value** – `median_comp - 16% fees - category shipping estimate`
6. **Profit** – `net_resale_value - true_cost`
7. **Risk Adjustment** – penalty for low feedback, "untested", "for parts", etc. → multiplier in [0.5, 1.0]
8. **Liquidity Score** – sell-through rate (sold ÷ listed)
9. **Ignorance Signals** – boost when seller appears unaware of value
10. **Deal Score** – weighted formula scaled to 0–100
11. **Database Storage** – persisted to `listings` and `scores` tables
12. **API** – served via `GET /deals?min_score=80`

**Weighted formula:**
```
deal_score = (0.4 × normalized_profit)
           + (0.3 × discount_vs_market)
           + (0.2 × sell_through_rate)
           − (0.1 × risk_penalty)
           + (0.1 × ignorance_boost)
```
All sub-scores are normalised to [0, 1] before weighting.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `127.0.0.1` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `DB_PATH` | `./fesif.db` | SQLite database file path |
| `EBAY_SEARCH_KEYWORD` | *(empty)* | Comma-separated keywords to search (e.g. `iphone,gpu,macbook pro`). The poller cycles through them round-robin. Blank = all categories |
| `EBAY_APP_ID` | *(empty)* | eBay application client ID (see [Get eBay API Keys](#get-ebay-api-keys)) |
| `EBAY_CERT_ID` | *(empty)* | eBay application client secret |
| `POLL_INTERVAL_MIN` | `5` | Minimum seconds between polls |
| `POLL_INTERVAL_MAX` | `15` | Maximum seconds between polls |
| `MIN_DEAL_SCORE` | `80` | Default minimum score for `/deals` |
| `API_PORT` | `3000` | Express listen port |
| `PROXIES` | *(empty)* | Comma-separated proxy URLs |

---

## Get eBay API Keys

The app uses the [eBay Browse API](https://developer.ebay.com/api-docs/buy/browse/overview.html) for reliable listing discovery when API credentials are provided.

1. Go to [https://developer.ebay.com](https://developer.ebay.com) and sign in (or create a free account).
2. Navigate to **My Account → Application Keysets**.
3. Create a new keyset for the **Production** environment.
4. Copy your **App ID (Client ID)** into `EBAY_APP_ID` and your **Cert ID (Client Secret)** into `EBAY_CERT_ID` in your `.env` file.

```
EBAY_APP_ID=YourApp-XXXX-XXXX-XXXX-XXXXXXXXXXXX
EBAY_CERT_ID=YourCert-XXXX-XXXX-XXXX-XXXXXXXXXXXX
```

> **Fallback**: If `EBAY_APP_ID` is not set, the app automatically falls back to HTML scraping and logs a warning. All functionality continues to work, but HTML scraping is more fragile and may be rate-limited by eBay.

---

## Tests

```bash
npm test
```

Unit tests cover the scoring pipeline, all parsing helpers, and the database layer using Node's built-in `node:test` runner (no external test framework).

---

## Scaling

- Run **multiple analyzer workers** (`docker-compose up --scale analyzer=4`)  
  – BullMQ distributes jobs automatically.
- **Poller** and **API** scale independently as separate containers.
- Replace the rule-based scoring with an ML model by swapping out `scoreListingFull` in `src/shared/scoring.js`.
