import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { nextExpenseNumber, sumPaidExpenses } from '@/lib/expense-service';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { EXPENSE_PAYMENT_METHODS, EXPENSE_STATUSES } from '@/lib/types';
import { resolveBackdate } from '@/lib/backdate';
import { round2 } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Expenses API. Expenses are operating expenses — never stock purchases — so
// they are intentionally NOT linked to StockMovement or Batch. Purchases feed
// COGS through the FIFO ledger; expenses hit the P&L directly, which keeps
// stock costs from being double-counted.
// ---------------------------------------------------------------------------

const RECEIPT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB as a data URL

const createSchema = z.object({
  categoryId: z.string().min(1),
  amount: z.coerce.number().positive('Amount must be greater than zero'),
  status: z.enum(EXPENSE_STATUSES).default('paid'),
  /** YYYY-MM-DD — the day the expense was incurred. */
  expenseDate: z.string().optional(),
  backdateReason: z.string().optional().nullable(),
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS).default('cash'),
  payee: z.string().trim().max(200).optional().nullable(),
  reference: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  receipt: z
    .object({
      name: z.string().max(255),
      type: z.string().max(100),
      /** Base64 payload (data URL prefix optional). */
      data: z.string().min(1),
    })
    .optional()
    .nullable(),
});

/** Decode + size-check an optional receipt before it goes anywhere near the DB. */
function normalizeReceipt(input: z.infer<typeof createSchema>['receipt']) {
  if (!input) return null;
  const base64 = input.data.includes(',') ? input.data.split(',')[1] : input.data;
  const bytes = Math.ceil((base64.length * 3) / 4);
  if (bytes > RECEIPT_MAX_BYTES) {
    throw new Error('Receipt must be smaller than 2 MB');
  }
  return { receiptName: input.name, receiptType: input.type, receiptData: `data:${input.type};base64,${base64}` };
}

export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'expense.view' });
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const categoryId = url.searchParams.get('categoryId');
    const paymentMethod = url.searchParams.get('paymentMethod');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const search = url.searchParams.get('q')?.trim();
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);

    const expenses = await prisma.expense.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(status ? { status } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(paymentMethod ? { paymentMethod } : {}),
        ...(from || to
          ? {
              expenseDate: {
                ...(from ? { gte: new Date(`${from}T00:00:00`) } : {}),
                ...(to ? { lte: new Date(`${to}T23:59:59.999`) } : {}),
              },
            }
          : {}),
        ...(search
          ? {
              OR: [
                { payee: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
                { reference: { contains: search, mode: 'insensitive' } },
                { number: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        category: true,
        createdBy: { select: { id: true, name: true } },
        updatedBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });

    // Totals for the filtered set: dashboard strip + table footer.
    const totalPaid = sumPaidExpenses(expenses);
    const totalAll = round2(expenses.reduce((s, e) => s + e.amount, 0));

    return NextResponse.json({
      expenses: expenses.map((e) => ({ ...e, hasReceipt: Boolean(e.receiptData && e.receiptData.length > 0) })),
      totals: { paid: totalPaid, all: totalAll, count: expenses.length },
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'expense.create' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    let receipt;
    try {
      receipt = normalizeReceipt(data.receipt);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : 'Invalid receipt');
    }

    const category = await prisma.expenseCategory.findFirst({
      where: { id: data.categoryId, isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
    });
    if (!category) return badRequest('Expense category not found');

    // Dated to the day incurred; past dates need a reason, like sales/purchases.
    const backdated = resolveBackdate(data.expenseDate, data.backdateReason);
    if (backdated.error) return badRequest(backdated.error);

    const last = await prisma.expense.findFirst({
      where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { number: true },
    });
    const number = nextExpenseNumber(last?.number);

    // Drafts sit outside the P&L until they are marked paid.
    const paidNow = data.status === 'paid';

    const expense = await prisma.expense.create({
      data: {
        tenantId: ctx.tenantId ?? null,
        number,
        categoryId: data.categoryId,
        amount: round2(data.amount),
        status: data.status,
        expenseDate: backdated.effectiveDate,
        backdateReason: backdated.backdateReason,
        isBackdated: backdated.isBackdated,
        paymentMethod: data.paymentMethod,
        payee: data.payee ?? null,
        reference: data.reference ?? null,
        description: data.description ?? null,
        notes: data.notes ?? null,
        ...(receipt ?? {}),
        createdById: ctx.id,
        ...(paidNow ? { approvedById: ctx.id, approvedAt: new Date() } : {}),
      },
      include: {
        category: true,
        createdBy: { select: { id: true, name: true } },
      },
    });

    await audit({
      ctx,
      action: 'create',
      entityType: 'Expense',
      entityId: expense.id,
      entityLabel: number,
      after: {
        number,
        amount: expense.amount,
        status: expense.status,
        category: category.name,
        payee: expense.payee,
        expenseDate: expense.expenseDate,
        paymentMethod: expense.paymentMethod,
        hasReceipt: Boolean(receipt),
      },
      metadata: backdated.isBackdated ? { backdateReason: backdated.backdateReason } : {},
    });

    return NextResponse.json({ expense }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
