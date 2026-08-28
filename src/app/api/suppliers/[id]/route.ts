import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';

const schema = z.object({
  name: z.string().min(2).optional(),
  contactPerson: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  taxId: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'supplier.manage' });
    const { id } = await params;
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const before = await prisma.supplier.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (!before) return NextResponse.json({ error: 'Supplier not found' }, { status: 404 });

    const supplier = await prisma.supplier.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
        ...(parsed.data.contactPerson !== undefined ? { contactPerson: parsed.data.contactPerson } : {}),
        ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
        ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
        ...(parsed.data.taxId !== undefined ? { taxId: parsed.data.taxId } : {}),
        ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    });

    await audit({
      ctx,
      action: 'update',
      entityType: 'Supplier',
      entityId: id,
      entityLabel: supplier.name,
      before,
      after: supplier,
    });

    return NextResponse.json({ supplier });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'supplier.manage' });
    const { id } = await params;
    const before = await prisma.supplier.findFirst({ where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (!before) return NextResponse.json({ error: 'Supplier not found' }, { status: 404 });

    await prisma.supplier.update({ where: { id }, data: { isActive: false } });
    await audit({
      ctx,
      action: 'delete',
      entityType: 'Supplier',
      entityId: id,
      entityLabel: before.name,
      before,
      metadata: { softDelete: true },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
