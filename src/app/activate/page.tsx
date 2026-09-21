'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ThemeToggle } from '@/components/theme-context';
import { api, errorMessage } from '@/lib/client';

interface ActivationContext {
  name: string;
  email: string;
  role: string;
  alreadyActive: boolean;
}

function ActivationForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [context, setContext] = useState<ActivationContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setLoadError('This activation link is missing its token. Ask an admin to resend the invitation.');
        return;
      }
      try {
        const data = await api.get<{ activation: ActivationContext }>(`/api/auth/activate?token=${encodeURIComponent(token)}`);
        if (!cancelled) {
          setContext(data.activation);
          setName(data.activation.name);
        }
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/activate', { token, name, phone: phone || undefined, password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-ink-50 px-4 py-10 dark:bg-ink-950">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-ink-900 dark:text-ink-100">MindBoxAfrica</h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">Activate your account</p>
        </div>

        <div className="card card-pad">
          {loadError ? (
            <div className="space-y-3">
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{loadError}</p>
              <Link href="/login" className="btn-primary block w-full text-center">
                Go to sign in
              </Link>
            </div>
          ) : !context ? (
            <p className="muted py-6 text-center text-sm">Checking your activation link…</p>
          ) : done ? (
            <div className="space-y-3 text-center">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Your account is active.</p>
              <p className="text-sm text-ink-600 dark:text-ink-300">
                Your email is verified and your password is set. You can sign in now.
              </p>
              <Link href="/login" className="btn-primary inline-block w-full text-center">
                Go to sign in
              </Link>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={submit}>
              <p className="text-sm text-ink-600 dark:text-ink-300">
                Welcome{context.name ? `, ${context.name}` : ''} — your account
                {context.alreadyActive ? ' is already active.' : ' is awaiting activation.'} Confirm your details and
                choose a password to finish setting up.
              </p>

              <label className="block">
                <span className="label">Email (verified via this link)</span>
                <input className="input" type="email" value={context.email} disabled />
              </label>

              <label className="block">
                <span className="label">Full name</span>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  minLength={2}
                  required
                />
              </label>

              <label className="block">
                <span className="label">Phone (optional)</span>
                <input
                  className="input"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoComplete="tel"
                  placeholder="+255 …"
                />
              </label>

              <label className="block">
                <span className="label">Create password</span>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>

              <label className="block">
                <span className="label">Confirm password</span>
                <input
                  className="input"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>

              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>
              )}

              <button className="btn-primary w-full" disabled={busy} type="submit">
                {busy ? 'Activating…' : 'Activate account'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ActivatePage() {
  return (
    <Suspense>
      <ActivationForm />
    </Suspense>
  );
}
