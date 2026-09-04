import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';
import { daysAgo, round2, todayStart } from '@/lib/utils';

/** Dashboard KPIs + low-stock alerts + recent ledger activity. */
export async function GET() {
  try {
    const ctx = await guard({ action: 'stock.view' });
    const scope = scopedLocationIds(ctx);
    // Tenant isolation: location-scoped roles see their assigned locations, any
    // other tenant user sees every location that belongs to their tenant — never
    // another tenant's locations, regardless of role.
    const tenantFilter = ctx.tenantId ? { tenantId: ctx.tenantId } : {};

    const locations = await prisma.location.findMany({
      where: { isActive: true, ...tenantFilter, ...(scope ? { id: { in: scope } } : {}) },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    const locationIds = locations.map((l) => l.id);
    // Effective location scope used to filter sales/stock/batches/movements.
    // Null = no location filter (only reachable for non-tenant global admins).
    const effective = scope ?? (ctx.tenantId ? locationIds : null);
    const inEffective = effective ? { locationId: { in: effective } } : {};

    const [salesToday, sales7, pendingAdjustments, inTransit, drafts] = await Promise.all([
      prisma.sale.aggregate({
        where: { status: 'completed', soldAt: { gte: todayStart() }, ...inEffective },
        _sum: { total: true, profit: true, totalCost: true },
        _count: true,
      }),
      prisma.sale.findMany({
        where: { status: 'completed', soldAt: { gte: daysAgo(7) }, ...inEffective },
        include: { location: true },
      }),
      prisma.stockAdjustment.count({
        where: { status: 'pending', ...inEffective },
      }),
      prisma.stockTransfer.count({
        where: {
          status: 'in_transit',
          ...(effective ? { OR: [{ fromLocationId: { in: effective } }, { toLocationId: { in: effective } }] } : {}),
        },
      }),
      prisma.purchase.count({ where: { status: 'draft', ...inEffective } }),
    ]);

    const stock = await getStockMatrix(prisma, { locationIds });
    const variants = await prisma.variant.findMany({
      where: { id: { in: stock.map((s) => s.variantId) }, isActive: true },
      include: { product: true },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    const lowStock = stock
      .map((row) => {
        const variant = variantMap.get(row.variantId);
        if (!variant) return null;
        const location = locations.find((l) => l.id === row.locationId);
        if (!location || location.type === 'DAMAGED') return null;
        return {
          variantId: variant.id,
          locationId: location.id,
          name: `${variant.product.name} — ${variant.label}`,
          sku: variant.sku,
          location: location.name,
          onHand: row.onHand,
          reserved: row.reserved,
          threshold: variant.lowStockThreshold,
          outOfStock: row.onHand <= 0,
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .filter((x) => x.onHand <= x.threshold)
      .sort((a, b) => a.onHand / Math.max(1, a.threshold) - b.onHand / Math.max(1, b.threshold))
      .slice(0, 12);

    const lots = await prisma.batch.findMany({
      where: { remainingQty: { gt: 0 }, ...(effective ? { locationId: { in: effective } } : {}) },
    });
    const inventoryValue = round2(lots.reduce((s, b) => s + b.remainingQty * b.unitCost, 0));
    const unitsOnHand = stock.reduce((s, r) => s + r.onHand, 0);

    // 7-day revenue sparkline
    const days: { date: string; revenue: number; profit: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const day = daysAgo(i);
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      const inDay = sales7.filter((s) => s.soldAt >= day && s.soldAt < next);
      days.push({
        date: day.toISOString().slice(0, 10),
        revenue: round2(inDay.reduce((s, x) => s + x.total, 0)),
        profit: round2(inDay.reduce((s, x) => s + x.profit, 0)),
      });
    }

    const recentMovements = await prisma.stockMovement.findMany({
      where: { ...inEffective },
      include: { variant: { include: { product: true } }, location: true },
      orderBy: { createdAt: 'desc' },
      take: 12,
    });

    return NextResponse.json({
      user: { name: ctx.name, role: ctx.role, email: ctx.email },
      locations,
      kpis: {
        salesToday: round2(salesToday._sum.total ?? 0),
        profitToday: round2(salesToday._sum.profit ?? 0),
        transactionsToday: salesToday._count,
        unitsOnHand,
        inventoryValue,
        lowStockCount: lowStock.length,
        pendingAdjustments,
        inTransit,
        draftPurchases: drafts,
      },
      sparkline: days,
      lowStock,
      recentMovements: recentMovements.map((m) => ({
        id: m.id,
        type: m.type,
        quantity: m.quantity,
        status: m.status,
        variant: `${m.variant.product.name} — ${m.variant.label}`,
        location: m.location.name,
        reference: m.referenceLabel,
        reason: m.adjustmentReason,
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}
