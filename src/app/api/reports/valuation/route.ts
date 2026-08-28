import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { round2 } from '@/lib/utils';

/**
 * Inventory valuation. Two methods side by side:
 *  * FIFO/lot value  — SUM(lot.remainingQty x lot.unitCost)
 *  * latest cost     — on-hand x most recent purchase_in unit cost
 *  * average cost    — on-hand x weighted average of all purchase_in costs
 * All three are computed from the ledger and the lots it created.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'report.valuation' });
    const url = new URL(request.url);
    const locationId = url.searchParams.get('locationId');

    const scope = scopedLocationIds(ctx);
    const locations = await prisma.location.findMany({
      where: {
        isActive: true,
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(locationId ? { id: locationId } : {}),
        ...(scope ? { id: { in: scope } } : {}),
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });

    const lots = await prisma.batch.findMany({
      where: { locationId: { in: locations.map((l) => l.id) }, remainingQty: { gt: 0 } },
      include: { variant: { include: { product: true } } },
      orderBy: [{ receivedAt: 'asc' }],
    });
    const lotsByLocation = new Map<string, typeof lots>();
    for (const lot of lots) {
      const bucket = lotsByLocation.get(lot.locationId) ?? [];
      bucket.push(lot);
      lotsByLocation.set(lot.locationId, bucket);
    }

    const stockVariantIds = [...new Set(lots.map((l) => l.variantId))];
    const purchaseMovements = await prisma.stockMovement.findMany({
      where: {
        type: 'purchase_in',
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(stockVariantIds.length ? { variantId: { in: stockVariantIds } } : { variantId: '__none__' }),
      },
      select: { variantId: true, unitCost: true, quantity: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const latestCost = new Map<string, number>();
    const costBuckets = new Map<string, { units: number; value: number }>();
    for (const m of purchaseMovements) {
      if (m.unitCost === null) continue;
      latestCost.set(m.variantId, m.unitCost);
      const bucket = costBuckets.get(m.variantId) ?? { units: 0, value: 0 };
      bucket.units += m.quantity;
      bucket.value += m.unitCost * m.quantity;
      costBuckets.set(m.variantId, bucket);
    }

    const byLocation: {
      locationId: string;
      location: string;
      type: string;
      units: number;
      lots: number;
      fifoValue: number;
      latestCostValue: number;
      averageCostValue: number;
    }[] = [];

    const variantRows: {
      location: string;
      variant: string;
      sku: string;
      units: number;
      lots: number;
      unitCost: number;
      value: number;
    }[] = [];

    for (const location of locations) {
      const locationLots = lotsByLocation.get(location.id) ?? [];

      const fifoValue = locationLots.reduce((s, b) => s + b.remainingQty * b.unitCost, 0);
      let latestCostValue = 0;
      let averageCostValue = 0;
      const perVariant = new Map<string, { units: number; value: number; label: string; sku: string; cost: number; lots: number }>();

      for (const lot of locationLots) {
        const label = `${lot.variant.product.name} — ${lot.variant.label}`;
        const last = latestCost.get(lot.variantId) ?? lot.unitCost;
        const bucket = costBuckets.get(lot.variantId);
        const avg = bucket && bucket.units ? bucket.value / bucket.units : lot.unitCost;

        latestCostValue += lot.remainingQty * last;
        averageCostValue += lot.remainingQty * avg;

        const entry = perVariant.get(lot.variantId) ?? {
          units: 0,
          value: 0,
          label,
          sku: lot.variant.sku,
          cost: lot.unitCost,
          lots: 0,
        };
        entry.units += lot.remainingQty;
        entry.value += lot.remainingQty * lot.unitCost;
        entry.lots += 1;
        perVariant.set(lot.variantId, entry);
      }

      byLocation.push({
        locationId: location.id,
        location: location.name,
        type: location.type,
        units: locationLots.reduce((s, b) => s + b.remainingQty, 0),
        lots: locationLots.length,
        fifoValue: round2(fifoValue),
        latestCostValue: round2(latestCostValue),
        averageCostValue: round2(averageCostValue),
      });

      for (const entry of perVariant.values()) {
        variantRows.push({
          location: location.name,
          variant: entry.label,
          sku: entry.sku,
          units: entry.units,
          lots: entry.lots,
          unitCost: round2(entry.units ? entry.value / entry.units : 0),
          value: round2(entry.value),
        });
      }
    }

    return NextResponse.json({
      byLocation,
      byVariant: variantRows.sort((a, b) => b.value - a.value).slice(0, 60),
      totals: {
        units: byLocation.reduce((s, l) => s + l.units, 0),
        lots: byLocation.reduce((s, l) => s + l.lots, 0),
        fifoValue: round2(byLocation.reduce((s, l) => s + l.fifoValue, 0)),
        latestCostValue: round2(byLocation.reduce((s, l) => s + l.latestCostValue, 0)),
        averageCostValue: round2(byLocation.reduce((s, l) => s + l.averageCostValue, 0)),
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
