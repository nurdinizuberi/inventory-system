import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { daysAgo, round2 } from '@/lib/utils';

/** Transfer history: what moved between which locations and when. */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'report.transfers' });
    const url = new URL(request.url);
    const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')!) : daysAgo(90);
    const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : new Date();
    to.setHours(23, 59, 59, 999);

    const includeBackdated = url.searchParams.get('includeBackdated') === '1';
    const scope = scopedLocationIds(ctx);
    const transfers = await prisma.stockTransfer.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        effectiveDate: { gte: from, lte: to },
        ...(scope ? { OR: [{ fromLocationId: { in: scope } }, { toLocationId: { in: scope } }] } : {}),
        ...(!includeBackdated ? { isBackdated: false } : {}),
      },
      include: {
        fromLocation: true,
        toLocation: true,
        createdBy: { select: { id: true, name: true } },
        lines: { include: { variant: { include: { product: true } } } },
      },
      orderBy: { effectiveDate: 'desc' },
    });

    // Value moved is taken from the ledger rows, not from a hand-kept total.
    const movements = await prisma.stockMovement.findMany({
      where: {
        type: 'transfer_out',
        referenceType: 'StockTransfer',
        referenceId: { in: transfers.map((t) => t.id) },
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      },
      select: { referenceId: true, totalCost: true, quantity: true },
    });
    const valueByTransfer = new Map<string, { units: number; value: number }>();
    for (const m of movements) {
      if (!m.referenceId) continue;
      const entry = valueByTransfer.get(m.referenceId) ?? { units: 0, value: 0 };
      entry.units += Math.abs(m.quantity);
      entry.value += Math.abs(m.totalCost ?? 0);
      valueByTransfer.set(m.referenceId, entry);
    }

    const byLane = new Map<string, { lane: string; transfers: number; units: number; value: number }>();
    for (const t of transfers) {
      const lane = `${t.fromLocation.name} → ${t.toLocation.name}`;
      const entry = byLane.get(lane) ?? { lane, transfers: 0, units: 0, value: 0 };
      entry.transfers += 1;
      const moved = valueByTransfer.get(t.id);
      if (moved) {
        entry.units += moved.units;
        entry.value += moved.value;
      }
      byLane.set(lane, entry);
    }
    for (const lane of byLane.values()) lane.value = round2(lane.value);

    return NextResponse.json({
      from,
      to,
      transfers: transfers.map((t) => {
        const moved = valueByTransfer.get(t.id);
        return {
          id: t.id,
          number: t.number,
          status: t.status,
          from: t.fromLocation.name,
          to: t.toLocation.name,
          effectiveDate: t.effectiveDate,
          shippedAt: t.shippedAt,
          completedAt: t.completedAt,
          createdBy: t.createdBy?.name ?? '—',
          units: moved?.units ?? 0,
          value: round2(moved?.value ?? 0),
          lines: t.lines.map((l) => ({
            variant: `${l.variant.product.name} — ${l.variant.label}`,
            quantity: l.quantity,
            receivedQty: l.receivedQty,
          })),
        };
      }),
      byLane: [...byLane.values()].sort((a, b) => b.value - a.value),
      totals: {
        transfers: transfers.length,
        pending: transfers.filter((t) => t.status === 'pending').length,
        inTransit: transfers.filter((t) => t.status === 'in_transit').length,
        completed: transfers.filter((t) => t.status === 'completed').length,
        value: round2([...byLane.values()].reduce((s, l) => s + l.value, 0)),
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
