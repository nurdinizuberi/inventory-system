'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/client';
import { ThemeToggle } from '@/components/theme-context';

// ---------------------------------------------------------------------------
// Auth context — exported for use in any admin page
// ---------------------------------------------------------------------------

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface AdminAuthState {
  user: AdminUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthState | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ user: AdminUser | null }>('/api/admin/auth/me');
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      await api.post('/api/admin/auth/login', { email, password });
      await refresh();
      router.push('/admin');
      router.refresh();
    },
    [refresh, router],
  );

  const logout = useCallback(async () => {
    await api.post('/api/admin/auth/logout');
    setUser(null);
    router.push('/admin');
    router.refresh();
  }, [router]);

  const value = useMemo<AdminAuthState>(
    () => ({ user, loading, login, logout, refresh }),
    [user, loading, login, logout, refresh],
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthState {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error('useAdminAuth must be used inside <AdminAuthProvider>');
  return ctx;
}

// ---------------------------------------------------------------------------
// Shell — sidebar + header (only rendered when authenticated)
// ---------------------------------------------------------------------------

const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/tenants', label: 'Organizations' },
];

function AdminShell({ children }: { children: ReactNode }) {
  const { user } = useAdminAuth();
  const pathname = usePathname();

  if (!user) return <AdminLoginPage />;

  return (
    <div className="flex min-h-screen bg-ink-50 dark:bg-ink-950">
      <aside className="hidden w-64 shrink-0 flex-col bg-violet-900 lg:flex">
        <div className="border-b border-white/10 px-5 py-4">
          <Link href="/admin" className="text-sm font-semibold text-white hover:text-violet-200">
            MindBoxAfrica Admin
          </Link>
          <p className="text-xs text-violet-300">Global Administration</p>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {NAV.map((item) => {
            const active = item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-lg px-3 py-2 text-sm transition ${
                  active
                    ? 'bg-white/10 font-medium text-white'
                    : 'text-violet-200 hover:bg-white/5 hover:text-white'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/10 px-4 py-3 text-xs text-violet-300">
          <p className="font-medium text-violet-100">{user.name}</p>
          <p>{user.email}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-ink-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-ink-800 dark:bg-ink-900/90 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-sm font-semibold text-violet-700 lg:hidden">
              Admin
            </Link>
            <p className="hidden text-sm font-semibold text-ink-900 dark:text-ink-100 lg:block">Global Administration</p>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <span className="badge bg-violet-100 text-violet-700">Global Admin</span>
            <button
              className="btn-secondary btn-sm"
              onClick={() => {
                void (async () => {
                  await api.post('/api/admin/auth/logout');
                  window.location.href = '/admin';
                })();
              }}
              type="button"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

function AdminLoginPage() {
  const { login } = useAdminAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
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
          <h2 className="text-lg font-semibold text-ink-900 dark:text-ink-100">Sign in</h2>
          <p className="muted mt-1 text-sm">Access the global admin panel.</p>
          <form className="mt-4 space-y-4" onSubmit={submit}>
            <label className="block">
              <span className="label">Email</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
                required
              />
            </label>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}
            <button className="btn-primary w-full" disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root admin layout — provides context + shell
// ---------------------------------------------------------------------------

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AdminAuthProvider>
      <AdminShell>{children}</AdminShell>
    </AdminAuthProvider>
  );
}
