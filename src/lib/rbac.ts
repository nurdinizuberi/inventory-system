import { NextResponse } from 'next/server';
import { AuthError, getSessionUser, requestMeta, type SessionUser } from './auth';
import { prisma } from './db';
import { logError } from './log';
import type { Role } from './types';

// ---------------------------------------------------------------------------
// RBAC matrix. This is the ONLY place permissions are declared, and it is
// enforced on the server for every write/read endpoint. Hiding UI is cosmetic;
// these checks are the real gate.
// ---------------------------------------------------------------------------

export type Action =
  // catalog
  | 'product.view' | 'product.create' | 'product.update' | 'product.delete'
  | 'variant.view' | 'variant.create' | 'variant.update' | 'variant.delete'
  // master data
  | 'location.view' | 'location.manage'
  | 'supplier.view' | 'supplier.manage'
  | 'user.view' | 'user.manage'
  // purchasing
  | 'purchase.view' | 'purchase.create' | 'purchase.update' | 'purchase.confirm' | 'purchase.cancel'
  // transfers
  | 'transfer.view' | 'transfer.create' | 'transfer.ship' | 'transfer.complete' | 'transfer.cancel'
  // POS
  | 'sale.create' | 'sale.view' | 'sale.void' | 'sale.ownOnly'
  // returns
  | 'return.create' | 'return.view'
  // stock
  | 'stock.view' | 'stock.adjust' | 'stock.adjustApprove' | 'reservation.manage'
  // reports
  | 'report.sales' | 'report.stock' | 'report.purchases' | 'report.transfers' | 'report.pnl' | 'report.valuation'
  // system
  | 'audit.view';

export const ALL_ACTIONS: Action[] = [
  'product.view', 'product.create', 'product.update', 'product.delete',
  'variant.view', 'variant.create', 'variant.update', 'variant.delete',
  'location.view', 'location.manage',
  'supplier.view', 'supplier.manage',
  'user.view', 'user.manage',
  'purchase.view', 'purchase.create', 'purchase.update', 'purchase.confirm', 'purchase.cancel',
  'transfer.view', 'transfer.create', 'transfer.ship', 'transfer.complete', 'transfer.cancel',
  'sale.create', 'sale.view', 'sale.void', 'sale.ownOnly',
  'return.create', 'return.view',
  'stock.view', 'stock.adjust', 'stock.adjustApprove', 'reservation.manage',
  'report.sales', 'report.stock', 'report.purchases', 'report.transfers', 'report.pnl', 'report.valuation',
  'audit.view',
];

const ALL_REPORTS: Action[] = [
  'report.sales', 'report.stock', 'report.purchases', 'report.transfers', 'report.pnl', 'report.valuation',
];

// ---------------------------------------------------------------------------
// System roles — used to seed the database on first boot.
// ---------------------------------------------------------------------------

export interface SystemRole {
  slug: string;
  name: string;
  description: string;
  permissions: Action[];
}

export const SYSTEM_ROLES: SystemRole[] = [
  {
    slug: 'ADMIN',
    name: 'Admin',
    description: 'Full access to everything, including users and the audit log.',
    permissions: ['*'] as unknown as Action[],
  },
  {
    slug: 'WAREHOUSE_MANAGER',
    name: 'Warehouse Manager',
    description: 'Records purchases, runs transfers both ways, sees warehouse stock and all reports. No POS access.',
    permissions: [
      'product.view', 'product.create', 'product.update',
      'variant.view', 'variant.create', 'variant.update',
      'location.view', 'supplier.view', 'supplier.manage',
      'purchase.view', 'purchase.create', 'purchase.update', 'purchase.confirm', 'purchase.cancel',
      'transfer.view', 'transfer.create', 'transfer.ship', 'transfer.complete', 'transfer.cancel',
      'stock.view', 'stock.adjust', 'stock.adjustApprove', 'reservation.manage',
      ...ALL_REPORTS,
    ],
  },
  {
    slug: 'STORE_MANAGER',
    name: 'Store Manager',
    description: 'Runs the shop floor: POS, returns, transfers out of the store, and store-level reports.',
    permissions: [
      'product.view', 'variant.view',
      'location.view', 'supplier.view',
      'transfer.view', 'transfer.create', 'transfer.complete',
      'sale.create', 'sale.view', 'sale.void',
      'return.create', 'return.view',
      'stock.view', 'stock.adjust', 'reservation.manage',
      'report.sales', 'report.stock', 'report.pnl',
    ],
  },
  {
    slug: 'CASHIER',
    name: 'Cashier',
    description: 'Sells at the assigned store and sees only their own tickets. No approvals, no master data writes.',
    permissions: [
      'product.view', 'variant.view', 'location.view',
      'sale.create', 'sale.view', 'sale.ownOnly',
      'return.create', 'return.view',
      'stock.view',
      'report.sales', 'report.stock',
    ],
  },
  {
    slug: 'AUDITOR',
    name: 'Auditor / Viewer',
    description: 'Read-only access across reports, stock, and the audit log.',
    permissions: [
      'product.view', 'variant.view', 'location.view', 'supplier.view',
      'purchase.view', 'transfer.view', 'sale.view', 'return.view',
      'stock.view', 'audit.view',
      ...ALL_REPORTS,
    ],
  },
];

// ---------------------------------------------------------------------------
// Synchronous matrix — kept for backward compat and fast in-process checks.
// The database-backed permissions (loaded via loadRolePermissions) are the
// source of truth for guard() calls.
// ---------------------------------------------------------------------------

const MATRIX: Record<Role, Action[]> = {
  ADMIN: ['*'] as unknown as Action[],

  WAREHOUSE_MANAGER: [
    'product.view', 'product.create', 'product.update',
    'variant.view', 'variant.create', 'variant.update',
    'location.view', 'supplier.view', 'supplier.manage',
    'purchase.view', 'purchase.create', 'purchase.update', 'purchase.confirm', 'purchase.cancel',
    'transfer.view', 'transfer.create', 'transfer.ship', 'transfer.complete', 'transfer.cancel',
    'stock.view', 'stock.adjust', 'stock.adjustApprove', 'reservation.manage',
    ...ALL_REPORTS,
  ],

  STORE_MANAGER: [
    'product.view', 'variant.view',
    'location.view', 'supplier.view',
    'transfer.view', 'transfer.create', 'transfer.complete',
    'sale.create', 'sale.view', 'sale.void',
    'return.create', 'return.view',
    'stock.view', 'stock.adjust', 'reservation.manage',
    'report.sales', 'report.stock', 'report.pnl',
  ],

  CASHIER: [
    'product.view', 'variant.view', 'location.view',
    'sale.create', 'sale.view', 'sale.ownOnly',
    'return.create', 'return.view',
    'stock.view',
    'report.sales', 'report.stock',
  ],

  AUDITOR: [
    'product.view', 'variant.view', 'location.view', 'supplier.view',
    'purchase.view', 'transfer.view', 'sale.view', 'return.view',
    'stock.view', 'audit.view',
    ...ALL_REPORTS,
  ],
};

/** Synchronous check against the hardcoded matrix (used in UI and fast paths). */
export function can(role: Role, action: Action): boolean {
  const allowed = MATRIX[role] ?? [];
  return allowed.includes('*' as Action) || allowed.includes(action);
}

export function allowedActions(role: Role): Action[] {
  const allowed = MATRIX[role] ?? [];
  return allowed.includes('*' as Action) ? [...ALL_ACTIONS] : allowed;
}

// ---------------------------------------------------------------------------
// In-memory permission cache (DB-backed, 5-minute TTL).
// ---------------------------------------------------------------------------

interface CacheEntry {
  permissions: Set<string>;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const permissionCache = new Map<string, CacheEntry>();

/**
 * Load a role's permissions from the database (with in-memory caching).
 * Returns a Set of action strings. If the role has '*' → returns ALL_ACTIONS.
 */
export async function loadRolePermissions(roleId: string): Promise<Set<string>> {
  const cached = permissionCache.get(roleId);
  if (cached && cached.expiresAt > Date.now()) return cached.permissions;

  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { permissions: true },
  });

  if (!role) return new Set<string>();

  const actions = role.permissions.map((p) => p.action);
  const set = actions.includes('*') ? new Set(ALL_ACTIONS as unknown as string[]) : new Set(actions);

  permissionCache.set(roleId, { permissions: set, expiresAt: Date.now() + CACHE_TTL_MS });
  return set;
}

/** Invalidate a role's cached permissions (called when admin updates role). */
export function invalidateRoleCache(roleId: string): void {
  permissionCache.delete(roleId);
}

/** Invalidate all cached permissions (called when any role is modified). */
export function invalidateAllRoleCache(): void {
  permissionCache.clear();
}

/** Async permission check against the database. */
export async function canDb(roleId: string, action: Action): Promise<boolean> {
  const perms = await loadRolePermissions(roleId);
  return perms.has(action);
}

// ---------------------------------------------------------------------------
// Location scoping
// ---------------------------------------------------------------------------

/** Roles that are location-scoped: they may only touch their assigned stores. */
const LOCATION_SCOPED: Role[] = ['WAREHOUSE_MANAGER', 'STORE_MANAGER', 'CASHIER'];

export interface GuardContext extends SessionUser {
  ip: string | null;
  userAgent: string | null;
  tenantId?: string | null;
}

/**
 * Which side of a move the caller must be assigned to.
 */
export type ScopeSide = 'source' | 'destination';

/**
 * Single entry point for endpoint protection.
 *  - checks the JWT + active user
 *  - checks the action against the role matrix
 *  - checks that `locationId` is one the user is assigned to (scoped roles)
 *  - optionally requires the location to carry a capability flag
 */
export async function guard(opts: {
  action: Action;
  locationId?: string | null;
  require?: { canReceivePurchase?: boolean; canSellPos?: boolean; type?: string; allowDirectToStore?: boolean };
  /** Only enforced when a locationId is supplied. */
  scope?: ScopeSide;
}): Promise<GuardContext> {
  const user = await getSessionUser();
  if (!user) throw new AuthError('Authentication required. Please sign in.', 401);

  // Check permissions: prefer DB-backed if roleId exists, else fall back to hardcoded matrix
  let permitted = false;
  if (user.roleId) {
    permitted = await canDb(user.roleId, opts.action);
  } else {
    permitted = can(user.role as Role, opts.action);
  }

  if (!permitted) {
    throw new AuthError(
      `Forbidden: role ${user.role} is not permitted to perform "${opts.action}".`,
      403,
    );
  }

  const meta = await requestMeta();
  const ctx: GuardContext = { ...user, ...meta, tenantId: user.tenantId ?? null };

  if (opts.locationId) {
    await assertLocationAccess(ctx, opts.locationId, opts.require);
  } else if (opts.require) {
    throw new AuthError('A location is required for this operation.', 400);
  }

  return ctx;
}

/** Like guard() but returns null instead of throwing, for optional auth. */
export async function tryGuard(opts: {
  action: Action;
  locationId?: string | null;
}): Promise<GuardContext | null> {
  try {
    return await guard(opts);
  } catch {
    return null;
  }
}

/**
 * May a location act as a purchase / opening-stock receiving point?
 * Yes when flagged. Otherwise — for a tenant that has NO receiving location
 * at all — an active retail store that sells at POS qualifies, so store-only
 * accounts (no warehouse) can stock their shop directly.
 */
export async function locationCanReceivePurchase(
  ctx: { tenantId?: string | null },
  location: { type: string; canSellPos: boolean; isActive: boolean; canReceivePurchase?: boolean },
): Promise<boolean> {
  if (location.canReceivePurchase) return true;
  if (!ctx.tenantId || location.type !== 'RETAIL_STORE' || !location.canSellPos || !location.isActive) {
    return false;
  }
  const hasReceiving = await prisma.location.count({
    where: { tenantId: ctx.tenantId, canReceivePurchase: true },
  });
  return hasReceiving === 0;
}

export async function assertLocationAccess(
  ctx: GuardContext,
  locationId: string,
  require?: { canReceivePurchase?: boolean; canSellPos?: boolean; type?: string; allowDirectToStore?: boolean },
): Promise<void> {
  const location = await prisma.location.findUnique({ where: { id: locationId } });
  if (!location || !location.isActive) {
    throw new AuthError('Location not found or inactive.', 404);
  }

  if (LOCATION_SCOPED.includes(ctx.role as Role) && !ctx.locationIds.includes(locationId)) {
    throw new AuthError(
      `Forbidden: you are not assigned to location "${location.name}".`,
      403,
    );
  }

  if (require?.type && location.type !== require.type) {
    throw new AuthError(`Location "${location.name}" must be of type ${require.type}.`, 422);
  }
  if (require?.canReceivePurchase) {
    const mayReceive =
      location.canReceivePurchase ||
      (require.allowDirectToStore === true && (await locationCanReceivePurchase(ctx, location)));
    if (!mayReceive) {
      throw new AuthError(
        `Location "${location.name}" cannot receive purchases (can_receive_purchase = false).`,
        422,
      );
    }
  }
  if (require?.canSellPos && !location.canSellPos) {
    throw new AuthError(
      `Location "${location.name}" cannot sell at POS (can_sell_pos = false).`,
      422,
    );
  }
}

/** Returns the location ids a user may query in reports/lists. Null = all. */
export function scopedLocationIds(ctx: GuardContext): string[] | null {
  if (!LOCATION_SCOPED.includes(ctx.role as Role)) return null;
  return ctx.locationIds;
}

/** Returns the tenant_id from the guard context, or null if not in a tenant. */
export function getTenantId(ctx: GuardContext): string | null {
  return ctx.tenantId ?? null;
}

export function jsonError(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : 'Unexpected server error';
  logError('api error', {}, err);
  return NextResponse.json({ error: 'Unexpected server error' }, { status: 500 });
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function conflict(message: string, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status: 409 });
}
