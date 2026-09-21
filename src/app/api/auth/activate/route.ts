import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { requestMeta } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { findUserByActivationToken, completeActivation } from '@/lib/tokens';
import { logInfo } from '@/lib/log';

/**
 * GET /api/auth/activate?token=...
 * Public, unauthenticated. Returns the minimal, non-sensitive context the
 * /activate page needs to render (name/email of the invited user) and whether
 * the token is still valid. Never reveals whether an arbitrary token string
 * was ever issued beyond the boolean.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (token.length < 16) {
    return NextResponse.json({ error: 'Invalid activation link.' }, { status: 400 });
  }

  const user = await findUserByActivationToken(token);
  if (!user) {
    return NextResponse.json(
      { error: 'This activation link is invalid or has expired. Ask an admin to resend the invitation.' },
      { status: 400 },
    );
  }
  if (user.status === 'SUSPENDED') {
    return NextResponse.json({ error: 'This account is suspended and cannot be activated.' }, { status: 403 });
  }

  return NextResponse.json({
    activation: {
      name: user.name,
      email: user.email,
      role: user.role,
      alreadyActive: user.status === 'ACTIVE',
    },
  });
}

const completeSchema = z.object({
  token: z.string().min(16, 'Invalid activation token'),
  name: z.string().min(2, 'Please enter your full name'),
  phone: z.string().trim().max(32).optional().nullable(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

/**
 * POST /api/auth/activate
 * Completes activation: consumes the single-use token, verifies the email
 * address, applies the profile updates, sets the user-chosen password and
 * flips the account PENDING -> ACTIVE. Rate-limit friendly by design — a
 * wrong token is a plain 400 and the token is never revealed.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 },
    );
  }

  const { token, name, phone, password } = parsed.data;
  const meta = await requestMeta();

  const before = await findUserByActivationToken(token);
  const result = await completeActivation({ raw: token, name, phone, password });
  if (!result.ok) {
    logInfo('activation rejected', { ip: meta.ip, reason: 'invalid or expired token' });
    return NextResponse.json({ error: 'This activation link is invalid or has expired.' }, { status: 400 });
  }

  await audit({
    ctx: { id: before?.id, email: result.user.email, role: (before?.role as never) ?? 'UNKNOWN', ...meta, tenantId: before?.tenantId ?? null },
    action: 'confirm',
    entityType: 'User',
    entityId: result.user.id,
    entityLabel: result.user.email,
    metadata: { activation: true, ...(before?.status === 'ACTIVE' ? { selfServiceUpdate: true } : {}) },
  });
  logInfo('account activated', { email: result.user.email, user: result.user.id, ip: meta.ip });

  return NextResponse.json({
    message: 'Your account is active. You can sign in now.',
    user: { id: result.user.id, email: result.user.email, name: result.user.name },
  });
}
