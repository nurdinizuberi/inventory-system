'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  counts: {
    users: number;
    locations: number;
    products: number;
    sales: number;
    purchases: number;
    transfers: number;
  };
  users: {
    id: string;
    email: string;
    name: string;
    role: string;
    isActive: boolean;
    createdAt: string;
  }[];
  locations: {
    id: string;
    code: string;
    name: string;
    type: string;
    isActive: boolean;
  }[];
}

export default function TenantDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/tenants/${id}`);
      const data = await res.json();
      setTenant(data.tenant ?? null);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleActive = async () => {
    if (!tenant) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/tenants/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !tenant.isActive }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to update tenant');
      await load();
    } catch (err) {
      console.error('toggle tenant active failed', err);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="muted py-6 text-center">Loading…</p>;
  if (!tenant) return <p className="muted py-6 text-center">Tenant not found.</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-ink-900 dark:text-ink-100">{tenant.name}</h1>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                tenant.isActive ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400'
              }`}
            >
              {tenant.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>
          <p className="muted mt-1">
            Subdomain: <span className="font-mono">{tenant.slug}.yourapp.com</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={tenant.isActive ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
            disabled={busy}
            onClick={toggleActive}
            type="button"
          >
            {busy ? 'Updating…' : tenant.isActive ? 'Deactivate' : 'Activate'}
          </button>
          <Link href="/admin/tenants" className="btn-ghost btn-sm">
            Back to list
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Users" value={tenant.counts.users} />
        <StatCard label="Locations" value={tenant.counts.locations} />
        <StatCard label="Products" value={tenant.counts.products} />
        <StatCard label="Sales" value={tenant.counts.sales} />
        <StatCard label="Purchases" value={tenant.counts.purchases} />
        <StatCard label="Transfers" value={tenant.counts.transfers} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="card">
          <div className="border-b border-ink-200 px-4 py-3 dark:border-ink-700">
            <h2 className="section-title">Users ({tenant.users.length})</h2>
          </div>
          {tenant.users.length === 0 ? (
            <p className="muted p-6 text-center">No users yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tenant.users.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <Link href={`/admin/users/${user.id}`} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
                          {user.name}
                        </Link>
                      </td>
                      <td className="text-sm text-ink-500 dark:text-ink-400">{user.email}</td>
                      <td className="text-sm text-ink-600 dark:text-ink-300">{user.role}</td>
                      <td>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            user.isActive ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400'
                          }`}
                        >
                          {user.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="border-b border-ink-200 px-4 py-3 dark:border-ink-700">
            <h2 className="section-title">Locations ({tenant.locations.length})</h2>
          </div>
          {tenant.locations.length === 0 ? (
            <p className="muted p-6 text-center">No locations yet.</p>
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
                  {tenant.locations.map((loc) => (
                    <tr key={loc.id}>
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

      <div className="text-xs text-ink-400 dark:text-ink-500">
        Created: {new Date(tenant.createdAt).toLocaleString()} · Last updated:{' '}
        {new Date(tenant.updatedAt).toLocaleString()}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card card-pad">
      <p className="text-xs text-ink-500 dark:text-ink-400">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink-900 dark:text-ink-100">{value.toLocaleString()}</p>
    </div>
  );
}
