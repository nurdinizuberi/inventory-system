'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-context';
import { PasswordInput } from '@/components/password-input';
import { ThemeToggle } from '@/components/theme-context';
import { errorMessage } from '@/lib/client';
import { LOCATION_MODE_LABELS, locationMode } from '@/lib/location-mode';

export default function LoginPage() {
  const { login, user, loading, setActiveLocation } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingActivation, setPendingActivation] = useState(false);
  const [busy, setBusy] = useState(false);

  const [selectedLocationId, setSelectedLocationId] = useState('');

  useEffect(() => {
    if (!user) return;
    if (user.locations.length === 1) {
      setActiveLocation(user.locations[0].id);
      router.replace('/');
    } else if (user.locations.length === 0) {
      router.replace('/');
    }
  }, [user, router, setActiveLocation]);

  if (!loading && user && user.locations.length > 1) {
    const selectedLocation = user.locations.find((location) => location.id === selectedLocationId);
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-50 px-6 py-12 dark:bg-ink-950">
        <div className="w-full max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-violet-700 dark:text-violet-300">MindBoxAfrica</p>
          <h1 className="mt-2 text-2xl font-semibold text-ink-900 dark:text-ink-100">Choose your active location</h1>
          <p className="muted mt-1">Your location determines the tools and stock rules you will use.</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {user.locations.map((location) => {
              const mode = locationMode(location.type);
              const selected = selectedLocationId === location.id;
              return (
                <button
                  key={location.id}
                  type="button"
                  onClick={() => setSelectedLocationId(location.id)}
                  className={`rounded-xl border p-4 text-left transition ${
                    selected
                      ? 'border-violet-500 bg-violet-50 ring-2 ring-violet-500/20 dark:bg-violet-900/20'
                      : 'border-ink-200 bg-white hover:border-violet-300 dark:border-ink-700 dark:bg-ink-900'
                  }`}
                >
                  <p className="font-medium text-ink-900 dark:text-ink-100">{location.name}</p>
                  <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">{location.code}</p>
                  <span className={`mt-4 inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                    mode === 'CONTROLLED'
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                  }`}>
                    {LOCATION_MODE_LABELS[mode]}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            className="btn-primary mt-6 w-full sm:w-auto"
            disabled={!selectedLocation}
            onClick={() => {
              if (!selectedLocation) return;
              setActiveLocation(selectedLocation.id);
              router.replace('/');
            }}
            type="button"
          >
            Continue to {selectedLocation?.name ?? 'workspace'}
          </button>
        </div>
      </div>
    );
  }

  if (!loading && user) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
      setPendingActivation(
        err instanceof Error && /not been activated yet/i.test(err.message),
      );
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
          <p className="muted mt-1">Sign in with your credentials.</p>

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
              <PasswordInput value={password} onChange={setPassword} required />
            </label>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}
            {pendingActivation && (
              <p className="text-center text-sm text-ink-600 dark:text-ink-300">
                Lost the email?{' '}
                <Link
                  href={`/forgot-password?email=${encodeURIComponent(email)}`}
                  className="text-violet-700 hover:underline dark:text-violet-300"
                >
                  Resend my activation link
                </Link>
              </p>
            )}
            <button className="btn-primary w-full" disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="text-center text-sm text-ink-600 dark:text-ink-300">
              <Link href="/forgot-password" className="text-violet-700 hover:underline dark:text-violet-300">
                Forgot password?
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
