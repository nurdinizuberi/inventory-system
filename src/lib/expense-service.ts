// ---------------------------------------------------------------------------
// Expense domain helpers. Expenses are OPERATING expenses (rent, transport,
// salaries...) and are deliberately kept apart from Purchases, which move cash
// into inventory and only hit the P&L as FIFO COGS when goods are sold.
// Only PAID expenses count toward Net Profit.
// ---------------------------------------------------------------------------

import { round2 } from './utils';

export const EXPENSE_COUNT_STATUSES = ['paid'] as const;

/** An expense hits the P&L only once it is actually paid. */
export function countsTowardProfit(status: string): boolean {
  return status === 'paid';
}

/** Total of paid expenses in a period — the "Operating expenses" P&L line. */
export function sumPaidExpenses(expenses: { amount: number; status: string }[]): number {
  return round2(expenses.filter((e) => countsTowardProfit(e.status)).reduce((s, e) => s + e.amount, 0));
}

/**
 * Net Profit = Total Sales Revenue − Cost of Goods Sold − Total Expenses.
 * `operatingLosses` carries refunds / damaged write-offs / shrinkage already
 * computed by the P&L report so the final line stays consistent with it.
 */
export function computeNetProfit(revenue: number, cogs: number, expenses: number, operatingLosses = 0): number {
  return round2(revenue - cogs - expenses - operatingLosses);
}

/** Start (inclusive) and end (exclusive) of the calendar bucket a date falls in. */
export function periodBounds(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

export type PeriodKey = 'day' | 'month' | 'year';

/** Stable grouping key for daily / monthly / yearly profit reports. */
export function periodKey(date: Date, granularity: PeriodKey): string {
  if (granularity === 'year') return `${date.getFullYear()}`;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  if (granularity === 'month') return `${date.getFullYear()}-${month}`;
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** EXP-0007 style sequential reference, per tenant. */
export function nextExpenseNumber(lastNumber: string | null | undefined): string {
  const tail = (lastNumber ?? '').split('-').pop() ?? '0';
  const seq = (parseInt(tail, 10) || 0) + 1;
  return `EXP-${String(seq).padStart(4, '0')}`;
}
