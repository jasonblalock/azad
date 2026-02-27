'use strict';

const YNAB_BASE = 'https://api.ynab.com/v1';
const CATEGORIES_STORAGE_KEY = 'ynab_categories';
const ACCOUNTS_CATEGORIES_STORAGE_KEY = 'ynab_accounts';

// Types

export interface YnabBudget {
  id: string;
  name: string;
}

export interface YnabCategory {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
}

export interface YnabCategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
  categories: YnabCategory[];
}

export interface YnabAccount {
  id: string;
  name: string;
  type: string;
  closed: boolean;
  on_budget: boolean;
}

export class YnabApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(`YNAB API error ${status}: ${detail}`);
    this.name = 'YnabApiError';
    this.status = status;
    this.detail = detail;
  }
}

// Internal fetch helper

async function ynabFetch<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${YNAB_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (body?.error?.detail) {
        detail = body.error.detail;
      }
    } catch (_) {
      // use statusText as detail
    }
    throw new YnabApiError(response.status, detail);
  }

  const json = await response.json();
  return json.data as T;
}

// Public API

export async function fetchBudgets(token: string): Promise<YnabBudget[]> {
  const data = await ynabFetch<{ budgets: YnabBudget[] }>('/budgets', token);
  return data.budgets.map(b => ({ id: b.id, name: b.name }));
}

export async function fetchCategories(
  token: string,
  budgetId: string,
): Promise<YnabCategoryGroup[]> {
  const data = await ynabFetch<{ category_groups: YnabCategoryGroup[] }>(
    `/budgets/${budgetId}/categories`,
    token,
  );
  return data.category_groups.map(g => ({
    id: g.id,
    name: g.name,
    hidden: g.hidden,
    deleted: g.deleted,
    categories: g.categories.map(c => ({
      id: c.id,
      name: c.name,
      hidden: c.hidden,
      deleted: c.deleted,
    })),
  }));
}

export async function fetchAccounts(
  token: string,
  budgetId: string,
): Promise<YnabAccount[]> {
  const data = await ynabFetch<{ accounts: YnabAccount[] }>(
    `/budgets/${budgetId}/accounts`,
    token,
  );
  return data.accounts
    .filter(a => !a.closed && a.on_budget)
    .map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      closed: a.closed,
      on_budget: a.on_budget,
    }));
}

export function cacheAccounts(accounts: YnabAccount[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [ACCOUNTS_CATEGORIES_STORAGE_KEY]: accounts }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message);
      } else {
        resolve();
      }
    });
  });
}

export function getCachedAccounts(): Promise<YnabAccount[] | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(ACCOUNTS_CATEGORIES_STORAGE_KEY, (result) => {
      resolve(result[ACCOUNTS_CATEGORIES_STORAGE_KEY] || null);
    });
  });
}

export function cacheCategories(groups: YnabCategoryGroup[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [CATEGORIES_STORAGE_KEY]: groups }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message);
      } else {
        resolve();
      }
    });
  });
}

export function getCachedCategories(): Promise<YnabCategoryGroup[] | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(CATEGORIES_STORAGE_KEY, (result) => {
      resolve(result[CATEGORIES_STORAGE_KEY] || null);
    });
  });
}

export function clearCachedCategories(): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(CATEGORIES_STORAGE_KEY, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message);
      } else {
        resolve();
      }
    });
  });
}
