import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';

const schema = z.object({ name: z.string().min(2), parentId: z.string().optional().nullable() });

export async function GET() {
  try {
    const ctx = await guard({ action: 'product.view' });
    const rows = await prisma.category.findMany({
      where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { _count: { select: { products: true } }, children: true, parent: true },
      orderBy: { name: 'asc' },
    });
    const categories = rows.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      parentId: c.parentId,
      productCount: c._count.products,
      children: c.children.map((ch) => ({ id: ch.id, name: ch.name })),
      parent: c.parent ? { id: c.parent.id, name: c.parent.name } : null,
    }));
    return NextResponse.json({ categories });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'product.create' });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const category = await prisma.category.create({
      data: {
        tenantId: ctx.tenantId ?? null,
        name: parsed.data.name.trim(),
        slug: parsed.data.name.trim().toLowerCase().replace(/\s+/g, '-'),
        parentId: parsed.data.parentId || null,
      },
    });

    await audit({
      ctx,
      action: 'create',
      entityType: 'Category',
      entityId: category.id,
      entityLabel: category.name,
      after: category,
    });

    return NextResponse.json({ category }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unique constraint')) {
      return badRequest('A category with that name already exists.');
    }
    return jsonError(err);
  }
}
