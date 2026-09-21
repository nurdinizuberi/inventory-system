'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { ExportButtons, money, pctText } from '@/components/report-tools';
import { Bars } from '@/components/charts';
import { Badge, Card, Empty, Kpi, TableWrap } from '@/components/ui';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { currency } from '@/lib/utils';

type View = 'abc' | 'trends';

interface AbcRow {
  variantId: string;
  productName: string;
  category: string | null;
  variantLabel: string;
  sku: string;
  units: number;
  salesValue: number;
  consumptionValue: number;
  onHand: number;
  daysOfStock: number | null;
  velocity: number;
  class: 'A' | 'B' | 'C';
  valueShare: number;
  cumValuePct: number;
  itemShare: number;
}

interface TrendRow {
  variantId: string;
  productName: string;
  category: string | null;
  variantLabel: string;
  sku: string;
  units: number;
  salesValue: number;
  previousUnits: number;
  growth: number;
  trend: 'rising' | 'steady' | 'declining';
  velocity: number;
  onHand: number;
  daysOfStock: number | null;
  projected30: number;
}

interface LocOption {
  id: string;
  name: string;
  type: string;
}

interface Analytics {
  periodDays: number;
  locations: LocOption[];
  abc: {
    rows: AbcRow[];
    totals: { lines: number; units: number; salesValue: number; consumptionValue: number; countA: number; countB: number; countC: number; valueA: number; valueB: number; valueC: number };
  };
  trends: {
    rows: TrendRow[];
    totals: { lines: number; units: number; rising: number; steady: number; declining: number; projectedUnits: number; avgDaysOfStock: number | null; shortageLines: number };
  };
}

const classTone = (klass: 'A' | 'B' | 'C') => (klass === 'A' ? 'blue' : klass === 'B' ? 'amber' : 'neutral') as 'blue' | 'amber' | 'neutral';
const trendTone = (trend: 'rising' | 'steady' | 'declining') =>
  (trend === 'rising' ? 'green' : trend === 'declining' ? 'red' : 'neutral') as 'green' | 'red' | 'neutral';

export default function AnalyticsReportPage() {
  const toast = useToast();
  const [view, setView] = useState<View>('abc');
  const [days, setDays] = useState(90);
  const [locationId, setLocationId] = useState('');
  const [data, setData] = useState<Analytics | null>(null);

  const load = useCallback(async () => {
    try {
      const to = new Date();
      const from = new Date(Date.now() - (days - 1) * 864e5);
      const params = new URLSearchParams({
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      });
      if (locationId) params.set('locationId', locationId);
      const result = await api.get<Analytics>(`/api/reports/analytics?${params.toString()}`);
      setData(result);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [days, locationId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const abc = data?.abc.rows ?? [];
  const trends = data?.trends.rows ?? [];

  return (
    <>
      <PageHeader
        title="Inventory analytics"
        description="ABC classification of what you sell, and sales-velocity trends with run-out and 30-day projections. Everything derives from the sales ledger and current on-hand."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-52" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All locations</option>
              {(data?.locations ?? []).map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
            <select className="input w-36" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 6 months</option>
              <option value={365}>Last 12 months</option>
            </select>
            {data && view === 'abc' && abc.length > 0 && (
              <ExportButtons
                label="Export ABC"
                csvFilename={`abc-analysis-${days}d${locationId ? `-${locationId}` : ''}`}
                csvHeaders={['Class', 'Product', 'Variant', 'SKU', 'Category', 'Units sold', 'Sales value', 'Consumption cost', 'Value share %', 'Cumulative %', 'On hand', 'Days of stock']}
                csvRows={abc.map((row) => [
                  row.class,
                  row.productName,
                  row.variantLabel,
                  row.sku,
                  row.category ?? '',
                  row.units,
                  row.salesValue,
                  row.consumptionValue,
                  Number(row.valueShare.toFixed(1)),
                  Number(row.cumValuePct.toFixed(1)),
                  row.onHand,
                  row.daysOfStock ?? '',
                ])}
                print={{
                  title: `ABC analysis — last ${data.periodDays} days`,
                  subtitle: locationId ? `Location: ${(data?.locations ?? []).find((l) => l.id === locationId)?.name ?? locationId}` : 'All locations',
                  blocks: [
                    {
                      title: 'Summary',
                      headers: ['Metric', 'Value'],
                      rows: [
                        ['Selling variants', String(data.abc.totals.lines)],
                        ['Units sold', String(data.abc.totals.units)],
                        ['Sales value', money(data.abc.totals.salesValue)],
                        ['Consumption cost', money(data.abc.totals.consumptionValue)],
                        ['A-class items', String(data.abc.totals.countA)],
                        ['B-class items', String(data.abc.totals.countB)],
                        ['C-class items', String(data.abc.totals.countC)],
                      ],
                    },
                    {
                      title: `Ranked by sales value (${abc.length})`,
                      headers: ['Class', 'Product', 'Variant', 'SKU', 'Units', 'Sales value', 'Value share', 'On hand', 'Days of stock'],
                      rows: abc.map((row) => [
                        row.class,
                        row.productName,
                        row.variantLabel,
                        row.sku,
                        String(row.units),
                        money(row.salesValue),
                        pctText(row.valueShare),
                        String(row.onHand),
                        row.daysOfStock === null ? '—' : String(row.daysOfStock),
                      ]),
                    },
                  ],
                }}
              />
            )}
            {data && view === 'trends' && trends.length > 0 && (
              <ExportButtons
                label="Export trends"
                csvFilename={`sales-trends-${days}d${locationId ? `-${locationId}` : ''}`}
                csvHeaders={['Trend', 'Product', 'Variant', 'SKU', 'Units now', 'Units prior', 'Growth %', 'Velocity/day', 'On hand', 'Days of stock', 'Projected 30d']}
                csvRows={trends.map((row) => [
                  row.trend,
                  row.productName,
                  row.variantLabel,
                  row.sku,
                  row.units,
                  row.previousUnits,
                  Number(row.growth.toFixed(1)),
                  row.velocity,
                  row.onHand,
                  row.daysOfStock ?? '',
                  row.projected30,
                ])}
                print={{
                  title: `Sales trends — last ${data.periodDays} days vs prior period`,
                  subtitle: locationId ? `Location: ${(data?.locations ?? []).find((l) => l.id === locationId)?.name ?? locationId}` : 'All locations',
                  blocks: [
                    {
                      title: 'Summary',
                      headers: ['Metric', 'Value'],
                      rows: [
                        ['Variants sold', String(data.trends.totals.lines)],
                        ['Units sold', String(data.trends.totals.units)],
                        ['Rising', String(data.trends.totals.rising)],
                        ['Steady', String(data.trends.totals.steady)],
                        ['Declining', String(data.trends.totals.declining)],
                        ['Projected next-30d units', String(data.trends.totals.projectedUnits)],
                        ['Average days of stock', data.trends.totals.avgDaysOfStock === null ? '—' : String(data.trends.totals.avgDaysOfStock)],
                      ],
                    },
                    {
                      title: `Velocity & projection (${trends.length})`,
                      headers: ['Trend', 'Product', 'Variant', 'Units now', 'Units prior', 'Growth', 'Velocity/day', 'On hand', 'Days of stock', 'Proj 30d'],
                      rows: trends.map((row) => [
                        row.trend,
                        row.productName,
                        row.variantLabel,
                        String(row.units),
                        String(row.previousUnits),
                        pctText(row.growth),
                        String(row.velocity),
                        String(row.onHand),
                        row.daysOfStock === null ? '—' : String(row.daysOfStock),
                        String(row.projected30),
                      ]),
                    },
                  ],
                }}
              />
            )}
          </div>
        }
      />

      <div className="mb-5 flex gap-2">
        <button className={`btn btn-sm ${view === 'abc' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('abc')} type="button">
          ABC analysis
        </button>
        <button className={`btn btn-sm ${view === 'trends' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('trends')} type="button">
          Sales trends
        </button>
      </div>

      {!data && <p className="muted">Loading analytics…</p>}

      {data && view === 'abc' && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Sales value" value={currency(data.abc.totals.salesValue)} hint={`${data.periodDays} days · ${data.abc.totals.units} units`} />
            <Kpi label="A-class items" value={data.abc.totals.countA} tone={data.abc.totals.countA ? 'good' : 'default'} hint={`${currency(data.abc.totals.valueA)} value`} />
            <Kpi label="B-class items" value={data.abc.totals.countB} hint={`${currency(data.abc.totals.valueB)} value`} />
            <Kpi label="C-class items" value={data.abc.totals.countC} hint={`${currency(data.abc.totals.valueC)} value · long tail`} />
          </div>

          {abc.length > 0 && (
            <Card title="ABC class distribution" subtitle="Sales value and item count per class — the Pareto shape of your sales">
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <p className="label">Sales value by class</p>
                  <Bars
                    height={220}
                    data={[
                      {
                        label: 'A',
                        values: [{ key: 'a-value', name: 'Sales value', value: data.abc.totals.valueA, color: 'sky' }],
                      },
                      {
                        label: 'B',
                        values: [{ key: 'b-value', name: 'Sales value', value: data.abc.totals.valueB, color: 'sky' }],
                      },
                      {
                        label: 'C',
                        values: [{ key: 'c-value', name: 'Sales value', value: data.abc.totals.valueC, color: 'sky' }],
                      },
                    ]}
                    format={(v) => currency(v)}
                  />
                </div>
                <div>
                  <p className="label">Items per class</p>
                  <Bars
                    height={220}
                    data={[
                      {
                        label: 'A',
                        values: [{ key: 'a-count', name: 'Items', value: data.abc.totals.countA, color: 'violet' }],
                      },
                      {
                        label: 'B',
                        values: [{ key: 'b-count', name: 'Items', value: data.abc.totals.countB, color: 'violet' }],
                      },
                      {
                        label: 'C',
                        values: [{ key: 'c-count', name: 'Items', value: data.abc.totals.countC, color: 'violet' }],
                      },
                    ]}
                    format={(v) => `${v} item(s)`}
                  />
                </div>
              </div>
              <p className="muted mt-3 text-xs">
                A ≈ top 80% of sales value, B ≈ next 15%, C ≈ the tail. A healthy distribution shows a
                few A-class bars carrying most of the value with many C-class lines behind them.
              </p>
            </Card>
          )}

          <Card>
            {abc.length === 0 ? (
              <Empty message="No sales in this period for the selected scope." />
            ) : (
              <TableWrap maxHeight="70vh">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th>Item</th>
                      <th className="text-right">Units sold</th>
                      <th className="text-right">Sales value</th>
                      <th className="text-right">Consumption</th>
                      <th className="text-right">Value share</th>
                      <th className="text-right">Cumulative</th>
                      <th className="text-right">On hand</th>
                      <th className="text-right">Days of stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {abc.map((row) => (
                      <tr key={row.variantId}>
                        <td>
                          <Badge tone={classTone(row.class)}>{row.class}</Badge>
                        </td>
                        <td>
                          <p className="font-medium">{row.productName} — {row.variantLabel}</p>
                          <p className="font-mono text-xs text-ink-400 dark:text-ink-500">
                            {row.sku}
                            {row.category ? ` · ${row.category}` : ''}
                          </p>
                        </td>
                        <td className="text-right tabular-nums">{row.units}</td>
                        <td className="text-right font-medium tabular-nums">{currency(row.salesValue)}</td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(row.consumptionValue)}</td>
                        <td className="text-right tabular-nums">{Number(row.valueShare.toFixed(1))}%</td>
                        <td className="text-right tabular-nums text-ink-400 dark:text-ink-500">{Number(row.cumValuePct.toFixed(0))}%</td>
                        <td className="text-right tabular-nums">{row.onHand}</td>
                        <td className="text-right">
                          {row.daysOfStock === null ? (
                            <span className="text-ink-400 dark:text-ink-500">—</span>
                          ) : row.daysOfStock < 30 ? (
                            <Badge tone="red">{row.daysOfStock}d</Badge>
                          ) : row.daysOfStock < 90 ? (
                            <Badge tone="amber">{row.daysOfStock}d</Badge>
                          ) : (
                            <Badge tone="neutral">{row.daysOfStock}d</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        </div>
      )}

      {data && view === 'trends' && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Units sold" value={data.trends.totals.units} hint={`${data.trends.totals.lines} variant(s) sold`} />
            <Kpi label="Rising" value={data.trends.totals.rising} tone={data.trends.totals.rising ? 'good' : 'default'} hint="≥ 15% vs prior period" />
            <Kpi label="Declining" value={data.trends.totals.declining} tone={data.trends.totals.declining ? 'warn' : 'default'} hint="≤ −15% vs prior period" />
            <Kpi
              label="Projected next 30 days"
              value={data.trends.totals.projectedUnits}
              hint={
                data.trends.totals.avgDaysOfStock === null
                  ? `${data.trends.totals.shortageLines} line(s) under 30 days of stock`
                  : `avg ${data.trends.totals.avgDaysOfStock} days of stock`
              }
            />
          </div>

          {trends.length > 0 && (
            <Card title="Trend distribution" subtitle="How your variants are moving vs the prior period — the momentum picture at a glance">
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <p className="label">Variants per trend</p>
                  <Bars
                    height={220}
                    data={[
                      {
                        label: 'Rising',
                        values: [{ key: 'rising-count', name: 'Variants', value: data.trends.totals.rising, color: 'emerald' }],
                      },
                      {
                        label: 'Steady',
                        values: [{ key: 'steady-count', name: 'Variants', value: data.trends.totals.steady, color: 'slate' }],
                      },
                      {
                        label: 'Declining',
                        values: [{ key: 'declining-count', name: 'Variants', value: data.trends.totals.declining, color: 'rose' }],
                      },
                    ]}
                    format={(v) => `${v} variant(s)`}
                  />
                </div>
                <div>
                  <p className="label">Units sold per trend</p>
                  <Bars
                    height={220}
                    data={([
                      ['Rising', 'rising', 'emerald'],
                      ['Steady', 'steady', 'slate'],
                      ['Declining', 'declining', 'rose'],
                    ] as const).map(([label, trend, color]) => ({
                      label,
                      values: [
                        {
                          key: `${trend}-units`,
                          name: 'Units',
                          value: trends.filter((row) => row.trend === trend).reduce((sum, row) => sum + row.units, 0),
                          color,
                        },
                      ],
                    }))}
                    format={(v) => `${v} unit(s)`}
                  />
                </div>
              </div>
              <p className="muted mt-3 text-xs">
                Rising = ≥ +15% vs the prior period, declining = ≤ −15%, steady in between. A wide
                rising bar with a thin declining bar means the assortment is gaining momentum;
                the opposite is a prompt to review pricing or restocking on the declining lines.
              </p>
            </Card>
          )}

          <Card>
            {trends.length === 0 ? (
              <Empty message="No sales in this period for the selected scope." />
            ) : (
              <TableWrap maxHeight="70vh">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Trend</th>
                      <th>Item</th>
                      <th className="text-right">Units now</th>
                      <th className="text-right">Sales value</th>
                      <th className="text-right">Prior period</th>
                      <th className="text-right">Growth</th>
                      <th className="text-right">Velocity/day</th>
                      <th className="text-right">On hand</th>
                      <th className="text-right">Days of stock</th>
                      <th className="text-right">Proj. 30d</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trends.map((row) => (
                      <tr key={row.variantId}>
                        <td>
                          <Badge tone={trendTone(row.trend)}>{row.trend}</Badge>
                        </td>
                        <td>
                          <p className="font-medium">{row.productName} — {row.variantLabel}</p>
                          <p className="font-mono text-xs text-ink-400 dark:text-ink-500">
                            {row.sku}
                            {row.category ? ` · ${row.category}` : ''}
                          </p>
                        </td>
                        <td className="text-right font-medium tabular-nums">{row.units}</td>
                        <td className="text-right tabular-nums">{currency(row.salesValue)}</td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{row.previousUnits}</td>
                        <td className="text-right tabular-nums">
                          {row.growth >= 15 ? (
                            <span className="text-emerald-600 dark:text-emerald-400">▲ {Number(row.growth.toFixed(0))}%</span>
                          ) : row.growth <= -15 ? (
                            <span className="text-red-600 dark:text-red-400">▼ {Number(row.growth.toFixed(0))}%</span>
                          ) : (
                            <span className="text-ink-500 dark:text-ink-400">{Number(row.growth.toFixed(0))}%</span>
                          )}
                        </td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{row.velocity}</td>
                        <td className="text-right tabular-nums">{row.onHand}</td>
                        <td className="text-right">
                          {row.daysOfStock === null ? (
                            <span className="text-ink-400 dark:text-ink-500">—</span>
                          ) : row.daysOfStock < 30 ? (
                            <Badge tone="red">{row.daysOfStock}d</Badge>
                          ) : (
                            <Badge tone="neutral">{row.daysOfStock}d</Badge>
                          )}
                        </td>
                        <td className="text-right tabular-nums">{row.projected30}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        </div>
      )}
    </>
  );
}