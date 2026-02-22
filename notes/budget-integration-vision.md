# Budget Integration Vision

## Problem

Amazon transactions imported into budget software (YNAB, Actual Budget, etc.) from bank feeds show only "Amazon $47.23" with no item detail. Categorizing these is tedious — users must cross-reference Amazon order history manually. Multi-item transactions are worse: splitting requires knowing which items cost what and belong in which category.

## Current State (Milestone 1 - Complete)

- Extension scrapes Amazon transactions and correlates them with order item details
- Enriched CSV export with item descriptions and categories in memo field
- Auto-fetches order details when transactions are scraped (no separate order scrape needed)

### Known Issues
- **Categories not appearing in CSV** — likely `show_category_in_items_view` setting is off, or Amazon breadcrumb XPath is broken. Needs investigation.
- **Memo field too long** — full Amazon product titles joined together are unreadable in YNAB's UI

## Ideal Progression

### Milestone 2: YNAB API Integration
- Add YNAB OAuth/personal access token auth to the extension
- Fetch user's YNAB budget categories
- Push enriched Amazon transactions to YNAB as split transactions via API
- Foundation for the categorization UI

### Milestone 3: Categorization UI
- Purpose-built UI within the extension (new tab or options page)
- Pull uncategorized Amazon transactions from YNAB API
- Correlate with Amazon order data from extension scrape
- Show each item individually with description, price, and category picker (populated from user's actual YNAB categories)
- User rapidly categorizes items, then pushes split transactions back to YNAB

### Milestone 4: AI-Assisted Categorization
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
