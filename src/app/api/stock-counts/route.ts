import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { assertLocationAccess, badRequest, guard, jsonError, scopedLocationIds } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';

/**
 * Shelf stock counting. GET is the count sheet: on-hand per variant at one
 * location (from the ledger) plus any count corrections still pending review.
 * POST compares the entered counted quantity against on-hand and raises one
 * `count_correction` adjustment per mismatch — those flow through the normal
 * pending → manager-approval pipeline and only touch stock once approved.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'stock.adjust' });
    const url = new URL(request.url);
    const locationId = url.searchParams.get('locationId');

    const scope = scopedLocationIds(ctx);
    const where = { isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}), ...(scope ? { id: { in: scope } } : {}) };

    const locations = await prisma.location.findMany({
      where: { ...where, type: { not: 'DAMAGED' } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });

    let sheet: {
      variantId: string;
      productName: string;
      category: string | null;
      variantLabel: string;
      sku: string;
      barcode: string | null;
      onHand: number;
      reserved: number;
    }[] = [];
    let pending: Awaited<ReturnType<typeof prisma.stockAdjustment.findMany>> = [];
    if (locations.length > 0 && locationId) {
      const variants = await prisma.variant.findMany({
        where: { isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
        include: { product: { include: { category: true } } },
        orderBy: [{ product: { name: 'asc' } }, { label: 'asc' }],
      });
      const matrix = await getStockMatrix(prisma, {
        variantIds: variants.map((v) => v.id),
        locationIds: [locationId],
      });
      const byVariant = new Map(matrix.map((row) => [row.variantId, row]));
      sheet = variants
        .map((variant) => {
          const row = byVariant.get(variant.id);
          return {
            variantId: variant.id,
            productName: variant.product.name,
            category: variant.product.category?.name ?? null,
            variantLabel: variant.label,
            sku: variant.sku,
            barcode: variant.barcode,
            onHand: row?.onHand ?? 0,
            reserved: row?.reserved ?? 0,
          };
        })
        .filter((row) => row.onHand > 0 || row.reserved > 0);

      pending = await prisma.stockAdjustment.findMany({
        where: {
          locationId,
          reason: 'count_correction',
          status: 'pending',
          ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        },
        include: { variant: { include: { product: true } }, createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      });
    }

    return NextResponse.json({ locations, sheet, pending });
  } catch (err) {
    return jsonError(err);
  }
}

const entrySchema = z.object({
  variantId: z.string().min(1),
  counted: z.coerce.number().int().min(0),
  notes: z.string().optional().nullable(),
});
const submitSchema = z.object({
  locationId: z.string().min(1),
  entries: z.array(entrySchema),
});

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'stock.adjust' });
    const parsed = submitSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const { locationId, entries } = parsed.data;
    if (entries.length === 0) return badRequest('Nothing to count — enter at least one quantity');

    await assertLocationAccess(ctx, locationId);

    const [location, variants] = await Promise.all([
      prisma.location.findFirst({ where: { id: locationId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } }),
      prisma.variant.findMany({
        where: { id: { in: entries.map((e) => e.variantId) }, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
        include: { product: true },
      }),
    ]);
    if (!location) return badRequest('Location not found');

    const matrix = await getStockMatrix(prisma, {
      variantIds: entries.map((e) => e.variantId),
      locationIds: [locationId],
    });
    const onHandByVariant = new Map(matrix.map((row) => [row.variantId, row.onHand]));

    // Reject pairs that already have a pending count correction, so a sheet
    // being reviewed is not silently overwritten by a second count.
    const pendingCounts = await prisma.stockAdjustment.findMany({
      where: {
        locationId,
        reason: 'count_correction',
        status: 'pending',
        variantId: { in: entries.map((e) => e.variantId) },
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      },
      select: { variantId: true },
    });
    const blocked = new Set(pendingCounts.map((a) => a.variantId));

    const variantIds = new Set(variants.map((v) => v.id));
    const existing = await prisma.stockAdjustment.count({ where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });

    const diffs: { variant: (typeof variants)[number]; onHand: number; counted: number; notes: string | null; quantity: number }[] = [];
    for (const entry of entries) {
      if (!variantIds.has(entry.variantId)) return badRequest('Variant not found');
      const onHand = onHandByVariant.get(entry.variantId) ?? 0;
      const quantity = entry.counted - onHand;
      const variant = variants.find((v) => v.id === entry.variantId)!;
      if (quantity === 0) continue;
      if (blocked.has(entry.variantId)) {
        return badRequest(`A count correction for ${variant.product?.name ?? variant.label} is already pending review — approve or reject it before counting again`);
      }
      diffs.push({ variant, onHand, counted: entry.counted, notes: entry.notes ?? null, quantity });
    }

    if (diffs.length === 0) return badRequest('Count matches the ledger — no corrections needed');

    const created = await prisma.$transaction(
      diffs.map((diff, index) =>
        prisma.stockAdjustment.create({
          data: {
            tenantId: ctx.tenantId ?? null,
            number: `ADJ-${String(existing + index + 1).padStart(4, '0')}`,
            variantId: diff.variant.id,
            locationId,
            reason: 'count_correction',
            quantity: diff.quantity,
            notes: diff.notes,
            status: 'pending',
            createdById: ctx.id,
          },
        }),
      ),
    );

    await audit({
      ctx,
      action: 'create',
      entityType: 'StockCount',
      entityId: locationId,
      entityLabel: `Stock count @ ${location.name}`,
      after: {
        location: location.name,
        lines: diffs.map((d) => ({
          variant: d.variant.label,
          onHand: d.onHand,
          counted: d.counted,
          correction: d.quantity,
          notes: d.notes ?? null,
        })),
      },
      metadata: { status: 'pending', pendingAdjustments: created.length },
    });

    return NextResponse.json({ created: created.length, adjustments: created }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}