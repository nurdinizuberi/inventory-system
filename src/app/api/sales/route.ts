import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { TX_OPTIONS, prisma } from '@/lib/db';
import { consumeFifo, InsufficientStockError } from '@/lib/fifo';
import { assertLocationAccess, badRequest, guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';
import { PAYMENT_METHODS } from '@/lib/types';
import { round2, withRetryNumber } from '@/lib/utils';

const lineSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.coerce.number().int().positive('Quantity must be a positive whole number'),
  /** Per-unit discount off the list selling price. */
  unitDiscount: z.coerce.number().min(0).default(0),
  /** Optional explicit price override (still bounded below by zero). */
  actualPrice: z.coerce.number().min(0).optional().nullable(),
});

const createSchema = z.object({
  locationId: z.string().min(1, 'Selling location is required'),
  customerName: z.string().optional().nullable(),
  customerPhone: z.string().optional().nullable(),
  paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
  amountPaid: z.coerce.number().min(0).optional().nullable(),
  effectiveDate: z.string().optional(), // YYYY-MM-DD for backdating
  backdateReason: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1, 'Add at least one item to the sale'),
});

export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'sale.view' });
    const url = new URL(request.url);
    const locationId = url.searchParams.get('locationId');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const status = url.searchParams.get('status') ?? 'completed';

    const scope = scopedLocationIds(ctx);
    const sales = await prisma.sale.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(status === 'all' ? {} : { status }),
        ...(locationId ? { locationId } : {}),
        ...(scope ? { locationId: { in: scope } } : {}),
        ...(from || to
          ? { soldAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
          : {}),
        // A cashier may only browse their own tickets.
        ...(ctx.role === 'CASHIER' ? { cashierId: ctx.id } : {}),
      },
      include: {
        location: true,
        cashier: { select: { id: true, name: true } },
        lines: { include: { variant: { include: { product: true } } } },
      },
      orderBy: { soldAt: 'desc' },
      take: 200,
    });

    return NextResponse.json({ sales });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * Complete a POS sale.
 *
 *  * location must have can_sell_pos = true AND be one the cashier is assigned to
 *  * requested quantity is checked against sellable stock (onHand - reserved)
 *    BEFORE anything is written; a short sale returns 409 with the shortfall
 *  * stock is consumed FIFO, oldest batch first, and the consumed cost becomes
 *    the line's cost of goods
 *  * profit per line = (actual price - FIFO cost) x quantity
 */
export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'sale.create' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    await assertLocationAccess(ctx, data.locationId, { canSellPos: true });

    const location = await prisma.location.findUnique({ where: { id: data.locationId } });
    if (!location) return badRequest('Location not found');

    const variants = await prisma.variant.findMany({
      where: { id: { in: data.lines.map((l) => l.variantId) }, isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { product: true },
    });
    const missing = data.lines.filter((l) => !variants.some((v) => v.id === l.variantId));
    if (missing.length) return badRequest(`Unknown variant id(s): ${missing.map((m) => m.variantId).join(', ')}`);

    // Pre-flight stock check so the cashier gets a clean error, not a
    // half-written transaction.
    const stock = await getStockMatrix(prisma, {
      locationIds: [data.locationId],
      variantIds: data.lines.map((l) => l.variantId),
    });
    const shortfalls = data.lines.flatMap((line) => {
      const variant = variants.find((v) => v.id === line.variantId)!;
      const row = stock.find((s) => s.variantId === line.variantId);
      const sellable = row?.sellable ?? 0;
      if (sellable >= line.quantity) return [];
      return [
        {
          variantId: line.variantId,
          variant: `${variant.product.name} — ${variant.label}`,
          requested: line.quantity,
          available: sellable,
          onHand: row?.onHand ?? 0,
          reserved: row?.reserved ?? 0,
        },
      ];
    });
    if (shortfalls.length) {
      const detail = shortfalls.map((s) => `${s.variant}: requested ${s.requested}, available ${s.available}`).join('; ');
      return NextResponse.json({ error: `Cannot complete sale — ${detail}`, details: shortfalls }, { status: 409 });
    }

    // Sale numbers are sequential (SLE-#####); two concurrent tickets can
    // compute the same candidate, so the create is retried on collision.
    const existing = await prisma.sale.count({ where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    const makeNumber = (attempt: number) => `SLE-${String(existing + 1 + attempt).padStart(5, '0')}`;
    const soldAt = new Date();

    // Backdating support
    const effectiveDate = data.effectiveDate ? new Date(data.effectiveDate) : soldAt;
    const isBackdated = effectiveDate < soldAt;

    const result = await withRetryNumber(makeNumber, async (number) => {
      let auditPayload: Record<string, unknown> | null = null;
      const updated = await prisma.$transaction(async (tx) => {
        const sale = await tx.sale.create({
          data: {
            tenantId: ctx.tenantId ?? null,
            number,
            locationId: data.locationId,
            cashierId: ctx.id,
            status: 'completed',
            customerName: data.customerName ?? null,
            customerPhone: data.customerPhone ?? null,
            paymentMethod: data.paymentMethod,
            soldAt,
            effectiveDate,
            backdateReason: data.backdateReason ?? null,
            isBackdated,
          },
        });

        let subtotal = 0;
        let discountTotal = 0;
        let totalCost = 0;

        for (const line of data.lines) {
          const variant = variants.find((v) => v.id === line.variantId)!;
          const unitPrice = variant.sellingPrice ?? variant.product.basePrice;
          const actualPrice = line.actualPrice ?? Math.max(0, unitPrice - line.unitDiscount);
          const lineTotal = round2(actualPrice * line.quantity);

          // FIFO: deduct from the oldest available batch first and capture its cost.
          const fifo = await consumeFifo(tx, {
            type: 'sale_out',
            tenantId: ctx.tenantId ?? null,
            variantId: variant.id,
            locationId: data.locationId,
            quantity: line.quantity,
            status: 'sold',
            referenceType: 'Sale',
            referenceId: sale.id,
            referenceLabel: number,
            createdById: ctx.id,
            variantLabel: `${variant.product.name} — ${variant.label}`,
            locationName: location.name,
            notes: `Sold at ${actualPrice.toLocaleString()} per unit`,
          });

          const lineCost = round2(fifo.totalCost);
          const discountAmount = round2((unitPrice - actualPrice) * line.quantity);
          subtotal += unitPrice * line.quantity;
          discountTotal += discountAmount;
          totalCost += lineCost;

          await tx.saleLine.create({
            data: {
              saleId: sale.id,
              variantId: variant.id,
              quantity: line.quantity,
              unitCost: round2(fifo.unitCost),
              unitPrice,
              discountAmount,
              actualPrice,
              lineTotal,
              lineCost,
              lineProfit: round2(lineTotal - lineCost),
            },
          });
        }

        const total = round2(subtotal - discountTotal);
        const amountPaid = data.amountPaid ?? total;
        const done = await tx.sale.update({
          where: { id: sale.id },
          data: {
            subtotal: round2(subtotal),
            discountAmount: round2(discountTotal),
            total,
            amountPaid: round2(amountPaid),
            changeDue: round2(Math.max(0, amountPaid - total)),
            totalCost: round2(totalCost),
            profit: round2(total - totalCost),
          },
          include: { lines: { include: { variant: { include: { product: true } } } }, location: true },
        });

        auditPayload = {
          number,
          total,
          totalCost: round2(totalCost),
          profit: round2(total - totalCost),
          lines: data.lines.length,
          location: location.name,
        };

        return done;
      }, TX_OPTIONS);

      if (auditPayload) {
        await audit({
          ctx,
          action: 'create',
          entityType: 'Sale',
          entityId: updated.id,
          entityLabel: number,
          after: auditPayload,
          metadata: {
            paymentMethod: data.paymentMethod,
            ...(isBackdated ? { effectiveDate: data.effectiveDate, backdateReason: data.backdateReason } : {}),
          },
        });
      }

      return updated;
    });

    return NextResponse.json({ sale: result }, { status: 201 });
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return jsonError(err);
  }
}
