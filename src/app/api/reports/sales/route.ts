import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { daysAgo, round2 } from '@/lib/utils';

/**
 * Sales report over a period, grouped by day / location / variant.
 * Cost of goods comes from the FIFO unit cost stored on each sale line, which
 * itself came from the batches consumed at the till.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'report.sales' });
    const url = new URL(request.url);
    const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')!) : daysAgo(30);
    const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : new Date();
    to.setHours(23, 59, 59, 999);
    const locationId = url.searchParams.get('locationId');
    const groupBy = url.searchParams.get('groupBy') ?? 'day';
    const includeBackdated = url.searchParams.get('includeBackdated') === '1';

    const scope = scopedLocationIds(ctx);
    const where = {
      ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      status: 'completed' as const,
      soldAt: { gte: from, lte: to },
      ...(locationId ? { locationId } : {}),
      ...(scope ? { locationId: { in: scope } } : {}),
      // When includeBackdated is off, exclude backdated entries
      ...(!includeBackdated ? { isBackdated: false } : {}),
    };

    const sales = await prisma.sale.findMany({
      where,
      include: {
        location: true,
        cashier: { select: { id: true, name: true } },
        lines: { include: { variant: { include: { product: true } } } },
      },
      orderBy: { soldAt: 'asc' },
    });

    type Bucket = {
      key: string;
      label: string;
      transactions: number;
      units: number;
      revenue: number;
      cost: number;
      discount: number;
      profit: number;
      margin: number;
    };
    const buckets = new Map<string, Bucket>();
    const push = (key: string, label: string) => {
      const existing = buckets.get(key);
      if (existing) return existing;
      const created: Bucket = {
        key,
        label,
        transactions: 0,
        units: 0,
        revenue: 0,
        cost: 0,
        discount: 0,
        profit: 0,
        margin: 0,
      };
      buckets.set(key, created);
      return created;
    };

    const dayKey = (d: Date) => d.toISOString().slice(0, 10);

    for (const sale of sales) {
      let saleGroupKey: string;
      let saleGroupLabel: string;
      if (groupBy === 'location') {
        saleGroupKey = sale.locationId;
        saleGroupLabel = sale.location.name;
      } else if (groupBy === 'cashier') {
        saleGroupKey = sale.cashierId;
        saleGroupLabel = sale.cashier.name;
      } else if (groupBy === 'variant') {
        saleGroupKey = '__all__';
        saleGroupLabel = 'All variants';
      } else {
        saleGroupKey = dayKey(sale.soldAt);
        saleGroupLabel = saleGroupKey;
      }

      if (groupBy !== 'variant') {
        const bucket = push(saleGroupKey, saleGroupLabel);
        bucket.transactions += 1;
        bucket.revenue += sale.total;
        bucket.cost += sale.totalCost;
        bucket.discount += sale.discountAmount;
        bucket.profit += sale.profit;
        bucket.units += sale.lines.reduce((s, l) => s + l.quantity, 0);
      }

      for (const line of sale.lines) {
        const variantKey = groupBy === 'variant' ? line.variantId : `${saleGroupKey}::${line.variantId}`;
        const variantLabel = `${line.variant.product.name} — ${line.variant.label}`;
        const bucket = push(variantKey, groupBy === 'variant' ? variantLabel : variantLabel);
        if (groupBy === 'variant') {
          bucket.transactions += 1;
          bucket.revenue += line.lineTotal;
          bucket.cost += line.lineCost;
          bucket.discount += line.discountAmount;
          bucket.profit += line.lineProfit;
          bucket.units += line.quantity;
        }
      }
    }

    for (const bucket of buckets.values()) {
      bucket.revenue = round2(bucket.revenue);
      bucket.cost = round2(bucket.cost);
      bucket.profit = round2(bucket.profit);
      bucket.discount = round2(bucket.discount);
      bucket.margin = bucket.revenue ? round2((bucket.profit / bucket.revenue) * 100) : 0;
    }

    const totals: {
      transactions: number;
      units: number;
      revenue: number;
      cost: number;
      discount: number;
      profit: number;
      margin: number;
    } = {
      transactions: sales.length,
      units: sales.reduce((s, sale) => s + sale.lines.reduce((x, l) => x + l.quantity, 0), 0),
      revenue: round2(sales.reduce((s, sale) => s + sale.total, 0)),
      cost: round2(sales.reduce((s, sale) => s + sale.totalCost, 0)),
      discount: round2(sales.reduce((s, sale) => s + sale.discountAmount, 0)),
      profit: round2(sales.reduce((s, sale) => s + sale.profit, 0)),
      margin: 0,
    };
    totals.margin = totals.revenue ? round2((totals.profit / totals.revenue) * 100) : 0;

    // Best / worst sellers by profit.
    const byVariant = [...buckets.values()]
      .filter((b) => b.key.includes('::') || groupBy === 'variant')
      .map((b) => ({
        variant: b.label,
        units: b.units,
        revenue: b.revenue,
        profit: b.profit,
        margin: b.revenue ? round2((b.profit / b.revenue) * 100) : 0,
      }))
      .sort((a, b) => b.profit - a.profit);

    const recent = sales
      .slice(-10)
      .reverse()
      .map((sale) => ({
        id: sale.id,
        number: sale.number,
        soldAt: sale.soldAt,
        location: sale.location.name,
        cashier: sale.cashier.name,
        total: sale.total,
        profit: sale.profit,
        items: sale.lines.reduce((s, l) => s + l.quantity, 0),
      }));

    return NextResponse.json({
      from,
      to,
      groupBy,
      buckets: [...buckets.values()]
        .filter((b) => (groupBy === 'variant' ? !b.key.includes('::') : true))
        .sort((a, b) => a.key.localeCompare(b.key)),
      totals,
      topSellers: byVariant.slice(0, 8),
      worstSellers: byVariant.slice(-5).reverse(),
      recent,
    });
  } catch (err) {
    return jsonError(err);
  }
}
