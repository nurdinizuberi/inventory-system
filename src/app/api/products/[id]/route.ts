import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  basePrice: z.coerce.number().min(0).optional(),
  costPrice: z.coerce.number().min(0).optional(),
  optionNames: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'product.view' });
    const { id } = await params;
    const product = await prisma.product.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { category: true, variants: { orderBy: { label: 'asc' } } },
    });
    if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

    const matrix = await getStockMatrix(prisma, { variantIds: product.variants.map((v) => v.id) });
    const stock = product.variants.map((v) => ({
      variantId: v.id,
      rows: matrix.filter((row) => row.variantId === v.id),
    }));
    return NextResponse.json({ product, stock });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'product.update' });
    const { id } = await params;
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const before = await prisma.product.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { variants: { where: { isActive: true } } },
    });
    if (!before) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

    const payload = parsed.data;
    // Changing the product-level defaults can silently zero out any active variant
    // that inherits them, so when a default actually changes, make sure every
    // sellable variant still ends up with a selling price and cost greater than 0
    // (its own, or via the product default). Untouched defaults (metadata-only
    // edits) don't need re-validation.
    if (
      (payload.basePrice !== undefined && payload.basePrice !== before.basePrice) ||
      (payload.costPrice !== undefined && payload.costPrice !== before.costPrice)
    ) {
      const basePrice = payload.basePrice !== undefined ? payload.basePrice : before.basePrice;
      const costPrice = payload.costPrice !== undefined ? payload.costPrice : before.costPrice;
      for (const v of before.variants) {
        if (!((v.sellingPrice ?? basePrice) > 0)) {
          return badRequest(`"${v.label}" needs a selling price greater than 0 — it currently inherits a 0 product default.`);
        }
        if (!((v.costPrice ?? costPrice) > 0)) {
          return badRequest(`"${v.label}" needs a cost greater than 0 — it currently inherits a 0 product default.`);
        }
      }
    }

    const product = await prisma.product.update({
      where: { id },
      data: {
        ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.categoryId !== undefined ? { categoryId: payload.categoryId || null } : {}),
        ...(payload.basePrice !== undefined ? { basePrice: payload.basePrice } : {}),
        ...(payload.costPrice !== undefined ? { costPrice: payload.costPrice } : {}),
        ...(payload.optionNames !== undefined ? { optionNames: payload.optionNames.filter(Boolean).join(',') } : {}),
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
      },
      include: { variants: true, category: true },
    });

    await audit({
      ctx,
      action: 'update',
      entityType: 'Product',
      entityId: id,
      entityLabel: product.name,
      before,
      after: product,
    });

    return NextResponse.json({ product });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * Hard delete (only for archived products with no stock on hand).
 * Cascades the full ledger (batches, movements, adjustments, reservations,
 * transfer/purchase/sale/return lines) for the product's variants so the
 * destructive removal does not leave orphaned rows. This intentionally erases
 * the audit ledger for the product, per the destructive-delete choice.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'product.delete' });
    const { id } = await params;
    const before = await prisma.product.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { variants: true },
    });
    if (!before) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

    if (before.isActive) {
      return NextResponse.json(
        { error: 'Archive the product before deleting it.' },
        { status: 400 },
      );
    }

    const variantIds = before.variants.map((v) => v.id);
    if (variantIds.length === 0) {
      return NextResponse.json(
        { error: 'Product has no variants to delete.' },
        { status: 400 },
      );
    }

    await audit({
      ctx,
      action: 'delete',
      entityType: 'Product',
      entityId: id,
      entityLabel: before.name,
      before,
    });

    await prisma.$transaction(async (tx) => {
      // Delete rows referencing the variants, dependency order first.
      const args = variantIds.map((_, i) => `$${i + 1}`).join(', ');
      await tx.$executeRawUnsafe(`DELETE FROM "ReturnLine" WHERE "variantId" IN (${args})`, ...variantIds);
      await tx.$executeRawUnsafe(`DELETE FROM "SaleLine" WHERE "variantId" IN (${args})`, ...variantIds);
      await tx.$executeRawUnsafe(`DELETE FROM "PurchaseLine" WHERE "variantId" IN (${args})`, ...variantIds);
      await tx.$executeRawUnsafe(`DELETE FROM "TransferLine" WHERE "variantId" IN (${args})`, ...variantIds);
      await tx.$executeRawUnsafe(`DELETE FROM "Reservation" WHERE "variantId" IN (${args})`, ...variantIds);
      await tx.$executeRawUnsafe(`DELETE FROM "StockAdjustment" WHERE "variantId" IN (${args})`, ...variantIds);
      await tx.$executeRawUnsafe(`DELETE FROM "StockMovement" WHERE "variantId" IN (${args})`, ...variantIds);
      await tx.$executeRawUnsafe(`DELETE FROM "Batch" WHERE "variantId" IN (${args})`, ...variantIds);
      await tx.$executeRawUnsafe(`DELETE FROM "Variant" WHERE "id" IN (${args})`, ...variantIds);
      await tx.product.deleteMany({ where: { id } });
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
