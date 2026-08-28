import { NextResponse } from 'next/server';
import { bootstrapDatabase } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { can, loadRolePermissions, ALL_ACTIONS, type Action } from '@/lib/rbac';
import { ROLES, type Role } from '@/lib/types';

export async function GET() {
  await bootstrapDatabase();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ user: null }, { status: 401 });

  // Use DB-backed permissions if roleId exists, else fall back to hardcoded matrix
  let permissions: Record<string, boolean>;
  if (user.roleId) {
    const rolePerms = await loadRolePermissions(user.roleId);
    permissions = Object.fromEntries(
      ALL_ACTIONS.map((action) => [action, rolePerms.has(action)]),
    );
  } else {
    permissions = Object.fromEntries(
      ALL_ACTIONS.map((action) => [action, user.role === 'ADMIN' ? true : can(user.role, action)]),
    );
  }

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      locations: user.locations,
      locationIds: user.locationIds,
      unrestricted: user.role === 'ADMIN' || user.role === 'AUDITOR',
    },
    permissions,
    roles: ROLES as unknown as Role[],
  });
}
