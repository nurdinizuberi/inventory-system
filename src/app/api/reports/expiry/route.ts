import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { round2 } from '@/lib/utils';

/**
 * Approaching-expiry report. Every batch still on the shelf with a best-before
 * date inside the horizon (default 90 days, may already be past). Written off
 * stock does not appear because those batches are consumed FIFO.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'report.stock' });
    const url = new URL(request.url);
    const locationId = url.searchParams.get('locationId');
    const horizon = Number(url.searchParams.get('horizon') ?? 90);

    const scope = scopedLocationIds(ctx);
    const locationIds = locationId ? [locationId] : scope ?? undefined;

    const cutoff = new Date();
    cutoff.setHours(23, 59, 59, 999);
    cutoff.setDate(cutoff.getDate() + horizon);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const batches = await prisma.batch.findMany({
      where: {
        remainingQty: { gt: 0 },
        expiresAt: { not: null, lte: cutoff },
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(locationIds ? { locationId: { in: locationIds } } : {}),
      },
      include: { variant: { include: { product: { include: { category: true } } } }, location: true },
      orderBy: { expiresAt: 'asc' },
    });

    const rows = batches.map((batch) => {
      const daysLeft = Math.ceil((batch.expiresAt!.getTime() - today.getTime()) / 864e5);
      return {
        batchId: batch.id,
        code: batch.code,
        variantId: batch.variantId,
        locationId: batch.locationId,
        productName: batch.variant.product.name,
        category: batch.variant.product.category?.name ?? null,
        variantLabel: batch.variant.label,
        sku: batch.variant.sku,
        locationName: batch.location.name,
        expiresAt: batch.expiresAt,
        daysLeft,
        remainingQty: batch.remainingQty,
        unitCost: batch.unitCost,
        value: round2(batch.remainingQty * batch.unitCost),
      };
    });

    const expiredUnits = rows.filter((r) => r.daysLeft < 0).reduce((s, r) => s + r.remainingQty, 0);
    const soonUnits = rows.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 30).reduce((s, r) => s + r.remainingQty, 0);
    const expiredValue = round2(rows.filter((r) => r.daysLeft < 0).reduce((s, r) => s + r.value, 0));
    const soonValue = round2(rows.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 30).reduce((s, r) => s + r.value, 0));

    const locations = await prisma.location.findMany({
      where: {
        isActive: true,
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(locationIds ? { id: { in: locationIds } } : {}),
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });

    return NextResponse.json({
      rows,
      locations,
      horizon,
      totals: {
        lines: rows.length,
        units: rows.reduce((s, r) => s + r.remainingQty, 0),
        valueAtRisk: round2(rows.reduce((s, r) => s + r.value, 0)),
        expiredUnits,
        expiredValue,
        soonUnits,
        soonValue,
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}