/* Copyright(c) 2024 Philip Mulcahy. */

'use strict';

import * as azad_order from './order';
import {dateToDateIsoString} from './date';
import * as item from './item';
import * as save_file from './save_file';
import * as transaction from './transaction';

export interface EnrichedTransactionItem {
  description: string;
  price: string;
  quantity: number;
  category: string;
  asin: string;
  orderId: string;
}

export interface EnrichedTransaction {
  date: Date;
  amount: number;
  cardInfo: string;
  vendor: string;
  orderIds: string[];
  items: EnrichedTransactionItem[];
  itemSummary: string;
  categorySummary: string;
}

export type EnrichedTransactionHandler = (
  enriched: EnrichedTransaction[]
) => Promise<void>;

export async function correlateTransactionsWithOrders(
  transactions: transaction.Transaction[],
  orderMap: Record<string, azad_order.IOrder>,
): Promise<EnrichedTransaction[]> {
  return Promise.all(transactions.map(async (t) => {
    const allItems: EnrichedTransactionItem[] = [];

    for (const orderId of t.orderIds) {
      const order = orderMap[orderId];
      if (order) {
        try {
          const items = await order.item_list();
          for (const i of items) {
            allItems.push({
              description: i.description,
              price: i.price,
              quantity: i.quantity,
              category: i.category,
              asin: i.asin,
              orderId,
            });
          }
        } catch (ex) {
          console.warn(
            `budget_shim: failed to get items for order ${orderId}:`, ex);
        }
      }
    }

    const itemSummary = allItems.map(i =>
      i.quantity > 1 ? `${i.description} x${i.quantity}` : i.description
    ).join('; ');

    const categories = allItems.map(i => i.category).filter(c => c);
    const categorySummary = [...new Set(categories)].join('; ');

    return {
      date: new Date(t.date),
      amount: t.amount,
      cardInfo: t.cardInfo,
      vendor: t.vendor,
      orderIds: t.orderIds,
      items: allItems,
      itemSummary,
      categorySummary,
    };
  }));
}

function csvEscape(s: string): string {
  const str = s == null ? '' : String(s);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export function enrichedTransactionsToCsv(
  enriched: EnrichedTransaction[]
): string {
  const BOM = '\uFEFF';
  const headers = [
    'Date', 'Payee', 'Memo', 'Amount', 'Card', 'Order IDs', 'Categories',
  ];
  const rows = enriched.map(t => [
    dateToDateIsoString(t.date),
    t.vendor,
    t.itemSummary,
    t.amount.toFixed(2),
    t.cardInfo,
    t.orderIds.join(' '),
    t.categorySummary,
  ].map(csvEscape).join(','));
  return BOM + [headers.map(csvEscape).join(','), ...rows].join('\r\n');
}

export async function downloadEnrichedCsv(
  enriched: EnrichedTransaction[]
): Promise<void> {
  const csvContent = enrichedTransactionsToCsv(enriched);
  const today = dateToDateIsoString(new Date());
  await save_file.save(csvContent, `amazon_transactions_enriched_${today}.csv`);
}

const PENDING_STORAGE_KEY = 'azad_pending_categorization';

function transactionKey(t: EnrichedTransaction): string {
  if (t.orderIds.length > 0) {
    return t.orderIds.slice().sort().join(',');
  }
  return `${t.date.toISOString()}|${t.amount}|${t.vendor}`;
}

function serializeTransaction(t: EnrichedTransaction): any {
  return { ...t, date: t.date.toISOString() };
}

function deserializeTransaction(raw: any): EnrichedTransaction {
  return { ...raw, date: new Date(raw.date) } as EnrichedTransaction;
}

export async function mergeForCategorization(
  enriched: EnrichedTransaction[]
): Promise<void> {
  const existing = await loadPendingCategorization();
  const pool = new Map<string, EnrichedTransaction>();
  if (existing) {
    for (const t of existing) {
      pool.set(transactionKey(t), t);
    }
  }
  for (const t of enriched) {
    pool.set(transactionKey(t), t);
  }
  const serializable = Array.from(pool.values()).map(serializeTransaction);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [PENDING_STORAGE_KEY]: serializable }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message);
      } else {
        resolve();
      }
    });
  });
}

export function loadPendingCategorization(): Promise<EnrichedTransaction[] | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(PENDING_STORAGE_KEY, (result) => {
      const raw = result[PENDING_STORAGE_KEY];
      if (!raw) {
        resolve(null);
        return;
      }
      resolve((raw as any[]).map(deserializeTransaction));
    });
  });
}

export async function exportBudgetData(
  transactions: transaction.Transaction[],
  orderMap: Record<string, azad_order.IOrder>,
  handler: EnrichedTransactionHandler,
): Promise<void> {
  const enriched = await correlateTransactionsWithOrders(transactions, orderMap);
  await handler(enriched);
}
