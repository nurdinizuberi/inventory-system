'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ThemeToggle } from '@/components/theme-context';
import { api, errorMessage } from '@/lib/client';

export default function AdminForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/auth/forgot-password', { email });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-violet-50 px-4 dark:bg-violet-950">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-violet-900 dark:text-violet-100">MindBoxAfrica</h1>
          <p className="mt-1 text-sm text-violet-600 dark:text-violet-300">Global Administration Portal</p>
        </div>
        <div className="card card-pad">
          <h2 className="text-lg font-semibold text-ink-900 dark:text-ink-100">Reset password</h2>
          <p className="muted mt-1 text-sm">Enter your global admin email and we&apos;ll send a reset link.</p>
          {done ? (
            <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-900/30 dark:text-green-300">
              If that account exists, a reset link is on its way.
            </p>
          ) : (
            <form className="mt-4 space-y-4" onSubmit={submit}>
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
              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
                  {error}
                </p>
              )}
              <button className="btn-primary w-full" disabled={busy} type="submit">
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <p className="text-center text-sm">
                <Link href="/admin" className="text-violet-700 hover:underline dark:text-violet-300">
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
