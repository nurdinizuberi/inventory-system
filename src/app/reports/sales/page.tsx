'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Bars, HBarList } from '@/components/charts';
import { ExportButtons, money, pctText } from '@/components/report-tools';
import { Card, Empty, Kpi, TableWrap } from '@/components/ui';
import { api, errorMessage } from '@/lib/client';
import { useToast } from '@/components/toast';
import { currency, formatDate } from '@/lib/utils';

interface Bucket {
  key: string;
  label: string;
  transactions: number;
  units: number;
  revenue: number;
  cost: number;
  discount: number;
  profit: number;
  margin: number;
}

interface Report {
  buckets: Bucket[];
  totals: { transactions: number; units: number; revenue: number; cost: number; discount: number; profit: number; margin: number };
  topSellers: { variant: string; units: number; revenue: number; profit: number; margin: number }[];
  worstSellers: { variant: string; units: number; revenue: number; profit: number; margin: number }[];
  recent: { id: string; number: string; soldAt: string; location: string; cashier: string; total: number; profit: number; items: number }[];
}

export default function SalesReportPage() {
  const toast = useToast();
  const [from, setFrom] = useState(() => new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [groupBy, setGroupBy] = useState('day');
  const [includeBackdated, setIncludeBackdated] = useState(false);
  const [data, setData] = useState<Report | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<Report>(`/api/reports/sales?from=${from}&to=${to}&groupBy=${groupBy}${includeBackdated ? '&includeBackdated=1' : ''}`);
      setData(result);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [from, to, groupBy, includeBackdated, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Sales report"
        description="Units, revenue, cost and profit over a period — grouped by day, location, cashier or variant."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-ink-600 dark:text-ink-300">
              <input type="checkbox" checked={includeBackdated} onChange={(e) => setIncludeBackdated(e.target.checked)} />
              Include backdated
            </label>
            <input className="input w-40" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-ink-400 dark:text-ink-500">→</span>
            <input className="input w-40" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <select className="input w-36" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value="day">By day</option>
              <option value="location">By location</option>
              <option value="cashier">By cashier</option>
              <option value="variant">By variant</option>
            </select>
            {data && (
              <ExportButtons
                label="Export"
                csvFilename={`sales-report-${from}-to-${to}`}
                csvHeaders={[groupBy, 'Txns', 'Units', 'Revenue', 'Discounts', 'Cost', 'Profit', 'Margin %']}
                csvRows={[
                  ...data.buckets.map((b) => [b.label, b.transactions, b.units, b.revenue, b.discount, b.cost, b.profit, Number(b.margin.toFixed(1))]),
                  ['Total', data.totals.transactions, data.totals.units, data.totals.revenue, data.totals.discount, data.totals.cost, data.totals.profit, Number(data.totals.margin.toFixed(1))],
                ]}
                print={{
                  title: 'Sales report',
                  subtitle: (
                    <>
                      Period {from} → {to} · grouped by {groupBy}
                      {includeBackdated ? ' · includes backdated entries' : ''}
                    </>
                  ),
                  blocks: [
                    {
                      title: 'Summary',
                      headers: ['Metric', 'Value'],
                      rows: [
                        ['Revenue', money(data.totals.revenue)],
                        ['Cost of goods (FIFO)', money(data.totals.cost)],
                        ['Gross profit', money(data.totals.profit)],
                        ['Margin', pctText(data.totals.margin)],
                        ['Transactions', String(data.totals.transactions)],
                        ['Units sold', String(data.totals.units)],
                      ],
                    },
                    {
                      title: `Breakdown by ${groupBy}`,
                      headers: [groupBy, 'Txns', 'Units', 'Revenue', 'Discounts', 'Cost', 'Profit', 'Margin'],
                      rows: data.buckets.map((b) => [b.label, b.transactions, b.units, money(b.revenue), money(b.discount), money(b.cost), money(b.profit), pctText(b.margin)]),
                    },
                    {
                      title: 'Best sellers by profit',
                      headers: ['Variant', 'Units', 'Revenue', 'Profit'],
                      rows: data.topSellers.map((row) => [row.variant, row.units, money(row.revenue), money(row.profit)]),
                    },
                    {
                      title: 'Recent tickets',
                      headers: ['Ticket', 'Date', 'Location', 'Cashier', 'Items', 'Total'],
                      rows: data.recent.map((sale) => [sale.number, formatDate(sale.soldAt, true), sale.location, sale.cashier, sale.items, money(sale.total)]),
                    },
                  ],
                }}
              />
            )}
          </div>
        }
      />

      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="space-y-5">
          {includeBackdated && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              ⚠ This report includes backdated entries. Accurate as of {new Date().toISOString().slice(0, 10)}.
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi label="Revenue" value={currency(data.totals.revenue)} />
            <Kpi label="Cost of goods" value={currency(data.totals.cost)} hint="FIFO" />
            <Kpi label="Gross profit" value={currency(data.totals.profit)} tone={data.totals.profit >= 0 ? 'good' : 'bad'} />
            <Kpi label="Margin" value={`${data.totals.margin.toFixed(1)}%`} />
            <Kpi label="Transactions" value={data.totals.transactions} hint={`${data.totals.units} units`} />
          </div>

          <Card title={groupBy === 'day' ? 'Revenue & profit by day' : `Revenue by ${groupBy === 'location' ? 'location' : groupBy === 'cashier' ? 'cashier' : 'variant'}`}>
            {data.buckets.length === 0 ? (
              <Empty message="No sales in this period." />
            ) : groupBy === 'day' ? (
              <Bars
                height={220}
                data={data.buckets.map((bucket) => ({
                  label: bucket.label.slice(5),
                  values: [
                    { key: 'revenue', name: 'Revenue', value: bucket.revenue, color: 'sky' },
                    { key: 'profit', name: 'Profit', value: bucket.profit, color: 'emerald' },
                  ],
                }))}
                format={(v) => currency(v)}
                legend={[
                  { name: 'Revenue', color: 'sky' },
                  { name: 'Profit', color: 'emerald' },
                ]}
              />
            ) : (
              <HBarList
                items={[...data.buckets]
                  .sort((a, b) => b.revenue - a.revenue)
                  .slice(0, 12)
                  .map((b) => ({ label: b.label, value: b.revenue, hint: `${b.transactions} transaction(s)` }))}
                format={(v) => currency(v)}
                color="sky"
              />
            )}
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Best sellers by profit">
              {data.topSellers.length === 0 ? (
                <Empty />
              ) : (
                <TableWrap maxHeight="320px">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Variant</th>
                        <th className="text-right">Units</th>
                        <th className="text-right">Revenue</th>
                        <th className="text-right">Profit</th>
                        <th className="text-right">Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topSellers.map((row, i) => (
                        <tr key={`${row.variant}-${i}`}>
                          <td>{row.variant}</td>
                          <td className="text-right tabular-nums">{row.units}</td>
                          <td className="text-right tabular-nums">{currency(row.revenue)}</td>
                          <td className="text-right tabular-nums text-emerald-700 dark:text-emerald-400">{currency(row.profit)}</td>
                          <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{row.margin.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>

            <Card title="Weakest sellers">
              {data.worstSellers.length === 0 ? (
                <Empty />
              ) : (
                <TableWrap maxHeight="320px">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Variant</th>
                        <th className="text-right">Units</th>
                        <th className="text-right">Revenue</th>
                        <th className="text-right">Profit</th>
                        <th className="text-right">Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.worstSellers.map((row, i) => (
                        <tr key={`${row.variant}-${i}`}>
                          <td>{row.variant}</td>
                          <td className="text-right tabular-nums">{row.units}</td>
                          <td className="text-right tabular-nums">{currency(row.revenue)}</td>
                          <td className={`text-right tabular-nums ${row.profit >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                            {currency(row.profit)}
                          </td>
                          <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{row.margin.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          </div>

          <Card title={`Breakdown — ${groupBy}`}>
            {data.buckets.length === 0 ? (
              <Empty message="No sales in this period." />
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{groupBy === 'variant' ? 'Variant' : groupBy}</th>
                      <th className="text-right">Txns</th>
                      <th className="text-right">Units</th>
                      <th className="text-right">Revenue</th>
                      <th className="text-right">Discounts</th>
                      <th className="text-right">Cost</th>
                      <th className="text-right">Profit</th>
                      <th className="text-right">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.buckets.map((bucket) => (
                      <tr key={bucket.key}>
                        <td className="font-medium">{bucket.label}</td>
                        <td className="text-right tabular-nums">{bucket.transactions}</td>
                        <td className="text-right tabular-nums">{bucket.units}</td>
                        <td className="text-right tabular-nums">{currency(bucket.revenue)}</td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(bucket.discount)}</td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(bucket.cost)}</td>
                        <td className={`text-right tabular-nums ${bucket.profit >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                          {currency(bucket.profit)}
                        </td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{bucket.margin.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          <Card title="Most recent tickets">
            <TableWrap maxHeight="300px">
              <table className="table">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>When</th>
                    <th>Location</th>
                    <th>Cashier</th>
                    <th className="text-right">Items</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((sale) => (
                    <tr key={sale.id}>
                      <td className="font-mono">{sale.number}</td>
                      <td>{formatDate(sale.soldAt, true)}</td>
                      <td className="text-ink-600 dark:text-ink-300">{sale.location}</td>
                      <td className="text-ink-600 dark:text-ink-300">{sale.cashier}</td>
                      <td className="text-right tabular-nums">{sale.items}</td>
                      <td className="text-right tabular-nums">{currency(sale.total)}</td>
                      <td className="text-right tabular-nums text-emerald-700 dark:text-emerald-400">{currency(sale.profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </div>
      )}
    </>
  );
}
