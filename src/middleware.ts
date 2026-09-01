import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Next.js middleware — runs on every request.
 *
 * Extracts the tenant subdomain from the Host header and forwards it as a
 * header (`x-tenant-slug`) so that server components and API routes can
 * resolve the tenant without a second Host-header parse.
 *
 * Routes under /admin and /api/admin are exempt from tenant resolution
 * (Global Admin portal).
 */
export function middleware(request: NextRequest) {
  const url = request.nextUrl;
  const host = request.headers.get('host') ?? '';
  const hostname = host.split(':')[0];

  // Skip tenant resolution for the admin portal and health checks
  if (
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/api/admin') ||
    url.pathname === '/api/health'
  ) {
    return NextResponse.next();
  }

  // Extract subdomain from host
  // Production: acme.yourapp.com → "acme"
  // Development: acme.localhost → "acme"  OR  localhost:3000 → null
  // Vercel's *.vercel.app domains are always treated as bare (no tenant).
  const parts = hostname.split('.');
  let tenantSlug: string | null = null;

  if (hostname.endsWith('.vercel.app')) {
    tenantSlug = null;
  } else if (parts.length >= 3) {
    // Production: subdomain.example.com
    tenantSlug = parts[0];
  } else if (parts.length === 2 && parts[1] === 'localhost') {
    // Dev: subdomain.localhost
    tenantSlug = parts[0];
  }

  // Forward tenant slug as a header for downstream resolution
  const response = NextResponse.next();
  if (tenantSlug) {
    response.headers.set('x-tenant-slug', tenantSlug);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
