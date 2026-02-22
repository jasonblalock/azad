# Plan: Categorization UI for YNAB

## Context

Milestone 2 calls for a categorization UI where users assign YNAB budget categories to individual Amazon items before pushing to YNAB. We have working YNAB API access (PAT auth, budget/category fetch+cache). The enriched transaction data (items with descriptions, prices, ASINs) exists but is ephemeral — only lives in memory during CSV export. We need to persist it, build a UI for category assignment, and store the user's choices.

YNAB split transactions **cannot be updated after creation**, so categorization must happen before any push. This UI is the prerequisite.

## Design Decisions

1. **New extension tab** (`chrome.tabs.create`) — the popup is 300px wide, the injected Amazon table is fragile. A dedicated tab gives full viewport, direct `chrome.storage.local` access (no cache proxy needed), and persists across navigation.

2. **Persist enriched data to `chrome.storage.local`** at button-click time, before opening the tab. Key: `azad_pending_categorization`.

3. **Category assignments stored separately** in `chrome.storage.local` key `azad_category_assignments` as `Record<itemKey, ynab_category_id>`. Saved on every dropdown change (debounced). Work is never lost if the tab closes.

4. **Item key format**: `${orderId}:${asin}` (falls back to `${orderId}:idx${index}` for items without ASIN).

5. **Ignore Amazon breadcrumb categories** — they're broken/empty. Focus entirely on YNAB category assignment.

6. **Pro-rate taxes/fees across items at push time** — Item prices won't sum to the transaction total (tax, shipping, fees). Instead of a separate "tax" subtransaction, distribute the remainder proportionally by each item's share of the pre-tax total. Rounding remainder goes on the largest item. The categorization UI shows original item prices — pro-rating is a push-time concern.

7. **Flatten same-category items at push time** — The categorization UI always shows individual items. When we eventually build the YNAB push, items sharing a category get combined into one subtransaction with summed amounts and descriptions joined by ` | ` in the memo (a parseable, human-readable separator). Order IDs go in the parent transaction memo.

8. **Refunds require manual intervention** — Amazon calculates refund amounts independently (partial refunds, tax adjustments, restocking fees). We include order IDs in memos to help users correlate, but don't try to auto-match refunds to splits.

9. **YNAB push is out of scope** for this plan — the UI saves assignments, push comes next.

## Files to Modify

### `src/js/budget_shim.ts`
- Export `persistForCategorization(enriched)` — writes `EnrichedTransaction[]` to `chrome.storage.local['azad_pending_categorization']` as JSON
- Export `loadPendingCategorization()` — reads and deserializes (restoring Date objects)
- Export the `EnrichedTransaction` and `EnrichedTransactionItem` types (already exported)

### `src/js/table.ts`
- Add `addCategorizationButton(transactions)` alongside `addBudgetExportButton`
  - Only visible when `budget_export_enabled` is true AND `ynab_pat` setting is non-empty
  - On click: awaits `ordersForBudgetPromise`, calls `exportBudgetData(transactions, order_map, budget_shim.persistForCategorization)`, then sends `chrome.runtime.sendMessage({ action: 'open_tab', url: chrome.runtime.getURL('categorize.html') })` (existing background handler at `background.ts:386`)
  - Shows loading state while preparing, same pattern as the CSV button
- Call `addCategorizationButton(transactions)` in both branches of `reallyDisplayTransactions` (lines ~393-394 and ~408-409), right after `addBudgetExportButton`

### `webpack.config.js`
- Add `categorize` entry point: `categorize: path.join(__dirname, "src", "js", "categorize.ts")`
- Add copy patterns: `{ from: "src/html/categorize.html" }` and `{ from: "src/styles/categorize.css" }`

## Files to Create

### `src/html/categorize.html`
- Minimal standalone page: loads `categorize.bundle.js` and `categorize.css`
- Container div `#azad-categorize-root` with loading text
- No jQuery, no DataTables

### `src/js/categorize.ts`
Entry point for the categorize tab. On DOMContentLoaded:
1. `loadPendingCategorization()` — get enriched transactions from storage
2. `ynab_api.getCachedCategories()` — get YNAB category groups
3. `loadAssignments()` — get any previously saved assignments from `azad_category_assignments`
4. Render:
   - Sticky header with title + progress counter ("X of Y items categorized")
   - One section per transaction: date, vendor, amount, order IDs
   - Item table within each section: description, price, qty, category `<select>` dropdown
   - Categories flattened from groups, formatted as "Group: Category", sorted alphabetically, hidden/deleted filtered out
   - Rows highlight green when assigned
   - Transactions with no items get a single category picker for the whole transaction
5. On dropdown change: update in-memory assignments, debounced save to `chrome.storage.local`, update progress counter

### `src/styles/categorize.css`
- Follows existing conventions: orange borders, CornflowerBlue accents, Arial
- Full-page layout, max-width 960px centered
- Sticky header, transaction cards with item tables, dropdown styling

## Verification
1. `npm run build` succeeds with new entry point
2. Load unpacked extension in Chrome
3. Scrape transactions on Amazon (table type = transactions, budget export enabled)
4. Verify "categorize for YNAB" button appears (only when YNAB is connected)
5. Click button — new tab opens with categorize.html
6. Verify transactions render with item details and category dropdowns
7. Select categories — verify green highlight and progress counter update
8. Close and reopen tab — verify selections persist
9. Verify CSV export button still works independently
