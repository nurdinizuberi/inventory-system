import { audit } from './audit';
import { TX_OPTIONS, prisma } from './db';
import { consumeFifo, createTransferBatches, InsufficientStockError } from './fifo';
import type { GuardContext } from './rbac';
import { recordMovement } from './stock';

/**
 * Ship a transfer.
 *
 * Writes `transfer_out` at the source (FIFO, so cost follows the oldest lots)
 * and pre-creates the destination batches with the SAME unit cost and the SAME
 * received date, which is what keeps FIFO ordering intact across the move.
 * No `transfer_in` yet — the goods are on the road, not on the shelf.
 */
export async function shipTransfer(transferId: string, ctx: GuardContext) {
  const { transfer, summary } = await prisma.$transaction(
    async (tx) => {
      const record = await tx.stockTransfer.findUnique({
        where: { id: transferId },
        include: {
          lines: { include: { variant: { include: { product: true } } } },
          fromLocation: true,
          toLocation: true,
        },
      });
      if (!record) throw new Error('Transfer not found');
      if (record.status !== 'pending') {
        throw new Error(`Transfer is ${record.status}; only a pending transfer can ship`);
      }
      if (record.fromLocationId === record.toLocationId) {
        throw new Error('Source and destination must be different locations');
      }

      for (const [index, line] of record.lines.entries()) {
        const codePrefix = `B-${record.number}-${String(index + 1).padStart(2, '0')}`;
        const pieces = await createTransferBatches(tx, {
          variantId: line.variantId,
          fromLocationId: record.fromLocationId,
          toLocationId: record.toLocationId,
          quantity: line.quantity,
          codePrefix,
        });

        for (const piece of pieces) {
          await consumeFifo(tx, {
            type: 'transfer_out',
            variantId: line.variantId,
            locationId: record.fromLocationId,
            quantity: piece.quantity,
            status: 'available',
            tenantId: record.tenantId ?? null,
            referenceType: 'StockTransfer',
            referenceId: record.id,
            referenceLabel: record.number,
            createdById: ctx.id,
            variantLabel: `${line.variant.product.name} (${line.variant.label})`,
            locationName: record.fromLocation.name,
            notes: `Shipped to ${record.toLocation.name}`,
            effectiveDate: record.effectiveDate,
            backdateReason: record.backdateReason,
            isBackdated: record.isBackdated,
            onAllocation: () => ({ resultingBatchId: piece.id }),
          });
        }
      }

      const updated = await tx.stockTransfer.update({
        where: { id: transferId },
        data: { status: 'in_transit', shippedAt: new Date(), approvedById: ctx.id },
        include: { lines: true, fromLocation: true, toLocation: true },
      });

      return {
        transfer: updated,
        summary: { from: record.fromLocation.name, to: record.toLocation.name },
      };
    },
    TX_OPTIONS,
  );

  await audit({
    ctx,
    action: 'ship',
    entityType: 'StockTransfer',
    entityId: transferId,
    entityLabel: transfer.number,
    before: { status: 'pending' },
    after: { status: 'in_transit' },
    metadata: summary,
  });

  return transfer;
}

/**
 * Receive a transfer. Writes the `transfer_in` rows at the destination against
 * the batches opened at ship time — so both sides of the movement are explicit,
 * auditable ledger entries and never a net-zero shortcut.
 */
export async function completeTransfer(transferId: string, ctx: GuardContext) {
  const { transfer, summary } = await prisma.$transaction(
    async (tx) => {
      const record = await tx.stockTransfer.findUnique({
        where: { id: transferId },
        include: { lines: true, fromLocation: true, toLocation: true },
      });
      if (!record) throw new Error('Transfer not found');
      if (record.status === 'completed') return { transfer: record, summary: null };
      if (record.status !== 'in_transit') {
        throw new Error(`Transfer is ${record.status}; it must be shipped before it can be received`);
      }

      const outMovements = await tx.stockMovement.findMany({
        where: { referenceType: 'StockTransfer', referenceId: transferId, type: 'transfer_out' },
        orderBy: { createdAt: 'asc' },
      });

      for (const movement of outMovements) {
        if (!movement.resultingBatchId) {
          throw new Error(`Transfer ${record.number} has an outbound row with no destination batch`);
        }
        await recordMovement(tx, {
          type: 'transfer_in',
          variantId: movement.variantId,
          locationId: record.toLocationId,
          quantity: Math.abs(movement.quantity),
          batchId: movement.resultingBatchId,
          sourceBatchId: movement.batchId,
          status: 'available',
          tenantId: record.tenantId ?? null,
          unitCost: movement.unitCost,
          totalCost: movement.totalCost,
          referenceType: 'StockTransfer',
          referenceId: record.id,
          referenceLabel: record.number,
          createdById: ctx.id,
          notes: `Received from ${record.fromLocation.name}`,
          effectiveDate: record.effectiveDate,
          backdateReason: record.backdateReason,
          isBackdated: record.isBackdated,
        });
      }

      for (const line of record.lines) {
        await tx.transferLine.update({ where: { id: line.id }, data: { receivedQty: line.quantity } });
      }

      const updated = await tx.stockTransfer.update({
        where: { id: transferId },
        data: { status: 'completed', completedAt: new Date() },
        include: { lines: true, fromLocation: true, toLocation: true },
      });

      return {
        transfer: updated,
        summary: { from: record.fromLocation.name, to: record.toLocation.name, rows: outMovements.length },
      };
    },
    TX_OPTIONS,
  );

  if (summary) {
    await audit({
      ctx,
      action: 'complete',
      entityType: 'StockTransfer',
      entityId: transferId,
      entityLabel: transfer.number,
      before: { status: 'in_transit' },
      after: { status: 'completed' },
      metadata: summary,
    });
  }

  return transfer;
}

/** Cancel. Allowed while pending (nothing moved) or in transit (send it back). */
export async function cancelTransfer(transferId: string, ctx: GuardContext, reason?: string) {
  const { transfer, summary } = await prisma.$transaction(
    async (tx) => {
      const record = await tx.stockTransfer.findUnique({
        where: { id: transferId },
        include: { lines: true, fromLocation: true, toLocation: true },
      });
      if (!record) throw new Error('Transfer not found');
      if (record.status === 'completed') {
        throw new Error('A completed transfer cannot be cancelled — record a return transfer instead');
      }
      if (record.status === 'cancelled') throw new Error('Transfer is already cancelled');

      let reversed = 0;
      if (record.status === 'in_transit') {
        const outMovements = await tx.stockMovement.findMany({
          where: { referenceType: 'StockTransfer', referenceId: transferId, type: 'transfer_out' },
        });
        for (const movement of outMovements) {
          if (movement.resultingBatchId) {
            await tx.batch.update({ where: { id: movement.resultingBatchId }, data: { remainingQty: 0 } });
          }
          await tx.batch.update({
            where: { id: movement.batchId! },
            data: { remainingQty: { increment: Math.abs(movement.quantity) } },
          });
          await recordMovement(tx, {
            type: 'transfer_in',
            variantId: movement.variantId,
            locationId: record.fromLocationId,
            quantity: Math.abs(movement.quantity),
            batchId: movement.batchId,
            sourceBatchId: movement.resultingBatchId,
            status: 'available',
            tenantId: record.tenantId ?? null,
            unitCost: movement.unitCost,
            totalCost: movement.totalCost,
            referenceType: 'StockTransfer',
            referenceId: record.id,
            referenceLabel: record.number,
            createdById: ctx.id,
            notes: `Transfer cancelled — stock returned to ${record.fromLocation.name}${reason ? ` (${reason})` : ''}`,
          });
          reversed += 1;
        }
      }

      const updated = await tx.stockTransfer.update({
        where: { id: transferId },
        data: { status: 'cancelled' },
        include: { lines: true, fromLocation: true, toLocation: true },
      });

      return {
        transfer: updated,
        summary: {
          before: record.status,
          from: record.fromLocation.name,
          to: record.toLocation.name,
          reversed,
        },
      };
    },
    TX_OPTIONS,
  );

  await audit({
    ctx,
    action: 'cancel',
    entityType: 'StockTransfer',
    entityId: transferId,
    entityLabel: transfer.number,
    before: { status: summary.before },
    after: { status: 'cancelled', reason: reason ?? null },
    metadata: summary,
  });

  return transfer;
}

export { InsufficientStockError };
