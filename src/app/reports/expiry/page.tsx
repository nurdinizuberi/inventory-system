'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { ExportButtons, money } from '@/components/report-tools';
import { Badge, Card, Empty, Kpi, TableWrap } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { currency, formatDate } from '@/lib/utils';

interface ExpiryRow {
  batchId: string;
  code: string;
  variantId: string;
  locationId: string;
  productName: string;
  category: string | null;
  variantLabel: string;
  sku: string;
  locationName: string;
  expiresAt: string;
  daysLeft: number;
  remainingQty: number;
  unitCost: number;
  value: number;
}

interface LocationOption {
  id: string;
  name: string;
  type: string;
}

export default function ExpiryReportPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<ExpiryRow[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [totals, setTotals] = useState({
    lines: 0,
    units: 0,
    valueAtRisk: 0,
    expiredUnits: 0,
    expiredValue: 0,
    soonUnits: 0,
    soonValue: 0,
  });
  const [locationId, setLocationId] = useState('');
  const [horizon, setHorizon] = useState(90);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ horizon: String(horizon) });
      if (locationId) params.set('locationId', locationId);
      const data = await api.get<{ rows: ExpiryRow[]; locations: LocationOption[]; totals: typeof totals }>(
        `/api/reports/expiry?${params.toString()}`,
      );
      setRows(data.rows);
      setLocations(data.locations);
      setTotals(data.totals);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [locationId, horizon, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const writeOff = async (row: ExpiryRow) => {
    if (
      !confirm(
        `Write off the ${row.remainingQty} expired unit(s) of ${row.productName} — ${row.variantLabel} (batch ${row.code})? It raises an expired-stock adjustment pending manager approval.`,
      )
    )
      return;
    try {
      await api.post('/api/adjustments', {
        variantId: row.variantId,
        locationId: row.locationId,
        reason: 'expired',
        quantity: -row.remainingQty,
        notes: `Write-off from expiry report — batch ${row.code} expired ${formatDate(row.expiresAt)}`,
      });
      toast.push('success', 'Expired write-off raised — pending approval.');
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Approaching expiry"
        description="Batches still on the shelf with a best-before date inside the horizon. Expired lots can be written off straight into the adjustment approval flow."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-52" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All locations</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
            <select className="input w-36" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              <option value={15}>15 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
            </select>
            {rows.length > 0 && (
              <ExportButtons
                label="Export"
                csvFilename={`expiry-report-horizon-${horizon}${locationId ? `-${locationId}` : ''}`}
                csvHeaders={['Batch', 'Product', 'Variant', 'SKU', 'Category', 'Location', 'Expiry', 'Days left', 'Qty', 'Unit cost', 'Value']}
                csvRows={rows.map((row) => [
                  row.code,
                  row.productName,
                  row.variantLabel,
                  row.sku,
                  row.category ?? '',
                  row.locationName,
                  formatDate(row.expiresAt),
                  row.daysLeft,
                  row.remainingQty,
                  row.unitCost,
                  row.value,
                ])}
                print={{
                  title: 'Approaching expiry report',
                  subtitle: `${horizon}-day horizon · ${locationId ? `Location: ${locations.find((l) => l.id === locationId)?.name ?? locationId}` : 'All locations'}`,
                  blocks: [
                    {
                      title: 'Summary',
                      headers: ['Metric', 'Value'],
                      rows: [
                        ['Batches at risk', String(totals.lines)],
                        ['Units at risk', String(totals.units)],
                        ['Value at risk', money(totals.valueAtRisk)],
                        ['Expired units', String(totals.expiredUnits)],
                        ['Expired value', money(totals.expiredValue)],
                        ['Expiring within 30 days', String(totals.soonUnits)],
                      ],
                    },
                    {
                      title: `Batches (${rows.length})`,
                      headers: ['Batch', 'Product', 'Variant', 'SKU', 'Location', 'Expiry', 'Days left', 'Qty', 'Value'],
                      rows: rows.map((row) => [
                        row.code,
                        row.productName,
                        row.variantLabel,
                        row.sku,
                        row.locationName,
                        formatDate(row.expiresAt),
                        String(row.daysLeft),
                        String(row.remainingQty),
                        money(row.value),
                      ]),
                    },
                  ],
                }}
              />
            )}
          </div>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Expired units" value={totals.expiredUnits} tone={totals.expiredUnits ? 'bad' : 'good'} hint={`${currency(totals.expiredValue)} written off value`} />
        <Kpi label="Expiring ≤ 30 days" value={totals.soonUnits} tone={totals.soonUnits ? 'warn' : 'good'} hint={`${currency(totals.soonValue)} at risk`} />
        <Kpi label={`Units at risk (${horizon}d)`} value={totals.units} hint={`${totals.lines} batch(es)`} />
        <Kpi label="Value at risk" value={currency(totals.valueAtRisk)} tone={totals.valueAtRisk ? 'warn' : 'default'} />
      </div>

      <Card>
        {rows.length === 0 ? (
          <Empty message={`No batches expiring within ${horizon} days match these filters.`} />
        ) : (
          <TableWrap maxHeight="70vh">
            <table className="table">
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Item</th>
                  <th className="text-right">SKU</th>
                  <th>Location</th>
                  <th>Expires</th>
                  <th className="text-right">Days left</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.batchId}>
                    <td className="font-mono font-medium">{row.code}</td>
                    <td>
                      {row.productName} — {row.variantLabel}
                      {row.category && (
                        <span className="block text-xs text-ink-400 dark:text-ink-500">{row.category}</span>
                      )}
                    </td>
                    <td className="text-right font-mono text-xs">{row.sku}</td>
                    <td className="text-ink-600 dark:text-ink-300">{row.locationName}</td>
                    <td className="whitespace-nowrap tabular-nums">{formatDate(row.expiresAt)}</td>
                    <td className="text-right">
                      {row.daysLeft < 0 ? (
                        <Badge tone="red">expired {Math.abs(row.daysLeft)}d ago</Badge>
                      ) : row.daysLeft <= 7 ? (
                        <Badge tone="red">{row.daysLeft}d</Badge>
                      ) : row.daysLeft <= 30 ? (
                        <Badge tone="amber">{row.daysLeft}d</Badge>
                      ) : (
                        <Badge tone="neutral">{row.daysLeft}d</Badge>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{row.remainingQty}</td>
                    <td className="text-right tabular-nums">{currency(row.value)}</td>
                    <td className="text-right whitespace-nowrap">
                      {row.daysLeft < 0 && can('stock.adjust') ? (
                        <button className="btn-danger btn-sm" onClick={() => void writeOff(row)} type="button">
                          Write off
                        </button>
                      ) : (
                        <span className="text-xs text-ink-400 dark:text-ink-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}