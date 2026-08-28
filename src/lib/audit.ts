import { prisma } from './db';
import type { GuardContext } from './rbac';
import { diffObjects, safeSnapshot } from './utils';

// ---------------------------------------------------------------------------
// Audit trail. Deliberately separate from StockMovement (business data):
// this is the SYSTEM activity log. Written through this one function and never
// exposed through any update/delete endpoint.
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'create' | 'update' | 'delete' | 'confirm' | 'approve' | 'reject'
  | 'cancel' | 'ship' | 'complete' | 'void' | 'login' | 'logout' | 'password_change';

export interface AuditInput {
  ctx?: Partial<GuardContext> | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export async function audit(input: AuditInput): Promise<void> {
  const { ctx } = input;
  let beforeJson: string | null = null;
  let afterJson: string | null = null;
  let changed: string[] | null = null;

  if (input.action === 'update') {
    const d = diffObjects(
      safeSnapshot(input.before as Record<string, unknown>),
      safeSnapshot(input.after as Record<string, unknown>),
    );
    beforeJson = JSON.stringify(d.before);
    afterJson = JSON.stringify(d.after);
    changed = d.changed;
  } else {
    beforeJson = input.before === undefined ? null : JSON.stringify(safeSnapshot(input.before));
    afterJson = input.after === undefined ? null : JSON.stringify(safeSnapshot(input.after));
  }

  await prisma.auditLog.create({
    data: {
      tenantId: ctx?.tenantId ?? null,
      userId: ctx?.id ?? null,
      userEmail: ctx?.email ?? 'system',
      userRole: ctx?.role ?? 'SYSTEM',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      entityLabel: input.entityLabel ?? null,
      before: beforeJson,
      after: afterJson,
      ipAddress: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      metadata: JSON.stringify({ ...(input.metadata ?? {}), ...(changed ? { changed } : {}) }),
    },
  });
}

export function describeEntity(type: string, id?: string | null, label?: string | null): string {
  return label ? `${type} · ${label}` : `${type}${id ? ` · ${id}` : ''}`;
}
