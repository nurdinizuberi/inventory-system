import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';
import { LOCATION_TYPES } from '@/lib/types';

const schema = z.object({
  code: z.string().min(2).max(20),
  name: z.string().min(2),
  type: z.enum(LOCATION_TYPES),
  address: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  canReceivePurchase: z.boolean().optional(),
  canSellPos: z.boolean().optional(),
});

export async function GET() {
  try {
    const ctx = await guard({ action: 'location.view' });
    const locations = await prisma.location.findMany({
      where: { isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { users: { include: { user: { select: { id: true, name: true, email: true, role: true } } } } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });

    const stock = await getStockMatrix(prisma, { locationIds: locations.map((l) => l.id) });
    const byLocation = new Map<string, { units: number; variants: number }>();
    for (const row of stock) {
      const entry = byLocation.get(row.locationId) ?? { units: 0, variants: 0 };
      entry.units += row.onHand;
      if (row.onHand !== 0) entry.variants += 1;
      byLocation.set(row.locationId, entry);
    }

    return NextResponse.json({
      locations: locations.map((l) => ({
        ...l,
        users: l.users.map((u) => u.user),
        unitsOnHand: byLocation.get(l.id)?.units ?? 0,
        variantsWithStock: byLocation.get(l.id)?.variants ?? 0,
      })),
      scopedRole: ctx.role,
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'location.manage' });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const data = parsed.data;
    // Capability flags follow the location type unless explicitly overridden.
    // Warehouses AND retail stores receive purchases by default — a store can
    // take stock directly even when the tenant also has a warehouse. Turn the
    // flag off on the Locations page for a shop that should not take direct
    // deliveries.
    const canReceivePurchase =
      data.canReceivePurchase ?? (data.type === 'WAREHOUSE' || data.type === 'RETAIL_STORE');
    const canSellPos = data.canSellPos ?? data.type === 'RETAIL_STORE';

    const location = await prisma.location.create({
      data: {
        tenantId: ctx.tenantId ?? null,
        code: data.code.trim().toUpperCase(),
        name: data.name.trim(),
        type: data.type,
        address: data.address ?? null,
        phone: data.phone ?? null,
        canReceivePurchase,
        canSellPos,
        isDamagedLocation: data.type === 'DAMAGED',
      },
    });

    await audit({
      ctx,
      action: 'create',
      entityType: 'Location',
      entityId: location.id,
      entityLabel: `${location.code} · ${location.name}`,
      after: location,
    });

    return NextResponse.json({ location }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unique constraint')) {
      return badRequest('A location with that code already exists.');
    }
    return jsonError(err);
  }
}
