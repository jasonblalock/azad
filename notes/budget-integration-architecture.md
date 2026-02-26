# Budget Integration Architecture

How the budget/YNAB integration works within the azad extension.

## Data Model

### EnrichedTransaction (`budget_shim.ts`)

```typescript
interface EnrichedTransaction {
  date: Date;
  amount: number;
  cardInfo: string;
  vendor: string;
  orderIds: string[];
  items: EnrichedTransactionItem[];
  itemSummary: string;       // items joined with '; '
  categorySummary: string;   // unique categories joined with '; '
}

interface EnrichedTransactionItem {
  description: string;
  price: string;
  quantity: number;
  category: string;    // Amazon breadcrumb category (often empty/broken)
  asin: string;
  orderId: string;
}
```

### Key Identifiers

- **Item key**: `${orderId}:${asin}` (falls back to `${orderId}:idx${index}` when ASIN absent). Used in `azad_category_assignments` to store user's YNAB category picks.
- **Transaction dedup key**: `orderIds.slice().sort().join(',')` when orderIds present, otherwise `${date.toISOString()}|${amount}|${vendor}`. Used by `mergeForCategorization` to accumulate without duplicating.

## Data Flow

```
Amazon page scrape (content script on amazon.com)
  → transaction.reallyScrapeAndPublish() — transactions scraped and cached
  → fetchOrderDetailsForBudget() — creates IOrder objects, populates order_map
  → autoEnrichForCategorization() — correlates transactions with order items
  → mergeForCategorization() — deduped merge into azad_pending_categorization
                                 ↓
              chrome.storage.local (persisted pool of enriched transactions)
                                 ↓
              categorize.html tab reads from storage on open
                                 ↓
              User assigns YNAB categories → saved to azad_category_assignments
                                 ↓
              (Future) Push to YNAB API via background service worker
```

## Storage Keys (Budget-Specific)

| Key | Written By | Content | Lifetime |
|---|---|---|---|
| `azad_pending_categorization` | `budget_shim.ts` | `EnrichedTransaction[]` pool (serialized with ISO date strings) | Accumulates across scrapes, deduped by transaction key |
| `azad_category_assignments` | `categorize.ts` | `Record<itemKey, ynab_category_id>` | Persists indefinitely, debounced 300ms save |
| `ynab_categories` | `ynab_api.ts` | `YnabCategoryGroup[]` from YNAB API | Refreshed when user selects budget in popup |

## Enrichment Pipeline

`correlateTransactionsWithOrders()` in `budget_shim.ts`:
1. For each transaction, iterates its `orderIds`
2. Looks up each order in `order_map` (in-memory, populated by `populateOrderMapForBudget`)
3. Calls `order.item_list()` to get items (uses cached HTTP responses under the hood)
4. Builds `EnrichedTransactionItem` for each item
5. Returns `EnrichedTransaction` with all items, summaries

This must run in the content script context on the Amazon page because `IOrder` objects require the request scheduler and content script environment.

## YNAB API Integration

### Authentication
- Personal Access Token (PAT) entered by user in popup UI
- Stored in extension settings (`ynab_pat` via `chrome.storage.sync`)

### API Access (`ynab_api.ts`)
- Uses `ynab` npm package (ynab-sdk-js)
- API calls go through background service worker to avoid CORS
- `fetchBudgets(token)` — lists user's budgets
- `fetchCategories(token, budgetId)` — fetches category groups for a budget
- `getCachedCategories()` — reads from `ynab_categories` in local storage

### Popup Setup Flow (`control.ts`)
1. User pastes PAT, clicks Connect
2. Extension fetches budgets, populates dropdown
3. User selects budget → categories fetched and cached
4. Category count shown in popup

## Categorization UI (`categorize.html`)

Runs as an **extension page** (not content script), so has direct `chrome.storage.local` access.

On load:
1. `loadPendingCategorization()` — enriched transactions from storage
2. `getCachedCategories()` — YNAB category groups from cache
3. `loadAssignments()` — previously saved category assignments

Renders:
- Sticky header with progress counter ("X of Y items categorized")
- Transaction sections with date, vendor, amount, order IDs
- Item tables with description, price, qty, YNAB category dropdown
- Categories flattened from groups as "Group: Category", hidden/deleted filtered, sorted alphabetically
- Green row highlighting on assignment

Saves: debounced 300ms writes to `azad_category_assignments` on every dropdown change.

## Entry Points to Categorization UI

1. **Popup button** — "Open Categorization (N transactions)" in YNAB section, visible when pending data exists
2. **Table button** — "open categorization" on the Amazon transactions table, awaits auto-enrich then opens tab
3. Both use `open_tab` message to background, which reuses existing tab if one is open

## Design Decisions

1. **Accumulate, don't overwrite** — `mergeForCategorization` dedupes by transaction key. Multiple scrapes build up the pool. Re-scraping the same range updates existing entries.
2. **Auto-persist** — enrichment runs automatically after order details finish. No manual button click needed to save data.
3. **Tab reuse** — `open_tab` handler queries for existing tab before creating new one. Prevents duplicates.
4. **Pro-rate taxes at push time** — item prices don't sum to transaction total (tax, shipping). Distribute remainder proportionally. Rounding remainder on largest item. UI shows raw prices.
5. **Flatten same-category items at push time** — items sharing a YNAB category combine into one subtransaction, memos joined by ` | `.
6. **Refunds require manual intervention** — Amazon calculates refunds independently. Order IDs in memos help users correlate.
7. **YNAB split transactions cannot be updated after creation** — categorization must happen before push. This is why the categorize UI exists.
