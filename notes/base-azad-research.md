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

## Stats Publishing

Two mechanisms for publishing scraping progress stats to the popup:

### Order scraping (root page path)
- `inject.ts` creates a scheduler via `resetScheduler()`, which starts `setStatsTimeout()` — a recurring 2-second timer
- Timer calls `_stats.publish(ports.getBackgroundPort, purpose)`, passing the **port getter function**
- Stats flow: root page → background (`statistics_update` case) → `control_port` → popup
- This path is reliable because the root page's port persists for the tab's lifetime

### Transaction scraping (iframe worker path)
- Transaction scraping runs inside an iframe worker (`/cpe/yourpayments/transactions`)
- The iframe has its own port (`azad_iframe_worker:...`) to the background
- `transaction.ts` extraction functions publish stats via `statistics.publish(getPort, 'transactions')`
- Stats flow: iframe → background → `control_port` → popup (same routing, different source port)

### Gotchas discovered
- **Missing `await` on date-range scraping** (`iframe-worker.ts`): The date-range path originally didn't `await` `reallyScrapeAndPublish()`, causing scraping to fire-and-forget. The year-based path had `await`. Both paths also need `await removeThisIframe()` after scraping completes.
- **Captured port vs port getter**: The extraction functions originally captured `port` once at the start (`const port = await getPort()`) and passed `() => Promise.resolve(port)` to `statistics.publish()`. If the port disconnects/reconnects during scraping, the captured reference goes stale. Fix: pass the `getPort` function through and call it fresh each time, matching how budget order details stats work.
- **Unawaited `statistics.publish()`**: The `updateStatistics()` helpers called `statistics.publish()` (async) without `await`. In iframe contexts this can cause stats messages to not be sent before context changes. Fix: make `updateStatistics` async and await the publish.
- **No `control_port` disconnect handler**: `background.ts` stored the popup's port in `control_port` but never cleared it on disconnect, leaving a stale reference. Fix: add `port.onDisconnect.addListener(() => { control_port = null; })`.

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
