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

/** Fixed width of the y-axis tick columns on both sides of the plot. */
const AXIS_W = 'w-12';
const LABEL_SPACE = 14; // px reserved above each bar for its value label

/**
 * Vertical grouped bars, one group per bucket (e.g. one per day), drawn on a
 * shared scale with horizontal gridlines and tick labels on both sides —
 * styled after a classic "weekly report" poster chart. A formatted value is
 * printed above every bar; `format` is used for hover tooltips only.
 */
export function Bars({
  data,
  format,
  height = 220,
  legend,
  empty = 'No data to chart.',
  showValueLabels = true,
}: {
  data: { label: string; values: BarSeriesPoint[] }[];
  format?: (value: number) => string;
  height?: number;
  legend?: { name: string; color: ChartColor }[];
  empty?: string;
  /** Turn off the number printed above each bar (handy when bars are very dense). */
  showValueLabels?: boolean;
}) {
  if (!data.length) return <p className="muted py-6 text-center">{empty}</p>;

  const fmt = format ?? ((v: number) => String(v));
  const flat = data.flatMap((bucket) => bucket.values);
  const seriesMax = Math.max(1, ...flat.map((v) => Math.max(0, v.value)));
  const { max, steps } = niceAxis(seriesMax);
  const plotHeight = Math.max(100, height - 26); // 26px for the x-axis labels
  const gridRows = Array.from({ length: steps + 1 }, (_, i) => max - (i * max) / steps); // top → bottom
  const ticks = gridRows.map((t) => compactTick(t));

  return (
    <div className="space-y-3">
      {legend && legend.length > 0 && <ChartLegend items={legend} />}
      <div className="overflow-x-auto pb-1">
        {/* Everything shares one scrolling box so axes, bars and labels stay aligned. */}
        <div className="flex min-w-full items-start" style={{ width: 'max-content' }}>
          <TickAxis ticks={ticks} side="left" height={plotHeight} />
          <div className="min-w-0 flex-1">
            <div className="relative" style={{ height: plotHeight }}>
              <div className="absolute inset-0 flex flex-col justify-between" aria-hidden="true">
                {gridRows.map((_, i) => (
                  <div
                    key={i}
                    className={`h-px w-full ${i === steps ? 'bg-ink-300 dark:bg-ink-600' : 'bg-ink-200/70 dark:bg-ink-700/70'}`}
                  />
                ))}
              </div>
              <div className="relative flex h-full items-end">
                {data.map((bucket) => (
                  <div key={bucket.label} className="flex h-full min-w-[2.25rem] flex-1 items-end justify-center gap-1 px-1">
                    {bucket.values.map((point) => {
                      const value = Math.max(0, point.value);
                      const barHeight = Math.max(2, (value / max) * (plotHeight - (showValueLabels ? LABEL_SPACE : 0)));
                      return (
                        <div
                          key={point.key}
                          title={`${bucket.label} · ${point.name}: ${fmt(point.value)}`}
                          className="flex h-full w-full max-w-[2.5rem] flex-col items-center justify-end"
                        >
                          {showValueLabels && (
                            <span
                              className="mb-0.5 text-[10px] font-semibold leading-none tabular-nums text-ink-700 dark:text-ink-300"
                              style={{ visibility: value / max < 0.06 ? 'hidden' : undefined }}
                            >
                              {compactTick(value)}
                            </span>
                          )}
                          <div className={`w-full ${CHART_BG[point.color]}`} style={{ height: `${barHeight}px` }} />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            {/* X-axis labels sit on the baseline, one per bucket, same flex math as the bars. */}
            <div className="flex">
              {data.map((bucket) => (
                <p
                  key={bucket.label}
                  className="min-w-[2.25rem] flex-1 truncate px-1 text-center text-xs font-semibold text-ink-800 dark:text-ink-200"
                  title={bucket.label}
                >
                  {bucket.label}
                </p>
              ))}
            </div>
          </div>
          <TickAxis ticks={ticks} side="right" height={plotHeight} />
        </div>
      </div>
    </div>
  );
}

/**
 * Mirror-image y-axis tick column ("200 / 150 / 100 / 50" on both sides, like
 * the poster layout). `side` decides which edge the numbers hug.
 */
function TickAxis({ ticks, side, height }: { ticks: string[]; side: 'left' | 'right'; height: number }) {
  return (
    <div
      className={`flex shrink-0 flex-col justify-between ${AXIS_W} ${
        side === 'left' ? 'items-end pr-2 text-right' : 'items-start pl-2'
      } text-[10px] leading-none tabular-nums text-ink-400 dark:text-ink-500`}
      style={{ height }}
      aria-hidden="true"
    >
      {ticks.map((tick, i) => (
        <span key={i} className="tabular-nums" style={{ transform: 'translateY(-50%)' }}>
          {tick}
        </span>
      ))}
    </div>
  );
}

/**
 * Pick a tidy axis maximum: a "nice" step (1/2/2.5/5 × 10^k) times a step
 * count of 3–6, choosing the tightest fit above the series max so bars use
 * most of the plot (e.g. series max 209 → axis 250 with 5 steps).
 */
export function niceAxis(seriesMax: number): { max: number; steps: number } {
  let best = { max: Number.POSITIVE_INFINITY, steps: 4 };
  for (const steps of [3, 4, 5, 6]) {
    const rough = (seriesMax * 1.05) / steps;
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
    const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude);
    const step = candidates.find((c) => c >= rough) ?? magnitude * 10;
    const max = step * steps;
    if (max < best.max) best = { max, steps };
  }
  return best;
}

/** Short label for axis ticks and bar value labels: 1500 → "1.5k", 209 → "209". */
export function compactTick(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trimZero(value / 1_000)}k`;
  if (abs >= 1_000) return value % 1_000 === 0 ? `${value / 1_000}k` : trimZero(value);
  return trimZero(value);
}

function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Horizontal proportion bars (a labelled track per item) — good for top-N
 * lists like best sellers, profit by location, or value by location. Formatted
 * values sit right-aligned on the same row as the label, so every row reads
 * like `Label ……… value` with the filled track underneath.
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
