import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { accountView, canAdminReactivate, toAccountStatus } from '@/lib/account';
import { suspendedEmailHtml } from '@/lib/account-email';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { sendEmail } from '@/lib/email';
import { ROLES } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  role: z.enum(ROLES).optional(),
  roleId: z.string().optional(),
  isActive: z.boolean().optional(),
  /** PENDING | ACTIVE | SUSPENDED. Supported transitions: ACTIVE <-> SUSPENDED. */
  status: z.string().optional(),
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

    if (id === ctx.id && (data.isActive === false || data.status === 'SUSPENDED')) {
      return badRequest('You cannot suspend your own account');
    }

    // Status transitions. Only ACTIVE <-> SUSPENDED is admin-controlled; a
    // PENDING account must activate itself, and status is never set to ACTIVE
    // from PENDING here (the activation link proves mailbox ownership).
    let statusChange: { from: string; to: 'ACTIVE' | 'SUSPENDED' } | null = null;
    if (data.status !== undefined) {
      const next = toAccountStatus(data.status);
      if (!next || next === 'PENDING') return badRequest('Status must be ACTIVE or SUSPENDED');
      if (before.status === 'PENDING') {
        return badRequest('This account has not completed activation yet — resend the invitation instead.');
      }
      if (before.status !== next) statusChange = { from: before.status, to: next };
    } else if (data.isActive !== undefined) {
      // Legacy toggle: map isActive=false -> SUSPENDED, isActive=true ->
      // ACTIVE (unless the account is still PENDING, which only the user's
      // own activation can flip).
      if (before.status === 'PENDING' && data.isActive) {
        return badRequest('This account has not completed activation yet — resend the invitation instead.');
      }
      const next = data.isActive ? 'ACTIVE' : 'SUSPENDED';
      if (before.status !== next) statusChange = { from: before.status, to: next };
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

    // isActive stays the derived mirror of status on every transition.
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.email !== undefined ? { email: data.email.toLowerCase() } : {}),
        ...(roleSlug !== undefined && roleSlug !== null ? { role: roleSlug as typeof data.role } : {}),
        ...(roleIdVal !== null ? { roleId: roleIdVal } : {}),
        ...(statusChange ? { status: statusChange.to, isActive: statusChange.to === 'ACTIVE' } : {}),
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
        status: user.status,
        isActive: user.isActive,
        locationIds: user.assignments.map((a) => a.locationId),
        ...(data.password ? { password: '[changed]' } : {}),
      },
    });

    // Best-effort notification on suspension (fire-and-forget).
    if (statusChange?.to === 'SUSPENDED') {
      void sendEmail({ to: user.email, subject: 'Your MindBoxAfrica account has been suspended', html: suspendedEmailHtml({ name: user.name }) });
    }

    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        status: accountView(user.status, user.isActive, user.emailVerifiedAt, user.activatedAt).status,
        emailVerified: accountView(user.status, user.isActive, user.emailVerifiedAt, user.activatedAt).emailVerified,
        locations: user.assignments.map((a) => ({ id: a.location.id, name: a.location.name })),
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
