'use client';

import type { ReactNode } from 'react';
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

export function Sparkline({ data }: { data: { date: string; revenue: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.revenue));
  return (
    <div className="flex h-16 items-end gap-1.5">
      {data.map((point) => (
        <div key={point.date} className="group relative flex flex-1 flex-col items-center gap-1">
          <div
            className="w-full rounded-t bg-sky-500/85 transition group-hover:bg-sky-600 dark:bg-sky-400 dark:group-hover:bg-sky-300"
            style={{ height: `${Math.max(4, (point.revenue / max) * 56)}px` }}
            title={`${point.date}: ${currency(point.revenue)}`}
          />
          <span className="text-[10px] text-ink-400 dark:text-ink-500">{point.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
