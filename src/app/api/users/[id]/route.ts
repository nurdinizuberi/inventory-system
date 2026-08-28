import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { ROLES } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  role: z.enum(ROLES).optional(),
  roleId: z.string().optional(),
  isActive: z.boolean().optional(),
  locationIds: z.array(z.string()).optional(),
  password: z.string().min(6).optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await guard({ action: 'user.manage' });
    const { id } = await params;
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    const before = await prisma.user.findFirst({
      where: { id, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { assignments: true },
    });
    if (!before) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    if (id === ctx.id && data.isActive === false) {
      return badRequest('You cannot deactivate your own account');
    }

    if (data.locationIds !== undefined) {
      const valid = await prisma.location.count({
        where: { id: { in: data.locationIds }, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      });
      if (valid !== data.locationIds.length) return badRequest('One or more locations do not exist');
    }

    // Resolve roleId to role slug if provided
    let roleSlug: string | undefined = data.role;
    let roleIdVal: string | null = null;
    if (data.roleId) {
      const roleRecord = await prisma.role.findFirst({
        where: { id: data.roleId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      });
      if (!roleRecord) return badRequest('Role not found');
      roleSlug = roleRecord.slug;
      roleIdVal = roleRecord.id;
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.email !== undefined ? { email: data.email.toLowerCase() } : {}),
        ...(roleSlug !== undefined && roleSlug !== null ? { role: roleSlug as typeof data.role } : {}),
        ...(roleIdVal !== null ? { roleId: roleIdVal } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.password ? { passwordHash: await bcrypt.hash(data.password, 10) } : {}),
        ...(data.locationIds
          ? {
              assignments: {
                deleteMany: {},
                create: data.locationIds.map((locationId) => ({ locationId })),
              },
            }
          : {}),
      },
      include: { assignments: { include: { location: true } } },
    });

    await audit({
      ctx,
      action: 'update',
      entityType: 'User',
      entityId: id,
      entityLabel: user.email,
      before: {
        name: before.name,
        email: before.email,
        role: before.role,
        isActive: before.isActive,
        locationIds: before.assignments.map((a) => a.locationId),
      },
      after: {
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        locationIds: user.assignments.map((a) => a.locationId),
        ...(data.password ? { password: '[changed]' } : {}),
      },
    });

    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        locations: user.assignments.map((a) => ({ id: a.location.id, name: a.location.name })),
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
