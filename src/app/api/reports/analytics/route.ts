import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';
import { daysAgo, round2 } from '@/lib/utils';

/**
 * Inventory analytics. Two views over one query batch:
 *
 *  - ABC: every variant sold in the period, ranked by sales value and cut into
 *    A / B / C buckets on the classic 80/15/5 cumulative-value rule, with
 *    on-hand and run-out days for prioritisation.
 *  - Trends: velocity and direction compared with the previous equal-length
 *    period, plus days-of-stock and a straight-line 30-day projection.
 *
 * No schema change is needed: everything derives from the sales ledger and the
 * stock matrix.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'report.sales' });
    const url = new URL(request.url);
    const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')!) : daysAgo(90);
    const to = new Date(url.searchParams.get('to') ?? Date.now());
    to.setHours(23, 59, 59, 999);
    const locationId = url.searchParams.get('locationId');

    const scope = scopedLocationIds(ctx);
    const locationFilter = locationId ? [locationId] : scope ?? undefined;
    const saleWhere = (gte: Date, lte: Date) => ({
      ...(ctx.tenantId ? { tenant: { id: ctx.tenantId } } : {}),
      status: 'completed',
      effectiveDate: { gte, lte },
      ...(locationFilter ? { location: { id: { in: locationFilter } } } : {}),
    });

    const daySpan = Math.max(1, Math.round((to.getTime() - from.getTime()) / 864e5));
    const previousTo = new Date(from.getTime() - 1);
    const previousFrom = new Date(from.getTime() - daySpan * 864e5);

    const after = (rows: Array<{ variantId: string; quantity: number; lineTotal: number; lineCost: number }>) => {
      const byVariant = new Map<string, { units: number; value: number; cost: number }>();
      for (const line of rows) {
        const agg = byVariant.get(line.variantId) ?? { units: 0, value: 0, cost: 0 };
        agg.units += line.quantity;
        agg.value += line.lineTotal;
        agg.cost += line.lineCost;
        byVariant.set(line.variantId, agg);
      }
      return byVariant;
    };

    const [current, previous] = await Promise.all([
      prisma.saleLine.findMany({
        where: { sale: saleWhere(from, to) },
        select: { variantId: true, quantity: true, lineTotal: true, lineCost: true },
      }),
      prisma.saleLine.findMany({
        where: { sale: saleWhere(previousFrom, previousTo) },
        select: { variantId: true, quantity: true, lineTotal: true, lineCost: true },
      }),
    ]);

    const currentByVariant = after(current);
    const previousByVariant = after(previous);

    const locations = await prisma.location.findMany({
      where: {
        isActive: true,
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(locationFilter ? { id: { in: locationFilter } } : {}),
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });

    // Current on-hand aggregated across the effective location set.
    const matrix = await getStockMatrix(prisma, { locationIds: locations.map((l) => l.id) });
    const onHandByVariant = new Map<string, number>();
    for (const row of matrix) onHandByVariant.set(row.variantId, (onHandByVariant.get(row.variantId) ?? 0) + row.onHand);

    const soldIds = new Set([...currentByVariant.keys(), ...previousByVariant.keys()]);
    const variants = await prisma.variant.findMany({
      where: { id: { in: [...soldIds] }, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { product: { include: { category: true } } },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    const velocity = (units: number) => round2(units / daySpan);
    const daysOfStock = (units: number, onHand: number) => (units > 0 ? round2(onHand / velocity(units)) : null);
    const projected30 = (units: number) => round2(velocity(units) * 30);

    // ---- ABC by sales value (classic 80/15/5 cumulative cut) --------------
    const abcEntries = [...currentByVariant.entries()]
      .map(([variantId, agg]) => {
        const variant = variantMap.get(variantId);
        if (!variant) return null;
        const onHand = onHandByVariant.get(variantId) ?? 0;
        return {
          variantId,
          productName: variant.product.name,
          category: variant.product.category?.name ?? null,
          variantLabel: variant.label,
          sku: variant.sku,
          units: agg.units,
          salesValue: round2(agg.value),
          consumptionValue: round2(agg.cost),
          onHand,
          daysOfStock: daysOfStock(agg.units, onHand),
          velocity: velocity(agg.units),
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => b.salesValue - a.salesValue);

    const totalValue = abcEntries.reduce((s, r) => s + r.salesValue, 0);
    const totalConsumption = abcEntries.reduce((s, r) => s + r.consumptionValue, 0);
    let cumValue = 0;
    const counts = { a: 0, b: 0, c: 0 };
    const valueByClass = { a: 0, b: 0, c: 0 };
    const abc = abcEntries.map((row, i) => {
      cumValue += row.salesValue;
      const valuePct = totalValue ? (cumValue / totalValue) * 100 : 0;
      const klass = valuePct <= 80 ? 'A' : valuePct <= 95 ? 'B' : 'C';
      counts[klass.toLowerCase() as 'a' | 'b' | 'c'] += 1;
      valueByClass[klass.toLowerCase() as 'a' | 'b' | 'c'] += row.salesValue;
      return {
        ...row,
        class: klass,
        valueShare: totalValue ? round2((row.salesValue / totalValue) * 100) : 0,
        cumValuePct: round2(valuePct),
        itemShare: round2(((i + 1) / Math.max(1, abcEntries.length)) * 100),
      };
    });

    // ---- Trends: current vs previous period -------------------------------
    const trends = [...currentByVariant.entries()]
      .map(([variantId, agg]) => {
        const variant = variantMap.get(variantId);
        if (!variant) return null;
        const prev = previousByVariant.get(variantId);
        const prevUnits = prev?.units ?? 0;
        const onHand = onHandByVariant.get(variantId) ?? 0;
        const growth =
          prevUnits > 0
            ? round2(((agg.units - prevUnits) / prevUnits) * 100)
            : agg.units > 0
              ? 100
              : 0;
        const trend: 'rising' | 'steady' | 'declining' =
          growth >= 15 ? 'rising' : growth <= -15 ? 'declining' : 'steady';
        return {
          variantId,
          productName: variant.product.name,
          category: variant.product.category?.name ?? null,
          variantLabel: variant.label,
          sku: variant.sku,
          units: agg.units,
          salesValue: round2(agg.value),
          previousUnits: prevUnits,
          growth,
          trend,
          velocity: velocity(agg.units),
          onHand,
          daysOfStock: daysOfStock(agg.units, onHand),
          projected30: projected30(agg.units),
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => b.units - a.units);

    const stockDays = trends.map((t) => t.daysOfStock).filter((d): d is number => d !== null);
    const trendCounts: Record<'rising' | 'steady' | 'declining', number> = { rising: 0, steady: 0, declining: 0 };
    for (const t of trends) trendCounts[t.trend] += 1;

    return NextResponse.json({
      from,
      to,
      previousFrom,
      periodDays: daySpan,
      locations,
      abc: {
        rows: abc,
        totals: {
          lines: abc.length,
          units: abc.reduce((s, r) => s + r.units, 0),
          salesValue: round2(totalValue),
          consumptionValue: round2(totalConsumption),
          countA: counts.a,
          countB: counts.b,
          countC: counts.c,
          valueA: round2(valueByClass.a),
          valueB: round2(valueByClass.b),
          valueC: round2(valueByClass.c),
        },
      },
      trends: {
        rows: trends,
        totals: {
          lines: trends.length,
          units: trends.reduce((s, r) => s + r.units, 0),
          rising: trendCounts.rising,
          steady: trendCounts.steady,
          declining: trendCounts.declining,
          projectedUnits: round2(trends.reduce((s, r) => s + r.projected30, 0)),
          avgDaysOfStock: stockDays.length ? round2(stockDays.reduce((s, d) => s + d, 0) / stockDays.length) : null,
          shortageLines: stockDays.filter((d) => d < 30).length,
        },
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}