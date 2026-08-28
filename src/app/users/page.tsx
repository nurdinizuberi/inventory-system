'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { ROLE_LABELS, type Role } from '@/lib/types';
import { formatDate } from '@/lib/utils';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  roleId?: string | null;
  roleDisplayName?: string;
  isActive: boolean;
  createdAt: string;
  locations: { id: string; name: string; code: string; type: string }[];
}

interface RoleOption {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  isSystemRole: boolean;
  userCount: number;
}

interface LocationOption {
  id: string;
  name: string;
  code: string;
  type: string;
}

const ROLE_HINTS: Record<string, string> = {
  ADMIN: 'Everything, including users and the audit log.',
  WAREHOUSE_MANAGER: 'Purchases, transfers, warehouse stock and all reports. No POS.',
  STORE_MANAGER: 'POS, returns and transfers for their own store, plus store reports.',
  CASHIER: 'Sells at their assigned store and sees only their own tickets.',
  AUDITOR: 'Read-only across reports, stock and the audit log.',
};

export default function UsersPage() {
  const { can, refresh } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [allRoles, setAllRoles] = useState<RoleOption[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'CASHIER' as Role,
    roleId: '' as string,
    locationIds: [] as string[],
    isActive: true,
  });

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ users: UserRow[]; locations: LocationOption[]; allRoles: RoleOption[] }>('/api/users');
      setUsers(data.users);
      setLocations(data.locations);
      setAllRoles(data.allRoles ?? []);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const systemRoleId = (slug: string) => allRoles.find((r) => r.slug === slug)?.id ?? '';
  const legacyRoles = useMemo(
    () => Object.entries(ROLE_LABELS).filter(([value]) => !allRoles.some((r) => r.slug === value)),
    [allRoles],
  );

  const submit = async () => {
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`/api/users/${editing.id}`, {
          name: form.name,
          email: form.email,
          role: form.role,
          roleId: form.roleId || undefined,
          isActive: form.isActive,
          locationIds: form.locationIds,
          ...(form.password ? { password: form.password } : {}),
        });
        toast.push('success', 'User updated.');
      } else {
        await api.post('/api/users', {
          name: form.name,
          email: form.email,
          password: form.password,
          role: form.role,
          roleId: form.roleId || undefined,
          locationIds: form.locationIds,
        });
        toast.push('success', 'User created.');
      }
      setOpen(false);
      setEditing(null);
      await load();
      await refresh();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (user: UserRow) => {
    try {
      await api.patch(`/api/users/${user.id}`, { isActive: !user.isActive });
      toast.push('success', `${user.name} ${user.isActive ? 'deactivated' : 'reactivated'}.`);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  return (
    <Shell>
      <PageHeader
        title="Users & roles"
        description="Every user is tied to the locations they may operate on. Permissions are enforced server-side on every request."
        action={
          can('user.manage') && (
            <button
              className="btn-primary"
              onClick={() => {
                setEditing(null);
                setForm({ name: '', email: '', password: '', role: 'CASHIER', roleId: systemRoleId('CASHIER'), locationIds: [], isActive: true });
                setOpen(true);
              }}
              type="button"
            >
              New user
            </button>
          )
        }
      />

      <Card>
        {users.length === 0 ? (
          <Empty message="No users." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Locations</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="font-medium">{user.name}</td>
                    <td className="font-mono text-xs text-ink-600 dark:text-ink-300">{user.email}</td>
                    <td>
                      <Badge tone={user.role === 'ADMIN' ? 'violet' : user.role === 'AUDITOR' ? 'blue' : user.roleId ? 'blue' : 'neutral'}>
                        {user.roleDisplayName ?? ROLE_LABELS[user.role as Role] ?? user.role}
                      </Badge>
                    </td>
                    <td className="text-xs text-ink-600 dark:text-ink-300">
                      {user.locations.length ? user.locations.map((l) => l.name).join(', ') : 'All (unrestricted)'}
                    </td>
                    <td>
                      <Badge tone={user.isActive ? 'green' : 'red'}>{user.isActive ? 'active' : 'disabled'}</Badge>
                    </td>
                    <td>{formatDate(user.createdAt)}</td>
                    <td className="whitespace-nowrap text-right">
                      {can('user.manage') && (
                        <>
                          <button
                            className="btn-secondary btn-sm"
                            onClick={() => {
                              setEditing(user);
                              setForm({
                                name: user.name,
                                email: user.email,
                                password: '',
                                role: user.role as Role,
                                roleId: user.roleId ?? systemRoleId(user.role),
                                locationIds: user.locations.map((l) => l.id),
                                isActive: user.isActive,
                              });
                              setOpen(true);
                            }}
                            type="button"
                          >
                            Edit
                          </button>
                          <button className="btn-ghost btn-sm" onClick={() => toggleActive(user)} type="button">
                            {user.isActive ? 'Disable' : 'Enable'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Modal
        open={open}
        title={editing ? `Edit ${editing.name}` : 'New user'}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || !form.name || !form.email} onClick={submit} type="button">
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create user'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Email">
              <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label={editing ? 'New password (optional)' : 'Password'}>
              <input
                className="input"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
            <Field label="Role" hint={form.roleId ? allRoles.find((r) => r.id === form.roleId)?.description ?? ROLE_HINTS[form.role] : ROLE_HINTS[form.role]}>
              <select
                className="input"
                value={form.roleId || form.role}
                onChange={(e) => {
                  const val = e.target.value;
                  const matchedRole = allRoles.find((r) => r.id === val);
                  if (matchedRole) {
                    setForm({ ...form, roleId: matchedRole.id, role: matchedRole.slug as Role });
                  } else {
                    setForm({ ...form, roleId: '', role: val as Role });
                  }
                }}
              >
                {allRoles.length > 0 && (
                  <optgroup label="All roles">
                    {allRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} {r.isSystemRole ? '(system)' : ''} — {r.userCount} user(s)
                      </option>
                    ))}
                  </optgroup>
                )}
                {legacyRoles.length > 0 && (
                  <optgroup label="Legacy (hardcoded)">
                    {legacyRoles.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Field>
          </div>

          <div>
            <span className="label">Allowed locations</span>
            <div className="space-y-1.5">
              {locations.map((location) => (
                <label key={location.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.locationIds.includes(location.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        locationIds: e.target.checked
                          ? [...form.locationIds, location.id]
                          : form.locationIds.filter((id) => id !== location.id),
                      })
                    }
                  />
                  {location.name}
                  <span className="text-xs text-ink-400 dark:text-ink-500">
                    {location.code} · {location.type.replace('_', ' ').toLowerCase()}
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-500 dark:text-ink-400">
              Admin and Auditor are unrestricted by design; every other role is limited to the locations ticked here.
            </p>
          </div>

          {editing && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              />
              Account is active
            </label>
          )}
        </div>
      </Modal>
    </Shell>
  );
}
