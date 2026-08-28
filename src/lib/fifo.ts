import { prisma, type Prisma } from './db';
import { recordMovement } from './stock';
import type { MovementType } from './types';

// ---------------------------------------------------------------------------
// FIFO (first-in-first-out) costing.
//
// Batches are the costing unit. They carry the unit cost and the date they
// entered the network, so "consume the oldest batch first" is a plain sort.
// Batch.remainingQty is the batch-level counter that makes FIFO unambiguous;
// the ledger remains the source of truth for location stock.
//
// Reservations: a hold is a reclassification, not a physical move. The meter
// lots are NOT decremented by a hold — instead the recorded `reserved` ledger
// rows are subtracted here, so held units can never be handed to a sale or
// transfer while ActiveReservedQty basis in remainingQty stays the physical
// truth.
// ---------------------------------------------------------------------------

export interface BatchAllocation {
  batchId: string;
  batchCode: string;
  unitCost: number;
  quantity: number;
  receivedAt: Date;
}

export interface FifoResult {
  allocations: BatchAllocation[];
  totalQuantity: number;
  totalCost: number;
  /** Weighted-average unit cost across the consumed batches. */
  unitCost: number;
}

export class InsufficientStockError extends Error {
  variantLabel: string;
  requested: number;
  available: number;
  locationName: string;
  constructor(variantLabel: string, requested: number, available: number, locationName: string) {
    super(
      `Insufficient stock for "${variantLabel}" at ${locationName}: requested ${requested}, available ${available}.`,
    );
    this.variantLabel = variantLabel;
    this.requested = requested;
    this.available = available;
    this.locationName = locationName;
  }
}

/**
 * Net units a customer currently holds on each batch.
 *
 * A hold writes a POSITIVE `reserved` row per lot; release/fulfil write the
 * matching NEGATIVE `reserved` row, so the sum over `reserved` rows is the
 * active hold per lot. Capped at zero for safety.
 */
export async function reservedQtyByBatch(
  tx: Prisma.TransactionClient | typeof prisma,
  batchIds: string[],
): Promise<Map<string, number>> {
  if (batchIds.length === 0) return new Map<string, number>();
  const rows = await tx.stockMovement.groupBy({
    by: ['batchId'],
    where: { batchId: { in: batchIds }, status: 'reserved' },
    _sum: { quantity: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.batchId) continue;
    map.set(r.batchId, Math.max(0, r._sum.quantity ?? 0));
  }
  return map;
}

/** Batches with stock still allocatable at a location, oldest first (FIFO). */
export async function fifoBatches(
  tx: Prisma.TransactionClient | typeof prisma,
  variantId: string,
  locationId: string,
): Promise<BatchAllocation[]> {
  const batches = await tx.batch.findMany({
    where: { variantId, locationId, remainingQty: { gt: 0 } },
    orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }, { code: 'asc' }],
  });
  if (batches.length === 0) return [];
  const held = await reservedQtyByBatch(
    tx,
    batches.map((b) => b.id),
  );
  return batches
    .map((b) => ({
      batchId: b.id,
      batchCode: b.code,
      unitCost: b.unitCost,
      quantity: Math.max(0, b.remainingQty - (held.get(b.id) ?? 0)),
      receivedAt: b.receivedAt,
    }))
    .filter((a) => a.quantity > 0);
}

/** How many units are allocatable (batch counters minus active holds). */
export async function fifoAvailable(
  tx: Prisma.TransactionClient | typeof prisma,
  variantId: string,
  locationId: string,
): Promise<number> {
  const queue = await fifoBatches(tx, variantId, locationId);
  return queue.reduce((sum, b) => sum + b.quantity, 0);
}

/**
 * Walk the FIFO queue and split `quantity` across batches. Throws
 * InsufficientStockError when the queue cannot cover the request — callers use
 * that to block the sale rather than selling into negative stock.
 */
export async function allocateFifo(
  tx: Prisma.TransactionClient | typeof prisma,
  opts: { variantId: string; locationId: string; quantity: number },
): Promise<BatchAllocation[]> {
  const queue = await fifoBatches(tx, opts.variantId, opts.locationId);
  let remaining = opts.quantity;
  const picked: BatchAllocation[] = [];
  for (const batch of queue) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, batch.quantity);
    picked.push({ ...batch, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) {
    const available = opts.quantity - remaining;
    throw new InsufficientStockError(
      opts.variantId,
      opts.quantity,
      available,
      opts.locationId,
    );
  }
  return picked;
}

export function summariseAllocations(allocations: BatchAllocation[]): FifoResult {
  const totalQuantity = allocations.reduce((s, a) => s + a.quantity, 0);
  const totalCost = allocations.reduce((s, a) => s + a.quantity * a.unitCost, 0);
  return {
    allocations,
    totalQuantity,
    totalCost,
    unitCost: totalQuantity ? totalCost / totalQuantity : 0,
  };
}

/**
 * Consume stock FIFO and write the ledger rows. Used by sales and transfers.
 * Returns the cost summary so the caller can compute profit/loss.
 */
export async function consumeFifo(
  tx: Prisma.TransactionClient,
  opts: {
    type: MovementType;
    variantId: string;
    locationId: string;
    quantity: number;
    tenantId?: string | null;
    status?: 'available' | 'reserved' | 'sold';
    adjustmentReason?: 'damaged' | 'theft' | 'expired' | 'misplaced' | 'count_correction';
    approvedById?: string | null;
    referenceType?: string;
    referenceId?: string;
    referenceLabel?: string;
    notes?: string;
    createdById?: string | null;
    variantLabel?: string;
    locationName?: string;
    effectiveDate?: Date | null;
    backdateReason?: string | null;
    isBackdated?: boolean;
    /** Optional hook: extra data per ledger row (e.g. resulting batch id). */
    onAllocation?: (allocation: BatchAllocation, index: number) => {
      resultingBatchId?: string;
      notes?: string;
    };
  },
): Promise<FifoResult> {
  const queue = await fifoBatches(tx, opts.variantId, opts.locationId);
  let remaining = opts.quantity;
  const allocations: BatchAllocation[] = [];

  for (const batch of queue) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, batch.quantity);
    allocations.push({ ...batch, quantity: take });
    remaining -= take;
  }

  if (remaining > 0) {
    const available = opts.quantity - remaining;
    const [variant, location] = await Promise.all([
      opts.variantLabel
        ? Promise.resolve(null)
        : tx.variant.findUnique({
            where: { id: opts.variantId },
            include: { product: true },
          }),
      opts.locationName ? Promise.resolve(null) : tx.location.findUnique({ where: { id: opts.locationId } }),
    ]);
    const label =
      opts.variantLabel ??
      (variant ? `${variant.product.name} (${variant.label})` : opts.variantId);
    const locName = opts.locationName ?? location?.name ?? opts.locationId;
    throw new InsufficientStockError(label, opts.quantity, available, locName);
  }

  let totalCost = 0;
  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    totalCost += alloc.quantity * alloc.unitCost;
    await tx.batch.update({
      where: { id: alloc.batchId },
      data: { remainingQty: { decrement: alloc.quantity } },
    });
    const extra = opts.onAllocation?.(alloc, i) ?? {};
    await recordMovement(tx, {
      type: opts.type,
      variantId: opts.variantId,
      locationId: opts.locationId,
      tenantId: opts.tenantId ?? null,
      quantity: -alloc.quantity,
      batchId: alloc.batchId,
      resultingBatchId: extra.resultingBatchId ?? null,
      status: opts.status ?? 'sold',
      adjustmentReason: opts.adjustmentReason ?? null,
      approvedById: opts.approvedById ?? null,
      unitCost: alloc.unitCost,
      totalCost: alloc.quantity * alloc.unitCost,
      referenceType: opts.referenceType ?? null,
      referenceId: opts.referenceId ?? null,
      referenceLabel: opts.referenceLabel ?? null,
      notes: extra.notes ?? opts.notes ?? `FIFO batch ${alloc.batchCode}`,
      createdById: opts.createdById ?? null,
      effectiveDate: opts.effectiveDate ?? null,
      backdateReason: opts.backdateReason ?? null,
      isBackdated: opts.isBackdated ?? false,
    });
  }

  return {
    allocations,
    totalQuantity: opts.quantity,
    totalCost,
    unitCost: opts.quantity ? totalCost / opts.quantity : 0,
  };
}

/**
 * Consume stock FIFO at the source and create the matching batch at the
 * destination. The destination batch inherits the source cost AND the source
 * received date, so FIFO ordering survives the move.
 */
export async function createTransferBatches(
  tx: Prisma.TransactionClient | typeof prisma,
  opts: {
    variantId: string;
    fromLocationId: string;
    toLocationId: string;
    quantity: number;
    codePrefix: string;
    tenantId?: string | null;
  },
): Promise<{ id: string; quantity: number; unitCost: number }[]> {
  const queue = await fifoBatches(tx, opts.variantId, opts.fromLocationId);
  let remaining = opts.quantity;
  const created: { id: string; quantity: number; unitCost: number }[] = [];
  let i = 0;
  for (const src of queue) {
    if (remaining <= 0) break;
    i += 1;
    const take = Math.min(remaining, src.quantity);
    remaining -= take;
    const batch = await tx.batch.create({
      data: {
        tenantId: opts.tenantId ?? null,
        code: `${opts.codePrefix}/${src.batchCode}`,
        variantId: opts.variantId,
        locationId: opts.toLocationId,
        unitCost: src.unitCost,
        quantity: take,
        remainingQty: take,
        receivedAt: src.receivedAt,
        sourceBatchId: src.batchId,
      },
    });
    created.push({ id: batch.id, quantity: take, unitCost: src.unitCost });
  }
  if (remaining > 0) {
    throw new Error(
      `Cannot move ${opts.quantity} units: only ${opts.quantity - remaining} available at the source location.`,
    );
  }
  return created;
}

/** Cost of the stock currently on hand at a location, FIFO-weighted. */
export async function inventoryValue(
  tx: Prisma.TransactionClient | typeof prisma,
  locationId: string,
): Promise<{ units: number; value: number }> {
  const batches = await tx.batch.findMany({
    where: { locationId, remainingQty: { gt: 0 } },
    select: { remainingQty: true, unitCost: true },
  });
  return batches.reduce(
    (acc, b) => ({ units: acc.units + b.remainingQty, value: acc.value + b.remainingQty * b.unitCost }),
    { units: 0, value: 0 },
  );
}
