import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { tenantSlugFromHost } from './lib/app-domain';

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

  const requestId = request.headers.get('x-vercel-id') || randomId();

  // Skip tenant resolution for the admin portal and health checks
  if (
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/api/admin') ||
    url.pathname === '/api/health'
  ) {
    return withRequestId(requestId);
  }

  // Extract subdomain from host. See tenantSlugFromHost() — a real
  // APP_BASE_DOMAIN + wildcard behaves like Vercel's bare *.vercel.app.
  const tenantSlug = tenantSlugFromHost(hostname);

  // Forward tenant slug + a request id as headers for downstream resolution /
  // correlation of structured logs.
  const response = NextResponse.next();
  if (tenantSlug) {
    response.headers.set('x-tenant-slug', tenantSlug);
  }
  response.headers.set('x-request-id', requestId);

  return response;
}

function withRequestId(requestId: string) {
  const response = NextResponse.next();
  response.headers.set('x-request-id', requestId);
  return response;
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
