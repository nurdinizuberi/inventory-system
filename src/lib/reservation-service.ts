import { TX_OPTIONS, prisma } from './db';
import { consumeFifo, fifoBatches } from './fifo';
import type { GuardContext } from './rbac';
import { recordMovement } from './stock';
import type { PaymentMethod } from './types';
import { round2, withRetryNumber } from './utils';

/**
 * Hold stock for a customer.
 *
 * A hold is a reclassification, not a physical move: the units stay on the
 * shelf, so their lot counters and the on-hand ledger sum must both stay put.
 * Two things happen together or the hold is a lie:
 *   1. a net-zero pair of ledger rows moves the units out of the sellable pool
 *      (`-take` available, `+take` reserved — sellable = onHand - reserved);
 *   2. FIFO allocation subtracts the `reserved` balance per lot, so no later
 *      sale or transfer can hand the held units to anyone else.
 * Batch.remainingQty is left untouched; it always counts physical units.
 */
export async function holdReservation(
  opts: { reservationId: string; number: string; variantId: string; locationId: string; quantity: number; customerRef?: string | null },
  ctx: GuardContext,
) {
  return prisma.$transaction(async (tx) => {
    const queue = await fifoBatches(tx, opts.variantId, opts.locationId);
    let remaining = opts.quantity;
    const pieces: { batchId: string; quantity: number; unitCost: number }[] = [];

    for (const batch of queue) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, batch.quantity);
      pieces.push({ batchId: batch.batchId, quantity: take, unitCost: batch.unitCost });
      remaining -= take;
    }
    if (remaining > 0) {
      throw new Error(
        `Only ${opts.quantity - remaining} unit(s) available to reserve — requested ${opts.quantity}.`,
      );
    }

    for (const piece of pieces) {
      // Take off the sellable pool (net-zero with the reserved row below).
      await recordMovement(tx, {
        type: 'reservation',
        tenantId: ctx.tenantId ?? null,
        variantId: opts.variantId,
        locationId: opts.locationId,
        quantity: -piece.quantity,
        batchId: piece.batchId,
        status: 'available',
        unitCost: piece.unitCost,
        totalCost: -(piece.quantity * piece.unitCost),
        reservationId: opts.reservationId,
        referenceType: 'Reservation',
        referenceId: opts.reservationId,
        referenceLabel: opts.number,
        createdById: ctx.id,
        notes: `Held for ${opts.customerRef ?? 'customer'}`,
      });
      // Record the hold (removes the units from sellable = onHand - reserved).
      await recordMovement(tx, {
        type: 'reservation',
        tenantId: ctx.tenantId ?? null,
        variantId: opts.variantId,
        locationId: opts.locationId,
        quantity: piece.quantity,
        batchId: piece.batchId,
        status: 'reserved',
        unitCost: piece.unitCost,
        totalCost: piece.quantity * piece.unitCost,
        reservationId: opts.reservationId,
        referenceType: 'Reservation',
        referenceId: opts.reservationId,
        referenceLabel: opts.number,
        createdById: ctx.id,
        notes: `Held for ${opts.customerRef ?? 'customer'}`,
      });
    }

    return pieces;
  }, TX_OPTIONS);
}

/**
 * Release a hold: cancel the `reserved` balance and put the units back into
 * the sellable pool (net-zero, lots untouched).
 */
export async function endReservation(reservationId: string, ctx: GuardContext) {
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findUnique({ where: { id: reservationId } });
    if (!reservation) throw new Error('Reservation not found');
    if (reservation.status !== 'active') throw new Error(`Reservation is already ${reservation.status}`);

    const held = await tx.stockMovement.findMany({
      where: { reservationId, status: 'reserved', type: 'reservation' },
    });

    for (const movement of held) {
      // Cancel the reserved balance for this piece, then give the units back to
      // the sellable pool. Both rows together are net-zero, so Release never
      // changes the on-hand balance or the lot counters.
      await recordMovement(tx, {
        type: 'reservation_release',
        tenantId: ctx.tenantId ?? null,
        variantId: reservation.variantId,
        locationId: reservation.locationId,
        quantity: -movement.quantity,
        batchId: movement.batchId,
        status: 'reserved',
        unitCost: movement.unitCost,
        totalCost: movement.totalCost ? -Math.abs(movement.totalCost) : null,
        reservationId,
        referenceType: 'Reservation',
        referenceId: reservationId,
        referenceLabel: reservation.number,
        createdById: ctx.id,
        notes: 'Hold released, stock returned to the shelf',
      });
      await recordMovement(tx, {
        type: 'reservation_release',
        tenantId: ctx.tenantId ?? null,
        variantId: reservation.variantId,
        locationId: reservation.locationId,
        quantity: movement.quantity,
        batchId: movement.batchId,
        status: 'available',
        unitCost: movement.unitCost,
        totalCost: Math.abs(movement.totalCost ?? 0),
        reservationId,
        referenceType: 'Reservation',
        referenceId: reservationId,
        referenceLabel: reservation.number,
        createdById: ctx.id,
        notes: 'Hold released, stock returned to the shelf',
      });
    }

    return tx.reservation.update({
      where: { id: reservationId },
      data: { status: 'released' },
    });
  }, TX_OPTIONS);
}

/**
 * "Sell a hold" — fulfil the reservation through the POS.
 *
 * Ringing a held item is one logical sale, done in two balanced steps inside a
 * single transaction:
 *   1. Release the earmark (the two net-zero rows above); the units become
 *      allocatable again even though they are still physically on the shelf.
 *   2. Walk the FIFO queue, decrement the lot counters and write the `sale_out`
 *      ledger rows, then build the Sale + SaleLine with the real selling price
 *      and FIFO cost so revenue, COGS and profit are recorded.
 * The ledger ends with onHand and lot counters both down by the taken units and
 * no residual reserved balance — matching a plain over-the-counter sale.
 */
export async function sellReservation(
  reservationId: string,
  opts: { paymentMethod?: PaymentMethod; amountPaid?: number },
  ctx: GuardContext,
) {
  const existingSales = await prisma.sale.count({ where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
  const makeNumber = (attempt: number) => `SLE-${String(existingSales + 1 + attempt).padStart(5, '0')}`;

  return withRetryNumber(makeNumber, (saleNumber) =>
    prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({ where: { id: reservationId } });
      if (!reservation) throw new Error('Reservation not found');
      if (reservation.status !== 'active') throw new Error(`Reservation is already ${reservation.status}`);

      const [variant, location] = await Promise.all([
        tx.variant.findUnique({ where: { id: reservation.variantId }, include: { product: true } }),
        tx.location.findUnique({ where: { id: reservation.locationId } }),
      ]);
      if (!variant || !location) throw new Error('Reservation references a missing variant or location');

      const held = await tx.stockMovement.findMany({
        where: { reservationId, status: 'reserved', type: 'reservation' },
      });
      if (held.length === 0) throw new Error('No held stock left for this reservation');

      for (const movement of held) {
        await recordMovement(tx, {
          type: 'reservation_release',
          tenantId: ctx.tenantId ?? null,
          variantId: reservation.variantId,
          locationId: reservation.locationId,
          quantity: -movement.quantity,
          batchId: movement.batchId,
          status: 'reserved',
          unitCost: movement.unitCost,
          totalCost: movement.totalCost ? -Math.abs(movement.totalCost) : null,
          reservationId,
          referenceType: 'Reservation',
          referenceId: reservationId,
          referenceLabel: reservation.number,
          createdById: ctx.id,
          notes: `Hold ${reservation.number} sold at the till`,
        });
        await recordMovement(tx, {
          type: 'reservation_release',
          tenantId: ctx.tenantId ?? null,
          variantId: reservation.variantId,
          locationId: reservation.locationId,
          quantity: movement.quantity,
          batchId: movement.batchId,
          status: 'available',
          unitCost: movement.unitCost,
          totalCost: Math.abs(movement.totalCost ?? 0),
          reservationId,
          referenceType: 'Reservation',
          referenceId: reservationId,
          referenceLabel: reservation.number,
          createdById: ctx.id,
          notes: `Hold ${reservation.number} sold at the till`,
        });
      }

      const sale = await tx.sale.create({
        data: {
          tenantId: reservation.tenantId,
          number: saleNumber,
          locationId: reservation.locationId,
          cashierId: ctx.id,
          status: 'completed',
          customerName: reservation.customerRef ?? null,
          paymentMethod: opts.paymentMethod ?? 'cash',
          soldAt: new Date(),
          effectiveDate: new Date(),
        },
      });

      const unitPrice = variant.sellingPrice ?? variant.product.basePrice;
      const fifo = await consumeFifo(tx, {
        type: 'sale_out',
        variantId: reservation.variantId,
        locationId: reservation.locationId,
        tenantId: reservation.tenantId,
        quantity: reservation.quantity,
        status: 'sold',
        referenceType: 'Sale',
        referenceId: sale.id,
        referenceLabel: saleNumber,
        createdById: ctx.id,
        variantLabel: `${variant.product.name} — ${variant.label}`,
        locationName: location.name,
        notes: `Reservation ${reservation.number} sold at the till`,
      });

      const lineTotal = round2(unitPrice * reservation.quantity);
      const totalCost = round2(fifo.totalCost);
      await tx.saleLine.create({
        data: {
          saleId: sale.id,
          variantId: reservation.variantId,
          quantity: reservation.quantity,
          unitCost: round2(fifo.unitCost),
          unitPrice,
          discountAmount: 0,
          actualPrice: unitPrice,
          lineTotal,
          lineCost: totalCost,
          lineProfit: round2(lineTotal - totalCost),
        },
      });

      const total = round2(lineTotal);
      const amountPaid = opts.amountPaid ?? total;
      const saleRecord = await tx.sale.update({
        where: { id: sale.id },
        data: {
          subtotal: total,
          discountAmount: 0,
          total,
          amountPaid: round2(amountPaid),
          changeDue: round2(Math.max(0, amountPaid - total)),
          totalCost,
          profit: round2(total - totalCost),
        },
        include: { lines: { include: { variant: { include: { product: true } } } }, location: true },
      });

      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'fulfilled' },
      });

      return { sale: saleRecord, reservation: updated };
    }, TX_OPTIONS),
  );
}