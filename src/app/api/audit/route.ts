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
    await guard({ action: 'audit.view' });
    const url = new URL(request.url);
    const entityType = url.searchParams.get('entityType');
    const action = url.searchParams.get('action');
    const userId = url.searchParams.get('userId');
    const q = url.searchParams.get('q')?.trim();
    const take = Math.min(Number(url.searchParams.get('take') ?? 150), 500);

    const [logs, entityTypes, actions, total] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
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
      },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    }),

    prisma.auditLog.groupBy({ by: ['entityType'], _count: true }),

    prisma.auditLog.groupBy({ by: ['action'], _count: true }),

    prisma.auditLog.count(),
  ]);

    return NextResponse.json({
      logs,
      entityTypes: entityTypes.map((e) => ({ value: e.entityType, count: e._count })),
      actions: actions.map((a) => ({ value: a.action, count: a._count })),
      total,
    });
  } catch (err) {
    return jsonError(err);
  }
}
