# Budget Integration Architecture

> **Scope:** Documents the architecture of the budget/YNAB integration we're building on top of azad. Covers our additions: data model, enrichment pipeline, YNAB API, categorization UI, storage keys, and design decisions. For the base extension architecture, see `base-azad-research.md`. For milestone tracking and vision, see `budget-integration-vision.md`.

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
| `ynab_categories` | `ynab_api.ts` | `YnabCategoryGroup[]` from YNAB API | Refreshed on budget selection, on-demand if missing, or via refresh button on categorize page |
| `ynab_accounts` | `ynab_api.ts` | `YnabAccount[]` (open, on-budget) from YNAB API | Refreshed on budget selection, on-demand if missing, or via refresh button on categorize page |
| `azad_card_account_map` | `categorize.ts` | `Record<cardInfo, accountId>` mapping card strings to YNAB accounts | Persists indefinitely, updated via card mapping UI |

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
2. Filter out gift card transactions (see below)
3. `getCachedCategories()` — YNAB category groups from cache
4. `loadAssignments()` — previously saved category assignments
5. `getCachedAccounts()` — if empty, fetches live from YNAB API using PAT/budget from settings and caches

### Gift Card Filtering

Transactions where `cardInfo` matches `/gift\s*card/i` (e.g., "Amazon Gift Card") are filtered out before rendering. These are never pushed to YNAB because the money is already accounted for — the gift card itself was purchased with a credit card that has a YNAB account, so pushing gift card spend would double-count.

Filtered transactions remain in `azad_pending_categorization` (filter is display-only). If any are filtered, a note ("N gift card transaction(s) hidden") appears in the header.

Renders:
- Sticky header with progress counter ("X of Y items categorized")
- Transaction sections with date, vendor, amount, order IDs
- Item tables with description, price, qty, YNAB category dropdown
- Categories flattened from groups as "Group: Category", hidden/deleted filtered, sorted alphabetically
- Green row highlighting on assignment

Saves: debounced 300ms writes to `azad_category_assignments` on every dropdown change.

Refresh button in header fetches fresh accounts and categories from YNAB API, caches both, and re-renders the page preserving existing assignments and card mappings.

## Entry Points to Categorization UI

1. **Popup button** — "Open Categorization (N transactions)" in YNAB section, visible when pending data exists
2. **Table button** — "open categorization" on the Amazon transactions table, awaits auto-enrich then opens tab
3. Both use `open_tab` message to background, which reuses existing tab if one is open

## Push Flow

```
categorize.ts (Push to YNAB button clicked)
  → buildYnabTransactions() in ynab_push.ts
    - Uses isTransactionReady() to check each transaction
    - Only fully-ready transactions (all items categorized + card mapped) are built
    - Incomplete transactions are skipped and remain in the pending pool
    - Builds SaveTransaction[] with splits, remainder on largest item
    - Generates idempotent import_id: YNAB:{milliunits}:{date}:{occurrence}
  → ynab.API(token).transactions.createTransaction(budgetId, { transactions })
    - SDK handles REST call directly (extension page, no CORS issue)
    - Returns created IDs + duplicate_import_ids for idempotency
  → removePendingTransactions() in budget_shim.ts
    - Filters out pushed transactions by transactionKey
    - Saves remaining back to azad_pending_categorization
  → UI updates: pushed sections removed, in-memory array spliced,
    remaining transactions stay editable, push button re-evaluated
```

### import_id Generation

Format: `YNAB:{milliunits}:{date}:{occurrence}` (max 36 chars)

This matches YNAB's own import format for bank feeds, enabling dedup across API pushes and file-based imports. The `occurrence` counter increments per unique `amount+date` combination within a single push batch.

## Design Decisions

1. **Accumulate, don't overwrite** — `mergeForCategorization` dedupes by transaction key. Multiple scrapes build up the pool. Re-scraping the same range updates existing entries.
2. **Auto-persist** — enrichment runs automatically after order details finish. No manual button click needed to save data.
3. **Tab reuse** — `open_tab` handler uses `chrome.tabs.query({ url })` to find existing tab before creating a new one. Requires the `"tabs"` permission in `manifest.json` (without it, URL-based queries silently return empty). This permission also enables future tab-to-tab communication between the categorize UI and Amazon content scripts.
4. **Pro-rate taxes at push time** — item prices don't sum to transaction total (tax, shipping). Distribute remainder proportionally. Rounding remainder on largest item. UI shows raw prices.
5. **Flatten same-category items at push time** — items sharing a YNAB category combine into one subtransaction, memos joined by ` | `.
6. **Refunds require manual intervention** — Amazon calculates refunds independently. Order IDs in memos help users correlate.
7. **YNAB split transactions cannot be updated after creation** — categorization must happen before push. This is why the categorize UI exists.
8. **Shared validation via `isTransactionReady()`** — `isTransactionReady()` in `ynab_push.ts` is the single source of truth for whether a transaction can be pushed (card mapped + all items categorized). Used by both `buildYnabTransactions()` and the UI's `countPushable()` to keep push eligibility logic in sync.
