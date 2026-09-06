'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './auth-context';
import { LowStockAlert } from './low-stock-alert';
import { ThemeToggle } from './theme-context';
import { ROLE_LABELS, type Role } from '@/lib/types';

interface NavItem {
  href: string;
  label: string;
  permission: string;
  group: string;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', permission: 'stock.view', group: 'Overview' },
  { href: '/pos', label: 'Point of Sale', permission: 'sale.create', group: 'Sell' },
  { href: '/sales', label: 'Sales history', permission: 'sale.view', group: 'Sell' },
  { href: '/returns', label: 'Returns', permission: 'return.view', group: 'Sell' },
  { href: '/purchases', label: 'Purchases', permission: 'purchase.view', group: 'Move stock' },
  { href: '/transfers', label: 'Transfers', permission: 'transfer.view', group: 'Move stock' },
  { href: '/stock', label: 'Stock ledger', permission: 'stock.view', group: 'Move stock' },
  { href: '/adjustments', label: 'Adjustments', permission: 'stock.view', group: 'Move stock' },
  { href: '/reservations', label: 'Reservations', permission: 'reservation.manage', group: 'Move stock' },
  { href: '/products', label: 'Products & variants', permission: 'product.view', group: 'Catalogue' },
  { href: '/locations', label: 'Locations', permission: 'location.view', group: 'Catalogue' },
  { href: '/suppliers', label: 'Suppliers', permission: 'supplier.view', group: 'Catalogue' },
  { href: '/reports/sales', label: 'Reports', permission: 'report.sales', group: 'Reports' },
  { href: '/audit', label: 'Audit log', permission: 'audit.view', group: 'System' },
  { href: '/users', label: 'Users', permission: 'user.view', group: 'System' },
  { href: '/roles', label: 'Roles & permissions', permission: 'user.manage', group: 'System' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { user, loading, can, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-ink-500 dark:text-ink-400">Loading session…</div>
    );
  }
  if (!user) return null;

  const items = NAV.filter((item) => can(item.permission));
  const groups = [...new Set(items.map((i) => i.group))];

  const nav = (
    <nav className="flex flex-col gap-5 px-3 py-4">
      {groups.map((group) => (
        <div key={group}>
          <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">{group}</p>
          <div className="flex flex-col gap-0.5">
            {items
              .filter((item) => item.group === group)
              .map((item) => {
                const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={`nav-link ${active ? 'nav-link-active' : ''}`}
                  >
                    {item.label}
                  </Link>
                );
              })}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-ink-50 dark:bg-ink-950">
      <aside className="hidden w-64 shrink-0 flex-col bg-ink-900 lg:flex">
        <div className="border-b border-white/10 px-5 py-4">
          <p className="text-sm font-semibold text-white">MindBoxAfrica</p>
          <p className="text-xs text-ink-400">Warehouse → Retail</p>
        </div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <div className="border-t border-white/10 px-4 py-3 text-xs text-ink-400">
          <p className="font-medium text-ink-200">{user.name}</p>
          <p>{ROLE_LABELS[user.role as Role]}</p>
        </div>
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-950/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-ink-900">{nav}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-ink-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-ink-800 dark:bg-ink-900/90 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              className="btn-ghost btn-sm lg:hidden"
              onClick={() => setOpen(true)}
              type="button"
              aria-label="Open navigation menu"
              title="Open menu"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>
            <div>
              <p className="text-sm font-semibold text-ink-900 dark:text-ink-100">MindBoxAfrica</p>
              <p className="text-xs text-ink-500 dark:text-ink-400">
                {user.locations.length
                  ? user.locations.map((l) => l.name).join(' · ')
                  : user.unrestricted
                    ? 'All locations'
                    : 'No location assigned'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <LowStockAlert />
            <ThemeToggle />
            <span className="badge bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200">{ROLE_LABELS[user.role as Role]}</span>
            <button
              className="btn-secondary btn-sm"
              onClick={() => {
                void logout();
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

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink-900 dark:text-ink-100">{title}</h1>
        {description && <p className="muted mt-1">{description}</p>}
      </div>
      {action}
    </div>
  );
}
