import { headers } from 'next/headers';
export { appBaseDomain } from './app-domain';

/**
 * The public origin the app is served from, used to build absolute links for
 * emails. Preference order:
 *   1. NEXT_PUBLIC_APP_URL when set (the canonical deployed origin);
 *   2. the request Host header (works on Vercel and any self-host that
 *      preserves Host, incl. tenant subdomains).
 * No trailing slash.
 */
export async function getAppBaseUrl(): Promise<string> {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const h = await headers();
  const host = h.get('host');
  return host ? `https://${host}` : 'http://localhost:3004';
}
