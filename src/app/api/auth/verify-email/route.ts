import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestMeta } from '@/lib/auth';
import { verifyEmailToken } from '@/lib/tokens';
import { logInfo } from '@/lib/log';

const schema = z.object({ token: z.string().min(16, 'Invalid token') });

/**
 * Confirm an email address by consuming a one-time verification token.
 * Tenant users are issued this link by an admin at creation time.
 */
export async function POST(request: Request) {
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

  const { token } = parsed.data;
  const meta = await requestMeta();

  const result = await verifyEmailToken(token);
  if (!result.ok) {
    return NextResponse.json({ error: 'This verification link is invalid or has already been used.' }, { status: 400 });
  }

  logInfo('email verified', { email: result.user?.email, ip: meta.ip, user: result.user?.id });
  return NextResponse.json({ message: 'Your email address has been verified.' });
}
