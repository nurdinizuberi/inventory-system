import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { resolveBackdate } from '@/lib/backdate';
import { prisma } from '@/lib/db';
import { assertLocationAccess, badRequest, guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { approvePurchase } from '@/lib/purchase-service';
import { round2, withRetryNumber } from '@/lib/utils';

const lineSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.coerce.number().int().positive('Quantity must be a positive whole number'),
  unitCost: z.coerce.number().min(0),
  expiresAt: z.string().optional().nullable(),
});

const createSchema = z.object({
  supplierId: z.string().min(1, 'Supplier is required'),
  locationId: z.string().min(1, 'Receiving location is required'),
  orderDate: z.string().optional(),
  expectedDate: z.string().optional().nullable(),
  effectiveDate: z.string().optional(),
  backdateReason: z.string().optional().nullable(),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  notes: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1, 'At least one line item is required'),
  confirmImmediately: z.boolean().default(false),
});

export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'purchase.view' });
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const supplierId = url.searchParams.get('supplierId');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    const scope = scopedLocationIds(ctx);
    const purchases = await prisma.purchase.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(status ? { status } : {}),
        ...(supplierId ? { supplierId } : {}),
        ...(scope ? { locationId: { in: scope } } : {}),
        ...(from || to
          ? { effectiveDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
          : {}),
      },
      include: {
        supplier: true,
        location: true,
        createdBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
        lines: { include: { variant: { include: { product: true } }, batches: true } },
      },
      orderBy: { effectiveDate: 'desc' },
      take: 200,
    });

    return NextResponse.json({ purchases });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * Create a purchase order against a receiving location — any warehouse or
 * retail store with the “can receive purchases” flag (stores have it on by
 * default, so stock can be ordered straight into the shop).
 * `confirmImmediately` approves the order (draft → confirmed) without touching
 * stock; the goods are received separately, per line, as they arrive.
 */
export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'purchase.create' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    // Server-side capability check: the location must be flagged to receive
    // purchases. Warehouses and retail stores are flagged by default on
    // creation, so this lets stock land in a warehouse or straight into a
    // store regardless of which was set up first.
    await assertLocationAccess(ctx, data.locationId, { canReceivePurchase: true });

    const supplier = await prisma.supplier.findFirst({ where: { id: data.supplierId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (!supplier || !supplier.isActive) return badRequest('Supplier not found or inactive');

    const variantIds = data.lines.map((l) => l.variantId);
    const variants = await prisma.variant.findMany({ where: { id: { in: variantIds }, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    const missing = variantIds.filter((id) => !variants.some((v) => v.id === id));
    if (missing.length) return badRequest(`Unknown variant id(s): ${missing.join(', ')}`);

    const subtotal = data.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
    const taxAmount = round2((subtotal * data.taxRate) / 100);

    const existing = await prisma.purchase.count({ where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    const makeNumber = (attempt: number) => `PO-${String(existing + 1 + attempt).padStart(4, '0')}`;

    const backdated = resolveBackdate(data.effectiveDate, data.backdateReason);
    if (backdated.error) return badRequest(backdated.error);
    const effectiveDate = backdated.effectiveDate;
    const isBackdated = backdated.isBackdated;

    const purchase = await withRetryNumber(makeNumber, (number) =>
      prisma.purchase.create({
        data: {
          tenantId: ctx.tenantId ?? null,
          number,
          supplierId: supplier.id,
          locationId: data.locationId,
          status: 'draft',
          orderDate: data.orderDate ? new Date(data.orderDate) : new Date(),
          expectedDate: data.expectedDate ? new Date(data.expectedDate) : null,
          effectiveDate,
          backdateReason: data.backdateReason ?? null,
          isBackdated,
          total: round2(subtotal + taxAmount),
          taxAmount,
          notes: data.notes ?? null,
          createdById: ctx.id,
          lines: {
            create: data.lines.map((l) => ({
              variantId: l.variantId,
              quantity: l.quantity,
              unitCost: l.unitCost,
              lineTotal: round2(l.quantity * l.unitCost),
              expiresAt: l.expiresAt ? new Date(l.expiresAt) : null,
            })),
          },
        },
        include: { lines: true, supplier: true, location: true },
      }),
    );

    await audit({
      ctx,
      action: 'create',
      entityType: 'Purchase',
      entityId: purchase.id,
      entityLabel: purchase.number,
      after: { ...purchase, lines: purchase.lines.length },
      metadata: {
        status: 'draft',
        supplier: supplier.name,
        location: purchase.location.name,
        ...(isBackdated ? { effectiveDate: data.effectiveDate, backdateReason: data.backdateReason } : {}),
      },
    });

    if (!data.confirmImmediately) return NextResponse.json({ purchase }, { status: 201 });

    const approved = await approvePurchase(purchase.id, ctx);
    return NextResponse.json({ purchase: approved }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
