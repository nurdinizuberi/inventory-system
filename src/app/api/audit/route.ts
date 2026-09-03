import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guard, jsonError } from '@/lib/rbac';

/**
 * System activity log. Read-only: this endpoint only ever performs a SELECT.
 * There is deliberately no POST/PATCH/DELETE for audit entries anywhere in the
 * app — the log is append-only through src/lib/audit.ts.
 */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'audit.view' });
    const url = new URL(request.url);
    const entityType = url.searchParams.get('entityType');
    const action = url.searchParams.get('action');
    const userId = url.searchParams.get('userId') || undefined;
    const q = url.searchParams.get('q')?.trim();
    const take = Math.min(Number(url.searchParams.get('take') ?? 150), 500);

    // Every organization only ever sees its own audit entries. Entries are
    // stamped with tenantId on write (src/lib/audit.ts); scoping the read here
    // keeps tenants fully isolated — never expose another org's activity.
    const tenantWhere = ctx.tenantId ? { tenantId: ctx.tenantId } : {};
    const where = {
      ...tenantWhere,
      ...(entityType ? { entityType } : {}),
      ...(action ? { action } : {}),
      ...(userId ? { userId } : {}),
      ...(q
        ? {
            OR: [
              { entityLabel: { contains: q } },
              { userEmail: { contains: q } },
              { entityId: { contains: q } },
            ],
          }
        : {}),
    };

    const [logs, entityTypes, actions, total, userGroups] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take,
      }),

      prisma.auditLog.groupBy({ by: ['entityType'], _count: true, where: tenantWhere }),

      prisma.auditLog.groupBy({ by: ['action'], _count: true, where: tenantWhere }),

      prisma.auditLog.count({ where: tenantWhere }),

      // Distinct users who have activity in this tenant's log, so the page can
      // offer a user filter without needing the (Admin-only) user.view action.
      prisma.auditLog.groupBy({ by: ['userId', 'userEmail'], _count: true, where: tenantWhere }),
    ]);

    const users = userGroups
      .filter((u) => u.userId)
      .map((u) => ({ id: u.userId as string, email: u.userEmail ?? '', count: u._count }))
      .sort((a, b) => a.email.localeCompare(b.email));

    return NextResponse.json({
      logs,
      entityTypes: entityTypes.map((e) => ({ value: e.entityType, count: e._count })),
      actions: actions.map((a) => ({ value: a.action, count: a._count })),
      users,
      total,
    });
  } catch (err) {
    return jsonError(err);
  }
}
