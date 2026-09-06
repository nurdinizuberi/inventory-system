import { TX_OPTIONS, prisma } from './db';
import { audit } from './audit';
import { locationCanReceivePurchase, type GuardContext } from './rbac';
import { recordMovement } from './stock';

/**
 * Confirming a purchase order is now an APPROVAL, not a goods receipt.
 * It moves the order from `draft` to `confirmed` and records who approved it.
 * Stock is only put in the building later, per line, through
 * `receivePurchaseLines` — so a delivery can arrive in several partial lots.
 */
export async function approvePurchase(purchaseId: string, ctx: GuardContext) {
  const { purchase, after } = await prisma.$transaction(
    async (tx) => {
      const record = await tx.purchase.findUnique({
        where: { id: purchaseId },
        include: { supplier: true, location: true },
      });
      if (!record) throw new Error('Purchase not found');
      if (record.status === 'confirmed') return { purchase: record, after: null };
      if (record.status === 'received') throw new Error('A received purchase cannot be re-opened; raise a new order instead');
      if (record.status === 'cancelled') throw new Error('A cancelled purchase cannot be confirmed');
      if (!locationCanReceivePurchase(record.location)) {
        throw new Error(
          `Location "${record.location.name}" cannot receive purchases (can_receive_purchase = false).`,
        );
      }

      const updated = await tx.purchase.update({
        where: { id: purchaseId },
        data: { status: 'confirmed', approvedById: ctx.id },
        include: { lines: true, supplier: true, location: true },
      });

      return {
        purchase: updated,
        after: { supplier: record.supplier.name, location: record.location.name, total: record.total },
      };
    },
    TX_OPTIONS,
  );

  if (after) {
    await audit({
      ctx,
      action: 'confirm',
      entityType: 'Purchase',
      entityId: purchaseId,
      entityLabel: purchase.number,
      before: { status: 'draft' },
      after: { status: 'confirmed', total: after.total },
      metadata: { supplier: after.supplier, location: after.location },
    });
  }

  return purchase;
}

export interface ReceiveLine {
  lineId: string;
  quantity: number;
}

/**
 * Partial goods receipt. Opens one batch per received line quantity (carrying
 * the line's expiry date), writes the matching `purchase_in` ledger rows, and
 * increments the line's received total. When every line is fully received the
 * purchase moves to `received`. Runs in one transaction so a failure can never
 * leave stock in the building without a batch (or vice versa).
 */
export async function receivePurchaseLines(
  purchaseId: string,
  ctx: GuardContext,
  receipts: ReceiveLine[],
) {
  if (!receipts.length) throw new Error('At least one line quantity is required');

  const { purchase, after } = await prisma.$transaction(
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
      if (record.status !== 'confirmed') {
        throw new Error(`Only a confirmed purchase can receive goods (current status: "${record.status}")`);
      }
      if (!locationCanReceivePurchase(record.location)) {
        throw new Error(
          `Location "${record.location.name}" cannot receive purchases (can_receive_purchase = false).`,
        );
      }

      const receivedAt = record.effectiveDate || new Date();
      const lineById = new Map(record.lines.map((l) => [l.id, l]));
      const picked: string[] = [];

      for (const receipt of receipts) {
        const line = lineById.get(receipt.lineId);
        if (!line) throw new Error('A receipt line does not belong to this purchase');
        const quantity = Number(receipt.quantity);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          throw new Error(`${line.variant.product.name} (${line.variant.label}): received quantity must be a positive whole number`);
        }
        const remaining = line.quantity - line.receivedQty;
        if (quantity > remaining) {
          throw new Error(
            `${line.variant.product.name} (${line.variant.label}): only ${remaining} unit(s) remain outstanding, cannot receive ${quantity}`,
          );
        }
        picked.push(line.id);

        const seq = (await tx.batch.count({ where: { purchaseLineId: line.id } })) + 1;
        const lineIndex = record.lines.findIndex((l) => l.id === line.id) + 1;
        const batch = await tx.batch.create({
          data: {
            tenantId: record.tenantId ?? null,
            code: `B-${record.number}-${String(lineIndex).padStart(2, '0')}-${String(seq).padStart(2, '0')}`,
            variantId: line.variantId,
            locationId: record.locationId,
            unitCost: line.unitCost,
            quantity,
            remainingQty: quantity,
            receivedAt,
            expiresAt: line.expiresAt,
            purchaseLineId: line.id,
          },
        });

        await recordMovement(tx, {
          type: 'purchase_in',
          tenantId: record.tenantId ?? null,
          variantId: line.variantId,
          locationId: record.locationId,
          quantity,
          batchId: batch.id,
          status: 'available',
          unitCost: line.unitCost,
          totalCost: line.unitCost * quantity,
          referenceType: 'Purchase',
          referenceId: record.id,
          referenceLabel: record.number,
          approvedById: ctx.id,
          createdById: ctx.id,
          notes: `Received ${quantity} × ${line.variant.product.name} (${line.variant.label}) on batch ${batch.code}${line.expiresAt ? `, expires ${line.expiresAt.toISOString().slice(0, 10)}` : ''}`,
          effectiveDate: record.effectiveDate,
          backdateReason: record.backdateReason,
          isBackdated: record.isBackdated,
        });

        await tx.purchaseLine.update({
          where: { id: line.id },
          data: { receivedQty: { increment: quantity } },
        });
      }

      const refreshed = await tx.purchase.findUniqueOrThrow({
        where: { id: purchaseId },
        include: { lines: true, supplier: true, location: true },
      });
      const fullyReceived = refreshed.lines.every((l) => l.receivedQty >= l.quantity);

      const updated = await tx.purchase.update({
        where: { id: purchaseId },
        data: { status: fullyReceived ? 'received' : 'confirmed', approvedById: ctx.id },
        include: { lines: true, supplier: true, location: true },
      });

      return {
        purchase: updated,
        after: {
          before: record.status,
          supplier: record.supplier.name,
          location: record.location.name,
          receivedLines: picked.length,
          fullyReceived,
        },
      };
    },
    TX_OPTIONS,
  );

  await audit({
    ctx,
    action: 'confirm',
    entityType: 'Purchase',
    entityId: purchaseId,
    entityLabel: purchase.number,
    before: { status: after.before },
    after: {
      status: purchase.status,
      linesReceived: after.receivedLines,
      fullyReceived: after.fullyReceived,
    },
    metadata: { supplier: after.supplier, location: after.location },
  });

  return purchase;
}