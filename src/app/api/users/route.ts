import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { ROLES } from '@/lib/types';

const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(ROLES),
  roleId: z.string().optional(), // optional custom role ID
  locationIds: z.array(z.string()).default([]),
});

export async function GET() {
  try {
    const ctx = await guard({ action: 'user.view' });
    const [users, locations, roles] = await Promise.all([
    prisma.user.findMany({
      where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { assignments: { include: { location: true } }, roleRef: true },
      orderBy: { name: 'asc' },
    }),
    prisma.location.findMany({ where: { isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) }, orderBy: { name: 'asc' } }),
    prisma.role.findMany({
      where: { ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { _count: { select: { users: true } } },
      orderBy: [{ isSystemRole: 'desc' }, { name: 'asc' }],
    }),
  ]);
    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        roleId: u.roleId,
        roleDisplayName: u.roleRef?.name ?? u.role,
        isActive: u.isActive,
        createdAt: u.createdAt,
        locations: u.assignments.map((a) => ({ id: a.location.id, name: a.location.name, code: a.location.code, type: a.location.type })),
      })),
      locations,
      roles: ROLES,
      allRoles: roles.map((r) => ({ id: r.id, name: r.name, slug: r.slug, isSystemRole: r.isSystemRole, userCount: r._count.users })),
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'user.manage' });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const data = parsed.data;

    const exists = await prisma.user.findFirst({ where: { email: data.email.toLowerCase(), ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (exists) return badRequest('A user with that email already exists');

    const locations = await prisma.location.findMany({ where: { id: { in: data.locationIds }, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } });
    if (locations.length !== data.locationIds.length) return badRequest('One or more locations do not exist');

    // If roleId provided, verify it exists and set role string from it
    let roleSlug: string = data.role;
    let roleId: string | null = null;
    if (data.roleId) {
      const roleRecord = await prisma.role.findFirst({
        where: { id: data.roleId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      });
      if (!roleRecord) return badRequest('Role not found');
      roleSlug = roleRecord.slug;
      roleId = roleRecord.id;
    }

    const user = await prisma.user.create({
      data: {
        tenantId: ctx.tenantId ?? null,
        name: data.name.trim(),
        email: data.email.toLowerCase(),
        passwordHash: await bcrypt.hash(data.password, 10),
        role: roleSlug as typeof data.role,
        roleId: roleId,
        assignments: { create: data.locationIds.map((locationId) => ({ locationId })) },
      },
      include: { assignments: { include: { location: true } } },
    });

    await audit({
      ctx,
      action: 'create',
      entityType: 'User',
      entityId: user.id,
      entityLabel: user.email,
      after: {
        name: user.name,
        email: user.email,
        role: user.role,
        locations: user.assignments.map((a) => a.location.name),
      },
    });

    return NextResponse.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
