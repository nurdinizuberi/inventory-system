'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ROLE_LABELS } from '@/lib/types';

interface UserDetail {
  id: string;
  email: string;
  name: string;
  role: string;
  roleId: string | null;
  roleRef: { id: string; name: string; slug: string } | null;
  isActive: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tenant: { id: string; name: string; slug: string; isActive: boolean } | null;
  tenantId: string | null;
  locations: {
    assignmentId: string;
    id: string;
    code: string;
    name: string;
    type: string;
    isActive: boolean;
  }[];
  counts: {
    sales: number;
    purchases: number;
    transfers: number;
    adjustments: number;
    auditLogs: number;
  };
}

export default function AdminUserDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [user, setUser] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/users/${id}`);
      const data = await res.json();
      setUser(data.user ?? null);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p className="muted py-6 text-center">Loading…</p>;
  if (!user) return <p className="muted py-6 text-center">User not found.</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-ink-900 dark:text-ink-100">{user.name}</h1>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                user.isActive ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400'
              }`}
            >
              {user.isActive ? 'Active' : 'Inactive'}
            </span>
            {user.emailVerifiedAt && (
              <span className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
                Email verified
              </span>
            )}
          </div>
          <p className="muted mt-1">{user.email}</p>
          {user.tenant && (
            <p className="muted mt-1 text-sm">
              Organization:{' '}
              <Link href={`/admin/tenants/${user.tenant.id}`} className="text-violet-700 hover:underline dark:text-violet-300">
                {user.tenant.name}
              </Link>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link href={user.tenant ? `/admin/tenants/${user.tenant.id}` : '/admin/tenants'} className="btn-ghost btn-sm">
            Back
          </Link>
          <Link href="/admin/tenants" className="btn-ghost btn-sm">
            All organizations
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Sales" value={user.counts.sales} />
        <StatCard label="Purchases" value={user.counts.purchases} />
        <StatCard label="Transfers" value={user.counts.transfers} />
        <StatCard label="Adjustments" value={user.counts.adjustments} />
        <StatCard label="Audit entries" value={user.counts.auditLogs} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="card">
          <div className="border-b border-ink-200 px-4 py-3 dark:border-ink-700">
            <h2 className="section-title">Account</h2>
          </div>
          <dl className="divide-y divide-ink-100 dark:divide-ink-800">
            <Row label="Role">
              {user.roleRef ? `${user.roleRef.name} (${user.role})` : (ROLE_LABELS[user.role as keyof typeof ROLE_LABELS] ?? user.role)}
            </Row>
            <Row label="Email">{user.email}</Row>
            <Row label="Email verified">{user.emailVerifiedAt ? new Date(user.emailVerifiedAt).toLocaleString() : 'Not verified'}</Row>
            <Row label="Created">{new Date(user.createdAt).toLocaleString()}</Row>
            <Row label="Last updated">{new Date(user.updatedAt).toLocaleString()}</Row>
          </dl>
        </div>

        <div className="card">
          <div className="border-b border-ink-200 px-4 py-3 dark:border-ink-700">
            <h2 className="section-title">Locations ({user.locations.length})</h2>
          </div>
          {user.locations.length === 0 ? (
            <p className="muted p-6 text-center">No assigned locations.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {user.locations.map((loc) => (
                    <tr key={loc.assignmentId}>
                      <td className="font-mono text-sm text-ink-500 dark:text-ink-400">{loc.code}</td>
                      <td className="font-medium text-ink-900 dark:text-ink-100">{loc.name}</td>
                      <td className="text-sm text-ink-600 dark:text-ink-300">{loc.type}</td>
                      <td>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            loc.isActive ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400'
                          }`}
                        >
                          {loc.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 px-4 py-3 text-sm">
      <dt className="text-ink-500 dark:text-ink-400">{label}</dt>
      <dd className="text-ink-900 dark:text-ink-100">{children}</dd>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card card-pad">
      <p className="text-sm text-ink-500 dark:text-ink-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-900 dark:text-ink-100">{value.toLocaleString()}</p>
    </div>
  );
}