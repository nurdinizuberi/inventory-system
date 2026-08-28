'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  userCount: number;
  locationCount: number;
  productCount: number;
  salesCount: number;
}

export default function TenantsPage() {
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

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900 dark:text-ink-100">Organizations</h1>
          <p className="muted mt-1">Manage tenant organizations. Each tenant has its own users, inventory, and sales.</p>
        </div>
        <Link href="/admin/tenants/new" className="btn-primary btn-sm">
          New organization
        </Link>
      </div>

      <div className="card">
        {loading ? (
          <p className="muted p-6 text-center">Loading…</p>
        ) : tenants.length === 0 ? (
          <p className="muted p-6 text-center">No organizations yet.</p>
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
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => (
                  <tr key={tenant.id}>
                    <td className="font-medium text-ink-900 dark:text-ink-100">{tenant.name}</td>
                    <td className="font-mono text-sm text-ink-500 dark:text-ink-400">{tenant.slug}.yourapp.com</td>
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
                    <td className="text-sm text-ink-500 dark:text-ink-400">
                      {new Date(tenant.createdAt).toLocaleDateString()}
                    </td>
                    <td>
                      <Link href={`/admin/tenants/${tenant.id}`} className="text-sm text-violet-600 hover:underline dark:text-violet-400">
                        Manage
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
