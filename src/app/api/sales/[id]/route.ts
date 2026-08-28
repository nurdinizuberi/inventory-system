import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { TX_OPTIONS, prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { recordMovement } from '@/lib/stock';
import { round2 } from '@/lib/utils';

type Params = { params: Promise<{ id: string }> };

const actionSchema = z.object({ action: z.enum(['void']), reason: z.string().optional() });

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'sale.view' });
    const { id } = await params;
    const sale = await prisma.sale.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: {
        location: true,
        cashier: { select: { id: true, name: true, email: true } },
        lines: { include: { variant: { include: { product: true } } } },
        returns: { include: { lines: { include: { variant: { include: { product: true } } } } } },
      },
    });
    if (!sale) return NextResponse.json({ error: 'Sale not found' }, { status: 404 });
    if (ctx.role === 'CASHIER' && sale.cashierId !== ctx.id) {
      return NextResponse.json({ error: 'Forbidden: cashiers can only open their own tickets.' }, { status: 403 });
    }

    const movements = await prisma.stockMovement.findMany({
      where: { referenceType: 'Sale', referenceId: id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { variant: { include: { product: true } }, location: true, batch: true },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json({ sale, movements });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * Void a sale: the units go back onto the exact batches they came off (so FIFO
 * costing is not corrupted), and the ticket is marked voided. Nothing is ever
 * deleted from the ledger.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const ctx = await guard({ action: 'sale.void' });
    const sale = await prisma.sale.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) }, include: { lines: true, location: true } });
    if (!sale) return NextResponse.json({ error: 'Sale not found' }, { status: 404 });
    if (sale.status === 'voided') return badRequest('Sale is already voided');

    const returns = await prisma.return.count({ where: { saleId: id, status: 'completed', ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (returns > 0) return badRequest('Sale already has returns recorded — void is not allowed.');

    let restored = 0;
    const updated = await prisma.$transaction(async (tx) => {
      const outbound = await tx.stockMovement.findMany({
        where: { referenceType: 'Sale', referenceId: id, type: 'sale_out', ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
        orderBy: { createdAt: 'asc' },
      });

      for (const movement of outbound) {
        if (movement.batchId) {
          await tx.batch.update({
            where: { id: movement.batchId },
            data: { remainingQty: { increment: Math.abs(movement.quantity) } },
          });
        }
        await recordMovement(tx, {
          type: 'adjustment',
          tenantId: ctx.tenantId ?? null,
          variantId: movement.variantId,
          locationId: movement.locationId,
          quantity: Math.abs(movement.quantity),
          batchId: movement.batchId,
          status: 'available',
          adjustmentReason: 'count_correction',
          unitCost: movement.unitCost,
          totalCost: movement.totalCost ? Math.abs(movement.totalCost) : null,
          approvedById: ctx.id,
          referenceType: 'Sale',
          referenceId: id,
          referenceLabel: sale.number,
          createdById: ctx.id,
          notes: `Sale ${sale.number} voided — stock restored to batch${parsed.data.reason ? ` (${parsed.data.reason})` : ''}`,
        });
      }

      const result = await tx.sale.update({
        where: { id },
        data: { status: 'voided', profit: 0, totalCost: 0, amountPaid: 0, changeDue: 0 },
        include: { lines: { include: { variant: { include: { product: true } } } }, location: true },
      });

      restored = outbound.length;
      return result;
    }, TX_OPTIONS);

    await audit({
      ctx,
      action: 'void',
      entityType: 'Sale',
      entityId: id,
      entityLabel: sale.number,
      before: { status: sale.status, total: sale.total, profit: sale.profit },
      after: { status: 'voided', total: updated.total, profit: 0 },
      metadata: { reason: parsed.data.reason ?? null, restoredUnits: restored },
    });

    return NextResponse.json({ sale: updated, restocked: true, profit: round2(0) });
  } catch (err) {
    return jsonError(err);
  }
}
