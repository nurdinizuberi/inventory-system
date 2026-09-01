import jwt from 'jsonwebtoken';
import { cookies, headers } from 'next/headers';
import { prisma } from './db';
import { sessionSecret } from './secrets';
import type { Role } from './types';

export const SESSION_COOKIE = 'ims_session';

const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

export interface SessionClaims {
  sub: string;
  email: string;
  name: string;
  role: Role;
  roleId?: string | null;
  tenantId?: string | null;
  /** Location ids this user may operate on. Empty => unrestricted (admin/auditor). */
  locationIds: string[];
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  roleId?: string | null;
  tenantId?: string | null;
  locationIds: string[];
  locations: { id: string; name: string; code: string; type: string }[];
}

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, sessionSecret(), { expiresIn: EXPIRES_IN } as jwt.SignOptions);
}

export function verifySession(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, sessionSecret()) as jwt.JwtPayload & Partial<SessionClaims>;
    if (!decoded?.sub) return null;
    return {
      sub: decoded.sub,
      email: decoded.email ?? '',
      name: decoded.name ?? '',
      role: (decoded.role as Role) ?? 'AUDITOR',
      roleId: (decoded.roleId as string) ?? null,
      tenantId: (decoded.tenantId as string) ?? null,
      locationIds: Array.isArray(decoded.locationIds) ? (decoded.locationIds as string[]) : [],
    };
  } catch {
    return null;
  }
}

/** Claims straight off the JWT — cheap, no DB round trip. */
export async function getSessionClaims(): Promise<SessionClaims | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

/**
 * Claims + a fresh DB check that the user still exists, is active, and still
 * holds the location assignments encoded in the token.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const claims = await getSessionClaims();
  if (!claims) return null;
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    include: { assignments: { include: { location: true } } },
  });
  if (!user || !user.isActive) return null;
  const locations = user.assignments.map((a) => ({
    id: a.location.id,
    name: a.location.name,
    code: a.location.code,
    type: a.location.type,
  }));
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    roleId: user.roleId ?? null,
    tenantId: user.tenantId ?? claims.tenantId ?? null,
    locationIds: user.assignments.map((a) => a.locationId),
    locations,
  };
}

/** Client IP + user agent for the audit trail (best effort). */
export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const fwd = h.get('x-forwarded-for');
  const ip = (fwd ? fwd.split(',')[0].trim() : null) || h.get('x-real-ip');
  return { ip, userAgent: h.get('user-agent') };
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Tenant helpers — multi-tenancy support
// ---------------------------------------------------------------------------

/**
 * Resolve a tenant by its subdomain slug.
 * Returns null if not found or inactive.
 */
export async function resolveTenant(slug: string) {
  return prisma.tenant.findUnique({
    where: { slug },
  });
}

/**
 * Extract the tenant subdomain from the current request.
 * Uses the Host header. Returns null if no subdomain is detected.
 */
export async function extractSubdomain(): Promise<string | null> {
  const h = await headers();
  const host = h.get('host') ?? '';
  const hostname = host.split(':')[0];

  // Skip IP addresses (e.g. 127.0.0.1, 192.168.1.1)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
  // Skip plain localhost (no subdomain)
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return null;
  // Skip Vercel's *.vercel.app domains — the first label is a deployment hash,
  // not a tenant slug, so there's no meaningful subdomain.
  if (hostname.endsWith('.vercel.app')) return null;

  const parts = hostname.split('.');
  // For production: subdomain.yourapp.com → subdomain
  if (parts.length >= 3) return parts[0];
  // For development with subdomains like acme.localhost
  if (parts.length === 2 && parts[1] === 'localhost') return parts[0];
  return null;
}

/**
 * Get the current tenant from the request context.
 * Returns null if not in a tenant context (e.g. admin portal, or no subdomain).
 */
export async function getCurrentTenant() {
  const subdomain = await extractSubdomain();
  if (!subdomain) return null;
  return resolveTenant(subdomain);
}
