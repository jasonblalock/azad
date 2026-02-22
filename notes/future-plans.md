B. Custom categorization UI (standalone, API-driven)

  This is the most compelling idea to me. The workflow would be:
  1. Pull uncategorized transactions from YNAB API (filtered to Amazon payees)
  2. Correlate with Amazon order data (from this extension's scrape, cached locally or in extension storage)
  3. Present a purpose-built UI: each item shown individually with its description, price, and a category picker populated from the user's actual YNAB categories
  4. User rapidly categorizes (or confirms AI suggestions — see option C)
  5. Push split transactions back to YNAB via API

  Why this is strong: You control the entire UX. No memo length limits, no fighting YNAB's UI, no fragile DOM overlays. YNAB's API is well-documented and supports split transactions natively.

  This could live as a page within the existing extension (options page or new tab) or as a small standalone web app.

  C. AI/LLM auto-categorization

  This pairs naturally with option B rather than replacing it. The flow:
  - User's YNAB categories are fetched via API (e.g., "Groceries", "Electronics", "Health", "Household")
  - Item descriptions + categories are sent to an LLM (could be a simple prompt: "Given these budget categories, categorize this item: 'Anker USB-C Charger 45W...'")
  - AI suggests category for each item; user confirms/overrides in the UI
  - Over time, you could cache confirmed mappings (ASIN → category) so repeat purchases don't need AI at all

  This is very feasible — the mapping problem is straightforward for even small models. Could use a cloud API (OpenAI, Anthropic) or even a local rules-based approach as a starting point (keyword
  matching against category names).

  ---
  My recommendation

  B + C combined: A categorization UI powered by AI suggestions. The CSV becomes an intermediate format or goes away entirely — the real value is the streamlined categorization workflow with YNAB
  API integration.