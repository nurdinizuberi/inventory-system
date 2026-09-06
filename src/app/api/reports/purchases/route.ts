import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { daysAgo, round2 } from '@/lib/utils';

/** Purchase history: by supplier, by period, by variant — over confirmed POs. */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'report.purchases' });
    const url = new URL(request.url);
    const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')!) : daysAgo(90);
    const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : new Date();
    to.setHours(23, 59, 59, 999);
    const supplierId = url.searchParams.get('supplierId');
    const includeBackdated = url.searchParams.get('includeBackdated') === '1';

    const scope = scopedLocationIds(ctx);
    const purchases = await prisma.purchase.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        status: { in: ['confirmed', 'received'] },
        effectiveDate: { gte: from, lte: to },
        ...(supplierId ? { supplierId } : {}),
        ...(scope ? { locationId: { in: scope } } : {}),
        ...(!includeBackdated ? { isBackdated: false } : {}),
      },
      include: {
        supplier: true,
        location: true,
        lines: { include: { variant: { include: { product: true } }, batches: true } },
      },
      orderBy: { effectiveDate: 'desc' },
    });

    const bySupplier = new Map<string, { supplier: string; orders: number; units: number; value: number }>();
    const byVariant = new Map<string, { variant: string; units: number; value: number; avgCost: number }>();

    for (const purchase of purchases) {
      const s = bySupplier.get(purchase.supplierId) ?? {
        supplier: purchase.supplier.name,
        orders: 0,
        units: 0,
        value: 0,
      };
      s.orders += 1;
      bySupplier.set(purchase.supplierId, s);

      for (const line of purchase.lines) {
        s.units += line.quantity;
        s.value += line.lineTotal;

        const vKey = `${line.variant.product.name} — ${line.variant.label}`;
        const v = byVariant.get(vKey) ?? { variant: vKey, units: 0, value: 0, avgCost: 0 };
        v.units += line.quantity;
        v.value += line.lineTotal;
        byVariant.set(vKey, v);
      }
    }

    for (const v of byVariant.values()) {
      v.avgCost = v.units ? round2(v.value / v.units) : 0;
      v.value = round2(v.value);
    }
    for (const s of bySupplier.values()) s.value = round2(s.value);

    return NextResponse.json({
      from,
      to,
      purchases: purchases.map((p) => ({
        id: p.id,
        number: p.number,
        supplier: p.supplier.name,
        location: p.location.name,
        orderDate: p.effectiveDate,
        total: p.total,
        lines: p.lines.map((l) => ({
          variant: `${l.variant.product.name} — ${l.variant.label}`,
          sku: l.variant.sku,
          quantity: l.quantity,
          unitCost: l.unitCost,
          lineTotal: l.lineTotal,
          batch: l.batches.map((b) => b.code).join(', ') || null,
        })),
      })),
      bySupplier: [...bySupplier.values()].sort((a, b) => b.value - a.value),
      byVariant: [...byVariant.values()].sort((a, b) => b.value - a.value).slice(0, 20),
      totals: {
        orders: purchases.length,
        units: [...bySupplier.values()].reduce((s, x) => s + x.units, 0),
        value: round2([...bySupplier.values()].reduce((s, x) => s + x.value, 0)),
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
