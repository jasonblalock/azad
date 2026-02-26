# Budget Integration Vision

## Problem

Amazon transactions imported into budget software (YNAB, Actual Budget, etc.) from bank feeds show only "Amazon $47.23" with no item detail. Categorizing these is tedious — users must cross-reference Amazon order history manually. Multi-item transactions are worse: splitting requires knowing which items cost what and belong in which category.

## Milestone 1: Enriched CSV Export (Complete)

- Extension scrapes Amazon transactions and correlates them with order item details
- Enriched CSV export with item descriptions and categories in memo field
- Auto-fetches order details when transactions are scraped (no separate order scrape needed)
- YNAB research in ./ynab-research.md
- ynab-sdk-js installed (npm install ynab)

### Known Issues
- **Categories not appearing in CSV** — likely `show_category_in_items_view` setting is off, or Amazon breadcrumb XPath is broken. Needs investigation.
- **Memo field too long** — full Amazon product titles joined together are unreadable in YNAB's UI, very difficult to then categorize

## Milestone 2: YNAB Integration + Categorization UI (In Progress)

Categorization must happen before pushing to YNAB — pushing uncategorized data with broken categories and overlong memos creates cleanup work, and we'd need to update those same transactions later. Better to categorize locally, then push clean data once.

### Done
- PAT auth to YNAB API via popup settings UI (`control.ts`, `popup.html`)
- Fetch user's budgets and categories with caching (`ynab_api.ts`)
- Categorization UI in a dedicated extension tab (`categorize.ts`, `categorize.html`, `categorize.css`)
  - Sticky header with progress counter ("X of Y items categorized")
  - One section per transaction with date, vendor, amount, order IDs
  - Item table with description, price, qty, and YNAB category dropdown
  - Categories flattened from YNAB groups as "Group: Category", hidden/deleted filtered, sorted alphabetically
  - Green row highlighting on assignment, debounced auto-save to `chrome.storage.local`
  - Selections persist across tab close/reopen
  - Transactions with no items get a single category picker for the whole transaction
- "Categorize for YNAB" button in table UI (gated on `budget_export_enabled` + `ynab_pat` non-empty)
- Data persistence: enriched transactions serialized to `chrome.storage.local` with proper Date handling
- Back-button fix to prevent broken navigation states after table injection
- Detailed plan in ./greedy-forging-blanket.md

### Remaining
- **YNAB push** — read saved assignments and push split transactions via YNAB API
- **Tax/fee pro-ration** — distribute remainder (tax, shipping) proportionally across items at push time
- **Same-category flattening** — combine items sharing a category into one subtransaction at push time
- **Refunds** — require manual intervention; order IDs in memos help users correlate

### Known Issues
- **Back-button fix doesn't work with popup open** — `history.pushState` behaves unexpectedly in content script context when Chrome popup has focus. Works fine when popup is closed.
- **Item key collision edge case** — `${orderId}:${asin}` key format could collide if the same ASIN appears multiple times in one order (e.g. consumables re-ordered). Rare but possible.

## Next Up

### Milestone 2b: YNAB Push
- Read saved category assignments from `azad_category_assignments`
- Pro-rate taxes/fees across items proportionally (rounding remainder on largest item)
- Flatten same-category items into single subtransactions (memo joined by ` | `)
- Push split transactions to YNAB API via background service worker
- Order IDs in parent transaction memo

### Milestone 3: AI-Assisted Categorization
- Feed item descriptions + user's YNAB categories to an LLM
- AI suggests category for each item; user confirms/overrides in the UI
- Cache confirmed ASIN-to-category mappings so repeat purchases auto-categorize
- Could start with simple keyword matching, graduate to LLM API calls
- Works with cloud APIs (OpenAI, Anthropic) or potentially local models

### Future Milestones
- Support Actual Budget / Monarch Money as alternative targets
- Pull YNAB bank-feed transactions, match against Amazon data by date/amount, update in place
- Learn from user's categorization history for better suggestions over time

## Design Principles

1. **Handler callback pattern** — `exportBudgetData` already takes a handler function. API push is just a different handler. Keep this pattern.
2. **Extension architecture** — API calls go through background service worker (avoids CORS). Follow existing `fetch_url` message pattern in `background.ts`.
3. **Incremental value** — each milestone is independently useful. CSV export works today, API push is better, categorization UI is best.
4. **Provider-agnostic correlation** — the enrichment engine (`budget_shim.ts`) stays budget-software-neutral. Provider-specific code lives in separate modules.
