import { logError, logInfo } from './log';

/**
 * Transactional email via the Resend REST API (native fetch — no SDK dep).
 *
 * Provider: "resend" (default) uses RESEND_API_KEY. Provider "console" prints
 * the message instead — handy for local dev when no key/domain is configured.
 *
 * Never throws on a send problem; it logs and continues, so a failing mail
 * service cannot take down an auth flow. Callers that care about delivery can
 * inspect the returned { ok } flag.
 */

export type EmailProvider = 'resend' | 'console';

const FROM = process.env.EMAIL_FROM || 'MindBoxAfrica <no-reply@mindboxafrica.vercel.app>';

function provider(): EmailProvider {
  return (process.env.EMAIL_PROVIDER as EmailProvider) || (process.env.RESEND_API_KEY ? 'resend' : 'console');
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    if (provider() === 'console') {
      logInfo('[email:console] would send', {
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      });
      return { ok: true };
    }

    const key = process.env.RESEND_API_KEY;
    if (!key) {
      logError('No RESEND_API_KEY configured for email send');
      return { ok: false, error: 'Email provider is not configured' };
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from: FROM,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
      }),
      // Serverless runtimes shouldn't block on a slow mail provider.
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const detail = await res.text();
      logError('Resend send failed', { to: opts.to, subject: opts.subject }, detail || String(res.status));
      return { ok: false, error: detail || `HTTP ${res.status}` };
    }

    return { ok: true };
  } catch (err) {
    logError('Email send error', { to: opts.to, subject: opts.subject }, err);
    return { ok: false, error: err instanceof Error ? err.message : 'Email send error' };
  }
}
