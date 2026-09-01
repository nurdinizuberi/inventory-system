import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestMeta } from '@/lib/auth';
import { consumeReset } from '@/lib/tokens';
import { logInfo } from '@/lib/log';

const schema = z.object({
  token: z.string().min(16, 'Invalid token'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

/**
 * Complete a password reset. The token is consumed on success (single-use). A
 * failed/invalid/expired token returns 400 without revealing whether the token
 * ever existed.
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

  const { token, password } = parsed.data;
  const meta = await requestMeta();

  const result = await consumeReset(token, password);
  if (!result.ok) {
    logInfo('password reset rejected', { ip: meta.ip, reason: 'invalid or expired token' });
    return NextResponse.json({ error: 'This reset link is invalid or has expired.' }, { status: 400 });
  }

  logInfo('password reset completed', { email: result.user?.email, ip: meta.ip, user: result.user?.id });
  return NextResponse.json({ message: 'Your password has been reset. You can now sign in.' });
}
