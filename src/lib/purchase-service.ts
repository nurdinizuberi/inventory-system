import { TX_OPTIONS, prisma } from './db';
import { audit } from './audit';
import { locationCanReceivePurchase, type GuardContext } from './rbac';
import { recordMovement } from './stock';

/**
 * Goods receipt. Opens a batch per purchase line and writes the matching
 * `purchase_in` ledger rows — all inside one transaction so a failure can never
 * leave stock in the building without a batch (or vice versa).
 *
 * The audit entry is written AFTER the commit on purpose: the ledger write is
 * the thing that must be atomic, and holding a transaction open across an
 * unrelated insert is what made this time out.
 */
export async function confirmPurchase(purchaseId: string, ctx: GuardContext) {
  const { purchase, summary } = await prisma.$transaction(
    async (tx) => {
      const record = await tx.purchase.findUnique({
        where: { id: purchaseId },
        include: {
          lines: { include: { variant: { include: { product: true } } } },
          location: true,
          supplier: true,
        },
      });
      if (!record) throw new Error('Purchase not found');
      if (record.status === 'confirmed') return { purchase: record, summary: null };
      if (record.status === 'cancelled') throw new Error('A cancelled purchase cannot be confirmed');
      if (!locationCanReceivePurchase(record.location)) {
        throw new Error(
          `Location "${record.location.name}" cannot receive purchases (can_receive_purchase = false).`,
        );
      }

      const receivedAt = record.effectiveDate || new Date();
      for (const [index, line] of record.lines.entries()) {
        const batch = await tx.batch.create({
          data: {
            tenantId: record.tenantId ?? null,
            code: `B-${record.number}-${String(index + 1).padStart(2, '0')}`,
            variantId: line.variantId,
            locationId: record.locationId,
            unitCost: line.unitCost,
            quantity: line.quantity,
            remainingQty: line.quantity,
            receivedAt,
            purchaseLineId: line.id,
          },
        });

        await recordMovement(tx, {
          type: 'purchase_in',
          tenantId: record.tenantId ?? null,
          variantId: line.variantId,
          locationId: record.locationId,
          quantity: line.quantity,
          batchId: batch.id,
          status: 'available',
          unitCost: line.unitCost,
          totalCost: line.lineTotal,
          referenceType: 'Purchase',
          referenceId: record.id,
          referenceLabel: record.number,
          approvedById: ctx.id,
          createdById: ctx.id,
          notes: `Received ${line.quantity} × ${line.variant.product.name} (${line.variant.label}) on batch ${batch.code}`,
          effectiveDate: record.effectiveDate,
          backdateReason: record.backdateReason,
          isBackdated: record.isBackdated,
        });

        await tx.purchaseLine.update({ where: { id: line.id }, data: { receivedQty: line.quantity } });
      }

      const updated = await tx.purchase.update({
        where: { id: purchaseId },
        data: { status: 'confirmed', approvedById: ctx.id },
        include: { lines: true, supplier: true, location: true },
      });

      return {
        purchase: updated,
        summary: {
          before: record.status,
          supplier: record.supplier.name,
          location: record.location.name,
          total: record.total,
          lines: record.lines.length,
        },
      };
    },
    TX_OPTIONS,
  );

  if (summary) {
    await audit({
      ctx,
      action: 'confirm',
      entityType: 'Purchase',
      entityId: purchaseId,
      entityLabel: purchase.number,
      before: { status: summary.before },
      after: { status: 'confirmed', total: summary.total, lines: summary.lines },
      metadata: { supplier: summary.supplier, location: summary.location },
    });
  }

  return purchase;
}
