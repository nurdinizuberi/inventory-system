import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  parentId: z.string().nullable().optional(),
});

type Params = { params: Promise<{ id: string }> };

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'product.update' });
    const { id } = await params;
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const before = await prisma.category.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { _count: { select: { products: true } } },
    });
    if (!before) return NextResponse.json({ error: 'Category not found' }, { status: 404 });

    const data = parsed.data;
    const category = await prisma.category.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.name !== undefined ? { slug: slugify(data.name) } : {}),
        ...(data.parentId !== undefined ? { parentId: data.parentId || null } : {}),
      },
    });

    await audit({
      ctx,
      action: 'update',
      entityType: 'Category',
      entityId: id,
      entityLabel: category.name,
      before,
      after: category,
    });

    return NextResponse.json({ category });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unique constraint')) {
      return badRequest('A category with that name already exists.');
    }
    return jsonError(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'product.delete' });
    const { id } = await params;
    const category = await prisma.category.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { _count: { select: { products: true } } },
    });
    if (!category) return NextResponse.json({ error: 'Category not found' }, { status: 404 });

    if (category._count.products > 0) {
      return badRequest(
        `Cannot delete "${category.name}": ${category._count.products} product(s) still use it. Reassign or archive those products first.`,
      );
    }

    await prisma.category.delete({ where: { id } });
    await audit({
      ctx,
      action: 'delete',
      entityType: 'Category',
      entityId: id,
      entityLabel: category.name,
      before: category,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
