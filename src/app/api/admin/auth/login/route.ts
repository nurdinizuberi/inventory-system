import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { bootstrapDatabase } from '@/lib/db';
import { ADMIN_SESSION_COOKIE, signAdminToken } from '@/lib/admin-auth';
import { requestMeta } from '@/lib/auth';
import { assertNotLocked, clearFailures, LoginRateLimitedError, recordFailure } from '@/lib/rate-limit';

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
    assertNotLocked(retryKey);
  } catch (err) {
    if (err instanceof LoginRateLimitedError) {
      return NextResponse.json({ error: err.message }, { status: 429, headers: { 'Retry-After': String(err.retryAfterSeconds) } });
    }
    throw err;
  }

  // Admin users are identified by having no tenant (tenantId = null) and ADMIN role
  const user = await prisma.user.findFirst({
    where: {
      email: email.toLowerCase(),
      tenantId: null,
      role: 'ADMIN',
      isActive: true,
    },
  });

  if (!user) {
    recordFailure(retryKey);
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    recordFailure(retryKey);
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  clearFailures(retryKey);

  const token = signAdminToken({ id: user.id, email: user.email, name: user.name });

  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: 'GLOBAL_ADMIN',
    },
  });

  response.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });

  return response;
}
