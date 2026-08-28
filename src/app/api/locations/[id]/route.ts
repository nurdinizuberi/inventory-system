import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { LOCATION_TYPES } from '@/lib/types';

const schema = z.object({
  name: z.string().min(2).optional(),
  type: z.enum(LOCATION_TYPES).optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  canReceivePurchase: z.boolean().optional(),
  canSellPos: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'location.manage' });
    const { id } = await params;
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const before = await prisma.location.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (!before) return NextResponse.json({ error: 'Location not found' }, { status: 404 });

    const location = await prisma.location.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
        ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
        ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
        ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
        ...(parsed.data.canReceivePurchase !== undefined ? { canReceivePurchase: parsed.data.canReceivePurchase } : {}),
        ...(parsed.data.canSellPos !== undefined ? { canSellPos: parsed.data.canSellPos } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    });

    await audit({
      ctx,
      action: 'update',
      entityType: 'Location',
      entityId: id,
      entityLabel: `${location.code} · ${location.name}`,
      before,
      after: location,
    });

    return NextResponse.json({ location });
  } catch (err) {
    return jsonError(err);
  }
}
