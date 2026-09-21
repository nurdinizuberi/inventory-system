import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { computeNetProfit, periodKey } from '@/lib/expense-service';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { round2, todayStart } from '@/lib/utils';

/**
 * Expenses dashboard feed: KPI strip (this month / today / this year), a
 * category breakdown and a monthly expense trend for the chart. Grouped
 * profit-by-month is included so the page can chart net profit alongside
 * expenses without extra round trips.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'expense.view' });
    const url = new URL(request.url);
    const months = Math.min(Math.max(Number(url.searchParams.get('months')) || 12, 1), 24);
    const locationId = url.searchParams.get('locationId');
    const scope = scopedLocationIds(ctx);
    const locationFilter = locationId ? [locationId] : scope ?? undefined;
    const tenantFilter = ctx.tenantId ? { tenantId: ctx.tenantId } : {};
    const paidFilter = { status: 'paid' as const };

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const yearStart = new Date(monthStart.getFullYear(), 0, 1);

    const [today, thisMonth, thisYear, allTime, byCategory, paid] = await Promise.all([
      prisma.expense.aggregate({
        where: { ...tenantFilter, ...paidFilter, expenseDate: { gte: todayStart() } },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { ...tenantFilter, ...paidFilter, expenseDate: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { ...tenantFilter, ...paidFilter, expenseDate: { gte: yearStart } },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({ where: { ...tenantFilter, ...paidFilter }, _sum: { amount: true } }),
      prisma.expense.groupBy({
        by: ['categoryId'],
        where: { ...tenantFilter, ...paidFilter, expenseDate: { gte: monthStart } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.expense.findMany({
        where: { ...tenantFilter, ...paidFilter },
        select: { amount: true, expenseDate: true },
      }),
    ]);

    const categories = await prisma.expenseCategory.findMany({
      where: { ...tenantFilter },
      select: { id: true, name: true },
    });
    const categoryNames = new Map(categories.map((c) => [c.id, c.name]));

    // Monthly buckets: expenses + sales revenue/COGS → net profit per month.
    // Sales are scoped to the caller's location assignments; expenses are
    // tenant-wide (they are not location-bound documents).
    const salesWhere = {
      ...tenantFilter,
      status: 'completed' as const,
      ...(locationFilter ? { locationId: { in: locationFilter } } : {}),
    };
    const [sales, drafts, cancelled] = await Promise.all([
      prisma.sale.findMany({
        where: { ...salesWhere, effectiveDate: { gte: new Date(monthStart.getFullYear(), monthStart.getMonth() - (months - 1), 1) } },
        select: { total: true, totalCost: true, effectiveDate: true },
      }),
      prisma.expense.count({ where: { ...tenantFilter, status: 'draft' } }),
      prisma.expense.count({ where: { ...tenantFilter, status: 'cancelled' } }),
    ]);

    const monthly = new Map<string, { expenses: number; revenue: number; cogs: number; netProfit: number }>();
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(monthStart.getFullYear(), monthStart.getMonth() - i, 1);
      monthly.set(periodKey(d, 'month'), { expenses: 0, revenue: 0, cogs: 0, netProfit: 0 });
    }
    for (const e of paid) {
      const key = periodKey(e.expenseDate, 'month');
      const bucket = monthly.get(key);
      if (bucket) bucket.expenses = round2(bucket.expenses + e.amount);
    }
    for (const s of sales) {
      const key = periodKey(s.effectiveDate, 'month');
      const bucket = monthly.get(key);
      if (bucket) {
        bucket.revenue = round2(bucket.revenue + s.total);
        bucket.cogs = round2(bucket.cogs + s.totalCost);
      }
    }
    for (const bucket of monthly.values()) {
      bucket.netProfit = computeNetProfit(bucket.revenue, bucket.cogs, bucket.expenses);
    }

    return NextResponse.json({
      kpis: {
        today: round2(today._sum.amount ?? 0),
        thisMonth: round2(thisMonth._sum.amount ?? 0),
        thisYear: round2(thisYear._sum.amount ?? 0),
        allTime: round2(allTime._sum.amount ?? 0),
        drafts,
        cancelled,
      },
      byCategory: byCategory
        .map((row) => ({
          category: categoryNames.get(row.categoryId) ?? 'Other',
          total: round2(row._sum.amount ?? 0),
          count: row._count,
        }))
        .sort((a, b) => b.total - a.total),
      monthly: [...monthly.entries()].map(([key, v]) => ({ month: key, ...v })),
    });
  } catch (err) {
    return jsonError(err);
  }
}
