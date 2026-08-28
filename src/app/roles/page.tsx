'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';

interface PermissionGroup {
  key: string;
  label: string;
  actions: { action: string; label: string }[];
}

interface RoleRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isSystemRole: boolean;
  userCount: number;
  permissions: string[];
}

export default function RolesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [form, setForm] = useState({ name: '', slug: '', description: '', permissions: [] as string[] });

  const load = useCallback(async () => {
    try {
      const [rolesData, permsData] = await Promise.all([
        api.get<{ roles: RoleRow[] }>('/api/roles'),
        api.get<{ groups: PermissionGroup[] }>('/api/roles/permissions'),
      ]);
      setRoles(rolesData.roles);
      setGroups(permsData.groups);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const togglePerm = (action: string) => {
    setForm((prev) => ({
      ...prev,
      permissions: prev.permissions.includes(action)
        ? prev.permissions.filter((a) => a !== action)
        : [...prev.permissions, action],
    }));
  };

  const toggleGroup = (groupActions: string[]) => {
    setForm((prev) => {
      const allSelected = groupActions.every((a) => prev.permissions.includes(a));
      return {
        ...prev,
        permissions: allSelected
          ? prev.permissions.filter((a) => !groupActions.includes(a))
          : [...new Set([...prev.permissions, ...groupActions])],
      };
    });
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`/api/roles/${editing.id}`, {
          name: form.name,
          description: form.description || null,
          permissions: form.permissions,
        });
        toast.push('success', `Role "${form.name}" updated.`);
      } else {
        await api.post('/api/roles', {
          name: form.name,
          slug: form.slug,
          description: form.description || null,
          permissions: form.permissions,
        });
        toast.push('success', `Role "${form.name}" created.`);
      }
      setOpen(false);
      setEditing(null);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (role: RoleRow) => {
    if (!confirm(`Delete role "${role.name}"? This cannot be undone.`)) return;
    try {
      await api.del(`/api/roles/${role.id}`);
      toast.push('success', `Role "${role.name}" deleted.`);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  if (!can('user.manage')) {
    return (
      <Shell>
        <PageHeader title="Roles & permissions" description="You do not have permission to manage roles." />
      </Shell>
    );
  }

  return (
    <Shell>
      <PageHeader
        title="Roles & permissions"
        description="Create and manage roles. Each role grants a set of permissions that are enforced server-side on every request."
        action={
          <button
            className="btn-primary"
            onClick={() => {
              setEditing(null);
              setForm({ name: '', slug: '', description: '', permissions: [] });
              setOpen(true);
            }}
            type="button"
          >
            New role
          </button>
        }
      />

      <Card>
        {roles.length === 0 ? (
          <Empty message="No roles found." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Slug</th>
                  <th>Description</th>
                  <th className="text-right">Users</th>
                  <th className="text-right">Permissions</th>
                  <th>System</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td className="font-medium">{role.name}</td>
                    <td className="font-mono text-xs text-ink-600 dark:text-ink-300">{role.slug}</td>
                    <td className="text-sm text-ink-600 dark:text-ink-300 max-w-[20rem] truncate">{role.description ?? '—'}</td>
                    <td className="text-right tabular-nums">{role.userCount}</td>
                    <td className="text-right tabular-nums">
                      <Badge tone={role.permissions.includes('*') ? 'violet' : 'blue'}>
                        {role.permissions.includes('*') ? 'all' : role.permissions.length}
                      </Badge>
                    </td>
                    <td>
                      {role.isSystemRole && <Badge tone="amber">system</Badge>}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <button
                        className="btn-secondary btn-sm"
                        onClick={() => {
                          setEditing(role);
                          setForm({
                            name: role.name,
                            slug: role.slug,
                            description: role.description ?? '',
                            permissions: role.permissions.includes('*')
                              ? groups.flatMap((g) => g.actions.map((a) => a.action))
                              : role.permissions,
                          });
                          setOpen(true);
                        }}
                        type="button"
                      >
                        Edit
                      </button>
                      {!role.isSystemRole && (
                        <button className="btn-ghost btn-sm ml-1" onClick={() => remove(role)} type="button">
                          Delete
                        </button>
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
        title={editing ? `Edit role — ${editing.name}` : 'New role'}
        wide
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={busy || !form.name || (!editing && !form.slug) || form.permissions.length === 0}
              onClick={submit}
              type="button"
            >
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create role'}
            </button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role name" hint="Display name, e.g. Regional Manager">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            {!editing && (
              <Field label="Slug" hint="UPPERCASE identifier, e.g. REGIONAL_MANAGER">
                <input
                  className="input font-mono"
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}
                />
              </Field>
            )}
          </div>
          <Field label="Description" hint="Optional — explains what this role can do">
            <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>

          <div>
            <span className="label">Permissions</span>
            <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">Select the permissions this role grants. Changes take effect immediately for all users with this role.</p>

            <div className="mt-3 space-y-4">
              {groups.map((group) => {
                const groupActions = group.actions.map((a) => a.action);
                const selectedCount = groupActions.filter((a) => form.permissions.includes(a)).length;
                const allSelected = selectedCount === groupActions.length;
                const someSelected = selectedCount > 0 && !allSelected;

                return (
                  <div key={group.key} className="rounded-lg border border-ink-200 p-3 dark:border-ink-700">
                    <label className="flex items-center gap-2 text-sm font-medium text-ink-900 dark:text-ink-100">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = someSelected; }}
                        onChange={() => toggleGroup(groupActions)}
                      />
                      {group.label}
                      <span className="text-xs text-ink-400 dark:text-ink-500">({selectedCount}/{groupActions.length})</span>
                    </label>
                    <div className="mt-2 grid gap-1 sm:grid-cols-2 pl-6">
                      {group.actions.map((a) => (
                        <label key={a.action} className="flex items-center gap-2 text-sm text-ink-700 dark:text-ink-300">
                          <input
                            type="checkbox"
                            checked={form.permissions.includes(a.action)}
                            onChange={() => togglePerm(a.action)}
                          />
                          {a.label}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Modal>
    </Shell>
  );
}
