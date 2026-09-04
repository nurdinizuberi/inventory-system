'use client';

import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Small dependency-free charts for reports and the dashboard. All bars are
// divs styled with Tailwind light/dark classes, so they stay visible in dark
// mode and print cleanly via the report print stylesheet.
// ---------------------------------------------------------------------------

export type ChartColor = 'sky' | 'emerald' | 'amber' | 'violet' | 'rose';

const CHART_BG: Record<ChartColor, string> = {
  sky: 'bg-sky-500 dark:bg-sky-400',
  emerald: 'bg-emerald-500 dark:bg-emerald-400',
  amber: 'bg-amber-500 dark:bg-amber-400',
  violet: 'bg-violet-500 dark:bg-violet-400',
  rose: 'bg-rose-500 dark:bg-rose-400',
};

export function ChartLegend({ items }: { items: { name: string; color: ChartColor }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {items.map((item) => (
        <span key={item.name} className="flex items-center gap-1.5 text-xs text-ink-500 dark:text-ink-400">
          <span className={`h-2.5 w-2.5 rounded-sm ${CHART_BG[item.color]}`} />
          {item.name}
        </span>
      ))}
    </div>
  );
}

export interface BarSeriesPoint {
  key: string;
  name: string;
  value: number;
  color: ChartColor;
}

/**
 * Vertical grouped bars, one group per bucket (e.g. one per day).
 * `format` is used in hover titles only; values are scaled against the series max.
 */
export function Bars({
  data,
  format,
  height = 200,
  legend,
  empty = 'No data to chart.',
}: {
  data: { label: string; values: BarSeriesPoint[] }[];
  format?: (value: number) => string;
  height?: number;
  legend?: { name: string; color: ChartColor }[];
  empty?: string;
}) {
  if (!data.length) return <p className="muted py-6 text-center">{empty}</p>;
  const labelSpace = 22;
  const zone = Math.max(40, height - labelSpace);
  return (
    <div className="space-y-3">
      {legend && legend.length > 0 && <ChartLegend items={legend} />}
      <div className="flex gap-2 overflow-x-auto pb-1" style={{ height }}>
        {data.map((bucket) => {
          const values = bucket.values.map((v) => ({ ...v, value: Math.max(0, v.value) }));
          const max = Math.max(1, ...values.map((v) => v.value));
          return (
            <div key={bucket.label} className="flex min-w-[2.25rem] flex-1 flex-col justify-end">
              <div className="flex flex-1 items-end justify-center gap-1">
                {values.map((point) => (
                  <div
                    key={point.key}
                    title={`${bucket.label} · ${point.name}: ${format ? format(point.value) : point.value}`}
                    className={`w-2.5 rounded-t sm:w-3 ${CHART_BG[point.color]}`}
                    style={{ height: `${Math.max(2, (point.value / max) * (zone - 14))}px` }}
                  />
                ))}
              </div>
              <p className="mt-1 truncate text-center text-[10px] text-ink-400 dark:text-ink-500" title={bucket.label}>
                {bucket.label}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Horizontal proportion bars (a labelled track per item) — good for top-N
 * lists like best sellers, profit by location, or value by location.
 */
export function HBarList({
  items,
  format,
  color = 'emerald',
  empty = 'No data to chart.',
  hintFor,
}: {
  items: { label: string; value: number; hint?: string }[];
  format: (value: number) => string;
  color?: ChartColor;
  empty?: string;
  hintFor?: (item: { label: string; value: number }) => string;
}) {
  if (!items.length) return <p className="muted py-6 text-center">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => Math.max(0, i.value)));
  return (
    <ul className="space-y-3">
      {items.map((item, index) => (
        <li key={`${item.label}-${index}`}>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium text-ink-800 dark:text-ink-200" title={item.label}>
              {item.label}
            </span>
            <span className="shrink-0 font-semibold tabular-nums text-ink-900 dark:text-ink-100">
              {format(item.value)}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <div className={`h-full rounded-full ${CHART_BG[color]}`} style={{ width: `${(Math.max(0, item.value) / max) * 100}%` }} />
          </div>
          {(item.hint || hintFor) && (
            <p className="mt-0.5 text-xs text-ink-400 dark:text-ink-500">{item.hint ?? (hintFor ? hintFor(item) : '')}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Simple stacked share bar (e.g. revenue vs cost within one total). */
export function ShareBar({
  parts,
  total,
  format,
  empty = 'No data to chart.',
}: {
  parts: { name: string; value: number; color: ChartColor }[];
  total?: number;
  format?: (value: number) => string;
  empty?: string;
}) {
  const sum = total ?? parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (!parts.length || sum <= 0) return <p className="muted py-6 text-center">{empty}</p>;
  const children: ReactNode[] = [];
  let acc = 0;
  for (const part of parts) {
    const share = (Math.max(0, part.value) / sum) * 100;
    if (share <= 0) continue;
    children.push(
      <div
        key={part.name}
        className={`h-full ${CHART_BG[part.color]}`}
        style={{ width: `${share}%`, left: `${acc}%`, position: 'absolute' }}
        title={`${part.name}: ${format ? format(part.value) : part.value}`}
      />,
    );
    acc += share;
  }
  return (
    <div className="space-y-2">
      <div className="relative h-4 w-full overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">{children}</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {parts.map((part) => (
          <span key={part.name} className="flex items-center gap-1.5 text-xs text-ink-500 dark:text-ink-400">
            <span className={`h-2.5 w-2.5 rounded-sm ${CHART_BG[part.color]}`} />
            {part.name} — {format ? format(part.value) : part.value}
          </span>
        ))}
      </div>
    </div>
  );
}
