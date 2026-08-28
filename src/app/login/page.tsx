'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-context';
import { ThemeToggle } from '@/components/theme-context';
import { errorMessage } from '@/lib/client';

const DEMO_ACCOUNTS = [
  { email: 'admin@ims.tz', password: 'admin123', role: 'Admin', note: 'Full access, incl. audit log' },
  { email: 'wh.manager@ims.tz', password: 'warehouse123', role: 'Warehouse Manager', note: 'Purchases + transfers, no POS' },
  { email: 'store.mbezi@ims.tz', password: 'store123', role: 'Store Manager', note: 'POS at Mbezi Beach only' },
  { email: 'store.kariakoo@ims.tz', password: 'store123', role: 'Store Manager', note: 'POS at Kariakoo only' },
  { email: 'cashier@ims.tz', password: 'cashier123', role: 'Cashier', note: 'Sells only, own tickets only' },
  { email: 'auditor@ims.tz', password: 'audit123', role: 'Auditor', note: 'Read-only everywhere' },
];

export default function LoginPage() {
  const { login, user, loading } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('admin@ims.tz');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/');
  }, [loading, user, router]);

  if (!loading && user) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative grid min-h-screen lg:grid-cols-2">
      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle />
      </div>
      <div className="flex flex-col justify-center bg-ink-900 px-6 py-12 text-white sm:px-12">
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-400">MindBoxAfrica</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight">
          Inventory that follows the goods,
          <br />
          not a spreadsheet.
        </h1>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-ink-300">
          Every unit is tracked per variant, per location, on an append-only movement ledger. Purchases open costed
          batches in the warehouse, transfers move stock to the front stores, the POS sells from the oldest batch
          first, and every write is stamped in the audit log.
        </p>
        <ul className="mt-8 space-y-2 text-sm text-ink-300">
          <li>· Stock on hand is derived — never a stored counter</li>
          <li>· FIFO costing, so margin is real, not assumed</li>
          <li>· Role + location checks enforced on the server</li>
        </ul>
      </div>

      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-100">MindBoxAfrica</p>
          <h2 className="text-lg font-semibold text-ink-900 dark:text-ink-100">Sign in</h2>
          <p className="muted mt-1">Use one of the demo accounts below, or your own credentials.</p>

          <form className="mt-6 space-y-4" onSubmit={submit}>
            <label className="block">
              <span className="label">Email</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="block">
              <span className="label">Password</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}
            <button className="btn-primary w-full" disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="mt-8">
            <p className="label">Demo accounts — click to fill</p>
            <div className="space-y-1.5">
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.email}
                  type="button"
                  onClick={() => {
                    setEmail(account.email);
                    setPassword(account.password);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-ink-200 px-3 py-2 text-left text-xs transition hover:border-ink-400 hover:bg-ink-50 dark:border-ink-700 dark:hover:border-ink-500 dark:hover:bg-ink-800/50"
                >
                  <span>
                    <span className="font-medium text-ink-900 dark:text-ink-100">{account.role}</span>
                    <span className="block text-ink-500 dark:text-ink-400">{account.note}</span>
                  </span>
                  <span className="font-mono text-ink-400 dark:text-ink-400/80">{account.password}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
