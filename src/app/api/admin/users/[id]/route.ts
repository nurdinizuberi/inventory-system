import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-auth';
import { jsonError } from '@/lib/rbac';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;

    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        tenant: { select: { id: true, name: true, slug: true, isActive: true } },
        roleRef: { select: { id: true, name: true, slug: true } },
        assignments: {
          include: { location: { select: { id: true, code: true, name: true, type: true, isActive: true } } },
          orderBy: { location: { name: 'asc' } },
        },
        _count: {
          select: {
            sales: true,
            purchasesCreated: true,
            transfersCreated: true,
            adjustments: true,
            auditLogs: true,
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        roleId: user.roleId,
        roleRef: user.roleRef,
        isActive: user.isActive,
        emailVerifiedAt: user.emailVerifiedAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        tenant: user.tenant,
        tenantId: user.tenantId,
        locations: user.assignments.map((a) => ({ ...a.location, assignmentId: a.id })),
        counts: {
          sales: user._count.sales,
          purchases: user._count.purchasesCreated,
          transfers: user._count.transfersCreated,
          adjustments: user._count.adjustments,
          auditLogs: user._count.auditLogs,
        },
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}