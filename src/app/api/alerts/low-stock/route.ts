import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';

/**
 * Low-stock alert feed for the header bell. Tenant-isolated and
 * location-scoped exactly like the dashboard: location-scoped roles see only
 * their assigned locations, everyone else sees their tenant's locations.
 * Count = variant/location pairs at or below threshold (including zero on
 * hand); items = the worst offenders, most urgent first.
 */
export async function GET() {
  try {
    const ctx = await guard({ action: 'stock.view' });
    const scope = scopedLocationIds(ctx);
    const tenantFilter = ctx.tenantId ? { tenantId: ctx.tenantId } : {};

    const locations = await prisma.location.findMany({
      where: { isActive: true, ...tenantFilter, ...(scope ? { id: { in: scope } } : {}) },
    });
    const locationById = new Map(locations.map((l) => [l.id, l]));
    if (locations.length === 0) return NextResponse.json({ count: 0, items: [] });

    const stock = await getStockMatrix(prisma, { locationIds: locations.map((l) => l.id) });
    const variants = await prisma.variant.findMany({
      where: { id: { in: stock.map((s) => s.variantId) }, isActive: true },
      include: { product: true },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    const flagged = stock
      .map((row) => {
        const variant = variantMap.get(row.variantId);
        const location = locationById.get(row.locationId);
        if (!variant || !location || location.type === 'DAMAGED') return null;
        if (row.onHand > variant.lowStockThreshold) return null;
        return {
          variantId: variant.id,
          locationId: location.id,
          name: `${variant.product.name} — ${variant.label}`,
          sku: variant.sku,
          location: location.name,
          onHand: row.onHand,
          threshold: variant.lowStockThreshold,
          outOfStock: row.onHand <= 0,
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => a.onHand / Math.max(1, a.threshold) - b.onHand / Math.max(1, b.threshold));

    return NextResponse.json({ count: flagged.length, items: flagged.slice(0, 10) });
  } catch (err) {
    return jsonError(err);
  }
}