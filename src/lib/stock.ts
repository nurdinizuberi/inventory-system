import { prisma, type Prisma } from './db';
import type { AdjustmentReason, MovementStatus, MovementType } from './types';

// ---------------------------------------------------------------------------
// The stock ledger. Every quantity change in the system funnels through here.
// "Stock on hand" is never stored: it is SUM(quantity) over the ledger.
// ---------------------------------------------------------------------------

export interface MovementInput {
  type: MovementType;
  variantId: string;
  locationId: string;
  /** Tenant isolation. */
  tenantId?: string | null;
  /** Signed quantity. Positive = in, negative = out. */
  quantity: number;
  batchId?: string | null;
  sourceBatchId?: string | null;
  resultingBatchId?: string | null;
  status?: MovementStatus;
  adjustmentReason?: AdjustmentReason | null;
  unitCost?: number | null;
  totalCost?: number | null;
  approvedById?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  referenceLabel?: string | null;
  reservationId?: string | null;
  notes?: string | null;
  createdById?: string | null;
  /** When the transaction actually occurred (defaults to now). */
  effectiveDate?: Date | null;
  /** Reason for backdating (if applicable). */
  backdateReason?: string | null;
  /** Whether this is a backdated entry. */
  isBackdated?: boolean;
}

export async function recordMovement(
  tx: Prisma.TransactionClient,
  input: MovementInput,
): Promise<void> {
  if (!Number.isFinite(input.quantity) || input.quantity === 0) {
    throw new Error('Movement quantity must be a non-zero number.');
  }
  const effectiveDate = input.effectiveDate ?? new Date();
  const isBackdated = input.isBackdated ?? false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const effective = new Date(effectiveDate);
  effective.setHours(0, 0, 0, 0);

  await tx.stockMovement.create({
    data: {
      tenantId: input.tenantId ?? null,
      type: input.type,
      variantId: input.variantId,
      locationId: input.locationId,
      batchId: input.batchId ?? null,
      sourceBatchId: input.sourceBatchId ?? null,
      resultingBatchId: input.resultingBatchId ?? null,
      quantity: input.quantity,
      status: input.status ?? 'available',
      adjustmentReason: input.adjustmentReason ?? null,
      unitCost: input.unitCost ?? null,
      totalCost: input.totalCost ?? null,
      approvedById: input.approvedById ?? null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      referenceLabel: input.referenceLabel ?? null,
      reservationId: input.reservationId ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      effectiveDate: effectiveDate,
      backdateReason: input.backdateReason ?? null,
      isBackdated: effective < today,
    },
  });
}

/**
 * Derived stock for one (variant, location) pair.
 *
 * When `asOfDate` is provided, only movements with effectiveDate <= asOfDate
 * are included (historical stock). Without it, all movements are included
 * (current stock).
 */
export interface StockRow {
  variantId: string;
  locationId: string;
  /** Total units physically present at the location. */
  onHand: number;
  /** Units held by an active reservation (not sellable). */
  reserved: number;
  /** onHand - reserved: what the POS may sell. */
  sellable: number;
  /** Units that have left through sales. */
  sold: number;
  /** Kept as an alias of onHand for readability at call sites. */
  available: number;
}

function emptyRow(variantId: string, locationId: string): StockRow {
  return { variantId, locationId, onHand: 0, reserved: 0, sellable: 0, sold: 0, available: 0 };
}

function applySum(row: StockRow, status: string, qty: number): void {
  row.onHand += qty;
  if (status === 'reserved') row.reserved += qty;
  if (status === 'sold') row.sold -= qty;
}

function finalise(row: StockRow): StockRow {
  row.sellable = row.onHand - row.reserved;
  row.available = row.onHand;
  return row;
}

/** Build the where clause for date-aware stock queries. */
function dateFilter(asOfDate?: Date | null): Prisma.StockMovementWhereInput | undefined {
  if (!asOfDate) return undefined;
  return { effectiveDate: { lte: asOfDate } };
}

/** Derived stock for a single (variant, location) pair. */
export async function getStock(
  tx: Prisma.TransactionClient | typeof prisma,
  variantId: string,
  locationId: string,
  asOfDate?: Date,
): Promise<StockRow> {
  const where: Prisma.StockMovementWhereInput = {
    variantId,
    locationId,
    ...dateFilter(asOfDate),
  };
  const rows = await tx.stockMovement.groupBy({
    by: ['status'],
    where,
    _sum: { quantity: true },
  });
  const row = emptyRow(variantId, locationId);
  for (const r of rows) applySum(row, r.status, r._sum.quantity ?? 0);
  return finalise(row);
}

/** Units the POS may actually sell for a (variant, location) pair. */
export async function sellableQuantity(
  tx: Prisma.TransactionClient | typeof prisma,
  variantId: string,
  locationId: string,
): Promise<number> {
  const row = await getStock(tx, variantId, locationId);
  return row.sellable;
}

/** Derived stock for every variant at one location. */
export async function getStockForLocation(
  tx: Prisma.TransactionClient | typeof prisma,
  locationId: string,
  variantIds?: string[],
  asOfDate?: Date,
): Promise<Map<string, StockRow>> {
  const where: Prisma.StockMovementWhereInput = {
    locationId,
    ...(variantIds ? { variantId: { in: variantIds } } : {}),
    ...dateFilter(asOfDate),
  };
  const rows = await tx.stockMovement.groupBy({
    by: ['variantId', 'status'],
    where,
    _sum: { quantity: true },
  });
  const map = new Map<string, StockRow>();
  for (const r of rows) {
    const existing = map.get(r.variantId) ?? emptyRow(r.variantId, locationId);
    applySum(existing, r.status, r._sum.quantity ?? 0);
    map.set(r.variantId, existing);
  }
  for (const row of map.values()) finalise(row);
  return map;
}

/** Derived stock for one variant across every location. */
export async function getStockForVariant(
  tx: Prisma.TransactionClient | typeof prisma,
  variantId: string,
  locationIds?: string[],
  asOfDate?: Date,
): Promise<StockRow[]> {
  const where: Prisma.StockMovementWhereInput = {
    variantId,
    ...(locationIds ? { locationId: { in: locationIds } } : {}),
    ...dateFilter(asOfDate),
  };
  const rows = await tx.stockMovement.groupBy({
    by: ['locationId', 'status'],
    where,
    _sum: { quantity: true },
  });
  const map = new Map<string, StockRow>();
  for (const r of rows) {
    const existing = map.get(r.locationId) ?? emptyRow(variantId, r.locationId);
    applySum(existing, r.status, r._sum.quantity ?? 0);
    map.set(r.locationId, existing);
  }
  return [...map.values()].map(finalise);
}

/** Full derived stock matrix, optionally filtered by location/variant/date. */
export async function getStockMatrix(
  tx: Prisma.TransactionClient | typeof prisma,
  where: { locationIds?: string[]; variantIds?: string[]; asOfDate?: Date } = {},
): Promise<StockRow[]> {
  const dbWhere: Prisma.StockMovementWhereInput = {
    ...(where.locationIds ? { locationId: { in: where.locationIds } } : {}),
    ...(where.variantIds ? { variantId: { in: where.variantIds } } : {}),
    ...dateFilter(where.asOfDate),
  };
  const rows = await tx.stockMovement.groupBy({
    by: ['variantId', 'locationId', 'status'],
    where: dbWhere,
    _sum: { quantity: true },
  });
  const map = new Map<string, StockRow>();
  for (const r of rows) {
    const key = `${r.variantId}::${r.locationId}`;
    const existing = map.get(key) ?? emptyRow(r.variantId, r.locationId);
    applySum(existing, r.status, r._sum.quantity ?? 0);
    map.set(key, existing);
  }
  return [...map.values()].map(finalise);
}

/** Total units of a variant on hand across the given locations. */
export async function totalOnHand(
  tx: Prisma.TransactionClient | typeof prisma,
  variantId: string,
  locationIds?: string[],
  asOfDate?: Date,
): Promise<number> {
  const where: Prisma.StockMovementWhereInput = {
    variantId,
    ...(locationIds ? { locationId: { in: locationIds } } : {}),
    ...dateFilter(asOfDate),
  };
  const res = await tx.stockMovement.aggregate({
    where,
    _sum: { quantity: true },
  });
  return res._sum.quantity ?? 0;
}
