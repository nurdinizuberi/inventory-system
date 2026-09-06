import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { TX_OPTIONS, prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { approvePurchase, receivePurchaseLines } from '@/lib/purchase-service';

type Params = { params: Promise<{ id: string }> };

const actionSchema = z.object({
  action: z.enum(['confirm', 'receive', 'cancel']),
  reason: z.string().optional(),
  lines: z
    .array(z.object({ lineId: z.string().min(1), quantity: z.coerce.number().int().positive() }))
    .optional(),
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
            batches: { include: { location: true } },
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
      const updated = await approvePurchase(id, ctx);
      return NextResponse.json({ purchase: updated });
    }

    if (parsed.data.action === 'receive') {
      const ctx = await guard({ action: 'purchase.confirm' });
      const purchase = await prisma.purchase.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) }, include: { lines: true, location: true } });
      if (!purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });
      const updated = await receivePurchaseLines(id, ctx, parsed.data.lines ?? []);
      return NextResponse.json({ purchase: updated });
    }

    const ctx = await guard({ action: 'purchase.cancel' });
    const purchase = await prisma.purchase.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) }, include: { lines: true, location: true } });
    if (!purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });
    const { updated, previous, received, supplier, location } = await cancelPurchase(id, ctx, parsed.data.reason);
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
 * Cancel. A draft — or a confirmed order that never had goods received — simply
 * closes. Once any stock has been received the order is left alone and the
 * received goods must be written off or returned through the normal flows
 * (returns / adjustments): there is no "undo" for goods already in the ledger.
 */
async function cancelPurchase(
  purchaseId: string,
  ctx: Awaited<ReturnType<typeof guard>>,
  reason?: string,
) {
  return prisma.$transaction(async (tx) => {
    const purchase = await tx.purchase.findFirst({
      where: { id: purchaseId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { lines: { include: { variant: { include: { product: true } } } }, supplier: true, location: true },
    });
    if (!purchase) throw new Error('Purchase not found');
    if (purchase.status === 'cancelled') throw new Error('Purchase is already cancelled');

    const received = purchase.lines.reduce((sum, l) => sum + l.receivedQty, 0);
    if (received > 0) {
      throw new Error(
        `Cannot cancel ${purchase.number}: ${received} unit(s) have already been received. Write off or return the received goods instead.`,
      );
    }

    const updated = await tx.purchase.update({
      where: { id: purchaseId },
      data: { status: 'cancelled' },
      include: { lines: true, supplier: true, location: true },
    });

    return { updated, previous: purchase.status, received, supplier: purchase.supplier.name, location: purchase.location.name };
  }, TX_OPTIONS);
}