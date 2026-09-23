'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import { useInactivitySignout } from '@/components/use-inactivity-signout';
import { locationMode, type LocationMode } from '@/lib/location-mode';

export interface SessionLocation {
  id: string;
  name: string;
  code: string;
  type: 'WAREHOUSE' | 'RETAIL_STORE' | 'DAMAGED' | string;
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
  activeLocation: SessionLocation | null;
  activeMode: LocationMode;
  setActiveLocation: (locationId: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [activeLocationId, setActiveLocationId] = useState<string | null>(null);
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

  useEffect(() => {
    if (!user) {
      setActiveLocationId(null);
      return;
    }
    const stored = window.localStorage.getItem('ims_active_location');
    const valid = stored && user.locations.some((location) => location.id === stored);
    setActiveLocationId(valid ? stored : user.locations[0]?.id ?? null);
  }, [user]);

  const setActiveLocation = useCallback((locationId: string) => {
    setActiveLocationId(locationId);
    window.localStorage.setItem('ims_active_location', locationId);
  }, []);

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

  // Sign out automatically after a period of inactivity.
  useInactivitySignout(
    () => {
      void logout();
    },
    { enabled: !!user },
  );

  const value = useMemo<AuthState>(
    () => {
      const activeLocation = user?.locations.find((location) => location.id === activeLocationId) ?? user?.locations[0] ?? null;
      return {
        user,
        permissions,
        loading,
        can: (action: string) => user?.role === 'ADMIN' || permissions[action] === true,
        login,
        logout,
        refresh,
        activeLocation,
        activeMode: locationMode(activeLocation?.type),
        setActiveLocation,
      };
    },
    [user, permissions, loading, login, logout, refresh, activeLocationId, setActiveLocation],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
