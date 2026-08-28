'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';

export interface SessionLocation {
  id: string;
  name: string;
  code: string;
  type: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  locations: SessionLocation[];
  locationIds: string[];
  unrestricted: boolean;
}

interface AuthState {
  user: SessionUser | null;
  permissions: Record<string, boolean>;
  loading: boolean;
  can: (action: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ user: SessionUser | null; permissions: Record<string, boolean> }>('/api/auth/me');
      setUser(data.user);
      setPermissions(data.permissions ?? {});
    } catch {
      setUser(null);
      setPermissions({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      await api.post('/api/auth/login', { email, password });
      await refresh();
      router.push('/');
      router.refresh();
    },
    [refresh, router],
  );

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setUser(null);
    setPermissions({});
    router.push('/login');
    router.refresh();
  }, [router]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      permissions,
      loading,
      can: (action: string) => user?.role === 'ADMIN' || permissions[action] === true,
      login,
      logout,
      refresh,
    }),
    [user, permissions, loading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
