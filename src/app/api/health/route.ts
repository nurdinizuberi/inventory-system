import { NextResponse } from 'next/server';

/**
 * Liveness probe for load balancers, uptime monitors and Vercel.
 * Deliberately does NOT touch the database — auth routes run bootstrap/seed,
 * so a DB failure will surface there; keeping the probe DB-free avoids paging
 * the fleet during a temporary Postgres blip. Add a downstream DB check here
 * if you want stricter readiness semantics.
 */
export function GET() {
  return NextResponse.json({
    ok: true,
    status: 'healthy',
    service: 'warehouse-retail-inventory',
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}