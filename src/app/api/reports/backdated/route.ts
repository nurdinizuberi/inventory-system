import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError } from '@/lib/rbac';
import { daysAgo } from '@/lib/utils';

/**
 * Backdated entries report: all transactions where effectiveDate < createdAt,
 * across sales, purchases, transfers, adjustments, returns, and stock movements.
 * Restricted to admins.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'audit.view' });
    const url = new URL(request.url);
    const days = Math.min(Number(url.searchParams.get('days') ?? 30), 365);
    const since = daysAgo(days);

    const tenantFilter = ctx.tenantId ? { tenantId: ctx.tenantId } : {};
    const [backdatedSales, backdatedPurchases, backdatedTransfers, backdatedAdjustments, backdatedReturns, backdatedMovements] =
      await Promise.all([
      prisma.sale.findMany({
        where: { ...tenantFilter, isBackdated: true, createdAt: { gte: since } },
        select: {
          id: true,
          number: true,
          effectiveDate: true,
          backdateReason: true,
          createdAt: true,
          total: true,
          location: { select: { name: true } },
          cashier: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.purchase.findMany({
        where: { ...tenantFilter, isBackdated: true, createdAt: { gte: since } },
        select: {
          id: true,
          number: true,
          effectiveDate: true,
          backdateReason: true,
          createdAt: true,
          total: true,
          supplier: { select: { name: true } },
          location: { select: { name: true } },
          createdBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.stockTransfer.findMany({
        where: { ...tenantFilter, isBackdated: true, createdAt: { gte: since } },
        select: {
          id: true,
          number: true,
          effectiveDate: true,
          backdateReason: true,
          createdAt: true,
          fromLocation: { select: { name: true } },
          toLocation: { select: { name: true } },
          createdBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.stockAdjustment.findMany({
        where: { ...tenantFilter, isBackdated: true, createdAt: { gte: since } },
        select: {
          id: true,
          number: true,
          variantId: true,
          effectiveDate: true,
          backdateReason: true,
          createdAt: true,
          quantity: true,
          reason: true,
          variant: { select: { product: { select: { name: true } }, label: true } },
          location: { select: { name: true } },
          createdBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.return.findMany({
        where: { ...tenantFilter, isBackdated: true, createdAt: { gte: since } },
        select: {
          id: true,
          number: true,
          effectiveDate: true,
          backdateReason: true,
          createdAt: true,
          totalRefund: true,
          reason: true,
          location: { select: { name: true } },
          createdBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.stockMovement.findMany({
        where: { ...tenantFilter, isBackdated: true, createdAt: { gte: since } },
        select: {
          id: true,
          type: true,
          quantity: true,
          effectiveDate: true,
          backdateReason: true,
          createdAt: true,
          referenceLabel: true,
          variant: { select: { product: { select: { name: true } }, label: true } },
          location: { select: { name: true } },
          createdBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);

    // Combine into a unified list
    const entries = [
      ...backdatedSales.map((s) => ({
        type: 'Sale',
        number: s.number,
        effectiveDate: s.effectiveDate,
        backdateReason: s.backdateReason,
        enteredAt: s.createdAt,
        details: `${s.cashier.name} @ ${s.location.name}`,
        value: s.total,
      })),
      ...backdatedPurchases.map((p) => ({
        type: 'Purchase',
        number: p.number,
        effectiveDate: p.effectiveDate,
        backdateReason: p.backdateReason,
        enteredAt: p.createdAt,
        details: `${p.supplier.name} → ${p.location.name}`,
        value: p.total,
      })),
      ...backdatedTransfers.map((t) => ({
        type: 'Transfer',
        number: t.number,
        effectiveDate: t.effectiveDate,
        backdateReason: t.backdateReason,
        enteredAt: t.createdAt,
        details: `${t.fromLocation.name} → ${t.toLocation.name}`,
        value: null,
      })),
      ...backdatedAdjustments.map((a) => ({
        type: 'Adjustment',
        number: a.number,
        effectiveDate: a.effectiveDate,
        backdateReason: a.backdateReason,
        enteredAt: a.createdAt,
        details: `${a.variant?.product.name ?? a.variantId} — ${a.variant?.label ?? 'Unknown'} · ${a.quantity} @ ${a.location.name}`,
        value: null,
      })),
      ...backdatedReturns.map((r) => ({
        type: 'Return',
        number: r.number,
        effectiveDate: r.effectiveDate,
        backdateReason: r.backdateReason,
        enteredAt: r.createdAt,
        details: `${r.location.name} (${r.reason.replace(/_/g, ' ')})`,
        value: r.totalRefund,
      })),
      ...backdatedMovements.map((m) => ({
        type: 'Movement',
        number: m.referenceLabel ?? m.id.slice(0, 8),
        effectiveDate: m.effectiveDate,
        backdateReason: m.backdateReason,
        enteredAt: m.createdAt,
        details: `${m.variant.product.name} — ${m.variant.label} @ ${m.location.name}`,
        value: null,
      })),
    ].sort((a, b) => b.enteredAt.getTime() - a.enteredAt.getTime());

    return NextResponse.json({
      days,
      total: entries.length,
      entries,
    });
  } catch (err) {
    return jsonError(err);
  }
}
