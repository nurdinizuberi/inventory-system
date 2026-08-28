/**
 * Tenant context — extracts the current tenant_id from the session and provides
 * helpers for scoping all Prisma queries to a single tenant.
 *
 * Usage in API routes:
 *   const ctx = await getTenantContext(); // from guard() or standalone
 *   const items = await prisma.product.findMany({
 *     where: { tenantId: ctx.tenantId, isActive: true },
 *   });
 */

import { getSessionUser, type SessionUser } from './auth';

export interface TenantContext extends SessionUser {
  tenantId: string | null;
}

/**
 * Get the tenant-scoped context for the current request.
 * This is the primary entry point for tenant isolation in API routes.
 */
export async function getTenantContext(): Promise<TenantContext | null> {
  const user = await getSessionUser();
  if (!user) return null;
  return {
    ...user,
    tenantId: user.tenantId ?? null,
  };
}

/**
 * Assert that a user has a tenant context (i.e., is not a Global Admin
 * operating outside of a tenant scope). Throws if no tenant.
 */
export function assertTenant(ctx: TenantContext): asserts ctx is TenantContext & { tenantId: string } {
  if (!ctx.tenantId) {
    throw new Error('Tenant context required. This endpoint must be accessed from a tenant subdomain.');
  }
}

/**
 * Build a base WHERE clause that filters by tenant_id.
 * Use this as a starting point for all tenant-scoped queries.
 *
 * @example
 *   const where = tenantWhere(ctx, { isActive: true });
 *   const products = await prisma.product.findMany({ where });
 */
export function tenantWhere(
  ctx: { tenantId: string | null },
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (ctx.tenantId) {
    base.tenantId = ctx.tenantId;
  }
  if (extra) {
    Object.assign(base, extra);
  }
  return base;
}

/**
 * Build a create data payload that includes the tenant_id.
 * Automatically sets tenantId on the provided data object.
 */
export function tenantData<T extends Record<string, unknown>>(
  ctx: { tenantId: string | null },
  data: T,
): T & { tenantId: string | null } {
  return {
    ...data,
    tenantId: ctx.tenantId ?? null,
  };
}
