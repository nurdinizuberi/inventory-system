import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { TX_OPTIONS, prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { confirmPurchase } from '@/lib/purchase-service';
import { recordMovement } from '@/lib/stock';

type Params = { params: Promise<{ id: string }> };

const actionSchema = z.object({
  action: z.enum(['confirm', 'cancel']),
  reason: z.string().optional(),
});

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'purchase.view' });
    const { id } = await params;
    const purchase = await prisma.purchase.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: {
        supplier: true,
        location: true,
        createdBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
        lines: {
          include: {
            variant: { include: { product: true } },
            batch: { include: { location: true } },
          },
        },
      },
    });
    if (!purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });

    const movements = await prisma.stockMovement.findMany({
      where: { referenceType: 'Purchase', referenceId: id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { variant: { include: { product: true } }, location: true, batch: true },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json({ purchase, movements });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    if (parsed.data.action === 'confirm') {
      const ctx = await guard({ action: 'purchase.confirm' });
      const purchase = await prisma.purchase.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) }, include: { lines: true, location: true } });
      if (!purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });
      const updated = await confirmPurchase(id, ctx);
      return NextResponse.json({ purchase: updated });
    }

    const ctx = await guard({ action: 'purchase.cancel' });
    const purchase = await prisma.purchase.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) }, include: { lines: true, location: true } });
    if (!purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });
    const { updated, previous, supplier, location } = await cancelPurchase(id, ctx, parsed.data.reason);
    await audit({
      ctx,
      action: 'cancel',
      entityType: 'Purchase',
      entityId: id,
      entityLabel: updated.number,
      before: { status: previous },
      after: { status: 'cancelled', reason: parsed.data.reason ?? null },
      metadata: { supplier, location },
    });
    return NextResponse.json({ purchase: updated });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * Cancel. A draft simply closes. A confirmed receipt is reversed with explicit
 * negative adjustment rows (never by deleting the ledger), and only if the
 * stock is still physically there.
 */
async function cancelPurchase(
  purchaseId: string,
  ctx: Awaited<ReturnType<typeof guard>>,
  reason?: string,
) {
  return prisma.$transaction(async (tx) => {
    const purchase = await tx.purchase.findFirst({
      where: { id: purchaseId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { lines: { include: { batch: true, variant: { include: { product: true } } } }, supplier: true, location: true },
    });
    if (!purchase) throw new Error('Purchase not found');
    if (purchase.status === 'cancelled') throw new Error('Purchase is already cancelled');

    if (purchase.status === 'confirmed') {
      for (const line of purchase.lines) {
        if (!line.batch) continue;
        if (line.batch.remainingQty < line.quantity) {
          throw new Error(
            `Cannot cancel: ${line.quantity - line.batch.remainingQty} unit(s) of ${line.variant.product.name} (${line.variant.label}) ` +
              `from batch ${line.batch.code} have already been moved or sold.`,
          );
        }
      }
      for (const line of purchase.lines) {
        if (!line.batch) continue;
        await tx.batch.update({
          where: { id: line.batch.id },
          data: { remainingQty: { decrement: line.quantity } },
        });
        await recordMovement(tx, {
          type: 'adjustment',
          tenantId: ctx.tenantId ?? null,
          variantId: line.variantId,
          locationId: purchase.locationId,
          quantity: -line.quantity,
          batchId: line.batch.id,
          status: 'available',
          adjustmentReason: 'count_correction',
          unitCost: line.unitCost,
          totalCost: -line.lineTotal,
          approvedById: ctx.id,
          referenceType: 'Purchase',
          referenceId: purchase.id,
          referenceLabel: purchase.number,
          createdById: ctx.id,
          notes: `Purchase ${purchase.number} cancelled — receipt reversed${reason ? ` (${reason})` : ''}`,
        });
      }
    }

    const updated = await tx.purchase.update({
      where: { id: purchaseId },
      data: { status: 'cancelled' },
      include: { lines: true, supplier: true, location: true },
    });

    return { updated, previous: purchase.status, supplier: purchase.supplier.name, location: purchase.location.name };
  }, TX_OPTIONS);
}
