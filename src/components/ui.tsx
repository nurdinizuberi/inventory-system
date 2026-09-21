'use client';

import type { ReactNode } from 'react';
import { compactTick, niceAxis } from '@/components/charts';
import { currency, formatDate } from '@/lib/utils';

export function Card({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-4 py-3 sm:px-5 dark:border-ink-700">
          <div>
            {title && <h2 className="section-title">{title}</h2>}
            {subtitle && <p className="muted mt-0.5">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="card-pad">{children}</div>
    </section>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'bad'
          ? 'text-red-600 dark:text-red-400'
          : 'text-ink-900 dark:text-ink-100';
  return (
    <div className="kpi">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-500 dark:text-ink-400">{label}</span>
      <span className={`text-xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
      {hint && <span className="text-xs text-ink-500 dark:text-ink-400">{hint}</span>}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  neutral: 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  blue: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
};

export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return <span className={`badge ${BADGE_TONES[tone] ?? BADGE_TONES.neutral}`}>{children}</span>;
}

export function statusTone(status: string): keyof typeof BADGE_TONES {
  const map: Record<string, keyof typeof BADGE_TONES> = {
    confirmed: 'green',
    completed: 'green',
    received: 'green',
    approved: 'green',
    active: 'green',
    draft: 'neutral',
    pending: 'amber',
    in_transit: 'blue',
    reserved: 'violet',
    cancelled: 'red',
    rejected: 'red',
    voided: 'red',
    sold: 'neutral',
    released: 'neutral',
    fulfilled: 'green',
    available: 'green',
  };
  return map[status] ?? 'neutral';
}

export function MovementBadge({ type }: { type: string }) {
  const tones: Record<string, keyof typeof BADGE_TONES> = {
    purchase_in: 'green',
    transfer_in: 'blue',
    transfer_out: 'violet',
    sale_out: 'neutral',
    return_in: 'green',
    return_damaged: 'red',
    reservation: 'violet',
    reservation_release: 'amber',
    adjustment: 'amber',
    opening_stock: 'green',
    revaluation: 'violet',
    product_edit: 'blue',
  };
  const labels: Record<string, string> = {
    purchase_in: 'Purchase In',
    transfer_in: 'Transfer In',
    transfer_out: 'Transfer Out',
    sale_out: 'Sale Out',
    return_in: 'Return In',
    return_damaged: 'Damaged',
    reservation: 'Reservation',
    reservation_release: 'Release',
    adjustment: 'Adjustment',
    opening_stock: 'Opening Stock',
    revaluation: 'Revaluation',
    product_edit: 'Product Edit',
  };
  return <Badge tone={tones[type] ?? 'neutral'}>{labels[type] ?? type}</Badge>;
}

export function Empty({ message = 'Nothing here yet.' }: { message?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-300 px-4 py-10 text-center text-sm text-ink-500 dark:border-ink-600 dark:text-ink-400">
      {message}
    </div>
  );
}

export function TableWrap({ children, maxHeight }: { children: ReactNode; maxHeight?: string }) {
  return (
    <div className="overflow-auto rounded-lg border border-ink-200 dark:border-ink-700" style={maxHeight ? { maxHeight } : undefined}>
      {children}
    </div>
  );
}

export function Money({ value, className = '' }: { value: number; className?: string }) {
  return <span className={`tabular-nums ${className}`}>{currency(value)}</span>;
}

export function DateCell({ value, withTime = false }: { value: string | Date | null | undefined; withTime?: boolean }) {
  return <span className="whitespace-nowrap tabular-nums text-ink-600 dark:text-ink-300">{formatDate(value, withTime)}</span>;
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-400 dark:text-ink-500">{hint}</span>}
    </label>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4 backdrop-blur-sm">
      <div className={`card my-8 w-full ${wide ? 'max-w-4xl' : 'max-w-xl'}`}>
        <header className="flex items-center justify-between border-b border-ink-200 px-5 py-3 dark:border-ink-700">
          <h2 className="section-title">{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} type="button">
            Close
          </button>
        </header>
        <div className="card-pad max-h-[70vh] overflow-y-auto">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-ink-200 px-5 py-3 dark:border-ink-700">{footer}</footer>}
      </div>
    </div>
  );
}

/**
 * Dashboard mini bar chart (last 7 days revenue) — same visual language as the
 * report `Bars` chart: shared scale, gridlines, tick labels on both sides,
 * value label above each bar and bold weekday labels on the baseline.
 */
export function Sparkline({ data }: { data: { date: string; revenue: number }[] }) {
  if (!data.length) return <p className="muted py-6 text-center">No data to chart.</p>;

  const { max, steps } = niceAxis(Math.max(1, ...data.map((d) => Math.max(0, d.revenue))));
  const plotHeight = 150;
  const gridRows = Array.from({ length: steps + 1 }, (_, i) => max - (i * max) / steps); // top → bottom

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-full" style={{ width: 'max-content' }}>
        <div
          className="flex shrink-0 flex-col items-end justify-between pr-2 text-right text-[10px] tabular-nums text-ink-400 dark:text-ink-500"
          style={{ height: plotHeight }}
          aria-hidden="true"
        >
          {gridRows.map((tick, i) => (
            <span key={i} className="leading-none" style={{ transform: 'translateY(-50%)' }}>
              {compactTick(tick)}
            </span>
          ))}
        </div>
        <div className="relative" style={{ height: plotHeight }}>
          <div className="absolute inset-0 flex flex-col justify-between" aria-hidden="true">
            {gridRows.map((_, i) => (
              <div key={i} className={`h-px w-full ${i === steps ? 'bg-ink-300 dark:bg-ink-600' : 'bg-ink-200/70 dark:bg-ink-700/70'}`} />
            ))}
          </div>
          <div className="relative flex h-full items-end justify-around gap-2 px-2">
            {data.map((point) => (
              <div key={point.date} className="group flex h-full min-w-[2.5rem] flex-1 flex-col items-center justify-end">
                <span
                  className="mb-0.5 text-[10px] font-semibold tabular-nums text-ink-700 dark:text-ink-300"
                  style={{ visibility: point.revenue / max < 0.06 ? 'hidden' : undefined }}
                >
                  {compactTick(point.revenue)}
                </span>
                <div
                  className="w-full max-w-[2.75rem] bg-sky-500/85 transition group-hover:bg-sky-600 dark:bg-sky-400 dark:group-hover:bg-sky-300"
                  style={{ height: `${Math.max(2, (point.revenue / max) * (plotHeight - 14))}px` }}
                  title={`${point.date}: ${currency(point.revenue)}`}
                />
              </div>
            ))}
          </div>
        </div>
        <div
          className="flex shrink-0 flex-col items-start justify-between pl-2 text-[10px] tabular-nums text-ink-400 dark:text-ink-500"
          style={{ height: plotHeight }}
          aria-hidden="true"
        >
          {gridRows.map((tick, i) => (
            <span key={i} className="leading-none" style={{ transform: 'translateY(-50%)' }}>
              {compactTick(tick)}
            </span>
          ))}
        </div>
      </div>
      <div className="flex">
        <div className="w-3 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-1">
          {data.map((point) => (
            <p key={point.date} className="min-w-[2.5rem] flex-1 truncate text-center text-xs font-semibold text-ink-800 dark:text-ink-200" title={point.date}>
              {weekdayLabel(point.date)}
            </p>
          ))}
          <div className="w-3 shrink-0" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

/** "2026-09-21" → "Mon" so the dashboard chart reads like a weekly report. */
function weekdayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? date.slice(5) : parsed.toLocaleDateString('en-GB', { weekday: 'short' });
}
