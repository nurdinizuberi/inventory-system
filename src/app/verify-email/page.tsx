'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ThemeToggle } from '@/components/theme-context';
import { api, errorMessage } from '@/lib/client';

function VerifyEmailView() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Verifying your email…');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.post('/api/auth/verify-email', { token });
        if (!cancelled) setState('success');
      } catch (err) {
        if (!cancelled) {
          setState('error');
          setMessage(errorMessage(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-ink-50 px-4 dark:bg-ink-950">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-ink-900 dark:text-ink-100">MindBoxAfrica</h1>
        </div>
        <div className="card card-pad text-center">
          <p className="text-sm text-ink-700 dark:text-ink-200">{message}</p>
          {state !== 'loading' && (
            <Link href="/login" className="btn-primary mt-4 inline-block w-full text-center">
              Go to sign in
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailView />
    </Suspense>
  );
}
