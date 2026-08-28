import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { assertLocationAccess, badRequest, guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';
import { withRetryNumber } from '@/lib/utils';

const lineSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.coerce.number().int().positive('Quantity must be a positive whole number'),
});

const createSchema = z.object({
  fromLocationId: z.string().min(1, 'Source location is required'),
  toLocationId: z.string().min(1, 'Destination location is required'),
  effectiveDate: z.string().optional(),
  backdateReason: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1, 'At least one line item is required'),
});

export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'transfer.view' });
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const scope = scopedLocationIds(ctx);

    const transfers = await prisma.stockTransfer.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(status ? { status } : {}),
        ...(scope ? { OR: [{ fromLocationId: { in: scope } }, { toLocationId: { in: scope } }] } : {}),
      },
      include: {
        fromLocation: true,
        toLocation: true,
        createdBy: { select: { id: true, name: true } },
        lines: { include: { variant: { include: { product: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return NextResponse.json({ transfers });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'transfer.create' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    if (data.fromLocationId === data.toLocationId) {
      return badRequest('Source and destination must be different locations');
    }

    // You may only ship FROM a location you are assigned to. The destination is
    // not scope-checked here — the receiving side is checked when it accepts the
    // transfer (transfer.complete), which is the point where ownership matters.
    await assertLocationAccess(ctx, data.fromLocationId);
    const destination = await prisma.location.findFirst({ where: { id: data.toLocationId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (!destination || !destination.isActive) return badRequest('Destination location not found');
    if (destination.isDamagedLocation) return badRequest('Stock cannot be transferred into the write-off location');

    const variants = await prisma.variant.findMany({
      where: { id: { in: data.lines.map((l) => l.variantId) }, isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { product: true },
    });
    const missing = data.lines.filter((l) => !variants.some((v) => v.id === l.variantId));
    if (missing.length) return badRequest(`Unknown variant id(s): ${missing.map((m) => m.variantId).join(', ')}`);

    // Warn early (the real check happens inside the ship transaction).
    const stock = await getStockMatrix(prisma, {
      locationIds: [data.fromLocationId],
      variantIds: data.lines.map((l) => l.variantId),
    });
    const shortfalls = data.lines
      .map((line) => {
        const row = stock.find((s) => s.variantId === line.variantId);
        const available = row?.sellable ?? 0;
        return available < line.quantity
          ? {
              variantId: line.variantId,
              variant: variants.find((v) => v.id === line.variantId),
              requested: line.quantity,
              available,
            }
          : null;
      })
      .filter(Boolean) as { variantId: string; variant: { product: { name: string }; label: string }; requested: number; available: number }[];

    if (shortfalls.length) {
      const detail = shortfalls
        .map((s) => `${s.variant.product.name} (${s.variant.label}): requested ${s.requested}, available ${s.available}`)
        .join('; ');
      return NextResponse.json(
        { error: `Insufficient stock at the source location — ${detail}`, details: shortfalls },
        { status: 409 },
      );
    }

    const existing = await prisma.stockTransfer.count({ where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    const makeNumber = (attempt: number) => `TR-${String(existing + 1 + attempt).padStart(4, '0')}`;

    const effectiveDate = data.effectiveDate ? new Date(data.effectiveDate) : new Date();
    const isBackdated = effectiveDate < new Date();

    const transfer = await withRetryNumber(makeNumber, (number) =>
      prisma.stockTransfer.create({
        data: {
          tenantId: ctx.tenantId ?? null,
          number,
          fromLocationId: data.fromLocationId,
          toLocationId: data.toLocationId,
          status: 'pending',
          effectiveDate,
          backdateReason: data.backdateReason ?? null,
          isBackdated,
          notes: data.notes ?? null,
          createdById: ctx.id,
          lines: { create: data.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) },
        },
        include: {
          fromLocation: true,
          toLocation: true,
          lines: { include: { variant: { include: { product: true } } } },
        },
      }),
    );

    await audit({
      ctx,
      action: 'create',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      entityLabel: transfer.number,
      after: { ...transfer, lines: transfer.lines.length },
      metadata: {
        from: transfer.fromLocation.name,
        to: transfer.toLocation.name,
        status: 'pending',
        ...(isBackdated ? { effectiveDate: data.effectiveDate, backdateReason: data.backdateReason } : {}),
      },
    });

    return NextResponse.json({ transfer }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
