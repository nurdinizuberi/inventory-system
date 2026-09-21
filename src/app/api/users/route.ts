import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { accountView } from '@/lib/account';
import { sendActivationEmail } from '@/lib/account-email';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { ROLES } from '@/lib/types';
import { getAppBaseUrl } from '@/lib/app-url';
import { sendEmail } from '@/lib/email';
import { issueActivation, issueVerificationForEmail } from '@/lib/tokens';

const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  // Optional: omit to create a PENDING account that activates itself via the
  // emailed link (verify email -> profile -> own password). Provide a password
  // to create the account as ACTIVE with admin-set credentials.
  password: z
    .string()
    .min(6, 'Password must be at least 6 characters')
    .optional(),
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
      users: users.map((u) => {
        const acct = accountView(u.status, u.isActive, u.emailVerifiedAt, u.activatedAt);
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          roleId: u.roleId,
          roleDisplayName: u.roleRef?.name ?? u.role,
          isActive: u.isActive,
          status: acct.status,
          emailVerified: acct.emailVerified,
          lastInvitedAt: u.lastInvitedAt,
          createdAt: u.createdAt,
          locations: u.assignments.map((a) => ({ id: a.location.id, name: a.location.name, code: a.location.code, type: a.location.type })),
        };
      }),
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

    // Without a password the account starts PENDING: an unusable random hash
    // (nobody can sign in with it) plus an activation token mailed to the
    // user, who then verifies the email and sets their own password.
    const pending = !data.password;
    const user = await prisma.user.create({
      data: {
        tenantId: ctx.tenantId ?? null,
        name: data.name.trim(),
        email: data.email.toLowerCase(),
        passwordHash: pending ? crypto.randomBytes(32).toString('hex') : await bcrypt.hash(data.password as string, 10),
        role: roleSlug as typeof data.role,
        roleId: roleId,
        status: pending ? 'PENDING' : 'ACTIVE',
        isActive: !pending,
        invitedById: ctx.id,
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
        status: user.status,
        locations: user.assignments.map((a) => a.location.name),
      },
    });

    // PENDING accounts get the activation email (verify email -> set own
    // password). ACTIVE accounts keep the plain verification notice. A mail
    // failure must never block the user creation.
    void (async () => {
      try {
        if (pending) {
          const invited = await issueActivation({ email: user.email, tenantId: ctx.tenantId ?? null, invitedById: ctx.id });
          if (invited) {
            const link = `${await getAppBaseUrl()}/activate?token=${invited.token}`;
            await sendActivationEmail({
              to: invited.user.email,
              name: invited.user.name,
              link,
              invitedBy: ctx.name,
              isNew: true,
            });
          }
        } else {
          const verified = await issueVerificationForEmail(user.email);
          if (verified) {
            const link = `${await getAppBaseUrl()}/verify-email?token=${verified.token}`;
            await sendEmail({
              to: verified.user.email,
              subject: 'Verify your MindBoxAfrica account email',
              html: `<p>Confirm your email to activate your account:</p><p><a href="${link}">${link}</a></p>`,
            });
          }
        }
      } catch {
        /* noop */
      }
    })();

    return NextResponse.json(
      {
        user: { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status },
        ...(pending ? { invitationSent: true } : {}),
      },
      { status: 201 },
    );
  } catch (err) {
    return jsonError(err);
  }
}
