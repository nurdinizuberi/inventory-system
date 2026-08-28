'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Card, Empty, Kpi, TableWrap } from '@/components/ui';
import { api, errorMessage } from '@/lib/client';
import { useToast } from '@/components/toast';
import { currency, formatDate } from '@/lib/utils';

interface Report {
  purchases: {
    id: string;
    number: string;
    supplier: string;
    location: string;
    orderDate: string;
    total: number;
    lines: { variant: string; sku: string; quantity: number; unitCost: number; lineTotal: number; batch: string | null }[];
  }[];
  bySupplier: { supplier: string; orders: number; units: number; value: number }[];
  byVariant: { variant: string; units: number; value: number; avgCost: number }[];
  totals: { orders: number; units: number; value: number };
}

export default function PurchaseReportPage() {
  const toast = useToast();
  const [from, setFrom] = useState(() => new Date(Date.now() - 179 * 864e5).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<Report | null>(null);
  const [includeBackdated, setIncludeBackdated] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Report>(`/api/reports/purchases?from=${from}&to=${to}${includeBackdated ? '&includeBackdated=1' : ''}`));
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [from, to, includeBackdated, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Purchase history"
        description="Confirmed purchase orders by supplier and variant, with the batches they opened."
        action={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-ink-600 dark:text-ink-300">
              <input type="checkbox" checked={includeBackdated} onChange={(e) => setIncludeBackdated(e.target.checked)} />
              Include backdated
            </label>
            <input className="input w-40" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-ink-400 dark:text-ink-500">→</span>
            <input className="input w-40" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        }
      />

      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Kpi label="Purchase orders" value={data.totals.orders} />
            <Kpi label="Units bought" value={data.totals.units.toLocaleString()} />
            <Kpi label="Purchase value" value={currency(data.totals.value)} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="By supplier">
              {data.bySupplier.length === 0 ? (
                <Empty />
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Supplier</th>
                        <th className="text-right">Orders</th>
                        <th className="text-right">Units</th>
                        <th className="text-right">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.bySupplier.map((row) => (
                        <tr key={row.supplier}>
                          <td className="font-medium">{row.supplier}</td>
                          <td className="text-right tabular-nums">{row.orders}</td>
                          <td className="text-right tabular-nums">{row.units}</td>
                          <td className="text-right tabular-nums">{currency(row.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>

            <Card title="By variant">
              {data.byVariant.length === 0 ? (
                <Empty />
              ) : (
                <TableWrap maxHeight="340px">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Variant</th>
                        <th className="text-right">Units</th>
                        <th className="text-right">Avg cost</th>
                        <th className="text-right">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byVariant.map((row) => (
                        <tr key={row.variant}>
                          <td>{row.variant}</td>
                          <td className="text-right tabular-nums">{row.units}</td>
                          <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(row.avgCost)}</td>
                          <td className="text-right tabular-nums">{currency(row.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          </div>

          <Card title="Purchase orders">
            <TableWrap maxHeight="50vh">
              <table className="table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Supplier</th>
                    <th>Warehouse</th>
                    <th>Date</th>
                    <th>Lines</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.purchases.map((purchase) => (
                    <tr key={purchase.id}>
                      <td className="font-mono font-medium">{purchase.number}</td>
                      <td>{purchase.supplier}</td>
                      <td className="text-ink-600 dark:text-ink-300">{purchase.location}</td>
                      <td>{formatDate(purchase.orderDate)}</td>
                      <td className="text-xs text-ink-600 dark:text-ink-300">
                        {purchase.lines.map((line) => `${line.quantity}× ${line.variant}`).join(' · ')}
                      </td>
                      <td className="text-right tabular-nums">{currency(purchase.total)}</td>
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
