'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Kpi, TableWrap } from '@/components/ui';
import { api, errorMessage } from '@/lib/client';
import { useToast } from '@/components/toast';
import { currency } from '@/lib/utils';

interface Report {
  byLocation: {
    locationId: string;
    location: string;
    type: string;
    units: number;
    lots: number;
    fifoValue: number;
    latestCostValue: number;
    averageCostValue: number;
  }[];
  byVariant: { location: string; variant: string; sku: string; units: number; lots: number; unitCost: number; value: number }[];
  totals: { units: number; lots: number; fifoValue: number; latestCostValue: number; averageCostValue: number };
}

export default function ValuationReportPage() {
  const toast = useToast();
  const [data, setData] = useState<Report | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Report>('/api/reports/valuation'));
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Inventory valuation"
        description="Value of stock on hand per location, computed three ways from the ledger and the lots it opened."
      />

      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Units on hand" value={data.totals.units.toLocaleString()} hint={`${data.totals.lots} open lots`} />
            <Kpi label="FIFO / lot value" value={currency(data.totals.fifoValue)} tone="good" />
            <Kpi label="Latest cost value" value={currency(data.totals.latestCostValue)} />
            <Kpi label="Weighted average value" value={currency(data.totals.averageCostValue)} />
          </div>

          <Card title="By location" subtitle="Differences between methods reveal where older, cheaper stock is still sitting">
            {data.byLocation.length === 0 ? (
              <Empty />
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th>Type</th>
                      <th className="text-right">Units</th>
                      <th className="text-right">Open lots</th>
                      <th className="text-right">FIFO value</th>
                      <th className="text-right">Latest cost</th>
                      <th className="text-right">Average cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byLocation.map((row) => (
                      <tr key={row.locationId}>
                        <td className="font-medium">{row.location}</td>
                        <td>
                          <Badge tone={row.type === 'WAREHOUSE' ? 'blue' : row.type === 'RETAIL_STORE' ? 'green' : 'red'}>
                            {row.type.replace('_', ' ').toLowerCase()}
                          </Badge>
                        </td>
                        <td className="text-right tabular-nums">{row.units.toLocaleString()}</td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{row.lots}</td>
                        <td className="text-right font-semibold tabular-nums">{currency(row.fifoValue)}</td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(row.latestCostValue)}</td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(row.averageCostValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          <Card title="Top holdings by FIFO value">
            {data.byVariant.length === 0 ? (
              <Empty />
            ) : (
              <TableWrap maxHeight="55vh">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Variant</th>
                      <th>SKU</th>
                      <th>Location</th>
                      <th className="text-right">Units</th>
                      <th className="text-right">Lots</th>
                      <th className="text-right">Avg unit cost</th>
                      <th className="text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byVariant.map((row, index) => (
                      <tr key={`${row.sku}-${row.location}-${index}`}>
                        <td>{row.variant}</td>
                        <td className="font-mono text-xs">{row.sku}</td>
                        <td className="text-ink-600 dark:text-ink-300">{row.location}</td>
                        <td className="text-right tabular-nums">{row.units}</td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{row.lots}</td>
                        <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(row.unitCost)}</td>
                        <td className="text-right font-medium tabular-nums">{currency(row.value)}</td>
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
