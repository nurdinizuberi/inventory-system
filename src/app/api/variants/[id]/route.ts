import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { getStockForVariant } from '@/lib/stock';

const updateSchema = z.object({
  label: z.string().min(1).optional(),
  attributes: z.record(z.string()).optional(),
  sku: z.string().min(1).optional(),
  barcode: z.string().min(1).optional(),
  costPrice: z.coerce.number().min(0).nullable().optional(),
  sellingPrice: z.coerce.number().min(0).nullable().optional(),
  lowStockThreshold: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
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

    const before = await prisma.variant.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (!before) return NextResponse.json({ error: 'Variant not found' }, { status: 404 });

    const data = parsed.data;
    const variant = await prisma.variant.update({
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

    await audit({
      ctx,
      action: 'update',
      entityType: 'Variant',
      entityId: id,
      entityLabel: `${variant.product.name} — ${variant.label}`,
      before,
      after: variant,
    });

    return NextResponse.json({ variant });
  } catch (err) {
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
