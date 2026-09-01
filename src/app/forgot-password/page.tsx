'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ThemeToggle } from '@/components/theme-context';
import { api, errorMessage } from '@/lib/client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/forgot-password', { email });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-ink-50 dark:bg-ink-950">
      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle />
      </div>
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <p className="text-center text-sm font-semibold text-ink-900 dark:text-ink-100">MindBoxAfrica</p>
          <h1 className="mt-2 text-center text-lg font-semibold text-ink-900 dark:text-ink-100">Reset password</h1>
          <p className="muted mt-1 text-center text-sm">
            Enter the email for your account and we&apos;ll send a reset link.
          </p>

          <div className="card card-pad mt-6">
            {done ? (
              <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-900/30 dark:text-green-300">
                If an account with that email exists, a reset link is on its way.
              </p>
            ) : (
              <form className="space-y-4" onSubmit={submit}>
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
                <p className="text-center text-sm text-ink-600 dark:text-ink-300">
                  <Link href="/login" className="text-violet-700 hover:underline dark:text-violet-300">
                    Back to sign in
                  </Link>
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
