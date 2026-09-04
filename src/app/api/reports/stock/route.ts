import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';

/**
 * Current stock report: on hand per variant per location, derived entirely from
 * the ledger, with low-stock flags.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'report.stock' });
    const url = new URL(request.url);
    const locationId = url.searchParams.get('locationId');
    const onlyLow = url.searchParams.get('onlyLow') === '1';
    const q = url.searchParams.get('q')?.trim().toLowerCase();
    const asOfDateStr = url.searchParams.get('asOfDate');
    const asOfDate = asOfDateStr ? new Date(asOfDateStr) : undefined;

    const scope = scopedLocationIds(ctx);
    const locationIds = locationId ? [locationId] : scope ?? undefined;

    const variants = await prisma.variant.findMany({
      where: {
        isActive: true,
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(q
          ? {
              OR: [
                { sku: { contains: q } },
                { barcode: { contains: q } },
                { label: { contains: q } },
                { product: { name: { contains: q } } },
              ],
            }
          : {}),
      },
      include: { product: { include: { category: true } } },
      orderBy: [{ product: { name: 'asc' } }, { label: 'asc' }],
    });

    const locations = await prisma.location.findMany({
      where: { isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}), ...(locationIds ? { id: { in: locationIds } } : {}) },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });

    const matrix = await getStockMatrix(prisma, {
      variantIds: variants.map((v) => v.id),
      ...(locations.length ? { locationIds: locations.map((l) => l.id) } : {}),
      ...(asOfDate ? { asOfDate } : {}),
    });
    const key = (variantId: string, locationId: string) => `${variantId}|${locationId}`;
    const byPair = new Map(matrix.map((row) => [key(row.variantId, row.locationId), row]));

    // Latest known cost per variant (most recent purchase_in), for valuation.
    const latestCost = new Map<string, number>();
    const costRows = await prisma.stockMovement.findMany({
      where: { type: 'purchase_in', unitCost: { not: null }, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      select: { variantId: true, unitCost: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    for (const row of costRows) {
      if (!latestCost.has(row.variantId) && row.unitCost !== null) latestCost.set(row.variantId, row.unitCost);
    }

    const rows = variants.flatMap((variant) =>
      locations.map((location) => {
        const row = byPair.get(key(variant.id, location.id));
        const onHand = row?.onHand ?? 0;
        const reserved = row?.reserved ?? 0;
        const unitCost = latestCost.get(variant.id) ?? variant.costPrice ?? variant.product.costPrice;
        // A pair only exists in the matrix when the ledger has movement rows
        // for it. A variant that was never stocked at this location (e.g. a
        // product registered directly into the store while the warehouse has
        // no history for it) must NOT count as low or out of stock — those
        // flags only make sense where the product actually lives.
        const stocked = Boolean(row);
        return {
          variantId: variant.id,
          locationId: location.id,
          productName: variant.product.name,
          category: variant.product.category?.name ?? null,
          variantLabel: variant.label,
          sku: variant.sku,
          barcode: variant.barcode,
          locationName: location.name,
          locationType: location.type,
          onHand,
          reserved,
          sellable: row?.sellable ?? 0,
          sold: row?.sold ?? 0,
          lowStockThreshold: variant.lowStockThreshold,
          stocked,
          lowStock: stocked && onHand <= variant.lowStockThreshold,
          outOfStock: stocked && onHand <= 0,
          unitCost,
          stockValue: Math.round(onHand * unitCost * 100) / 100,
        };
      }),
    );

    const filtered = rows.filter((row) => {
      if (onlyLow && !row.lowStock) return false;
      if (onlyLow && row.locationType === 'DAMAGED') return false;
      return true;
    });

    return NextResponse.json({
      rows: filtered,
      locations,
      totals: {
        units: filtered.reduce((s, r) => s + r.onHand, 0),
        value: Math.round(filtered.reduce((s, r) => s + r.stockValue, 0) * 100) / 100,
        lowStock: filtered.filter((r) => r.lowStock && r.onHand > 0).length,
        outOfStock: filtered.filter((r) => r.outOfStock).length,
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
