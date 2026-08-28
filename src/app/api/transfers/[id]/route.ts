import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { assertLocationAccess, badRequest, guard, jsonError } from '@/lib/rbac';
import { InsufficientStockError } from '@/lib/fifo';
import { cancelTransfer, completeTransfer, shipTransfer } from '@/lib/transfer-service';

type Params = { params: Promise<{ id: string }> };

const actionSchema = z.object({
  action: z.enum(['ship', 'complete', 'cancel']),
  reason: z.string().optional(),
});

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'transfer.view' });
    const { id } = await params;
    const transfer = await prisma.stockTransfer.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: {
        fromLocation: true,
        toLocation: true,
        createdBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
        lines: { include: { variant: { include: { product: true } } } },
      },
    });
    if (!transfer) return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });

    const movements = await prisma.stockMovement.findMany({
      where: { referenceType: 'StockTransfer', referenceId: id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: {
        variant: { include: { product: true } },
        location: true,
        batch: true,
        resultingBatch: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json({ transfer, movements });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const { action, reason } = parsed.data;

    if (action === 'ship') {
      const ctx = await guard({ action: 'transfer.ship' });
      const transfer = await prisma.stockTransfer.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
      if (!transfer) return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });
      const updated = await shipTransfer(id, ctx);
      return NextResponse.json({ transfer: updated });
    }

    if (action === 'complete') {
      const ctx = await guard({ action: 'transfer.complete' });
      const transfer = await prisma.stockTransfer.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
      if (!transfer) return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });
      // Whoever receives the goods must own the receiving location.
      await assertLocationAccess(ctx, transfer.toLocationId);
      const updated = await completeTransfer(id, ctx);
      return NextResponse.json({ transfer: updated });
    }

    const ctx = await guard({ action: 'transfer.cancel' });
    const transfer = await prisma.stockTransfer.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (!transfer) return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });
    const updated = await cancelTransfer(id, ctx, reason);
    return NextResponse.json({ transfer: updated });
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return jsonError(err);
  }
}
