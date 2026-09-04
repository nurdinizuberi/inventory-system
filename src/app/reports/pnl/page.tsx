'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { HBarList } from '@/components/charts';
import { ExportButtons, money, pctText } from '@/components/report-tools';
import { Card, Empty, Kpi, TableWrap } from '@/components/ui';
import { api, errorMessage } from '@/lib/client';
import { useToast } from '@/components/toast';
import { currency } from '@/lib/utils';

interface Report {
  revenue: number;
  discounts: number;
  cogs: number;
  grossProfit: number;
  grossMargin: number;
  refunds: number;
  damagedWriteOff: number;
  shrinkage: number;
  shrinkageByReason: { reason: string; units: number; value: number }[];
  netProfit: number;
  netMargin: number;
  transactions: number;
  byLocation: { location: string; revenue: number; cogs: number; profit: number; margin: number }[];
}

export default function PnlReportPage() {
  const toast = useToast();
  const [from, setFrom] = useState(() => new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<Report | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Report>(`/api/reports/pnl?from=${from}&to=${to}`));
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [from, to, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const line = (label: string, value: number, negative = false, strong = false) => (
    <div className={`flex items-center justify-between py-1.5 ${strong ? 'border-t border-ink-200 pt-3 font-semibold dark:border-ink-700' : ''}`}>
      <span className={strong ? 'text-ink-900 dark:text-ink-100' : 'text-ink-600 dark:text-ink-300'}>{label}</span>
      <span className={`tabular-nums ${negative && value > 0 ? 'text-red-600 dark:text-red-400' : strong && value >= 0 ? 'text-emerald-700 dark:text-emerald-400' : ''}`}>
        {currency(value)}
      </span>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Profit & loss"
        description="Revenue and FIFO cost of goods from the sales ledger, less refunds, damaged write-offs and stock shrinkage."
        action={
          <div className="flex items-center gap-2">
            <input className="input w-40" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-ink-400 dark:text-ink-500">→</span>
            <input className="input w-40" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            {data && (
              <ExportButtons
                label="Export"
                csvFilename={`pnl-report-${from}-to-${to}`}
                csvHeaders={['Location', 'Revenue', 'Cost of goods', 'Profit', 'Margin %']}
                csvRows={data.byLocation.map((row) => [row.location, row.revenue, row.cogs, row.profit, Number(row.margin.toFixed(1))])}
                print={{
                  title: 'Profit & loss report',
                  subtitle: <>Period {from} → {to}</>,
                  blocks: [
                    {
                      title: 'Statement',
                      headers: ['Line', 'Amount'],
                      rows: [
                        ['Revenue', money(data.revenue)],
                        ['Discounts given', money(-data.discounts)],
                        ['Cost of goods sold (FIFO)', money(-data.cogs)],
                        ['Gross profit', money(data.grossProfit)],
                        ['Refunds on returns', money(-data.refunds)],
                        ['Damaged write-offs', money(-data.damagedWriteOff)],
                        ['Stock shrinkage (adjustments)', money(-data.shrinkage)],
                        ['Net profit', money(data.netProfit)],
                      ],
                    },
                    {
                      title: 'Shrinkage by reason',
                      headers: ['Reason', 'Units', 'Cost impact'],
                      rows: data.shrinkageByReason.map((row) => [row.reason.replace(/_/g, ' '), row.units, money(-row.value)]),
                    },
                    {
                      title: 'By location',
                      headers: ['Location', 'Revenue', 'Cost of goods', 'Profit', 'Margin'],
                      rows: data.byLocation.map((row) => [row.location, money(row.revenue), money(row.cogs), money(row.profit), pctText(row.margin)]),
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
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Revenue" value={currency(data.revenue)} hint={`${data.transactions} tickets`} />
            <Kpi label="Gross profit" value={currency(data.grossProfit)} tone={data.grossProfit >= 0 ? 'good' : 'bad'} />
            <Kpi label="Gross margin" value={`${data.grossMargin.toFixed(1)}%`} />
            <Kpi label="Net profit" value={currency(data.netProfit)} tone={data.netProfit >= 0 ? 'good' : 'bad'} />
          </div>

          {data.byLocation.length > 0 && (
            <Card title="Profit by location">
              <HBarList
                items={[...data.byLocation]
                  .sort((a, b) => b.profit - a.profit)
                  .slice(0, 10)
                  .map((row) => ({ label: row.location, value: row.profit, hint: `${pctText(row.margin)} margin · ${currency(row.revenue)} revenue` }))}
                format={(v) => currency(v)}
                color="emerald"
              />
            </Card>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Statement">
              <div className="text-sm">
                {line('Revenue', data.revenue)}
                {line('Discounts given', -data.discounts)}
                {line('Cost of goods sold (FIFO)', -data.cogs)}
                {line('Gross profit', data.grossProfit, false, true)}
                {line('Refunds on returns', -data.refunds)}
                {line('Damaged write-offs', -data.damagedWriteOff)}
                {line('Stock shrinkage (adjustments)', -data.shrinkage)}
                {line('Net profit', data.netProfit, false, true)}
              </div>
              <p className="mt-4 text-xs text-ink-500 dark:text-ink-400">
                Net margin {data.netMargin.toFixed(1)}%. Shrinkage is valued at the FIFO cost of the units actually
                written off, not at list price.
              </p>
            </Card>

            <Card title="Shrinkage by reason">
              {data.shrinkageByReason.length === 0 ? (
                <Empty message="No adjustments in this period." />
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Reason</th>
                        <th className="text-right">Units</th>
                        <th className="text-right">Cost impact</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.shrinkageByReason.map((row) => (
                        <tr key={row.reason}>
                          <td className="capitalize">{row.reason.replace(/_/g, ' ')}</td>
                          <td className="text-right tabular-nums">{row.units}</td>
                          <td className="text-right tabular-nums text-red-600 dark:text-red-400">{currency(-row.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          </div>

          <Card title="By location">
            {data.byLocation.length === 0 ? (
              <Empty message="No sales in this period." />
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th className="text-right">Revenue</th>
                      <th className="text-right">Cost of goods</th>
                      <th className="text-right">Profit</th>
                      <th className="text-right">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byLocation.map((row) => (
                      <tr key={row.location}>
                        <td className="font-medium">{row.location}</td>
                        <td className="text-right tabular-nums">{currency(row.revenue)}</td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(row.cogs)}</td>
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
      )}
    </>
  );
}
