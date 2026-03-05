'use strict';

import { EnrichedTransaction, EnrichedTransactionItem } from './budget_shim';
import { NewTransaction, SaveSubTransaction, TransactionClearedStatus } from 'ynab';

export interface BuildResult {
  transactions: NewTransaction[];
  skipped: SkippedTransaction[];
}

export interface SkippedTransaction {
  transactionIndex: number;
  reason: string;
}

function itemKey(item: EnrichedTransactionItem, index: number): string {
  const id = item.asin ? item.asin : `idx${index}`;
  return `${item.orderId}:${id}`;
}

function txnKey(txn: EnrichedTransaction, index: number): string {
  return `txn:${txn.orderIds.join(',')}:${index}`;
}

export function isTransactionReady(
  txn: EnrichedTransaction,
  txnIndex: number,
  assignments: Record<string, string>,
  cardAccountMap: Record<string, string>,
): boolean {
  if (!cardAccountMap[txn.cardInfo]) return false;
  if (txn.items.length === 0) {
    return !!assignments[txnKey(txn, txnIndex)];
  }
  return txn.items.every((item, ii) => !!assignments[itemKey(item, ii)]);
}

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 3) + '...';
}

function parsePrice(price: string): number {
  const cleaned = price.replace(/[^0-9.-]/g, '');
  return parseFloat(cleaned) || 0;
}

export function buildYnabTransactions(
  transactions: EnrichedTransaction[],
  assignments: Record<string, string>,
  cardAccountMap: Record<string, string>,
): BuildResult {
  const built: NewTransaction[] = [];
  const skipped: SkippedTransaction[] = [];

  // Track occurrence per amount+date combo for import_id uniqueness
  const occurrenceMap = new Map<string, number>();

  for (let ti = 0; ti < transactions.length; ti++) {
    const txn = transactions[ti];

    // Check if transaction is fully ready (card mapped + all items categorized)
    if (!isTransactionReady(txn, ti, assignments, cardAccountMap)) {
      const reason = !cardAccountMap[txn.cardInfo]
        ? `Unmapped card: ${txn.cardInfo}`
        : txn.items.length === 0
          ? 'Transaction not categorized'
          : `${txn.items.filter((item, ii) => !assignments[itemKey(item, ii)]).length} uncategorized item(s)`;
      skipped.push({ transactionIndex: ti, reason });
      continue;
    }

    const accountId = cardAccountMap[txn.cardInfo];
    const hasItems = txn.items.length > 0;

    const date = formatDate(txn.date);
    const amountMilliunits = -Math.round(txn.amount * 1000);
    const memo = truncate(txn.orderIds.join(', '), 200);

    // Build import_id: YNAB:{amount}:{date}:{occurrence}
    const occKey = `${amountMilliunits}:${date}`;
    const occurrence = (occurrenceMap.get(occKey) || 0) + 1;
    occurrenceMap.set(occKey, occurrence);
    const importId = truncate(`YNAB:${amountMilliunits}:${date}:${occurrence}`, 36);

    const saveTxn: NewTransaction = {
      account_id: accountId,
      date,
      amount: amountMilliunits,
      payee_name: txn.vendor || 'Amazon.com',
      memo,
      cleared: TransactionClearedStatus.Uncleared,
      approved: true,
      import_id: importId,
    };

    if (!hasItems) {
      // Single category for the whole transaction
      saveTxn.category_id = assignments[txnKey(txn, ti)];
    } else if (txn.items.length === 1) {
      // Single item — direct category, no split
      saveTxn.category_id = assignments[itemKey(txn.items[0], 0)];
    } else {
      // Multiple items — build split subtransactions
      saveTxn.category_id = null;

      const subtransactions: SaveSubTransaction[] = txn.items.map((item, ii) => {
        const subAmount = -Math.round(parsePrice(item.price) * 1000);
        return {
          amount: subAmount,
          category_id: assignments[itemKey(item, ii)],
          memo: truncate(item.description, 200),
        };
      });

      // Remainder handling: distribute difference to largest subtransaction
      const subTotal = subtransactions.reduce((sum, s) => sum + s.amount, 0);
      const remainder = amountMilliunits - subTotal;
      if (remainder !== 0 && subtransactions.length > 0) {
        // Find the largest subtransaction (most negative = largest purchase)
        let largestIdx = 0;
        let largestAbs = 0;
        for (let i = 0; i < subtransactions.length; i++) {
          const abs = Math.abs(subtransactions[i].amount);
          if (abs > largestAbs) {
            largestAbs = abs;
            largestIdx = i;
          }
        }
        subtransactions[largestIdx].amount += remainder;
      }

      saveTxn.subtransactions = subtransactions;
    }

    built.push(saveTxn);
  }

  return { transactions: built, skipped };
}
