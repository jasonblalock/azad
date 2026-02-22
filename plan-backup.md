# Budget Software Integration Shim

## Context

The extension already extracts Amazon transactions (with linked order IDs) and orders (with item lists, descriptions, prices, categories). Budget software like YNAB imports bank-feed transactions that show "Amazon $47.23" with no item detail. This shim correlates Amazon transactions with their orders to produce enriched records containing item descriptions and categories, enabling budget software enrichment.

**First milestone**: Enriched CSV download from the transactions view. YNAB can auto-match imported CSV transactions against existing bank-feed entries by amount, so CSV import is viable without creating duplicates.

**Future milestones** (in rough order):
1. Push enriched Amazon transactions to YNAB API directly
2. Pull YNAB bank-feed transactions, match against Amazon data by date/amount, update in place
3. Support Actual Budget / Monarch Money as alternative targets

## Architecture

```
inject.ts  (no changes needed)
    │
    v
table.ts   (add budget export button next to existing CSV button)
    │
    v
budget_shim.ts  (NEW: correlation engine + CSV formatter + handler registry)
    │
    v
save_file.ts  (existing: triggers browser download)
```

The shim is a separate module (`budget_shim.ts`) with zero coupling to inject.ts. It receives data and produces output through a handler callback pattern, making it trivial to swap CSV for an API push later.

## Key Data Structures

**Input - Transaction** (`src/js/transaction.ts:14-20`):
```typescript
{ date: Date, cardInfo: string, orderIds: string[], amount: number, vendor: string }
```

**Input - IOrder** (`src/js/order.ts`): async interface with `id()`, `item_list()` returning `IItem[]` (description, price, quantity, category, asin).

**Correlation**: `Transaction.orderIds[]` → look up in `order_map` (table.ts:28) → call `order.item_list()` → flatten items into enriched record.

**Output - EnrichedTransaction** (new):
```typescript
{
  date: Date, amount: number, cardInfo: string, vendor: string,
  orderIds: string[],
  items: { description, price, quantity, category, asin, orderId }[],
  itemSummary: string,      // "USB-C Cable x2; Phone Case"
  categorySummary: string,  // "Electronics; Accessories"
}
```

## Files to Create/Modify

### 1. NEW: `src/js/budget_shim.ts`

Core module containing:

- **`EnrichedTransaction` and `EnrichedTransactionItem` interfaces** — the canonical data shape all output handlers consume.
- **`correlateTransactionsWithOrders(transactions, orderMap)`** — for each transaction, looks up orderIds in the map, calls `order.item_list()`, flattens items, builds summary strings. Transactions with no matching orders still appear (with empty items).
- **`enrichedTransactionsToCsv(enriched)`** — formats as CSV with columns: Date, Amount, Payee, Memo (item summary), Card, Order IDs, Categories. Uses BOM prefix for Excel. Column layout is YNAB-import-compatible (Date, Payee, Memo, Amount).
- **`downloadEnrichedCsv(enriched)`** — calls `save_file.save()` with the CSV string. Implements the `EnrichedTransactionHandler` callback type.
- **`exportBudgetData(transactions, orderMap, handler)`** — top-level orchestrator: correlates, then calls handler. The handler param makes it trivial to add API push later without changing call sites.

Reuses: `save_file.save()`, `dateToDateIsoString()`, `Transaction` type, `IOrder` interface.

### 2. MODIFY: `src/js/table.ts`

Minimal changes (~20 lines):

- Add `import * as budget_shim from './budget_shim';`
- Add `addBudgetExportButton(transactions, order_map)` function (mirrors `addTransactionsCsvButton` pattern at line 450).
- Call it in `reallyDisplayTransactions` at lines 390 and 402 (both `beautiful` and plain branches), right after `addTransactionsCsvButton`. Gated by `settings.getBoolean('budget_export_enabled')`.

The module-scoped `order_map` (line 28) is populated during order display and persists across view switches. When transactions are displayed, the map still contains orders from a prior scrape.

### 3. MODIFY: `src/html/popup.html`

Add a `budget_export_enabled` checkbox to the settings table, following the existing pattern used by `show_totals_in_csv` and similar toggles.

## Important Design Decisions

1. **No changes to inject.ts** — the `order_map` already lives in `table.ts` and persists across view switches. No interception needed in inject.ts for milestone 1.
2. **Handler callback pattern** — `exportBudgetData` takes a handler function, not a hardcoded action. Swapping CSV for YNAB API is just a different handler.
3. **Graceful degradation** — if `order_map` is empty (user didn't scrape orders first), the CSV still exports transactions with blank item/category columns.
4. **Settings-gated** — the button only appears when `budget_export_enabled` is true, keeping the feature opt-in.

## Future API Architecture Notes

These decisions are deferred but documented to avoid painting ourselves into a corner.

**Handler interface is already async** (`EnrichedTransactionHandler = (enriched) => Promise<void>`), so API handlers slot in without changing the interface.

**API call origin**: Content script → background service worker relay. This follows the extension's existing pattern (e.g., `fetch_url` messages in `background.ts`). The background service worker makes the actual HTTP calls, avoiding CORS issues. Future work adds:
- A new message action (e.g., `'push_to_budget_api'`) in `background.ts`
- YNAB API domain added to `manifest.json` `connect-src` / `host_permissions`
- API token stored in `chrome.storage.sync` (similar to existing settings pattern)

**Pull-and-match milestone**: The `EnrichedTransaction` structure already carries `date` and `amount` — sufficient for matching against YNAB bank-feed transactions. A future `ynab_api.ts` module would: (1) GET transactions from YNAB filtered by date range, (2) match by amount (exact) + date (±3 days for bank processing drift), (3) PATCH matched transactions with memo/category from `itemSummary`/`categorySummary`.

**Multi-provider support**: The handler callback pattern means adding Actual Budget or Monarch is just a new handler implementation — no changes to the correlation engine or `table.ts` integration points.

## Verification

1. Build: `npm run build` (or the project's webpack build command) should compile without errors.
2. Load the extension in Chrome, navigate to Amazon order history.
3. Enable "budget export" in extension settings.
4. Scrape orders for a time period (populates `order_map`).
5. Scrape transactions for the same period.
6. Verify "budget export" button appears alongside the existing CSV button.
7. Click it — a CSV file should download with transactions enriched with item descriptions and categories from the correlated orders.
8. Verify that the existing CSV download and all other functionality still works unchanged.
