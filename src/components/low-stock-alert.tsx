'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth-context';
import { api } from '@/lib/client';

interface AlertItem {
  variantId: string;
  locationId: string;
  name: string;
  sku: string;
  location: string;
  onHand: number;
  threshold: number;
  outOfStock: boolean;
}

const REFRESH_MS = 60_000;

/**
 * Persistent low-stock alert bell shown in the header on every page. The badge
 * counts variant/location pairs at or below their threshold; the dropdown
 * lists the most urgent ones and links to the full stock report. Quiet by
 * design — if the feed fails the bell just stays silent rather than breaking
 * a page.
 */
export function LowStockAlert() {
  const { can } = useAuth();
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<AlertItem[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ count: number; items: AlertItem[] }>('/api/alerts/low-stock');
      setCount(data.count);
      setItems(data.items);
    } catch {
      // Ignore — the alert indicator must never take down the shell.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Refresh on navigation so the badge reflects stock recorded on the page
  // the user just left (purchases, POS, transfers, …).
  useEffect(() => {
    void load();
  }, [pathname, load]);

  if (!can('stock.view')) return null;

  return (
    <div className="relative">
      <button
        className="btn-ghost btn-sm relative"
        onClick={() => setOpen((o) => !o)}
        type="button"
        aria-label={`Low stock alerts${count ? `: ${count}` : ''}`}
        title={count ? `${count} product(s) at or below low-stock threshold` : 'Low stock alerts'}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {count > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-ink-200 bg-white p-2 shadow-lg dark:border-ink-700 dark:bg-ink-900">
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <p className="text-sm font-semibold text-ink-900 dark:text-ink-100">
                Low stock alerts{count > 0 ? ` (${count})` : ''}
              </p>
              {can('report.stock') && (
                <Link className="btn-secondary btn-sm shrink-0" href="/reports/stock?onlyLow=1" onClick={() => setOpen(false)}>
                  Full report
                </Link>
              )}
            </div>
            {items.length === 0 ? (
              <p className="muted px-2 py-6 text-center">All good — nothing below threshold.</p>
            ) : (
              <ul className="max-h-80 overflow-y-auto">
                {items.map((item) => (
                  <li
                    key={`${item.variantId}-${item.locationId}`}
                    className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-50 dark:hover:bg-ink-800"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink-900 dark:text-ink-100">{item.name}</p>
                      <p className="truncate text-xs text-ink-500 dark:text-ink-400">
                        {item.location} · {item.sku}
                      </p>
                    </div>
                    <span
                      className={`badge shrink-0 ${
                        item.outOfStock
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                      }`}
                    >
                      {item.onHand} / {item.threshold}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}