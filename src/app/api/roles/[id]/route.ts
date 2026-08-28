import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError, invalidateAllRoleCache, type Action } from '@/lib/rbac';
import { ALL_ACTIONS } from '@/lib/rbac';

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  permissions: z.array(z.string()).optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await guard({ action: 'user.manage' });
    const { id } = await params;
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    const existing = await prisma.role.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { permissions: true },
    });
    if (!existing) return badRequest('Role not found');
    if (existing.isSystemRole) return badRequest('System roles cannot be modified.');

    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name.trim();
    if (data.description !== undefined) updates.description = data.description?.trim() || null;

    const permissionActions = data.permissions !== undefined ? data.permissions : undefined;
    if (permissionActions !== undefined) {
      const validActions = new Set(ALL_ACTIONS as unknown as string[]);
      const invalid = permissionActions.filter((p) => !validActions.has(p) && p !== '*');
      if (invalid.length) return badRequest(`Unknown permissions: ${invalid.join(', ')}`);
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (permissionActions !== undefined) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({
          data: permissionActions.map((action) => ({ roleId: id, action })),
        });
      }
      return tx.role.update({
        where: { id },
        data: updates,
        include: { permissions: true },
      });
    });

    invalidateAllRoleCache();

    await audit({
      ctx,
      action: 'update',
      entityType: 'Role',
      entityId: id,
      entityLabel: updated.name,
      before: { name: existing.name, permissions: existing.permissions.map((p) => p.action) },
      after: { name: updated.name, permissions: updated.permissions.map((p) => p.action) },
    });

    return NextResponse.json({
      role: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        description: updated.description,
        isSystemRole: updated.isSystemRole,
        permissions: updated.permissions.map((p) => p.action),
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await guard({ action: 'user.manage' });
    const { id } = await params;

    const existing = await prisma.role.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { _count: { select: { users: true } } },
    });
    if (!existing) return badRequest('Role not found');
    if (existing.isSystemRole) return badRequest('System roles cannot be deleted.');
    if (existing._count.users > 0) return badRequest(`Cannot delete role "${existing.name}" — ${existing._count.users} user(s) are assigned to it. Reassign them first.`);

    await prisma.role.delete({ where: { id } });
    invalidateAllRoleCache();

    await audit({
      ctx,
      action: 'delete',
      entityType: 'Role',
      entityId: id,
      entityLabel: existing.name,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
