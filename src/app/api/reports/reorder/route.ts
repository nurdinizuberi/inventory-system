import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';
import { round2 } from '@/lib/utils';

/**
 * Reorder suggestions. Uses the variant's low-stock threshold as the reorder
 * point: when on hand at a location is at or below it, suggest topping up to
 * twice the threshold. Only locations where the variant is actually stocked
 * are considered, so a variant never carried at a location is never suggested.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'report.stock' });
    const url = new URL(request.url);
    const locationId = url.searchParams.get('locationId');

    const scope = scopedLocationIds(ctx);
    const locationIds = locationId ? [locationId] : scope ?? undefined;

    const variants = await prisma.variant.findMany({
      where: {
        isActive: true,
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      },
      include: { product: { include: { category: true } } },
      orderBy: [{ product: { name: 'asc' } }, { label: 'asc' }],
    });

    const locations = await prisma.location.findMany({
      where: {
        isActive: true,
        type: { not: 'DAMAGED' },
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(locationIds ? { id: { in: locationIds } } : {}),
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });

    const matrix = await getStockMatrix(prisma, {
      variantIds: variants.map((v) => v.id),
      locationIds: locations.map((l) => l.id),
    });
    const key = (variantId: string, locationId: string) => `${variantId}|${locationId}`;
    const byPair = new Map(matrix.map((row) => [key(row.variantId, row.locationId), row]));

    // Latest known cost per variant (most recent purchase_in), for estimates.
    const latestCost = new Map<string, number>();
    const costRows = await prisma.stockMovement.findMany({
      where: { type: 'purchase_in', unitCost: { not: null }, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      select: { variantId: true, unitCost: true, effectiveDate: true },
      orderBy: { effectiveDate: 'desc' },
    });
    for (const row of costRows) {
      if (!latestCost.has(row.variantId) && row.unitCost !== null) latestCost.set(row.variantId, row.unitCost);
    }

    const rows = variants.flatMap((variant) =>
      locations.map((location) => {
        const row = byPair.get(key(variant.id, location.id));
        const stocked = Boolean(row);
        const onHand = row?.onHand ?? 0;
        if (!stocked) return null;
        const threshold = variant.lowStockThreshold;
        if (onHand > threshold) return null;
        const suggestedQty = Math.max(0, threshold * 2 - onHand);
        const unitCost = latestCost.get(variant.id) ?? variant.costPrice ?? variant.product.costPrice;
        return {
          variantId: variant.id,
          locationId: location.id,
          productName: variant.product.name,
          category: variant.product.category?.name ?? null,
          variantLabel: variant.label,
          sku: variant.sku,
          locationName: location.name,
          locationType: location.type,
          onHand,
          threshold,
          outOfStock: onHand <= 0,
          suggestedQty,
          unitCost,
          estimatedCost: round2(suggestedQty * unitCost),
        };
      }),
    ).filter((row): row is NonNullable<typeof row> => row !== null);

    return NextResponse.json({
      rows,
      locations,
      totals: {
        lines: rows.length,
        units: rows.reduce((s, r) => s + r.suggestedQty, 0),
        value: round2(rows.reduce((s, r) => s + r.estimatedCost, 0)),
        outOfStock: rows.filter((r) => r.outOfStock).length,
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}