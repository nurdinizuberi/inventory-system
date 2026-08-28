import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';

/**
 * Raw stock movement ledger with filters. This is the audit-grade view of
 * business events (distinct from /api/audit, which logs system activity).
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'stock.view' });
    const url = new URL(request.url);
    const locationId = url.searchParams.get('locationId');
    const variantId = url.searchParams.get('variantId');
    const type = url.searchParams.get('type');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const take = Math.min(Number(url.searchParams.get('take') ?? 200), 1000);

    const scope = scopedLocationIds(ctx);

    const movements = await prisma.stockMovement.findMany({
      where: {
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(type ? { type } : {}),
        ...(variantId ? { variantId } : {}),
        ...(locationId ? { locationId } : {}),
        ...(scope && !locationId ? { locationId: { in: scope } } : {}),
        ...(from || to
          ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
          : {}),
      },
      include: {
        variant: { include: { product: true } },
        location: true,
        batch: true,
        resultingBatch: true,
        createdBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    const stock = await getStockMatrix(prisma, {
      ...(scope ? { locationIds: scope } : {}),
      ...(variantId ? { variantIds: [variantId] } : {}),
      ...(locationId ? { locationIds: [locationId] } : {}),
    });

    return NextResponse.json({ movements, stock, total: movements.length });
  } catch (err) {
    return jsonError(err);
  }
}
