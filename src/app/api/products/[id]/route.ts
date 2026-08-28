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

    const before = await prisma.product.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (!before) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

    const payload = parsed.data;
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

/** Soft delete: keeps the ledger intact, which is the whole point of an audit trail. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'product.delete' });
    const { id } = await params;
    const before = await prisma.product.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (!before) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

    await prisma.product.update({
      where: { id },
      data: { isActive: false, variants: { updateMany: { where: {}, data: { isActive: false } } } },
    });

    await audit({
      ctx,
      action: 'delete',
      entityType: 'Product',
      entityId: id,
      entityLabel: before.name,
      before,
      metadata: { softDelete: true },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
