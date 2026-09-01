import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestMeta } from '@/lib/auth';
import { getAppBaseUrl } from '@/lib/app-url';
import { sendEmail } from '@/lib/email';
import { issueResetForEmail } from '@/lib/tokens';
import { logInfo } from '@/lib/log';

const schema = z.object({ email: z.string().email('Enter a valid email address') });

/**
 * Request a password reset for a tenant user. Responds generically whether or
 * not the email exists (no account enumeration), and mints + emails a one-time
 * link when it does.
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
    const issued = await issueResetForEmail(email);
    if (issued) {
      const baseUrl = await getAppBaseUrl();
      const link = `${baseUrl}/reset-password?token=${issued.token}`;
      await sendEmail({
        to: issued.user.email,
        subject: 'Reset your MindBoxAfrica password',
        html: resetEmailHtml(link),
      });
      logInfo('password reset link issued', { email: issued.user.email, ip: meta.ip });
    }
  } catch (err) {
    // Rate-limiting / unforeseen DB errors should not reveal account existence.
    logInfo('forgot-password handled', { email, tried: !!meta.ip });
    void err;
  }

  return NextResponse.json({
    message: 'If an account with that email exists, a password reset link has been sent.',
  });
}

function resetEmailHtml(link: string): string {
  return `
  <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#111827">
    <h2 style="color:#5b21b6">MindBoxAfrica</h2>
    <p>We received a request to reset the password for your account.</p>
    <p><a href="${link}"
      style="display:inline-block;background:#5b21b6;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">
      Reset password</a></p>
    <p style="color:#6b7280;font-size:13px">This link is valid for 1 hour. If you didn't request this,
    you can safely ignore this email.</p>
    </div>`;
}

