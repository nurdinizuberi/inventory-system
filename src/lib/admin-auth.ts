import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { sessionSecret } from './secrets';

export const ADMIN_SESSION_COOKIE = 'ims_admin_session';

export function adminSecret(): string {
  return sessionSecret();
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'GLOBAL_ADMIN';
}

/** Sign a fresh admin session token (global admin role claim). */
export function signAdminToken(user: { id: string; email: string; name: string }): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: 'GLOBAL_ADMIN',
      tenantId: null,
    },
    adminSecret(),
    { expiresIn: '12h' },
  );
}

/**
 * Authenticate the admin session cookie. Returns null when the cookie is
 * missing, expired, or does not carry the GLOBAL_ADMIN role.
 */
export async function requireAdmin(): Promise<AdminUser | null> {
  const store = await cookies();
  const token = store.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, adminSecret()) as jwt.JwtPayload & {
      sub?: string;
      email?: string;
      name?: string;
      role?: string;
    };
    if (!decoded?.sub || decoded.role !== 'GLOBAL_ADMIN') return null;
    return { id: decoded.sub, email: decoded.email ?? '', name: decoded.name ?? '', role: 'GLOBAL_ADMIN' };
  } catch {
    return null;
  }
}