import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError, invalidateAllRoleCache } from '@/lib/rbac';
import { ALL_ACTIONS, type Action } from '@/lib/rbac';

const createSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/, 'Slug must be uppercase letters, digits, and underscores'),
  description: z.string().optional().nullable(),
  permissions: z.array(z.string()).min(1, 'At least one permission is required'),
});

export async function GET() {
  try {
    const ctx = await guard({ action: 'user.manage' });
    const roles = await prisma.role.findMany({
      where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { permissions: true, _count: { select: { users: true } } },
      orderBy: [{ isSystemRole: 'desc' }, { name: 'asc' }],
    });
    return NextResponse.json({
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        description: r.description,
        isSystemRole: r.isSystemRole,
        userCount: r._count.users,
        permissions: r.permissions.map((p) => p.action),
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'user.manage' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    const exists = await prisma.role.findFirst({ where: { OR: [{ slug: data.slug }, { name: data.name }], ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (exists) return badRequest(`A role with that name or slug already exists`);

    const validActions = new Set(ALL_ACTIONS as unknown as string[]);
    const invalid = data.permissions.filter((p) => !validActions.has(p) && p !== '*');
    if (invalid.length) return badRequest(`Unknown permissions: ${invalid.join(', ')}`);

    const role = await prisma.role.create({
      data: {
        tenantId: ctx.tenantId ?? null,
        name: data.name.trim(),
        slug: data.slug,
        description: data.description?.trim() || null,
        isSystemRole: false,
        permissions: { create: data.permissions.map((action) => ({ action })) },
      },
      include: { permissions: true },
    });

    invalidateAllRoleCache();

    await audit({
      ctx,
      action: 'create',
      entityType: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      after: { name: role.name, slug: role.slug, permissions: data.permissions },
    });

    return NextResponse.json({
      role: { id: role.id, name: role.name, slug: role.slug, permissions: role.permissions.map((p) => p.action) },
    }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
