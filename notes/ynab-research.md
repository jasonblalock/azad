# YNAB API Research

Deep-dive reference for integrating with YNAB's API, focused on what we need for pushing enriched Amazon transactions as split transactions.

**API Version**: v1 (spec 1.76.0)
**Base URL**: `https://api.ynab.com/v1`
**Official JS SDK**: `ynab` on npm ([github.com/ynab/ynab-sdk-js](https://github.com/ynab/ynab-sdk-js))
**API Starter Kit**: [github.com/ynab/ynab-api-starter-kit](https://github.com/ynab/ynab-api-starter-kit) — Vue.js SPA showing OAuth + budget/transaction fetch

---

## 1. Authentication

### Personal Access Tokens (what we use)
- Generated from YNAB Account Settings > Developer Settings
- **Non-expiring**, non-retrievable after creation
- Header: `Authorization: Bearer <TOKEN>`
- Intended for single-developer/personal use

### OAuth2 (for multi-user apps, future consideration)
- **Implicit Grant**: Client-side, tokens expire in 2 hours, no refresh tokens
- **Authorization Code Grant**: Server-side, 2-hour tokens with refresh token support
- New OAuth apps start in **Restricted Mode** (25 user auth limit until YNAB review, 2-4 weeks)
- `read-only` scope available

---

## 2. Rate Limits

- **200 requests per access token per hour** (rolling window)
- Exceeding returns HTTP **429** with `{ error: { id: "429", name: "too_many_requests" } }`
- SDK does NOT auto-retry — we must implement our own backoff
- **Mitigation**: Use delta requests (`server_knowledge`) and aggressive caching

---

## 3. Amount Format (Milliunits)

All monetary values use **milliunits** — 1/1000th of currency unit.

| Display | Milliunits |
|---------|-----------|
| $5.00 | 5000 |
| -$47.23 | -47230 |
| $0.01 | 10 |
| -$1,500.50 | -1500500 |

- Negative = outflow (spending), Positive = inflow (income)
- SDK utility: `ynab.utils.convertMilliUnitsToCurrencyAmount(milliunits, decimalDigits?)`
- Reverse: `dollarAmount * 1000`

---

## 4. JS SDK (`ynab` npm package)

### Installation & Setup
```bash
npm install ynab
```

```typescript
import * as ynab from "ynab";
const api = new ynab.API(accessToken);
// Optional second arg: custom endpoint URL
```

Browser build available at `dist/browser/ynab.js` or via CDN:
```html
<script src="https://unpkg.com/ynab@latest/dist/browser/ynab.js"></script>
```

### Sub-API Methods

| Sub-API | Key Methods |
|---------|-------------|
| `api.budgets` | `getBudgets()`, `getBudgetById(id, serverKnowledge?)`, `getBudgetSettingsById(id)` |
| `api.accounts` | `getAccounts(budgetId)`, `getAccountById(budgetId, accountId)` |
| `api.categories` | `getCategories(budgetId, serverKnowledge?)`, `getCategoryById(budgetId, catId)` |
| `api.transactions` | `getTransactions(budgetId, sinceDate?, type?, serverKnowledge?)`, `createTransaction(budgetId, data)`, `updateTransaction(budgetId, txnId, data)`, `updateTransactions(budgetId, data)`, `deleteTransaction(budgetId, txnId)` |
| `api.payees` | `getPayees(budgetId)`, `getPayeeById(budgetId, payeeId)` |
| `api.months` | `getBudgetMonths(budgetId)`, `getBudgetMonth(budgetId, month)` |

Transaction listing variants: `getTransactionsByAccount(...)`, `getTransactionsByCategory(...)`, `getTransactionsByPayee(...)`, `getTransactionsByMonth(...)`

Filter by type: `"uncategorized"` or `"unapproved"`

### Utility Functions (`ynab.utils`)
- `convertMilliUnitsToCurrencyAmount(milliunits, currencyDecimalDigits?)` — milliunits to display amount
- `getCurrentMonthInISOFormat()` — returns e.g. `"2026-02-01"`
- `getCurrentDateInISOFormat()` — returns e.g. `"2026-02-22"`
- `convertFromISODateString(isoDateString)` — ISO string to JS Date

### Error Handling
```typescript
try {
  await api.transactions.getTransactions(budgetId);
} catch (error) {
  // YNAB errors: error.error.id, error.error.name, error.error.detail
  // e.g. { id: "401", name: "unauthorized", detail: "Unauthorized" }
}
```

---

## 5. Budgets API

### Endpoints
- `GET /budgets` — list all budgets (supports `include_accounts` param)
- `GET /budgets/{budget_id}` — full budget detail (essentially a full export of everything)
- `GET /budgets/{budget_id}/settings` — budget settings

**Special budget_id values**: `"last-used"` and `"default"` resolve to most recently used budget.

### BudgetSummary Fields
`id` (uuid), `name`, `last_modified_on` (datetime), `first_month`, `last_month`, `date_format`, `currency_format`, `accounts` (if requested)

### CurrencyFormat
`iso_code`, `decimal_digits`, `decimal_separator`, `symbol_first`, `group_separator`, `currency_symbol`, `display_symbol`, `example_format`

---

## 6. Accounts API

### Key Fields
| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid | |
| `name` | string | |
| `type` | AccountType | `checking`, `savings`, `creditCard`, `cash`, etc. |
| `on_budget` | boolean | |
| `closed` | boolean | |
| `balance` | int64 (milliunits) | |
| `cleared_balance` | int64 (milliunits) | |
| `uncleared_balance` | int64 (milliunits) | |
| `transfer_payee_id` | uuid | **Important**: Used to create transfers between accounts |
| `direct_import_linked` | boolean | Whether linked to bank for auto-import |

### AccountType Values
`checking`, `savings`, `cash`, `creditCard`, `lineOfCredit`, `otherAsset`, `otherLiability`, `mortgage`, `autoLoan`, `studentLoan`, `personalLoan`, `medicalDebt`, `otherDebt`

---

## 7. Categories API

### Endpoints
- `GET /budgets/{budget_id}/categories` — all categories grouped by category group (supports delta)
- `GET /budgets/{budget_id}/categories/{category_id}` — single category
- `PATCH /budgets/{budget_id}/categories/{category_id}` — update name/note/group/goal
- `GET /budgets/{budget_id}/months/{month}/categories/{category_id}` — category for specific month
- `PATCH /budgets/{budget_id}/months/{month}/categories/{category_id}` — update budgeted amount

### CategoryGroup Fields
`id` (uuid), `name`, `hidden` (boolean), `deleted` (boolean)

### Category Fields
| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid | |
| `category_group_id` | uuid | |
| `category_group_name` | string | |
| `name` | string | |
| `hidden` | boolean | |
| `deleted` | boolean | Only in delta responses |
| `note` | string, nullable | |
| `budgeted` | int64 (milliunits) | **Current month (UTC)** |
| `activity` | int64 (milliunits) | Current month |
| `balance` | int64 (milliunits) | Current month |
| `goal_type` | enum, nullable | `TB`, `TBD`, `MF`, `NEED`, `DEBT` |

**Important**: When fetching via list endpoint, `budgeted`/`activity`/`balance` reflect the **current month in UTC**. Use the month-specific endpoint for other months.

---

## 8. Payees API

### Endpoints
- `GET /budgets/{budget_id}/payees` — all payees (supports delta)
- `GET /budgets/{budget_id}/payees/{payee_id}` — single payee
- `PATCH /budgets/{budget_id}/payees/{payee_id}` — update name (max 500 chars)

### Payee Fields
`id` (uuid), `name`, `transfer_account_id` (uuid, nullable — set if this is a transfer payee), `deleted`

### Transfer Payees
- Every account has an auto-created **transfer payee**
- Account's `transfer_payee_id` → payee → payee's `transfer_account_id` → target account
- Cannot create/delete transfer payees manually

### Payee Name Resolution (when creating transactions)
When `payee_name` is provided with null `payee_id`:
1. Check payee rename rules (only if `import_id` is also set)
2. Match existing payee by exact name
3. Create new payee if no match

---

## 9. Transactions API (Critical for Our Integration)

### Endpoints
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/budgets/{id}/transactions` | List all (excludes pending) |
| `POST` | `/budgets/{id}/transactions` | Create single or bulk |
| `PATCH` | `/budgets/{id}/transactions` | Bulk update (by id or import_id) |
| `GET` | `/budgets/{id}/transactions/{txn_id}` | Get single |
| `PUT` | `/budgets/{id}/transactions/{txn_id}` | Update single |
| `DELETE` | `/budgets/{id}/transactions/{txn_id}` | Delete single |
| `GET` | `/budgets/{id}/accounts/{acct_id}/transactions` | By account |
| `GET` | `/budgets/{id}/categories/{cat_id}/transactions` | By category |
| `GET` | `/budgets/{id}/payees/{payee_id}/transactions` | By payee |

### Query Parameters (GET)
- `since_date` (ISO date) — filter on or after this date
- `type` (`"uncategorized"` | `"unapproved"`) — filter by status
- `last_knowledge_of_server` (int64) — delta request

### NewTransaction Fields (Write Model — from SDK source)
```typescript
interface NewTransaction {
  account_id?: string;
  date?: string;              // ISO "YYYY-MM-DD". Future dates NOT permitted.
  amount?: number;            // Milliunits. Negative = outflow.
  payee_id?: string | null;
  payee_name?: string | null; // Resolves via rename rules → name match → create new
  category_id?: string | null; // null for split transactions
  memo?: string | null;
  cleared?: "cleared" | "uncleared" | "reconciled";
  approved?: boolean;         // Defaults to FALSE if not supplied!
  flag_color?: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | null;
  import_id?: string | null;  // Max 36 chars. Idempotency key.
  subtransactions?: SaveSubTransaction[];
}
```

### SaveSubTransaction Fields (from SDK source)
```typescript
interface SaveSubTransaction {
  amount: number;               // REQUIRED. Milliunits.
  payee_id?: string | null;
  payee_name?: string | null;   // Same resolution logic as parent
  category_id?: string | null;  // Credit Card Payment categories NOT permitted
  memo?: string | null;
}
```

### TransactionDetail Fields (Read Model)
```typescript
interface TransactionDetail {
  id: string;
  date: string;
  amount: number;               // Milliunits
  memo?: string | null;
  cleared: "cleared" | "uncleared" | "reconciled";
  approved: boolean;
  flag_color?: string | null;
  account_id: string;
  account_name: string;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null; // Shows "Split" for split transactions
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
  matched_transaction_id?: string | null;
  import_id?: string | null;
  import_payee_name?: string | null;
  import_payee_name_original?: string | null;
  deleted: boolean;
  subtransactions: SubTransaction[];
}
```

### SubTransaction Fields (Read Model)
```typescript
interface SubTransaction {
  id: string;
  transaction_id: string;       // Parent transaction ID
  amount: number;               // Milliunits
  memo?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
  deleted: boolean;             // Only in delta responses
}
```

### Creating a Transaction
```typescript
const response = await api.transactions.createTransaction(budgetId, {
  transaction: {
    account_id: "acct-uuid",
    date: "2026-02-22",
    amount: -47230,            // -$47.23
    payee_name: "Amazon.com",
    category_id: "cat-uuid",
    memo: "Household supplies",
    cleared: "cleared",
    approved: true,
    import_id: "YNAB:-47230:2026-02-22:1",
  },
});
```

### Bulk Creating Transactions
```typescript
const response = await api.transactions.createTransaction(budgetId, {
  transactions: [txn1, txn2, txn3],  // Array of NewTransaction
});
// response.data.transaction_ids — created IDs
// response.data.duplicate_import_ids — skipped duplicates
// response.data.server_knowledge — for delta requests
```

### Create Response (`SaveTransactionsResponseData`)
```typescript
interface SaveTransactionsResponseData {
  transaction_ids: string[];
  transaction?: TransactionDetail;       // If single create
  transactions?: TransactionDetail[];    // If bulk create
  duplicate_import_ids?: string[];       // Skipped duplicates
  server_knowledge: number;
}
```

### Updating Transactions

**Single**: `PUT /budgets/{id}/transactions/{txn_id}` with `ExistingTransaction` body

**Bulk**: `PATCH /budgets/{id}/transactions` — can match by `id` OR `import_id`:
```typescript
await api.transactions.updateTransactions(budgetId, {
  transactions: [
    { id: "txn-uuid", category_id: "new-cat", memo: "updated" },
    { import_id: "YNAB:-50000:2026-01-15:1", approved: true },
  ],
});
```
- `id` takes precedence over `import_id` if both provided
- **Cannot update `import_id` value itself**

---

## 10. Split Transactions (Critical for Our Use Case)

### Creating a Split
Set `category_id` to `null` on parent, provide `subtransactions` array. Amounts must sum to parent total.

```typescript
await api.transactions.createTransaction(budgetId, {
  transaction: {
    account_id: "acct-uuid",
    date: "2026-02-22",
    amount: -47230,                    // Total: -$47.23
    payee_name: "Amazon.com",
    category_id: null,                 // Required for splits
    memo: "Amazon order #123-456",
    cleared: "cleared",
    approved: true,
    subtransactions: [
      {
        amount: -15990,                // -$15.99
        category_id: "electronics-uuid",
        memo: "USB-C Charger",
      },
      {
        amount: -21240,                // -$21.24
        category_id: "household-uuid",
        memo: "Paper Towels (x2)",
      },
      {
        amount: -10000,                // -$10.00
        category_id: "groceries-uuid",
        memo: "Snacks",
      },
    ],
  },
});
```

### Split Transaction Limitations (CRITICAL)

1. **Cannot update subtransactions on an existing split** — explicitly not supported
2. **Cannot change `category_id`** on an existing split
3. **Cannot change `date`** on an existing split
4. **Cannot change `amount`** on an existing split (silently ignored!)
5. When reading, parent's `category_name` shows `"Split"`

**Workaround for updating splits**: Delete the existing transaction and create a new one.

### Implications for Our Design
- We should create splits correctly the first time (get categorization right before pushing)
- If user wants to re-categorize after push, we must delete + recreate
- The Milestone 3 categorization UI should happen BEFORE the YNAB push, not after
- Consider keeping uncategorized items in an "uncategorized" subtransaction that can be updated later (but this won't work due to split update limitations)

---

## 11. import_id and Duplicate Detection

### Format
Standard: `YNAB:[milliunit_amount]:[iso_date]:[occurrence]`
- Example: `YNAB:-47230:2026-02-22:1` (first -$47.23 transaction on 2026-02-22)
- Example: `YNAB:-47230:2026-02-22:2` (second with same amount/date)
- **Max length**: 36 characters

### Behavior
- If `import_id` matches existing transaction on same account: **single create returns 409**, **bulk create silently skips** (reports in `duplicate_import_ids`)
- When set, YNAB auto-matches against existing **user-entered** transactions on same account, same amount, within **+/- 10 days**
- `import_id` is null for user-entered transactions
- Cannot be updated after creation

### Relevance to Our Integration
We should generate deterministic `import_id` values from Amazon transaction data (date + amount + occurrence) to:
- Prevent duplicate pushes if user runs the flow multiple times
- Allow YNAB to match against transactions already imported from bank feeds

---

## 12. Delta Requests (`server_knowledge`)

### How It Works
1. First request: full data, response includes `server_knowledge` integer
2. Subsequent requests: pass `?last_knowledge_of_server=<value>`
3. Response includes only changed entities (including deletions with `deleted: true`)

### Supported Endpoints
All major listing endpoints: budgets, accounts, categories, months, payees, transactions, scheduled_transactions

### Key Notes
- Deleted entities (`deleted: true`) **only appear** in delta responses
- Single-resource GETs do NOT support delta
- Store `server_knowledge` per endpoint for efficient polling

---

## 13. Error Codes Reference

| HTTP | Error ID | Name | Description |
|------|----------|------|-------------|
| 400 | 400 | bad_request | Malformed request or validation error |
| 401 | 401 | not_authorized | Bad/expired/revoked token |
| 403.1 | 403.1 | subscription_lapsed | YNAB subscription expired |
| 403.2 | 403.2 | trial_expired | Trial ended |
| 403.3 | 403.3 | unauthorized_scope | Token lacks required permissions |
| 403.4 | 403.4 | data_limit_reached | Abuse prevention limit |
| 404.1 | 404.1 | not_found | URI doesn't exist |
| 404.2 | 404.2 | resource_not_found | Resource (budget, txn, etc.) not found |
| 409 | 409 | conflict | Duplicate import_id (single create) |
| 429 | 429 | too_many_requests | Rate limit (200/hr) exceeded |
| 500 | 500 | internal_server_error | Server error |
| 503 | 503 | service_unavailable | Maintenance or >30s timeout |

---

## 14. HybridTransaction (Category/Payee/Month Listings)

When listing transactions by category or payee, subtransactions matching that filter are returned as individual entries:

```typescript
interface HybridTransaction extends TransactionSummary {
  type: "transaction" | "subtransaction";
  parent_transaction_id?: string | null; // Set if type is "subtransaction"
  account_name: string;
  payee_name?: string | null;
  category_name?: string;
}
```

This means: when querying transactions by category, you'll see individual subtransactions that belong to that category, not just the parent split transaction.

---

## 15. Key Gotchas Summary

1. **`approved` defaults to `false`** — transactions appear unapproved unless explicitly set
2. **Future dates rejected** — use scheduled transactions endpoint instead
3. **Credit Card Payment categories** cannot be set via API (silently ignored)
4. **Split updates not supported** — must delete + recreate
5. **Split amount/date/category changes silently ignored** — no error, just no effect
6. **409 vs silent skip** — single create with duplicate import_id = 409 error; bulk = silent skip
7. **Category amounts are month-specific** — list endpoint returns current UTC month only
8. **200 req/hr rate limit** — per token, not per endpoint
9. **Deleted entities only in delta responses** — won't see them without `server_knowledge`
10. **Memo max 500 chars** (per API spec), but YNAB UI may truncate display earlier
11. **Payee name max 200 chars** (on transaction), **500 chars** (on payee update)

---

## 16. SDK vs Raw Fetch Trade-off

### Current State
Our `ynab_api.ts` uses raw `fetch` with custom `YnabApiError` handling. Works for budgets + categories.

### SDK Advantages
- Full TypeScript types for all request/response shapes
- `subtransactions` support with proper typing (critical for splits)
- `import_id` duplicate detection
- `utils` (milliunit conversion, date formatting)
- Delta request support via `lastKnowledgeOfServer` parameter
- Structured `DetailError` for error handling

### SDK Disadvantages
- Bundle size increase for the extension
- Another dependency to maintain
- Our raw fetch approach is lightweight and already working

### Recommendation
Consider adopting the SDK when implementing transaction creation (Milestone 2). The typed split transaction support and import_id handling are valuable enough to justify the dependency. Alternatively, continue with raw fetch but use the SDK's type definitions as reference for our own interfaces.

---

## Sources
- [YNAB API Official Docs](https://api.ynab.com/)
- [YNAB JS SDK](https://github.com/ynab/ynab-sdk-js) — SDK source, TypeScript interfaces
- [YNAB API Starter Kit](https://github.com/ynab/ynab-api-starter-kit) — Vue.js reference app
- [YNAB OpenAPI Spec](https://github.com/ynab/ynab-sdk-ruby/blob/main/open_api_spec.yaml) — canonical spec
