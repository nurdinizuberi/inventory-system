'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  userCount: number;
  locationCount: number;
  productCount: number;
  salesCount: number;
}

interface Stats {
  totalTenants: number;
  activeTenants: number;
  totalUsers: number;
  totalSales: number;
}

export default function AdminDashboard() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/tenants');
      const data = await res.json();
      setTenants(data.tenants ?? []);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats: Stats = {
    totalTenants: tenants.length,
    activeTenants: tenants.filter((t) => t.isActive).length,
    totalUsers: tenants.reduce((s, t) => s + t.userCount, 0),
    totalSales: tenants.reduce((s, t) => s + t.salesCount, 0),
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900 dark:text-ink-100">Dashboard</h1>
        <p className="muted mt-1">Overview of all organizations on the platform.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Organizations" value={stats.totalTenants} sub={`${stats.activeTenants} active`} />
        <StatCard label="Total Users" value={stats.totalUsers} />
        <StatCard label="Total Sales" value={stats.totalSales} />
        <StatCard label="Active Tenants" value={stats.activeTenants} />
      </div>

      <div className="card">
        <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3 dark:border-ink-700">
          <h2 className="section-title">Organizations</h2>
          <Link href="/admin/tenants/new" className="btn-primary btn-sm">
            New organization
          </Link>
        </div>
        {loading ? (
          <p className="muted p-6 text-center">Loading…</p>
        ) : tenants.length === 0 ? (
          <p className="muted p-6 text-center">No organizations yet. Create one to get started.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Subdomain</th>
                  <th className="text-right">Users</th>
                  <th className="text-right">Locations</th>
                  <th className="text-right">Products</th>
                  <th className="text-right">Sales</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => (
                  <tr key={tenant.id}>
                    <td className="font-medium text-ink-900 dark:text-ink-100">{tenant.name}</td>
                    <td className="font-mono text-sm text-ink-500 dark:text-ink-400">{tenant.slug}</td>
                    <td className="text-right tabular-nums">{tenant.userCount}</td>
                    <td className="text-right tabular-nums">{tenant.locationCount}</td>
                    <td className="text-right tabular-nums">{tenant.productCount}</td>
                    <td className="text-right tabular-nums">{tenant.salesCount}</td>
                    <td>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          tenant.isActive ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400'
                        }`}
                      >
                        {tenant.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <Link href={`/admin/tenants/${tenant.id}`} className="text-sm text-violet-600 hover:underline dark:text-violet-400">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="card card-pad">
      <p className="text-sm text-ink-500 dark:text-ink-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-900 dark:text-ink-100">{value.toLocaleString()}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-400 dark:text-ink-500">{sub}</p>}
    </div>
  );
}
