import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { TX_OPTIONS, prisma } from '@/lib/db';
import { assertLocationAccess, badRequest, guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { recordMovement } from '@/lib/stock';
import { RETURN_CONDITIONS } from '@/lib/types';
import { round2 } from '@/lib/utils';

const lineSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.coerce.number().int().positive(),
  condition: z.enum(RETURN_CONDITIONS).default('sellable'),
  refundAmount: z.coerce.number().min(0).optional().nullable(),
});

const createSchema = z.object({
  saleId: z.string().optional().nullable(),
  locationId: z.string().min(1, 'Location is required'),
  reason: z.string().default('customer_return'),
  lines: z.array(lineSchema).min(1, 'At least one returned item is required'),
});

export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'return.view' });
    const url = new URL(request.url);
    const scope = scopedLocationIds(ctx);
    const returns = await prisma.return.findMany({
      where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}), ...(scope ? { locationId: { in: scope } } : {}) },
      include: {
        location: true,
        sale: { select: { id: true, number: true } },
        createdBy: { select: { id: true, name: true } },
        lines: { include: { variant: { include: { product: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return NextResponse.json({ returns });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * Record a return.
 *  * `sellable`  -> `return_in` movement at the sale's location; the units go
 *    back onto the oldest batch of that variant there, at that batch's cost, so
 *    FIFO stays honest.
 *  * `damaged`   -> `return_damaged` movement into the Damaged / write-off
 *    location (created on demand if the deployment has none).
 */
export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'return.create' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    await assertLocationAccess(ctx, data.locationId);

    let saleId: string | null = data.saleId ?? null;
    if (saleId) {
      const sale = await prisma.sale.findFirst({ where: { id: saleId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) }, include: { lines: true } });
      if (!sale) return badRequest('Original sale not found');
      if (sale.status !== 'completed') return badRequest(`Cannot return against a ${sale.status} sale`);
      const returnedRows = await prisma.returnLine.groupBy({
        by: ['variantId'],
        where: { return: { saleId, status: 'completed' }, variantId: { in: data.lines.map((l) => l.variantId) } },
        _sum: { quantity: true },
      });
      const returnedByVariant = new Map(returnedRows.map((r) => [r.variantId, r._sum.quantity ?? 0]));
      for (const line of data.lines) {
        const original = sale.lines.find((l) => l.variantId === line.variantId);
        if (!original) return badRequest('That variant was not part of the original sale');
        const returned = (returnedByVariant.get(line.variantId) ?? 0) + line.quantity;
        if (returned > original.quantity) {
          return badRequest(
            `Cannot return ${returned} unit(s) of that variant — only ${original.quantity} were sold on ${sale.number}`,
          );
        }
      }
    }

    const variants = await prisma.variant.findMany({
      where: { id: { in: data.lines.map((l) => l.variantId) }, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { product: true },
    });

    const existing = await prisma.return.count({ where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    const number = `RT-${String(existing + 1).padStart(4, '0')}`;

    let refundTotal = 0;
    const result = await prisma.$transaction(async (tx) => {
      const returnRecord = await tx.return.create({
        data: {
          tenantId: ctx.tenantId ?? null,
          number,
          saleId,
          locationId: data.locationId,
          reason: data.reason,
          status: 'completed',
          createdById: ctx.id,
          lines: {
            create: data.lines.map((l) => {
              const variant = variants.find((v) => v.id === l.variantId)!;
              const price = variant.sellingPrice ?? variant.product.basePrice;
              return {
                variantId: l.variantId,
                quantity: l.quantity,
                condition: l.condition,
                unitCost: variant.costPrice ?? variant.product.costPrice,
                refundAmount:
                  l.refundAmount ?? (l.condition === 'sellable' ? round2(price * l.quantity) : 0),
              };
            }),
          },
        },
        include: { lines: true },
      });

      let refund = 0;

      for (const line of returnRecord.lines) {
        const variant = variants.find((v) => v.id === line.variantId)!;

        if (line.condition === 'sellable') {
          // Restock onto the oldest existing batch at this location (that is the
          // batch the units most likely came from); if there is none, open one.
          const batches = await tx.batch.findMany({
            where: { variantId: line.variantId, locationId: data.locationId },
            orderBy: [{ receivedAt: 'asc' }],
            take: 1,
          });
          let batch = batches[0];
          if (!batch) {
            const cost = variant.costPrice ?? variant.product.costPrice;
            batch = await tx.batch.create({
              data: {
                tenantId: ctx.tenantId ?? null,
                code: `B-${number}-${line.id.slice(-4).toUpperCase()}`,
                variantId: line.variantId,
                locationId: data.locationId,
                unitCost: cost,
                quantity: 0,
                remainingQty: 0,
                receivedAt: new Date(),
              },
            });
          }

          await tx.batch.update({
            where: { id: batch.id },
            data: { remainingQty: { increment: line.quantity } },
          });

          await recordMovement(tx, {
            type: 'return_in',
            tenantId: ctx.tenantId ?? null,
            variantId: line.variantId,
            locationId: data.locationId,
            quantity: line.quantity,
            batchId: batch.id,
            status: 'available',
            unitCost: batch.unitCost,
            totalCost: round2(batch.unitCost * line.quantity),
            referenceType: 'Return',
            referenceId: returnRecord.id,
            referenceLabel: number,
            createdById: ctx.id,
            notes: `Customer return restocked as sellable (${data.reason})`,
          });
          refund += line.refundAmount;
        } else {
          let damaged = await tx.location.findFirst({
            where: { isDamagedLocation: true, isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
          });
          if (!damaged) {
            damaged = await tx.location.create({
              data: {
                tenantId: ctx.tenantId ?? null,
                code: 'DAMAGED',
                name: 'Damaged / Write-off',
                type: 'DAMAGED',
                canReceivePurchase: false,
                canSellPos: false,
                isDamagedLocation: true,
              },
            });
          }

          await recordMovement(tx, {
            type: 'return_damaged',
            tenantId: ctx.tenantId ?? null,
            variantId: line.variantId,
            locationId: damaged.id,
            quantity: line.quantity,
            status: 'available',
            unitCost: line.unitCost,
            totalCost: round2(line.unitCost * line.quantity),
            referenceType: 'Return',
            referenceId: returnRecord.id,
            referenceLabel: number,
            createdById: ctx.id,
            notes: `Customer return written off as damaged (${data.reason})`,
          });
        }
      }

      const updated = await tx.return.update({
        where: { id: returnRecord.id },
        data: { totalRefund: round2(refund) },
        include: {
          lines: { include: { variant: { include: { product: true } } } },
          location: true,
          sale: { select: { id: true, number: true } },
        },
      });

      refundTotal = refund;
      return updated;
    }, TX_OPTIONS);

    await audit({
      ctx,
      action: 'create',
      entityType: 'Return',
      entityId: result.id,
      entityLabel: number,
      after: {
        number,
        refund: round2(refundTotal),
        lines: result.lines.length,
        sale: saleId ?? null,
        reason: data.reason,
      },
    });

    return NextResponse.json({ return: result }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
