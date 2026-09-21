import { NextResponse } from 'next/server';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';

type Params = { params: Promise<{ id: string }> };

/** Archive a category. Categories with expenses recorded against them cannot be removed. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'expense.update' });
    const { id } = await params;
    const category = await prisma.expenseCategory.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { _count: { select: { expenses: true } } },
    });
    if (!category) return NextResponse.json({ error: 'Category not found' }, { status: 404 });
    if (category._count.expenses > 0) {
      return badRequest('This category has expenses recorded against it and cannot be deleted.');
    }
    const updated = await prisma.expenseCategory.update({
      where: { id },
      data: { isActive: false },
    });
    await audit({
      ctx,
      action: 'delete',
      entityType: 'ExpenseCategory',
      entityId: id,
      entityLabel: category.name,
      after: { isActive: false },
    });
    return NextResponse.json({ category: updated });
  } catch (err) {
    return jsonError(err);
  }
}
