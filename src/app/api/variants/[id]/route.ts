import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { TX_OPTIONS, prisma } from '@/lib/db';
import { InsufficientStockError } from '@/lib/fifo';
import { assertAction, assertLocationAccess, badRequest, guard, jsonError } from '@/lib/rbac';
import { getStockForVariant } from '@/lib/stock';
import { adjustVariantStock, revalueVariantBatches } from '@/lib/stock-edit';

const updateSchema = z.object({
  label: z.string().min(1).optional(),
  attributes: z.record(z.string()).optional(),
  sku: z.string().min(1).optional(),
  barcode: z.string().min(1).optional(),
  costPrice: z.coerce.number().min(0).nullable().optional(),
  sellingPrice: z.coerce.number().min(0).nullable().optional(),
  lowStockThreshold: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  /** Signed quantity change applied to on-hand stock (product editor). */
  quantityDelta: z.coerce.number().int().optional(),
  /** Location the quantity change applies to (required with quantityDelta). */
  stockLocationId: z.string().min(1).optional(),
  /** Reason for the cost/quantity change (required when stock changes). */
  reason: z.string().min(1).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'variant.view' });
    const { id } = await params;
    const variant = await prisma.variant.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { product: { include: { category: true } } },
    });
    if (!variant) return NextResponse.json({ error: 'Variant not found' }, { status: 404 });

    const [stock, batches] = await Promise.all([
      getStockForVariant(prisma, id),
      prisma.batch.findMany({
        where: { variantId: id, remainingQty: { gt: 0 } },
        include: { location: true },
        orderBy: [{ receivedAt: 'asc' }],
      }),
    ]);

    return NextResponse.json({ variant, stock, batches });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'variant.update' });
    const { id } = await params;
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const before = await prisma.variant.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { product: true },
    });
    if (!before) return NextResponse.json({ error: 'Variant not found' }, { status: 404 });

    const data = parsed.data;
    // A sellable variant must end up with a selling price and cost greater than 0
    // (its own, else the product default it inherits). Setting one to 0/null would
    // otherwise silently sell or value it at 0.
    if (before.isActive) {
      const sellingPrice = data.sellingPrice !== undefined ? data.sellingPrice : before.sellingPrice;
      const costPrice = data.costPrice !== undefined ? data.costPrice : before.costPrice;
      if (!((sellingPrice ?? before.product.basePrice) > 0)) {
        return badRequest('Selling price must be greater than 0.');
      }
      if (!((costPrice ?? before.product.costPrice) > 0)) {
        return badRequest('Cost must be greater than 0.');
      }
    }

    // Revaluation happens only when the cost actually changes to a positive value
    // (the product editor always sends costPrice, so an unchanged cost must not
    // fire a revaluation). Quantity edits carry a signed delta + target location.
    const revalueCost =
      data.costPrice !== undefined && data.costPrice !== null && data.costPrice > 0 && data.costPrice !== before.costPrice
        ? data.costPrice
        : null;
    const qtyDelta = data.quantityDelta ?? 0;
    const stockAffecting = revalueCost !== null || qtyDelta !== 0;

    if (stockAffecting && !data.reason?.trim()) {
      return badRequest('A reason is required for cost or quantity changes.');
    }
    if (qtyDelta !== 0) {
      if (!data.stockLocationId) return badRequest('A location is required when adjusting quantity.');
      await assertAction(ctx, 'stock.adjust');
      await assertLocationAccess(ctx, data.stockLocationId);
    } else if (revalueCost !== null) {
      await assertAction(ctx, 'stock.adjust');
    }

    const variant = await prisma.$transaction(async (tx) => {
      const updated = await tx.variant.update({
        where: { id },
        data: {
          ...(data.label !== undefined ? { label: data.label } : {}),
          ...(data.attributes !== undefined ? { attributes: JSON.stringify(data.attributes) } : {}),
          ...(data.sku !== undefined ? { sku: data.sku } : {}),
          ...(data.barcode !== undefined ? { barcode: data.barcode } : {}),
          ...(data.costPrice !== undefined ? { costPrice: data.costPrice } : {}),
          ...(data.sellingPrice !== undefined ? { sellingPrice: data.sellingPrice } : {}),
          ...(data.lowStockThreshold !== undefined ? { lowStockThreshold: data.lowStockThreshold } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
        include: { product: true },
      });

      const label = `${updated.product.name} — ${updated.label}`;
      if (revalueCost !== null) {
        await revalueVariantBatches(tx, {
          variantId: id,
          newCost: revalueCost,
          reason: (data.reason as string).trim(),
          referenceLabel: label,
          referenceId: id,
          referenceType: 'variant',
          tenantId: ctx.tenantId ?? null,
          createdById: ctx.id,
        });
      }
      if (qtyDelta !== 0) {
        const effectiveCost = updated.costPrice ?? updated.product.costPrice ?? 0;
        await adjustVariantStock(tx, {
          variantId: id,
          locationId: data.stockLocationId as string,
          delta: qtyDelta,
          unitCost: effectiveCost,
          reason: (data.reason as string).trim(),
          referenceLabel: label,
          referenceId: id,
          referenceType: 'variant',
          tenantId: ctx.tenantId ?? null,
          createdById: ctx.id,
        });
      }
      return updated;
    }, TX_OPTIONS);

    await audit({
      ctx,
      action: 'update',
      entityType: 'Variant',
      entityId: id,
      entityLabel: `${variant.product.name} — ${variant.label}`,
      before,
      after: variant,
      metadata: stockAffecting ? { revaluation: revalueCost !== null, quantityDelta: qtyDelta, reason: data.reason } : undefined,
    });

    return NextResponse.json({ variant });
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return jsonError(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'variant.delete' });
    const { id } = await params;
    const before = await prisma.variant.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) }, include: { product: true } });
    if (!before) return NextResponse.json({ error: 'Variant not found' }, { status: 404 });

    const onHand = (await getStockForVariant(prisma, id)).reduce((s, r) => s + r.onHand, 0);
    if (onHand > 0) {
      return badRequest(`Cannot deactivate ${before.label}: ${onHand} unit(s) still on hand. Adjust stock to zero first.`);
    }

    await prisma.variant.update({ where: { id }, data: { isActive: false } });
    await audit({
      ctx,
      action: 'delete',
      entityType: 'Variant',
      entityId: id,
      entityLabel: `${before.product.name} — ${before.label}`,
      before,
      metadata: { softDelete: true },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
