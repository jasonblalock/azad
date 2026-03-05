'use strict';

import {
  loadPendingCategorization,
  removePendingTransactions,
  transactionKey,
  EnrichedTransaction,
  EnrichedTransactionItem,
} from './budget_shim';
import {
  getCachedCategories,
  getCachedAccounts,
  fetchAccounts,
  fetchCategories,
  cacheAccounts,
  cacheCategories,
  YnabCategoryGroup,
  YnabAccount,
} from './ynab_api';
import { buildYnabTransactions, isTransactionReady } from './ynab_push';
import * as settings from './settings';
import * as ynab from 'ynab';

const ASSIGNMENTS_KEY = 'azad_category_assignments';
const CARD_MAP_KEY = 'azad_card_account_map';

type Assignments = Record<string, string>;
type CardAccountMap = Record<string, string>;

interface FlatCategory {
  id: string;
  label: string; // "Group: Category"
}

function isGiftCardTransaction(txn: EnrichedTransaction): boolean {
  return /gift\s*card/i.test(txn.cardInfo);
}

function itemKey(item: EnrichedTransactionItem, index: number): string {
  const id = item.asin ? item.asin : `idx${index}`;
  return `${item.orderId}:${id}`;
}

function txnKey(txn: EnrichedTransaction, index: number): string {
  return `txn:${txn.orderIds.join(',')}:${index}`;
}

function flattenCategories(groups: YnabCategoryGroup[]): FlatCategory[] {
  const cats: FlatCategory[] = [];
  for (const g of groups) {
    if (g.hidden || g.deleted) continue;
    for (const c of g.categories) {
      if (c.hidden || c.deleted) continue;
      cats.push({ id: c.id, label: `${g.name}: ${c.name}` });
    }
  }
  cats.sort((a, b) => a.label.localeCompare(b.label));
  return cats;
}

function loadAssignments(): Promise<Assignments> {
  return new Promise((resolve) => {
    chrome.storage.local.get(ASSIGNMENTS_KEY, (result) => {
      resolve(result[ASSIGNMENTS_KEY] || {});
    });
  });
}

function loadCardAccountMap(): Promise<CardAccountMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get(CARD_MAP_KEY, (result) => {
      resolve(result[CARD_MAP_KEY] || {});
    });
  });
}

function saveCardAccountMap(map: CardAccountMap): void {
  chrome.storage.local.set({ [CARD_MAP_KEY]: map });
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function saveAssignments(assignments: Assignments): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    chrome.storage.local.set({ [ASSIGNMENTS_KEY]: assignments });
  }, 300);
}

function formatDate(d: Date): string {
  if (isNaN(d.getTime())) return '(unknown date)';
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function countAssigned(
  transactions: EnrichedTransaction[],
  assignments: Assignments,
): { assigned: number; total: number } {
  let assigned = 0;
  let total = 0;
  for (let ti = 0; ti < transactions.length; ti++) {
    const txn = transactions[ti];
    if (txn.items.length === 0) {
      total++;
      if (assignments[txnKey(txn, ti)]) assigned++;
    } else {
      for (let ii = 0; ii < txn.items.length; ii++) {
        total++;
        if (assignments[itemKey(txn.items[ii], ii)]) assigned++;
      }
    }
  }
  return { assigned, total };
}

function getUniqueCards(transactions: EnrichedTransaction[]): string[] {
  const cards = new Set<string>();
  for (const txn of transactions) {
    if (txn.cardInfo) cards.add(txn.cardInfo);
  }
  return Array.from(cards).sort();
}

function countPushable(
  transactions: EnrichedTransaction[],
  assignments: Assignments,
  cardAccountMap: CardAccountMap,
): number {
  return transactions.filter(
    (txn, ti) => isTransactionReady(txn, ti, assignments, cardAccountMap)
  ).length;
}

function allCardsMapped(
  cards: string[],
  cardAccountMap: CardAccountMap,
): boolean {
  return cards.every(c => !!cardAccountMap[c]);
}

function buildCategorySelect(
  cats: FlatCategory[],
  key: string,
  assignments: Assignments,
  row: HTMLTableRowElement | null,
  onUpdate: () => void,
): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'azad-cat-select';

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '-- select category --';
  sel.appendChild(blank);

  for (const cat of cats) {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.label;
    sel.appendChild(opt);
  }

  sel.value = assignments[key] || '';
  if (row && sel.value) {
    row.classList.add('assigned');
  }

  sel.addEventListener('change', () => {
    if (sel.value) {
      assignments[key] = sel.value;
      if (row) row.classList.add('assigned');
    } else {
      delete assignments[key];
      if (row) row.classList.remove('assigned');
    }
    saveAssignments(assignments);
    onUpdate();
  });

  return sel;
}

function render(
  root: HTMLElement,
  transactions: EnrichedTransaction[],
  cats: FlatCategory[],
  assignments: Assignments,
  accounts: YnabAccount[],
  cardAccountMap: CardAccountMap,
): void {
  root.innerHTML = '';

  const uniqueCards = getUniqueCards(transactions);

  // Header
  const header = document.createElement('div');
  header.className = 'azad-cat-header';

  // Top row: title + progress + push button
  const topRow = document.createElement('div');
  topRow.className = 'azad-cat-header-top';

  const h1 = document.createElement('h1');
  h1.textContent = 'Categorize for YNAB';
  topRow.appendChild(h1);

  const rightGroup = document.createElement('div');
  rightGroup.className = 'azad-cat-header-right';

  const progress = document.createElement('div');
  progress.className = 'azad-cat-progress';
  rightGroup.appendChild(progress);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'azad-refresh-btn';
  refreshBtn.textContent = '\u21BB Refresh';
  refreshBtn.title = 'Refresh accounts and categories from YNAB';
  rightGroup.appendChild(refreshBtn);

  const pushBtn = document.createElement('button');
  pushBtn.className = 'azad-push-btn';
  pushBtn.textContent = 'Push to YNAB';
  rightGroup.appendChild(pushBtn);

  topRow.appendChild(rightGroup);
  header.appendChild(topRow);

  // Status message area
  const statusEl = document.createElement('div');
  statusEl.className = 'azad-push-status';
  header.appendChild(statusEl);

  // Card mapping section
  if (uniqueCards.length > 0 && accounts.length > 0) {
    const cardSection = document.createElement('div');
    cardSection.className = 'azad-card-mapping';

    const cardTitle = document.createElement('div');
    cardTitle.className = 'azad-card-mapping-title';
    cardTitle.textContent = 'Card \u2192 YNAB Account Mapping';
    cardSection.appendChild(cardTitle);

    for (const card of uniqueCards) {
      const row = document.createElement('div');
      row.className = 'azad-card-mapping-row';

      const label = document.createElement('span');
      label.className = 'azad-card-label';
      label.textContent = card;
      row.appendChild(label);

      const arrow = document.createElement('span');
      arrow.className = 'azad-card-arrow';
      arrow.textContent = '\u2192';
      row.appendChild(arrow);

      const sel = document.createElement('select');
      sel.className = 'azad-account-select';

      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '-- select account --';
      sel.appendChild(blank);

      const sortedAccounts = accounts.slice().sort((a, b) => a.name.localeCompare(b.name));
      for (const acct of sortedAccounts) {
        const opt = document.createElement('option');
        opt.value = acct.id;
        opt.textContent = acct.name;
        sel.appendChild(opt);
      }

      sel.value = cardAccountMap[card] || '';

      sel.addEventListener('change', () => {
        if (sel.value) {
          cardAccountMap[card] = sel.value;
        } else {
          delete cardAccountMap[card];
        }
        saveCardAccountMap(cardAccountMap);
        updatePushState();
      });

      row.appendChild(sel);
      cardSection.appendChild(row);
    }

    header.appendChild(cardSection);
  }

  root.appendChild(header);

  function updateProgress() {
    const { assigned, total } = countAssigned(transactions, assignments);
    const pushable = countPushable(transactions, assignments, cardAccountMap);
    progress.innerHTML = `<span class="done">${assigned}</span> of ${total} items categorized`
      + (pushable > 0 && pushable < transactions.length
        ? ` &middot; ${pushable} order(s) ready`
        : '');
  }

  function updatePushState() {
    updateProgress();
    const { assigned, total } = countAssigned(transactions, assignments);
    const pushable = countPushable(transactions, assignments, cardAccountMap);

    if (pushable > 0) {
      pushBtn.disabled = false;
      pushBtn.textContent = pushable === transactions.length
        ? 'Push to YNAB'
        : `Push ${pushable} of ${transactions.length} to YNAB`;
      pushBtn.title = '';
    } else {
      pushBtn.disabled = true;
      pushBtn.textContent = 'Push to YNAB';
      const reasons: string[] = [];
      if (assigned < total) reasons.push(`${total - assigned} item(s) uncategorized`);
      const unmapped = uniqueCards.filter(c => !cardAccountMap[c]).length;
      if (unmapped > 0) reasons.push(`${unmapped} card(s) unmapped`);
      pushBtn.title = reasons.join(', ');
    }
  }

  updatePushState();

  // Push button handler
  pushBtn.addEventListener('click', async () => {
    pushBtn.disabled = true;
    pushBtn.textContent = 'Pushing...';
    statusEl.textContent = '';
    statusEl.className = 'azad-push-status';

    try {
      // Get PAT and budget ID from settings
      const [token, budgetId] = await Promise.all([
        settings.getString('ynab_pat'),
        settings.getString('ynab_budget_id'),
      ]);

      if (!token || !budgetId) {
        statusEl.textContent = 'YNAB not connected. Set up PAT and budget in extension settings.';
        statusEl.className = 'azad-push-status error';
        pushBtn.textContent = 'Push to YNAB';
        updatePushState();
        return;
      }

      // Build transaction payloads
      const result = buildYnabTransactions(transactions, assignments, cardAccountMap);

      if (result.transactions.length === 0) {
        statusEl.textContent = `No transactions to push. ${result.skipped.length} skipped.`;
        statusEl.className = 'azad-push-status error';
        pushBtn.textContent = 'Push to YNAB';
        updatePushState();
        return;
      }

      // Push via YNAB SDK
      const api = new ynab.API(token);
      const response = await api.transactions.createTransaction(budgetId, {
        transactions: result.transactions,
      });

      const created = response.data.transaction_ids?.length || 0;
      const duplicates = response.data.duplicate_import_ids || [];

      // Remove pushed transactions from pending
      const pushedKeys = transactions
        .filter((_t, i) => !result.skipped.some(s => s.transactionIndex === i))
        .map(t => transactionKey(t));
      await removePendingTransactions(pushedKeys);

      // Show success
      const parts: string[] = [];
      if (created > 0) parts.push(`${created} transaction(s) pushed`);
      if (duplicates.length > 0) parts.push(`${duplicates.length} already existed`);
      if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
      statusEl.textContent = parts.join(', ') + '.';
      statusEl.className = 'azad-push-status success';

      // Remove pushed transaction sections from the UI
      const sectionEls = root.querySelectorAll('.azad-cat-section');
      const pushedKeySet = new Set(pushedKeys);
      for (let i = 0; i < transactions.length; i++) {
        if (pushedKeySet.has(transactionKey(transactions[i]))) {
          sectionEls[i]?.remove();
        }
      }

      // Update in-memory transactions array (iterate in reverse to preserve indices)
      for (let i = transactions.length - 1; i >= 0; i--) {
        if (pushedKeySet.has(transactionKey(transactions[i]))) {
          transactions.splice(i, 1);
        }
      }

      // Refresh unique cards list and UI state
      uniqueCards.length = 0;
      uniqueCards.push(...getUniqueCards(transactions));
      updatePushState();
    } catch (err: any) {
      pushBtn.textContent = 'Push to YNAB';
      updatePushState();

      if (err?.error?.id) {
        // YNAB API error response
        const status = err.error.id;
        if (status === '401') {
          statusEl.textContent = 'Invalid or expired YNAB token. Update in extension settings.';
        } else if (status === '429') {
          statusEl.textContent = 'Rate limited by YNAB. Please wait and try again.';
        } else {
          statusEl.textContent = `YNAB error: ${err.error.detail || err.message || status}`;
        }
      } else {
        statusEl.textContent = `Push failed: ${err.message || err}`;
      }
      statusEl.className = 'azad-push-status error';
    }
  });

  // Refresh button handler
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing...';
    statusEl.textContent = '';
    statusEl.className = 'azad-push-status';

    try {
      const [token, budgetId] = await Promise.all([
        settings.getString('ynab_pat'),
        settings.getString('ynab_budget_id'),
      ]);

      if (!token || !budgetId) {
        statusEl.textContent = 'YNAB not connected. Set up PAT and budget in extension settings.';
        statusEl.className = 'azad-push-status error';
        refreshBtn.textContent = '\u21BB Refresh';
        refreshBtn.disabled = false;
        return;
      }

      const [freshGroups, freshAccounts] = await Promise.all([
        fetchCategories(token, budgetId),
        fetchAccounts(token, budgetId),
      ]);

      await Promise.all([
        cacheCategories(freshGroups),
        cacheAccounts(freshAccounts),
      ]);

      const freshCats = flattenCategories(freshGroups);

      // Re-render with fresh data, preserving assignments and card map
      render(root, transactions, freshCats, assignments, freshAccounts, cardAccountMap);

      // Show status after re-render
      const newStatusEl = root.querySelector('.azad-push-status');
      if (newStatusEl) {
        newStatusEl.textContent = `Refreshed: ${freshAccounts.length} accounts, ${freshCats.length} categories`;
        newStatusEl.className = 'azad-push-status success';
      }
    } catch (err: any) {
      statusEl.textContent = `Refresh failed: ${err.message || err}`;
      statusEl.className = 'azad-push-status error';
      refreshBtn.textContent = '\u21BB Refresh';
      refreshBtn.disabled = false;
    }
  });

  // Transaction sections
  for (let ti = 0; ti < transactions.length; ti++) {
    const txn = transactions[ti];

    const section = document.createElement('div');
    section.className = 'azad-cat-section';

    // Transaction header
    const txnHeader = document.createElement('div');
    txnHeader.className = 'azad-cat-txn-header';

    const vendor = document.createElement('span');
    vendor.className = 'azad-cat-txn-vendor';
    vendor.textContent = txn.vendor || 'Unknown vendor';
    txnHeader.appendChild(vendor);

    const meta = document.createElement('span');
    meta.className = 'azad-cat-txn-meta';
    const parts = [formatDate(txn.date), `$${txn.amount.toFixed(2)}`];
    if (txn.cardInfo) {
      parts.push(txn.cardInfo);
    }
    if (txn.orderIds.length > 0) {
      parts.push(txn.orderIds.join(', '));
    }
    meta.textContent = parts.join(' \u2022 ');
    txnHeader.appendChild(meta);

    section.appendChild(txnHeader);

    // Items table
    const table = document.createElement('table');
    table.className = 'azad-cat-items';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Description', 'Price', 'Qty', 'Category']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    if (txn.items.length === 0) {
      // No items — show a single row for the whole transaction
      const tr = document.createElement('tr');

      const descTd = document.createElement('td');
      descTd.className = 'desc';
      descTd.textContent = txn.itemSummary || '(no item details)';
      descTd.setAttribute('title', txn.itemSummary || '');
      tr.appendChild(descTd);

      const priceTd = document.createElement('td');
      priceTd.className = 'price';
      priceTd.textContent = `$${txn.amount.toFixed(2)}`;
      tr.appendChild(priceTd);

      const qtyTd = document.createElement('td');
      qtyTd.className = 'qty';
      qtyTd.textContent = '1';
      tr.appendChild(qtyTd);

      const catTd = document.createElement('td');
      const key = txnKey(txn, ti);
      catTd.appendChild(buildCategorySelect(cats, key, assignments, tr, updatePushState));
      tr.appendChild(catTd);

      tbody.appendChild(tr);
    } else {
      for (let ii = 0; ii < txn.items.length; ii++) {
        const item = txn.items[ii];
        const tr = document.createElement('tr');

        const descTd = document.createElement('td');
        descTd.className = 'desc';
        descTd.textContent = item.description || '(unknown item)';
        descTd.setAttribute('title', item.description || '');
        tr.appendChild(descTd);

        const priceTd = document.createElement('td');
        priceTd.className = 'price';
        priceTd.textContent = item.price;
        tr.appendChild(priceTd);

        const qtyTd = document.createElement('td');
        qtyTd.className = 'qty';
        qtyTd.textContent = String(item.quantity);
        tr.appendChild(qtyTd);

        const catTd = document.createElement('td');
        const key = itemKey(item, ii);
        catTd.appendChild(buildCategorySelect(cats, key, assignments, tr, updatePushState));
        tr.appendChild(catTd);

        tbody.appendChild(tr);
      }
    }

    table.appendChild(tbody);
    section.appendChild(table);
    root.appendChild(section);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const root = document.getElementById('azad-categorize-root')!;

  try {
    const [transactions, categoryGroups, assignments, accounts, cardAccountMap] = await Promise.all([
      loadPendingCategorization(),
      getCachedCategories(),
      loadAssignments(),
      getCachedAccounts(),
      loadCardAccountMap(),
    ]);

    if (!transactions || transactions.length === 0) {
      root.innerHTML = '<div class="azad-cat-error">No transactions to categorize. Go back to the Amazon order page and click "categorize for YNAB".</div>';
      return;
    }

    // Filter out gift card transactions — they're already accounted for
    // via the credit card used to buy the gift card.
    const giftCardCount = transactions.filter(t => isGiftCardTransaction(t)).length;
    const budgetTransactions = transactions.filter(t => !isGiftCardTransaction(t));

    if (budgetTransactions.length === 0) {
      root.innerHTML = '<div class="azad-cat-error">No transactions to categorize. All ' + giftCardCount + ' transaction(s) were gift card purchases (hidden).</div>';
      return;
    }

    if (!categoryGroups || categoryGroups.length === 0) {
      root.innerHTML = '<div class="azad-cat-error">No YNAB categories found. Connect to YNAB and select a budget in the extension settings first.</div>';
      return;
    }

    let resolvedAccounts = accounts || [];
    if (resolvedAccounts.length === 0) {
      const token = await settings.getString('ynab_pat');
      const budgetId = await settings.getString('ynab_budget_id');
      if (token && budgetId) {
        try {
          resolvedAccounts = await fetchAccounts(token, budgetId);
          await cacheAccounts(resolvedAccounts);
        } catch (err) {
          console.warn('Failed to fetch YNAB accounts:', err);
        }
      }
    }

    const cats = flattenCategories(categoryGroups);
    render(root, budgetTransactions, cats, assignments, resolvedAccounts, cardAccountMap);

    if (giftCardCount > 0) {
      const note = document.createElement('div');
      note.className = 'azad-gift-card-note';
      note.textContent = `${giftCardCount} gift card transaction(s) hidden.`;
      const header = root.querySelector('.azad-cat-header');
      if (header) {
        header.appendChild(note);
      }
    }
  } catch (err) {
    console.error('Categorize page error:', err);
    root.innerHTML = `<div class="azad-cat-error">Error loading data: ${err}</div>`;
  }
});
