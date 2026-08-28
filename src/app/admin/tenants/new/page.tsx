'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function NewTenantPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    slug: '',
    adminName: '',
    adminEmail: '',
    adminPassword: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create tenant');
      router.push(`/admin/tenants/${data.tenant.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tenant');
    } finally {
      setBusy(false);
    }
  };

  const autoSlug = form.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900 dark:text-ink-100">New organization</h1>
        <p className="muted mt-1">
          Create a new tenant. They will access the system at <strong>{form.slug || 'slug'}.yourapp.com</strong>
        </p>
      </div>

      <form className="card card-pad space-y-4" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">Organization name</span>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value, slug: autoSlug })}
              required
            />
          </label>
          <label className="block">
            <span className="label">Subdomain</span>
            <div className="flex items-center">
              <input
                className="input flex-1 rounded-r-none"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                pattern="[a-z0-9-]+"
                required
              />
              <span className="rounded-r-lg border border-l-0 border-ink-300 bg-ink-50 px-3 py-2 text-sm text-ink-500 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-400">
                .yourapp.com
              </span>
            </div>
          </label>
        </div>

        <hr className="border-ink-200 dark:border-ink-700" />
        <p className="text-sm font-medium text-ink-700 dark:text-ink-300">Tenant Admin Account</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">Admin name</span>
            <input
              className="input"
              value={form.adminName}
              onChange={(e) => setForm({ ...form, adminName: e.target.value })}
              required
            />
          </label>
          <label className="block">
            <span className="label">Admin email</span>
            <input
              className="input"
              type="email"
              value={form.adminEmail}
              onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
              required
            />
          </label>
        </div>
        <label className="block">
          <span className="label">Admin password</span>
          <input
            className="input"
            type="password"
            value={form.adminPassword}
            onChange={(e) => setForm({ ...form, adminPassword: e.target.value })}
            minLength={6}
            required
          />
          <p className="mt-1 text-xs text-ink-400 dark:text-ink-500">The admin will use this to log in at {form.slug || 'slug'}.yourapp.com</p>
        </label>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}

        <div className="flex items-center gap-3 pt-2">
          <button className="btn-primary" disabled={busy} type="submit">
            {busy ? 'Creating…' : 'Create organization'}
          </button>
          <button className="btn-secondary" type="button" onClick={() => router.back()}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
