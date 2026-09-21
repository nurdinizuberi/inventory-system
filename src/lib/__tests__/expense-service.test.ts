import { describe, it, expect } from 'vitest';
import {
  computeNetProfit,
  countsTowardProfit,
  nextExpenseNumber,
  periodBounds,
  periodKey,
  sumPaidExpenses,
} from '../expense-service';

describe('sumPaidExpenses', () => {
  it('sums only paid expenses', () => {
    const expenses = [
      { amount: 500_000, status: 'paid' },
      { amount: 100_000, status: 'paid' },
      { amount: 50_000, status: 'draft' },
      { amount: 25_000, status: 'cancelled' },
    ];
    expect(sumPaidExpenses(expenses)).toBe(600_000);
  });

  it('returns 0 for empty or all-draft lists', () => {
    expect(sumPaidExpenses([])).toBe(0);
    expect(sumPaidExpenses([{ amount: 900, status: 'draft' }])).toBe(0);
  });

  it('rounds to 2 decimals', () => {
    expect(sumPaidExpenses([{ amount: 10.005, status: 'paid' }, { amount: 20.004, status: 'paid' }])).toBe(30.01);
  });
});

describe('countsTowardProfit', () => {
  it('is true only for paid', () => {
    expect(countsTowardProfit('paid')).toBe(true);
    expect(countsTowardProfit('draft')).toBe(false);
    expect(countsTowardProfit('cancelled')).toBe(false);
  });
});

describe('computeNetProfit', () => {
  it('follows Net Profit = Revenue − COGS − Expenses', () => {
    expect(computeNetProfit(10_000_000, 6_000_000, 1_200_000)).toBe(2_800_000);
  });

  it('includes operating losses (refunds, shrinkage) in the final line', () => {
    expect(computeNetProfit(10_000_000, 6_000_000, 1_200_000, 300_000)).toBe(2_500_000);
  });

  it('can go negative', () => {
    expect(computeNetProfit(1_000, 800, 500)).toBe(-300);
  });
});

describe('periodKey / periodBounds', () => {
  const d = new Date(2026, 8, 21, 15, 45); // 21 Sep 2026, 15:45 local

  it('buckets by day, month and year', () => {
    expect(periodKey(d, 'day')).toBe('2026-09-21');
    expect(periodKey(d, 'month')).toBe('2026-09');
    expect(periodKey(d, 'year')).toBe('2026');
  });

  it('day bounds are [start, next-day)', () => {
    const { start, end } = periodBounds(d);
    expect(start.getHours()).toBe(0);
    expect(end.getDate()).toBe(22);
    expect(end.getHours()).toBe(0);
    expect(d >= start && d < end).toBe(true);
  });
});

describe('nextExpenseNumber', () => {
  it('continues the sequence', () => {
    expect(nextExpenseNumber('EXP-0044')).toBe('EXP-0045');
  });

  it('starts at 0001', () => {
    expect(nextExpenseNumber(null)).toBe('EXP-0001');
    expect(nextExpenseNumber('')).toBe('EXP-0001');
  });
});
