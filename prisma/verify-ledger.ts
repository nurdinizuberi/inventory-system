/* eslint-disable no-console */
/**
 * Ledger integrity checks. Run with `npm run verify:ledger`.
 *
 * Invariants enforced:
 *  1. Derived on-hand per (variant, location) == SUM(quantity) over the ledger.
 *     Outbound rows are negative, so a plain sum is the balance.
 *  2. Derived on-hand == the batch-level remaining counters, EXCEPT for goods
 *     currently in transit (their destination batch is pre-created when the
 *     transfer ships, but the transfer_in row is only written on receipt).
 *  3. No negative on-hand anywhere (a sale can never oversell).
 *  4. Reserved stock is a subset of on-hand.
 */
import { PrismaClient } from '@prisma/client';
import { getStockMatrix } from '../src/lib/stock';

const prisma = new PrismaClient();

async function main() {
  const movements = await prisma.stockMovement.count();
  const derived = await getStockMatrix(prisma);

  // 1. independent re-computation of the ledger sum
  const raw = await prisma.stockMovement.groupBy({
    by: ['variantId', 'locationId'],
    _sum: { quantity: true },
  });
  const rawMap = new Map(raw.map((r) => [`${r.variantId}|${r.locationId}`, r._sum.quantity ?? 0]));

  /**
   * Damaged write-offs are recorded as a POSITIVE row at the write-off location
   * (the goods are accounted for, just quarantined) but they are discarded, so
   * no lot is opened for them. Sold stock needs no correction: sale_out rows are
   * negative, so they are already excluded from the on-hand sum. Reservations
   * are recorded as a net-zero reclassification (-take available, +take
   * reserved) so they change neither on-hand nor the lot counters.
   * Hence
   *     batchesRemaining == onHand + inTransit - discarded
   */
  const left = await prisma.stockMovement.groupBy({
    by: ['variantId', 'locationId', 'type'],
    where: { type: 'return_damaged' },
    _sum: { quantity: true },
  });
  const leftMap = new Map<string, number>();
  for (const r of left) {
    const key = `${r.variantId}|${r.locationId}`;
    leftMap.set(key, (leftMap.get(key) ?? 0) + Math.abs(r._sum.quantity ?? 0));
  }

  const batches = await prisma.batch.groupBy({
    by: ['variantId', 'locationId'],
    _sum: { remainingQty: true },
  });
  const batchMap = new Map(batches.map((b) => [`${b.variantId}|${b.locationId}`, b._sum.remainingQty ?? 0]));

  // units currently on the road, per (variant, destination)
  const inTransit = new Map<string, number>();
  const pendingTransfers = await prisma.stockTransfer.findMany({
    where: { status: 'in_transit' },
    include: { lines: true },
  });
  for (const t of pendingTransfers) {
    for (const line of t.lines) {
      const key = `${line.variantId}|${t.toLocationId}`;
      inTransit.set(key, (inTransit.get(key) ?? 0) + line.quantity);
    }
  }

  let mismatches = 0;
  let negatives = 0;
  let overReserved = 0;
  const keys = new Set([...derived.map((d) => `${d.variantId}|${d.locationId}`), ...batchMap.keys()]);

  for (const key of keys) {
    const row = derived.find((d) => `${d.variantId}|${d.locationId}` === key);
    const [variantId, locationId] = key.split('|');
    const derivedOnHand = row?.onHand ?? 0;
    const ledgerSum = rawMap.get(key) ?? 0;
    const batchTotal = batchMap.get(key) ?? 0;
    const inFlight = inTransit.get(key) ?? 0;

    const label = async () => {
      const [v, l] = await Promise.all([
        prisma.variant.findUnique({ where: { id: variantId }, include: { product: true } }),
        prisma.location.findUnique({ where: { id: locationId } }),
      ]);
      return `${v?.product.name} (${v?.label}) @ ${l?.name}`;
    };

    if (derivedOnHand !== ledgerSum) {
      mismatches += 1;
      console.log(`  MISMATCH(getStock) ${await label()}: getStock=${derivedOnHand} ledgerSum=${ledgerSum}`);
    }
    const leftQty = leftMap.get(key) ?? 0;
    if (derivedOnHand + inFlight - leftQty !== batchTotal) {
      mismatches += 1;
      console.log(
        `  MISMATCH(batches) ${await label()}: onHand=${derivedOnHand} inTransit=${inFlight} discarded=${leftQty} batches=${batchTotal}`,
      );
    }
    if (derivedOnHand < 0) {
      negatives += 1;
      console.log(`  NEGATIVE STOCK ${await label()}: onHand=${derivedOnHand}`);
    }
    if ((row?.reserved ?? 0) > derivedOnHand) {
      overReserved += 1;
      console.log(`  OVER-RESERVED ${await label()}: reserved=${row?.reserved} onHand=${derivedOnHand}`);
    }
  }

  const negBatchCounters = await prisma.batch.count({ where: { remainingQty: { lt: 0 } } });

  const sales = await prisma.sale.findMany({ where: { status: 'completed' }, include: { lines: true } });
  const revenue = sales.reduce((s, x) => s + x.total, 0);
  const cogs = sales.reduce((s, x) => s + x.totalCost, 0);

  // ledger-side cost of goods: sum of totalCost on sale_out rows must match
  const saleOutCost = await prisma.stockMovement.aggregate({
    where: { type: 'sale_out' },
    _sum: { totalCost: true },
  });

  const allBatches = await prisma.batch.findMany({ where: { remainingQty: { gt: 0 } } });
  const inventoryValue = allBatches.reduce((s, b) => s + b.remainingQty * b.unitCost, 0);

  const cogsDiff = Math.abs((saleOutCost._sum.totalCost ?? 0) - cogs);

  // FIFO must never be able to allocate more than the sellable pool. For each
  // pair, allocatable lot stock = sum over lots of (remaining - active holds) -
  // in-transit lots (destination lots are pre-created on ship but only become
  // real on receipt).
  let fifoLeak = 0;
  for (const key of keys) {
    const row = derived.find((d) => `${d.variantId}|${d.locationId}` === key);
    if (!row) continue;
    const [variantId, locationId] = key.split('|');
    const lots = await prisma.batch.findMany({
      where: { variantId, locationId, remainingQty: { gt: 0 } },
      select: { id: true, remainingQty: true },
    });
    if (!lots.length) continue;
    const heldRows = await prisma.stockMovement.groupBy({
      by: ['batchId'],
      where: { batchId: { in: lots.map((b) => b.id) }, status: 'reserved' },
      _sum: { quantity: true },
    });
    const heldMap = new Map<string, number>();
    for (const r of heldRows) {
      if (!r.batchId) continue;
      heldMap.set(r.batchId, Math.max(0, r._sum.quantity ?? 0));
    }
    const freeQty =
      lots.reduce((sum, b) => sum + Math.max(0, b.remainingQty - (heldMap.get(b.id) ?? 0)), 0) -
      (inTransit.get(key) ?? 0);
    if (freeQty > row.sellable) {
      fifoLeak += 1;
      const [v, l] = await Promise.all([
        prisma.variant.findUnique({ where: { id: variantId }, include: { product: true } }),
        prisma.location.findUnique({ where: { id: locationId } }),
      ]);
      console.log(`  FIFO LEAK ${v?.product.name} (${v?.label}) @ ${l?.name}: freeLots=${freeQty} sellable=${row.sellable}`);
    }
  }

  console.log(`movements=${movements} pairsChecked=${keys.size}`);
  console.log(`mismatches=${mismatches} negativeStock=${negatives} overReserved=${overReserved} negativeBatchCounters=${negBatchCounters} fifoLeaks=${fifoLeak}`);
  console.log(`completedSales=${sales.length} revenue=${revenue.toFixed(0)} cogs=${cogs.toFixed(0)} profit=${(revenue - cogs).toFixed(0)}`);
  console.log(`saleOutLedgerCost=${(saleOutCost._sum.totalCost ?? 0).toFixed(0)} cogsDelta=${cogsDiff.toFixed(2)}`);
  console.log(`inventoryValue=${inventoryValue.toFixed(0)}`);

  const ok = mismatches === 0 && negatives === 0 && overReserved === 0 && negBatchCounters === 0 && cogsDiff < 1 && fifoLeak === 0;
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
