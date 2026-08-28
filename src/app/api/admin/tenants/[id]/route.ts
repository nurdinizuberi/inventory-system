import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-auth';
import { badRequest, jsonError } from '@/lib/rbac';

type Params = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  isActive: z.boolean().optional(),
});

export async function GET(_request: Request, { params }: Params) {
  try {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const tenant = await prisma.tenant.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            locations: true,
            products: true,
            sales: true,
            purchases: true,
            stockTransfers: true,
          },
        },
        users: {
          select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
        locations: {
          select: { id: true, code: true, name: true, type: true, isActive: true },
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    return NextResponse.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        isActive: tenant.isActive,
        createdAt: tenant.createdAt,
        updatedAt: tenant.updatedAt,
        counts: {
          users: tenant._count.users,
          locations: tenant._count.locations,
          products: tenant._count.products,
          sales: tenant._count.sales,
          purchases: tenant._count.purchases,
          transfers: tenant._count.stockTransfers,
        },
        users: tenant.users,
        locations: tenant.locations,
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    }

    const existing = await prisma.tenant.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    const data = parsed.data;
    const tenant = await prisma.tenant.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    return NextResponse.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        isActive: tenant.isActive,
        updatedAt: tenant.updatedAt,
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const existing = await prisma.tenant.findUnique({
      where: { id },
      include: { _count: { select: { sales: true, users: true } } },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Soft delete — deactivate instead of hard delete
    const tenant = await prisma.tenant.update({
      where: { id },
      data: { isActive: false },
    });

    return NextResponse.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        isActive: tenant.isActive,
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
