import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { assertLocationAccess, badRequest, guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { endReservation, holdReservation, sellReservation } from '@/lib/reservation-service';
import { PAYMENT_METHODS } from '@/lib/types';
import { withRetryNumber } from '@/lib/utils';

const createSchema = z.object({
  variantId: z.string().min(1),
  locationId: z.string().min(1),
  quantity: z.coerce.number().int().positive(),
  customerRef: z.string().optional().nullable(),
});

const actionSchema = z.object({
  reservationId: z.string().min(1),
  action: z.enum(['release', 'fulfil']),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  amountPaid: z.coerce.number().min(0).optional(),
});

export async function GET() {
  try {
    const ctx = await guard({ action: 'reservation.manage' });
    const scope = scopedLocationIds(ctx);
    const reservations = await prisma.reservation.findMany({
      where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}), ...(scope ? { locationId: { in: scope } } : {}) },
      include: {
        variant: { include: { product: true } },
        location: true,
        createdBy: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return NextResponse.json({ reservations });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'reservation.manage' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    await assertLocationAccess(ctx, data.locationId);
    const variant = await prisma.variant.findFirst({
      where: { id: data.variantId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { product: true },
    });
    if (!variant) return badRequest('Variant not found');

    // A hold is taken so the units can be sold at the till, so the item must
    // actually have a selling price — reserving an unpriced item could otherwise
    // end up as a free sale when the hold is fulfilled.
    if (!((variant.sellingPrice ?? variant.product.basePrice) > 0)) {
      return badRequest(
        `${variant.product.name} — ${variant.label} has no selling price — set one before reserving it.`,
      );
    }

    const existing = await prisma.reservation.count({ where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    const makeNumber = (attempt: number) => `RSV-${String(existing + 1 + attempt).padStart(4, '0')}`;
    const number = await withRetryNumber(makeNumber, (n) =>
      prisma.reservation.create({
        data: {
          tenantId: ctx.tenantId ?? null,
          number: n,
          variantId: data.variantId,
          locationId: data.locationId,
          quantity: data.quantity,
          customerRef: data.customerRef ?? null,
          status: 'active',
          createdById: ctx.id,
        },
      }),
    );

    try {
      await holdReservation(
        {
          reservationId: number.id,
          number: number.number,
          variantId: data.variantId,
          locationId: data.locationId,
          quantity: data.quantity,
          customerRef: data.customerRef,
        },
        ctx,
      );
    } catch (err) {
      await prisma.reservation.delete({ where: { id: number.id } });
      const message = err instanceof Error ? err.message : 'Could not reserve stock';
      return NextResponse.json({ error: message }, { status: 409 });
    }

    await audit({
      ctx,
      action: 'create',
      entityType: 'Reservation',
      entityId: number.id,
      entityLabel: number.number,
      after: {
        variant: `${variant.product.name} — ${variant.label}`,
        quantity: data.quantity,
        customer: data.customerRef ?? null,
      },
    });

    return NextResponse.json({ reservation: number }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await guard({ action: 'reservation.manage' });
    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    // Fulfilling a hold sells the held units at the till — that needs the same
    // permission as ringing a normal sale.
    if (parsed.data.action === 'fulfil') await guard({ action: 'sale.create' });

    const reservation = await prisma.reservation.findFirst({ where: { id: parsed.data.reservationId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (!reservation) return NextResponse.json({ error: 'Reservation not found' }, { status: 404 });

    // Fulfilling a hold rings a sale at the item's list price — never allow that
    // to happen at 0 (e.g. an unpriced item that was held before being priced).
    if (parsed.data.action === 'fulfil') {
      const variant = await prisma.variant.findFirst({
        where: { id: reservation.variantId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
        include: { product: true },
      });
      if (!variant) return NextResponse.json({ error: 'Variant not found' }, { status: 404 });
      if (!((variant.sellingPrice ?? variant.product.basePrice) > 0)) {
        return badRequest(
          `${variant.product.name} — ${variant.label} has no selling price — set one before fulfilling the reservation.`,
        );
      }
    }

    if (parsed.data.action === 'release') {
      const updated = await endReservation(parsed.data.reservationId, ctx);
      await audit({
        ctx,
        action: 'cancel',
        entityType: 'Reservation',
        entityId: reservation.id,
        entityLabel: reservation.number,
        before: { status: reservation.status },
        after: { status: updated.status },
      });
      return NextResponse.json({ reservation: updated });
    }

    const outcome = await sellReservation(
      parsed.data.reservationId,
      { paymentMethod: parsed.data.paymentMethod, amountPaid: parsed.data.amountPaid },
      ctx,
    );

    await audit({
      ctx,
      action: 'complete',
      entityType: 'Reservation',
      entityId: reservation.id,
      entityLabel: reservation.number,
      before: { status: reservation.status },
      after: {
        status: outcome.reservation.status,
        saleNumber: outcome.sale.number,
        saleTotal: outcome.sale.total,
      },
    });

    return NextResponse.json({ reservation: outcome.reservation, sale: outcome.sale });
  } catch (err) {
    return jsonError(err);
  }
}
