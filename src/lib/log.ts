/**
 * Minimal structured logging + optional error reporting.
 *
 * Everything is written as a single JSON line to stdout/stderr (structured
 * logs work natively with Vercel Log Drains, Datadog, CloudWatch, etc.).
 *
 * When ERROR_WEBHOOK_URL is set, errors are POSTed as JSON payloads there —
 * works with Slack, Zapier, or a Sentry-compatible webhook.  This never
 * throws; reporting failures are silently swallowed.
 */

export interface LogContext {
  requestId?: string | null;
  method?: string;
  path?: string;
  ip?: string | null;
  user?: string;
  tenantId?: string | null;
  [k: string]: unknown;
}

function write(level: 'info' | 'error', message: string, extra: Record<string, unknown>): void {
  const base: Record<string, unknown> = {
    level,
    msg: message,
    ts: new Date().toISOString(),
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) base[k] = v;
  }
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(base));
}

export function logInfo(message: string, ctx?: LogContext): void {
  write('info', message, (ctx as Record<string, unknown>) ?? {});
}

export function logError(message: string, ctx?: LogContext, err?: unknown): void {
  const extra: Record<string, unknown> = { ...(ctx as Record<string, unknown>) };
  if (err instanceof Error) {
    extra.error = err.message;
    extra.stack = err.stack;
  } else if (err !== undefined) {
    extra.error = String(err);
  }
  write('error', message, extra);
  fireWebhook(message, extra);
}

function fireWebhook(message: string, extra: Record<string, unknown>): void {
  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return;
  try {
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, ...extra }),
    });
  } catch {
    // Never break the request because reporting failed.
  }
}
