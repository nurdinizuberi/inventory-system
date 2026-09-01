import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestMeta } from '@/lib/auth';
import { getAppBaseUrl } from '@/lib/app-url';
import { sendEmail } from '@/lib/email';
import { issueResetForEmail } from '@/lib/tokens';
import { logInfo } from '@/lib/log';

const schema = z.object({ email: z.string().email('Enter a valid email address') });

/**
 * Request a password reset for the GLOBAL ADMIN portal account. Scoped to
 * tenantId = null so a like-named tenant user can never be reset through this
 * endpoint. Responds generically (no account enumeration).
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

  const { email } = parsed.data;
  const meta = await requestMeta();

  try {
    const issued = await issueResetForEmail(email, { tenantId: null });
    if (issued) {
      const baseUrl = await getAppBaseUrl();
      const link = `${baseUrl}/reset-password?token=${issued.token}`;
      await sendEmail({
        to: issued.user.email,
        subject: 'Reset your MindBoxAfrica admin password',
        html: `Reset your global admin password: <a href="${link}">${link}</a> (valid 1 hour).`,
      });
      logInfo('admin password reset link issued', { email: issued.user.email, ip: meta.ip });
    }
  } catch (err) {
    void err;
  }

  return NextResponse.json({
    message: 'If a global admin account with that email exists, a reset link has been sent.',
  });
}
