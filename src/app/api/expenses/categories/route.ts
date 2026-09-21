import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';

const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
});

export async function GET() {
  try {
    const ctx = await guard({ action: 'expense.view' });
    const categories = await prisma.expenseCategory.findMany({
      where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json({ categories });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'expense.create' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const name = parsed.data.name;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `cat-${Date.now()}`;

    const existing = await prisma.expenseCategory.findFirst({
      where: { slug, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
    });
    if (existing) {
      if (existing.isActive) return badRequest(`Category "${existing.name}" already exists`);
      // Reactivate a previously archived category with the same name.
      const restored = await prisma.expenseCategory.update({
        where: { id: existing.id },
        data: { isActive: true, name },
      });
      return NextResponse.json({ category: restored }, { status: 201 });
    }

    const category = await prisma.expenseCategory.create({
      data: { tenantId: ctx.tenantId ?? null, name, slug },
    });
    await audit({
      ctx,
      action: 'create',
      entityType: 'ExpenseCategory',
      entityId: category.id,
      entityLabel: name,
      after: { name },
    });
    return NextResponse.json({ category }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
