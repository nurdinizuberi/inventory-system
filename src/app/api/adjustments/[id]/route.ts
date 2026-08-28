import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { TX_OPTIONS, prisma } from '@/lib/db';
import { consumeFifo, InsufficientStockError } from '@/lib/fifo';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import type { AdjustmentReason } from '@/lib/types';
import { recordMovement } from '@/lib/stock';
import { round2 } from '@/lib/utils';

type Params = { params: Promise<{ id: string }> };

const schema = z.object({ action: z.enum(['approve', 'reject']) });

/**
 * Approving an adjustment is the ONLY moment it touches stock. Write-offs are
 * consumed FIFO (so the cost booked against the loss is the real cost of the
 * units that actually disappeared); found stock opens a new batch.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const ctx = await guard({ action: 'stock.adjustApprove' });
    const adjustment = await prisma.stockAdjustment.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { variant: { include: { product: true } }, location: true },
    });
    if (!adjustment) return NextResponse.json({ error: 'Adjustment not found' }, { status: 404 });
    if (adjustment.status !== 'pending') return badRequest(`Adjustment is already ${adjustment.status}`);

    if (parsed.data.action === 'reject') {
      const rejected = await prisma.stockAdjustment.update({
        where: { id },
        data: { status: 'rejected', approvedById: ctx.id, approvedAt: new Date() },
        include: { variant: { include: { product: true } }, location: true },
      });
      await audit({
        ctx,
        action: 'reject',
        entityType: 'StockAdjustment',
        entityId: id,
        entityLabel: adjustment.number,
        before: { status: adjustment.status },
        after: { status: 'rejected' },
      });
      return NextResponse.json({ adjustment: rejected });
    }

    let bookedCost: number | null = null;
    const updated = await prisma.$transaction(async (tx) => {
      const variantLabel = `${adjustment.variant?.product.name ?? adjustment.variantId} — ${adjustment.variant?.label ?? ''}`;
      let unitCost: number | null = null;

      if (adjustment.quantity < 0) {
        const fifo = await consumeFifo(tx, {
          type: 'adjustment',
          tenantId: ctx.tenantId ?? null,
          variantId: adjustment.variantId,
          locationId: adjustment.locationId,
          quantity: Math.abs(adjustment.quantity),
          status: 'available',
          adjustmentReason: adjustment.reason as AdjustmentReason,
          referenceType: 'StockAdjustment',
          referenceId: adjustment.id,
          referenceLabel: adjustment.number,
          approvedById: ctx.id,
          createdById: ctx.id,
          variantLabel,
          locationName: adjustment.location.name,
          notes: `Adjustment ${adjustment.number} approved (${adjustment.reason})`,
        });
        unitCost = fifo.unitCost;
      } else {
        const cost = adjustment.variant?.costPrice ?? adjustment.variant?.product.costPrice ?? 0;
        const batch = await tx.batch.create({
          data: {
            tenantId: ctx.tenantId ?? null,
            code: `B-${adjustment.number}`,
            variantId: adjustment.variantId,
            locationId: adjustment.locationId,
            unitCost: cost,
            quantity: adjustment.quantity,
            remainingQty: adjustment.quantity,
            receivedAt: new Date(),
          },
        });
        await recordMovement(tx, {
          type: 'adjustment',
          tenantId: ctx.tenantId ?? null,
          variantId: adjustment.variantId,
          locationId: adjustment.locationId,
          quantity: adjustment.quantity,
          batchId: batch.id,
          status: 'available',
          adjustmentReason: adjustment.reason as AdjustmentReason,
          unitCost: cost,
          totalCost: round2(cost * adjustment.quantity),
          approvedById: ctx.id,
          referenceType: 'StockAdjustment',
          referenceId: adjustment.id,
          referenceLabel: adjustment.number,
          createdById: ctx.id,
          notes: `Adjustment ${adjustment.number} approved — stock found (${adjustment.reason})`,
        });
        unitCost = cost;
      }

      const result = await tx.stockAdjustment.update({
        where: { id },
        data: { status: 'approved', approvedById: ctx.id, approvedAt: new Date() },
        include: { variant: { include: { product: true } }, location: true },
      });

      bookedCost = unitCost;
      return result;
    }, TX_OPTIONS);

    await audit({
      ctx,
      action: 'approve',
      entityType: 'StockAdjustment',
      entityId: id,
      entityLabel: adjustment.number,
      before: { status: adjustment.status },
      after: { status: 'approved', quantity: adjustment.quantity, reason: adjustment.reason },
      metadata: { unitCost: bookedCost, approvedBy: ctx.email },
    });

    return NextResponse.json({ adjustment: updated });
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return jsonError(err);
  }
}
