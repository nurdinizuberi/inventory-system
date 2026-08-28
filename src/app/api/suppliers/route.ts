import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';

const schema = z.object({
  code: z.string().min(2).optional(),
  name: z.string().min(2),
  contactPerson: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  taxId: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
});

export async function GET() {
  try {
    const ctx = await guard({ action: 'supplier.view' });
    const suppliers = await prisma.supplier.findMany({
      where: { isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { _count: { select: { purchases: true } } },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json({ suppliers });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'supplier.manage' });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const data = parsed.data;
    const count = await prisma.supplier.count({ where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    const supplier = await prisma.supplier.create({
      data: {
        tenantId: ctx.tenantId ?? null,
        code: (data.code?.trim() || `SUP-${String(count + 1).padStart(3, '0')}`).toUpperCase(),
        name: data.name.trim(),
        contactPerson: data.contactPerson ?? null,
        email: data.email || null,
        phone: data.phone ?? null,
        taxId: data.taxId ?? null,
        address: data.address ?? null,
      },
    });

    await audit({
      ctx,
      action: 'create',
      entityType: 'Supplier',
      entityId: supplier.id,
      entityLabel: supplier.name,
      after: supplier,
    });

    return NextResponse.json({ supplier }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unique constraint')) {
      return badRequest('A supplier with that code already exists.');
    }
    return jsonError(err);
  }
}
