/**
 * Complex base domain (pure — importable from middleware/Edge code).
 *
 * Setting APP_BASE_DOMAIN (e.g. "mindboxafrica.com") lets a real apex +
 * wildcard domain behave exactly like Vercel's *.vercel.app: the apex and
 * "www" are bare (no tenant, global admin) and each
 * "<slug>.<APP_BASE_DOMAIN>" resolves to a tenant.
 */
export function appBaseDomain(): string | null {
  const v = (process.env.APP_BASE_DOMAIN ?? '').trim().toLowerCase();
  return v || null;
}

/**
 * Pure host → tenant-slug resolution. Shared by the edge middleware and the
 * Node-side extractSubdomain() so both are guaranteed to agree.
 *
 * Rules:
 *  - IPs and plain localhost → null (bare)
 *  - *.vercel.app → null (first label is a deployment hash, not a tenant)
 *  - When APP_BASE_DOMAIN is set:
 *      <slug>.<base>            → <slug>
 *      apex / www.<base>        → null
 *  - Otherwise (production-style subdomains): subdomain.example.com → subdomain
 *  - Dev: acme.localhost → acme
 *
 * Returns the subdomain string or null when the host is "bare" (no tenant).
 */
export function tenantSlugFromHost(hostname: string): string | null {
  const clean = hostname.split(':')[0].toLowerCase();

  // Ignore IP addresses.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) return null;
  // Vercel *.vercel.app — first label is a deployment hash, not a tenant.
  if (clean.endsWith('.vercel.app')) return null;

  const baseDomain = appBaseDomain();
  if (baseDomain) {
    // <slug>.<base> → tenant; apex and www.<base> → bare.
    if (clean === baseDomain || clean === `www.${baseDomain}` || clean.endsWith(`.www.${baseDomain}`)) {
      return null;
    }
    if (clean.endsWith(`.${baseDomain}`)) {
      return clean.slice(0, -(baseDomain.length + 1));
    }
    return null;
  }

  // Dev shorthand: acme.localhost → "acme"; plain localhost → null.
  if (clean === 'localhost') return null;
  if (clean.endsWith('.localhost')) return clean.slice(0, -'.localhost'.length);

  const parts = clean.split('.');
  if (parts.length >= 3) return parts[0]; // subdomain.example.com
  return null; // bare two-label host (e.g. yourapp.com)
}

