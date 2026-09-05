import { randomUUID } from 'crypto';
import type { Prisma } from './db';
import { consumeFifo } from './fifo';
import { recordMovement } from './stock';
import { round2 } from './utils';

// ---------------------------------------------------------------------------
// Stock-changing edits made from the product editor.
//
// Editing a cost revalues the affected batches IN PLACE (FIFO ordering and the
// on-hand quantity are preserved, only the cost basis changes) and writes a
// zero-quantity `revaluation` ledger row so the change is auditable. Editing a
// quantity adds a brand-new batch (increase) or consumes FIFO (decrease) and
// writes `product_edit` ledger rows. No stock is ever deleted: the historical
// cost/quantity detail lives in the ledger.
// ---------------------------------------------------------------------------

export interface RevalueOptions {
  variantId: string;
  /** The new unit cost (> 0). */
  newCost: number;
  reason: string;
  referenceLabel: string;
  referenceType?: string | null;
  referenceId?: string | null;
  tenantId?: string | null;
  createdById?: string | null;
}

/**
 * Revalue every in-stock batch of a variant to `newCost`. Physical quantities
 * and FIFO freshness are untouched — only the cost basis changes. Ledger rows
 * carry quantity 0 but record the old cost per lightweight footnote.
 */
export async function revalueVariantBatches(
  tx: Prisma.TransactionClient,
  opts: RevalueOptions,
): Promise<void> {
  const batches = await tx.batch.findMany({
    where: { variantId: opts.variantId, remainingQty: { gt: 0 } },
    orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
  });
  if (batches.length === 0) return;

  const totalRemaining = batches.reduce((s, b) => s + b.remainingQty, 0);
  const firstOldCost = batches[0].unitCost;
  const sameCost = batches.every((b) => b.unitCost === firstOldCost);

  for (const batch of batches) {
    await tx.batch.update({
      where: { id: batch.id },
      data: { unitCost: opts.newCost },
    });
  }

  await recordMovement(tx, {
    type: 'revaluation',
    variantId: opts.variantId,
    locationId: batches[0].locationId,
    tenantId: opts.tenantId ?? null,
    quantity: 0,
    unitCost: opts.newCost,
    totalCost: round2(opts.newCost * totalRemaining),
    referenceType: opts.referenceType ?? 'variant',
    referenceId: opts.referenceId ?? null,
    referenceLabel: opts.referenceLabel,
    notes: `Cost revaluation: ${sameCost ? firstOldCost : 'mixed'} → ${opts.newCost} across ${batches.length} batch(es), ${totalRemaining} units — ${opts.reason}`,
    createdById: opts.createdById ?? null,
  });
}

export interface AdjustStockOptions {
  variantId: string;
  locationId: string;
  /** Signed quantity change. Positive = add, negative = FIFO deduct. */
  delta: number;
  /** Effective unit cost used when stock is being ADDED. */
  unitCost: number;
  reason: string;
  referenceLabel: string;
  referenceType?: string | null;
  referenceId?: string | null;
  tenantId?: string | null;
  createdById?: string | null;
}

export interface AdjustStockResult {
  createdBatchId?: string;
  fifoCost?: number;
}

/**
 * Apply a signed quantity edit. Increases open a new batch at the variant's
 * current effective cost; decreases are consumed FIFO so the units that leave
 * book their real historical cost.
 */
export async function adjustVariantStock(
  tx: Prisma.TransactionClient,
  opts: AdjustStockOptions,
): Promise<AdjustStockResult> {
  if (!Number.isInteger(opts.delta) || opts.delta === 0) {
    throw new Error('Quantity change must be a non-zero integer.');
  }

  if (opts.delta > 0) {
    const batch = await tx.batch.create({
      data: {
        tenantId: opts.tenantId ?? null,
        code: `PE-${randomUUID()}`,
        variantId: opts.variantId,
        locationId: opts.locationId,
        unitCost: opts.unitCost,
        quantity: opts.delta,
        remainingQty: opts.delta,
        receivedAt: new Date(),
      },
    });
    await recordMovement(tx, {
      type: 'product_edit',
      variantId: opts.variantId,
      locationId: opts.locationId,
      tenantId: opts.tenantId ?? null,
      quantity: opts.delta,
      batchId: batch.id,
      status: 'available',
      unitCost: opts.unitCost,
      totalCost: round2(opts.unitCost * opts.delta),
      referenceType: opts.referenceType ?? 'variant',
      referenceId: opts.referenceId ?? null,
      referenceLabel: opts.referenceLabel,
      notes: `Product edit: added ${opts.delta} unit(s) at ${opts.unitCost} — ${opts.reason}`,
      createdById: opts.createdById ?? null,
    });
    return { createdBatchId: batch.id };
  }

  const result = await consumeFifo(tx, {
    type: 'product_edit',
    variantId: opts.variantId,
    locationId: opts.locationId,
    tenantId: opts.tenantId ?? null,
    quantity: Math.abs(opts.delta),
    status: 'available',
    referenceType: opts.referenceType ?? 'variant',
    referenceId: opts.referenceId ?? undefined,
    referenceLabel: opts.referenceLabel,
    notes: `Product edit: removed ${Math.abs(opts.delta)} unit(s) — ${opts.reason}`,
    createdById: opts.createdById ?? null,
  });
  return { fifoCost: result.totalCost };
}