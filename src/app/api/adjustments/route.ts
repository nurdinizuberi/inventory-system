import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { resolveBackdate } from '@/lib/backdate';
import { prisma } from '@/lib/db';
import { assertLocationAccess, badRequest, guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { ADJUSTMENT_REASONS } from '@/lib/types';

const createSchema = z.object({
  variantId: z.string().min(1),
  locationId: z.string().min(1),
  reason: z.enum(ADJUSTMENT_REASONS),
  /** Negative = write-off, positive = found stock. */
  quantity: z.coerce.number().int().refine((n) => n !== 0, 'Quantity cannot be zero'),
  effectiveDate: z.string().optional(), // YYYY-MM-DD for backdating
  backdateReason: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'stock.view' });
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const scope = scopedLocationIds(ctx);

    const adjustments = await prisma.stockAdjustment.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(status ? { status } : {}),
        ...(scope ? { locationId: { in: scope } } : {}),
      },
      include: {
        variant: { include: { product: true } },
        location: true,
        createdBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return NextResponse.json({ adjustments });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * Raise an adjustment. It lands as `pending` and does NOT touch stock until a
 * manager approves it — that approval is what writes the ledger row.
 */
export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'stock.adjust' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    await assertLocationAccess(ctx, data.locationId);

    const variant = await prisma.variant.findFirst({
      where: { id: data.variantId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { product: true },
    });
    if (!variant) return badRequest('Variant not found');

    if (data.quantity > 0) {
      const foundReasons: string[] = ['count_correction', 'misplaced'];
      if (!foundReasons.includes(data.reason)) {
        return badRequest('Only count_correction or misplaced may add stock back');
      }
    }

    const existing = await prisma.stockAdjustment.count({ where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    const number = `ADJ-${String(existing + 1).padStart(4, '0')}`;

    const backdated = resolveBackdate(data.effectiveDate, data.backdateReason);
    if (backdated.error) return badRequest(backdated.error);

    const adjustment = await prisma.stockAdjustment.create({
      data: {
        tenantId: ctx.tenantId ?? null,
        number,
        variantId: data.variantId,
        locationId: data.locationId,
        reason: data.reason,
        quantity: data.quantity,
        notes: data.notes ?? null,
        status: 'pending',
        effectiveDate: backdated.effectiveDate,
        backdateReason: backdated.backdateReason,
        isBackdated: backdated.isBackdated,
        createdById: ctx.id,
      },
      include: { variant: { include: { product: true } }, location: true },
    });

    await audit({
      ctx,
      action: 'create',
      entityType: 'StockAdjustment',
      entityId: adjustment.id,
      entityLabel: number,
      after: {
        number,
        reason: data.reason,
        quantity: data.quantity,
        variant: `${variant.product.name} — ${variant.label}`,
        location: adjustment.location.name,
      },
      metadata: {
        status: 'pending',
        ...(backdated.isBackdated
          ? { effectiveDate: data.effectiveDate, backdateReason: data.backdateReason }
          : {}),
      },
    });

    return NextResponse.json({ adjustment }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
