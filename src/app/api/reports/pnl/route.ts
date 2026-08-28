import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { daysAgo, round2 } from '@/lib/utils';

/**
 * Profit & loss summary. Revenue and COGS come from the sales ledger; write-offs
 * (adjustments, damaged returns) are pulled from the movement ledger at cost so
 * shrinkage shows up in the result rather than hiding in a stock count.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'report.pnl' });
    const url = new URL(request.url);
    const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')!) : daysAgo(30);
    const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : new Date();
    to.setHours(23, 59, 59, 999);
    const locationId = url.searchParams.get('locationId');

    const scope = scopedLocationIds(ctx);
    const locationFilter = locationId ? [locationId] : scope ?? undefined;

    const sales = await prisma.sale.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        status: 'completed',
        soldAt: { gte: from, lte: to },
        ...(locationFilter ? { locationId: { in: locationFilter } } : {}),
      },
      include: { location: true },
    });

    const revenue = round2(sales.reduce((s, x) => s + x.total, 0));
    const cogs = round2(sales.reduce((s, x) => s + x.totalCost, 0));
    const discounts = round2(sales.reduce((s, x) => s + x.discountAmount, 0));
    const grossProfit = round2(revenue - cogs);

    // Returns: sellable restock (revenue reversal) and damaged write-off (cost).
    const returns = await prisma.return.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        status: 'completed',
        createdAt: { gte: from, lte: to },
        ...(locationFilter ? { locationId: { in: locationFilter } } : {}),
      },
      include: { lines: true },
    });
    const refunds = round2(returns.reduce((s, r) => s + r.totalRefund, 0));
    const damagedWriteOff = round2(
      returns.flatMap((r) => r.lines).filter((l) => l.condition === 'damaged').reduce((s, l) => s + l.unitCost * l.quantity, 0),
    );

    // Adjustments booked in the period, valued at the cost actually consumed.
    const adjustments = await prisma.stockMovement.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        type: 'adjustment',
        adjustmentReason: { not: null },
        createdAt: { gte: from, lte: to },
        ...(locationFilter ? { locationId: { in: locationFilter } } : {}),
        // Ignore adjustments that merely reverse a cancelled/voided document.
        referenceType: { not: 'Sale' },
      },
      select: { quantity: true, totalCost: true, adjustmentReason: true },
    });
    const shrinkageByReason: Record<string, { units: number; value: number }> = {};
    for (const a of adjustments) {
      const reason = a.adjustmentReason ?? 'other';
      const entry = shrinkageByReason[reason] ?? { units: 0, value: 0 };
      entry.units += Math.abs(a.quantity);
      // A negative totalCost is a write-off; a positive one is stock found.
      entry.value += a.totalCost ?? 0;
      shrinkageByReason[reason] = entry;
    }
    const shrinkage = round2(
      Object.values(shrinkageByReason).reduce((s, e) => s - e.value, 0),
    );

    const netProfit = round2(grossProfit - refunds - damagedWriteOff - shrinkage);

    const byLocation = new Map<string, { location: string; revenue: number; cogs: number; profit: number; margin: number }>();
    for (const sale of sales) {
      const entry = byLocation.get(sale.locationId) ?? {
        location: sale.location.name,
        revenue: 0,
        cogs: 0,
        profit: 0,
        margin: 0,
      };
      entry.revenue += sale.total;
      entry.cogs += sale.totalCost;
      entry.profit += sale.profit;
      byLocation.set(sale.locationId, entry);
    }
    for (const entry of byLocation.values()) {
      entry.revenue = round2(entry.revenue);
      entry.cogs = round2(entry.cogs);
      entry.profit = round2(entry.profit);
      entry.margin = entry.revenue ? round2((entry.profit / entry.revenue) * 100) : 0;
    }

    return NextResponse.json({
      from,
      to,
      revenue,
      discounts,
      cogs,
      grossProfit,
      grossMargin: revenue ? round2((grossProfit / revenue) * 100) : 0,
      refunds,
      damagedWriteOff,
      shrinkage,
      shrinkageByReason: Object.entries(shrinkageByReason).map(([reason, v]) => ({
        reason,
        units: v.units,
        value: round2(v.value),
      })),
      netProfit,
      netMargin: revenue ? round2((netProfit / revenue) * 100) : 0,
      transactions: sales.length,
      byLocation: [...byLocation.values()].sort((a, b) => b.profit - a.profit),
    });
  } catch (err) {
    return jsonError(err);
  }
}
