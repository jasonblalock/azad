'use strict';

import { loadPendingCategorization, EnrichedTransaction, EnrichedTransactionItem } from './budget_shim';
import { getCachedCategories, YnabCategoryGroup } from './ynab_api';

const ASSIGNMENTS_KEY = 'azad_category_assignments';

type Assignments = Record<string, string>;

interface FlatCategory {
  id: string;
  label: string; // "Group: Category"
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
): void {
  root.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.className = 'azad-cat-header';

  const h1 = document.createElement('h1');
  h1.textContent = 'Categorize for YNAB';
  header.appendChild(h1);

  const progress = document.createElement('div');
  progress.className = 'azad-cat-progress';
  header.appendChild(progress);

  root.appendChild(header);

  function updateProgress() {
    const { assigned, total } = countAssigned(transactions, assignments);
    progress.innerHTML = `<span class="done">${assigned}</span> of ${total} items categorized`;
  }
  updateProgress();

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
      catTd.appendChild(buildCategorySelect(cats, key, assignments, tr, updateProgress));
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
        catTd.appendChild(buildCategorySelect(cats, key, assignments, tr, updateProgress));
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
    const [transactions, categoryGroups, assignments] = await Promise.all([
      loadPendingCategorization(),
      getCachedCategories(),
      loadAssignments(),
    ]);

    if (!transactions || transactions.length === 0) {
      root.innerHTML = '<div class="azad-cat-error">No transactions to categorize. Go back to the Amazon order page and click "categorize for YNAB".</div>';
      return;
    }

    if (!categoryGroups || categoryGroups.length === 0) {
      root.innerHTML = '<div class="azad-cat-error">No YNAB categories found. Connect to YNAB and select a budget in the extension settings first.</div>';
      return;
    }

    const cats = flattenCategories(categoryGroups);
    render(root, transactions, cats, assignments);
  } catch (err) {
    console.error('Categorize page error:', err);
    root.innerHTML = `<div class="azad-cat-error">Error loading data: ${err}</div>`;
  }
});
