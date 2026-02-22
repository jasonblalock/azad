'use strict';

const YNAB_BASE = 'https://api.ynab.com/v1';
const STORAGE_KEY = 'ynab_categories';

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

export function cacheCategories(groups: YnabCategoryGroup[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: groups }, () => {
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
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      resolve(result[STORAGE_KEY] || null);
    });
  });
}

export function clearCachedCategories(): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(STORAGE_KEY, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message);
      } else {
        resolve();
      }
    });
  });
}
