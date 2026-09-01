import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { SESSION_COOKIE, extractSubdomain, requestMeta, resolveTenant, signSession } from '@/lib/auth';
import { bootstrapDatabase, prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertNotLocked, clearFailures, LoginRateLimitedError, recordFailure } from '@/lib/rate-limit';
import type { Role } from '@/lib/types';

const schema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export async function POST(request: Request) {
  await bootstrapDatabase();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 },
    );
  }

  const { email, password } = parsed.data;

  const meta = await requestMeta();
  const retryKey = `${email.toLowerCase()}|${meta.ip ?? 'unknown'}`;
  try {
    await assertNotLocked(retryKey);
  } catch (err) {
    if (err instanceof LoginRateLimitedError) {
      return NextResponse.json({ error: err.message }, { status: 429, headers: { 'Retry-After': String(err.retryAfterSeconds) } });
    }
    throw err;
  }

  // Resolve tenant from subdomain
  const subdomain = await extractSubdomain();
  let tenantId: string | null = null;

  if (subdomain) {
    const tenant = await resolveTenant(subdomain);
    if (!tenant || !tenant.isActive) {
      return NextResponse.json({ error: 'Organization not found or inactive.' }, { status: 404 });
    }
    tenantId = tenant.id;
  }

  // Build the where clause — if tenant context exists, validate user belongs to it
  const where: Record<string, unknown> = { email: email.toLowerCase() };
  if (tenantId) {
    where.tenantId = tenantId;
  }

  const user = await prisma.user.findFirst({
    where,
    include: { assignments: true },
  });

  // When no subdomain (dev mode), use the user's own tenantId
  if (!tenantId && user?.tenantId) {
    tenantId = user.tenantId;
  }

  const logAttempt = async (success: boolean, reason?: string) => {
    await audit({
      ctx: { id: user?.id, email, role: (user?.role as Role) ?? 'UNKNOWN', ...meta, tenantId },
      action: 'login',
      entityType: 'User',
      entityId: user?.id ?? null,
      entityLabel: email,
      metadata: { success, ...(reason ? { reason } : {}) },
    });
  };

  if (!user || !user.isActive) {
    await recordFailure(retryKey);
    await logAttempt(false, 'unknown or inactive user');
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    await recordFailure(retryKey);
    await logAttempt(false, 'bad password');
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  await clearFailures(retryKey);

  const locationIds = user.assignments.map((a) => a.locationId);
  const token = signSession({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    roleId: user.roleId ?? null,
    tenantId: user.tenantId ?? null,
    locationIds,
  });

  await logAttempt(true);

  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      locationIds,
    },
  });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  return response;
}
