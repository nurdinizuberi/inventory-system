import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { EXPENSE_PAYMENT_METHODS, EXPENSE_STATUSES } from '@/lib/types';
import { resolveBackdate } from '@/lib/backdate';
import { round2 } from '@/lib/utils';

type Params = { params: Promise<{ id: string }> };

const RECEIPT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB as a data URL

const updateSchema = z.object({
  categoryId: z.string().min(1).optional(),
  amount: z.coerce.number().positive('Amount must be greater than zero').optional(),
  status: z.enum(EXPENSE_STATUSES).optional(),
  expenseDate: z.string().optional(),
  backdateReason: z.string().optional().nullable(),
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS).optional(),
  payee: z.string().trim().max(200).optional().nullable(),
  reference: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  receipt: z
    .object({
      name: z.string().max(255),
      type: z.string().max(100),
      data: z.string().min(1),
    })
    .optional()
    .nullable(),
});

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'expense.view' });
    const { id } = await params;
    const expense = await prisma.expense.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: {
        category: true,
        createdBy: { select: { id: true, name: true } },
        updatedBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
    });
    if (!expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
    return NextResponse.json({
      expense: { ...expense, hasReceipt: Boolean(expense.receiptData) },
      receipt: expense.receiptData
        ? { name: expense.receiptName, type: expense.receiptType, data: expense.receiptData }
        : null,
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'expense.update' });
    const { id } = await params;
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    const existing = await prisma.expense.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
    });
    if (!existing) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
    if (existing.status === 'cancelled') {
      return badRequest('Cancelled expenses cannot be edited. Void it back to draft first (see audit history).');
    }

    if (data.categoryId) {
      const category = await prisma.expenseCategory.findFirst({
        where: { id: data.categoryId, isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      });
      if (!category) return badRequest('Expense category not found');
    }

    // Re-check backdating whenever the date moves to a past day.
    let expenseDate = existing.expenseDate;
    let backdateReason = existing.backdateReason;
    let isBackdated = existing.isBackdated;
    if (data.expenseDate) {
      const backdated = resolveBackdate(data.expenseDate, data.backdateReason ?? existing.backdateReason);
      if (backdated.error) return badRequest(backdated.error);
      expenseDate = backdated.effectiveDate;
      backdateReason = backdated.backdateReason;
      isBackdated = backdated.isBackdated;
    }

    let receipt: { receiptName: string; receiptType: string; receiptData: string } | null | undefined;
    if (data.receipt !== undefined) {
      if (data.receipt === null) {
        receipt = null;
      } else {
        const base64 = data.receipt.data.includes(',') ? data.receipt.data.split(',')[1] : data.receipt.data;
        const bytes = Math.ceil((base64.length * 3) / 4);
        if (bytes > RECEIPT_MAX_BYTES) return badRequest('Receipt must be smaller than 2 MB');
        receipt = {
          receiptName: data.receipt.name,
          receiptType: data.receipt.type,
          receiptData: `data:${data.receipt.type};base64,${base64}`,
        };
      }
    }

    const before = { ...existing };
    const updated = await prisma.expense.update({
      where: { id },
      data: {
        ...(data.categoryId ? { categoryId: data.categoryId } : {}),
        ...(data.amount !== undefined ? { amount: round2(data.amount) } : {}),
        ...(data.status ? { status: data.status } : {}),
        ...(data.expenseDate ? { expenseDate, backdateReason, isBackdated } : {}),
        ...(data.paymentMethod ? { paymentMethod: data.paymentMethod } : {}),
        ...(data.payee !== undefined ? { payee: data.payee } : {}),
        ...(data.reference !== undefined ? { reference: data.reference } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(receipt === null
          ? { receiptName: null, receiptType: null, receiptData: null }
          : receipt
            ? receipt
            : {}),
        updatedById: ctx.id,
        // First transition into `paid` stamps the approver; later re-approvals
        // refresh it so the audit trail shows who last certified payment.
        ...(data.status === 'paid' && existing.status !== 'paid'
          ? { approvedById: ctx.id, approvedAt: new Date() }
          : {}),
      },
      include: {
        category: true,
        createdBy: { select: { id: true, name: true } },
        updatedBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
    });

    await audit({
      ctx,
      action: 'update',
      entityType: 'Expense',
      entityId: id,
      entityLabel: existing.number,
      before,
      after: updated,
      metadata: data.expenseDate && isBackdated ? { backdateReason } : {},
    });

    return NextResponse.json({ expense: { ...updated, hasReceipt: Boolean(updated.receiptData) } });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * Expenses are never hard-deleted: they are voided to `cancelled` so the
 * numbering stays gapless and the audit history survives. `?hard=1` (ADMIN
 * only) does a real delete for data-entry mistakes.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'expense.delete' });
    const { id } = await params;
    const hard = new URL(request.url).searchParams.get('hard') === '1';

    const existing = await prisma.expense.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { category: true },
    });
    if (!existing) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });

    if (hard) {
      if (ctx.role !== 'ADMIN') return NextResponse.json({ error: 'Only admins can hard-delete expenses' }, { status: 403 });
      await prisma.expense.delete({ where: { id } });
      await audit({
        ctx,
        action: 'delete',
        entityType: 'Expense',
        entityId: id,
        entityLabel: existing.number,
        before: existing,
      });
      return NextResponse.json({ deleted: true });
    }

    if (existing.status === 'cancelled') return badRequest('Expense is already cancelled');
    const cancelled = await prisma.expense.update({
      where: { id },
      data: { status: 'cancelled', updatedById: ctx.id },
      include: { category: true },
    });
    await audit({
      ctx,
      action: 'cancel',
      entityType: 'Expense',
      entityId: id,
      entityLabel: existing.number,
      before: { status: existing.status, amount: existing.amount },
      after: { status: 'cancelled' },
    });
    return NextResponse.json({ expense: cancelled });
  } catch (err) {
    return jsonError(err);
  }
}
