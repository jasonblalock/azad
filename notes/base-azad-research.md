# Base Azad Architecture Research

> **Scope:** Documents the original azad extension architecture as we found it — before our budget integration changes. Covers the base caching layers, scrape pipeline, storage keys, content script patterns, and what's ephemeral vs persisted. Preliminary notes; deep dive deferred to a future session. For our additions, see `budget-integration-architecture.md`.

## Storage Layers

Two distinct storage mechanisms:

- **`chrome.storage.sync`** — user settings only (key: `azad_settings`)
- **`chrome.storage.local`** — all cached data and scrape results

### LocalCacheImpl (`cachestuff.ts`)

Primary cache abstraction wrapping `chrome.storage.local`:
- LZ compression + JSON serialization
- Namespaced keys: `AZAD_<CACHENAME>_<KEY>`
- Used by transactions, request scheduler, periods

### Content Script Proxy Pattern

Content scripts cannot access `chrome.storage.local` directly. The extension uses message-passing:

- **Content scripts** → `CreateRealStoreProxy()` → sends `azad-cache-get/set/remove` messages to service worker
- **Background service worker** → `CreateRealStore()` → actual `chrome.storage.local` wrapper
- `registerCacheListenerInBackgroundPage()` in `background.ts` (~line 440) handles the proxy messages

Extension pages (like `categorize.html`) have direct `chrome.storage.local` access — no proxy needed.

## Scrape Pipeline

```
User selects date range in popup
  → control.ts sends "scrape_range" to background via port
    → background.ts handleMessageFromControl()

For transactions (table_type == 'transactions'):
  → Creates iframe worker at /cpe/yourpayments/transactions
  → iframe runs inject.ts → transaction.reallyScrapeAndPublish()
  → Two strategies: extractAllTransactionsWithNextButton (pagination)
                     or extractAllTransactionsWithScrolling (infinite scroll)
  → Results posted via port → background forwards to root content page
  → inject.ts receives 'transactions' message
  → fetchOrderDetailsForBudget() + displayTransactions()

For orders:
  → Forwards "scrape_range" to root content page
  → inject.ts → fetchAndShowOrdersByRange()
    → order.getOrdersByRange() → fetchYear() per year
      → olp.getHeaders() (dynamic fetch, cached except current year page 0)
      → order.create() per header
        → order_details.extractDetailPromise() (static fetch, cached)
        → pmt.fetch_payments() (static fetch, cached)
    → azad_table.display(orders, ...)
      → reallyDisplay() populates in-memory order_map, renders HTML table
```

## Caching: What's Persisted vs Ephemeral

### Persisted in `chrome.storage.local` (survives navigation, tab close, browser restart)

| Storage Key Pattern | Written By | Content |
|---|---|---|
| `AZAD_REQUESTSCHEDULER_<hash>` | `request_scheduler.ts` via `cachestuff` | Cached HTTP responses: order list pages, detail pages, payment pages, item category pages, tracking pages |
| `AZAD_TRANSACTIONS_ALL_TRANSACTIONS` | `transaction.ts` via `cachestuff` | All known transactions (LZ-compressed JSON, double-compressed) |
| `AZAD_PERIODS_YEARS` | `periods.ts` via `cachestuff` | Available order years (48h TTL) |
| `Azad_StrategyStats_global` | `statistics.ts` | Cumulative strategy usage counters |

### In-memory only (lost on navigation away from Amazon page)

- **`order_map`** in `table.ts` — assembled `IOrder` instances with live Promise references
- **`scheduler`** in `inject.ts` — request queue and in-flight requests
- **`ordersForBudgetPromise`** in `table.ts` — resolves when order details are fetched
- The rendered HTML table itself

### Practical consequence

If the user navigates away mid-scrape, any HTTP responses already fetched are in the `REQUESTSCHEDULER` cache. Re-scraping the same range is fast (cache hits). But the assembled `IOrder` objects and `order_map` must be rebuilt from scratch.

The transaction cache is especially robust: `putTransactionsInCache` writes progressively as pages are scraped, so even partial scrapes persist what was collected.

## Request Scheduler Caching

Order data is cached at the HTTP-response level, not as assembled order objects. Cache key format: `"<request_type>#<url>"`.

Examples:
- `get_page_of_headers#https://www.amazon.com/your-orders/orders?...`
- `extractDetailPromise#https://www.amazon.com/gp/css/summary/...`
- `getCategoryForProduct#https://www.amazon.com/dp/ASIN`

Notable: order list page for the **current year, first page** uses `nocache=true` (always fresh fetch). All other pages and detail pages are cached.

## Key Files

| File | Role |
|---|---|
| `src/js/cachestuff.ts` | Cache abstraction, LZ compression, proxy pattern |
| `src/js/background.ts` | Service worker: message routing, cache proxy listener, tab management |
| `src/js/inject.ts` | Content script: entry point on Amazon pages, scrape orchestration |
| `src/js/table.ts` | Table rendering, order_map management, button handlers |
| `src/js/transaction.ts` | Transaction scraping, caching, date filtering |
| `src/js/order.ts` / `order_impl.ts` | Order construction from cached HTTP responses |
| `src/js/request_scheduler.ts` | HTTP request queue with caching layer |
| `src/js/control.ts` | Popup UI logic |
| `src/html/popup.html` | Popup markup |
