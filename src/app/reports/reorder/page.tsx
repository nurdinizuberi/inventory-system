'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { ExportButtons, money } from '@/components/report-tools';
import { Badge, Card, Empty, Kpi, TableWrap } from '@/components/ui';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { currency } from '@/lib/utils';

interface ReorderRow {
  variantId: string;
  locationId: string;
  productName: string;
  category: string | null;
  variantLabel: string;
  sku: string;
  locationName: string;
  locationType: string;
  onHand: number;
  threshold: number;
  outOfStock: boolean;
  suggestedQty: number;
  unitCost: number;
  estimatedCost: number;
}

interface LocationOption {
  id: string;
  name: string;
  type: string;
}

export default function ReorderReportPage() {
  const toast = useToast();
  const [rows, setRows] = useState<ReorderRow[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [totals, setTotals] = useState({ lines: 0, units: 0, value: 0, outOfStock: 0 });
  const [locationId, setLocationId] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (locationId) params.set('locationId', locationId);
      const data = await api.get<{ rows: ReorderRow[]; locations: LocationOption[]; totals: typeof totals }>(
        `/api/reports/reorder?${params.toString()}`,
      );
      setRows(data.rows);
      setLocations(data.locations);
      setTotals(data.totals);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [locationId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Reorder suggestions"
        description="Lines at or below their low-stock threshold, with the quantity to top back up to twice the threshold. Cost estimates use the most recent purchase cost."
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
            {rows.length > 0 && (
              <ExportButtons
                label="Export"
                csvFilename={`reorder-report${locationId ? `-${locationId}` : ''}`}
                csvHeaders={['Product', 'Variant', 'SKU', 'Category', 'Location', 'On hand', 'Reorder point', 'Suggest qty', 'Unit cost', 'Est. cost']}
                csvRows={rows.map((row) => [
                  row.productName,
                  row.variantLabel,
                  row.sku,
                  row.category ?? '',
                  row.locationName,
                  row.onHand,
                  row.threshold,
                  row.suggestedQty,
                  row.unitCost,
                  row.estimatedCost,
                ])}
                print={{
                  title: 'Reorder suggestions',
                  subtitle: locationId ? `Location: ${locations.find((l) => l.id === locationId)?.name ?? locationId}` : 'All locations',
                  blocks: [
                    {
                      title: 'Summary',
                      headers: ['Metric', 'Value'],
                      rows: [
                        ['Suggestions', String(totals.lines)],
                        ['Units to order', String(totals.units)],
                        ['Estimated cost', money(totals.value)],
                        ['Out of stock', String(totals.outOfStock)],
                      ],
                    },
                    {
                      title: `Suggestions (${rows.length})`,
                      headers: ['Product', 'Variant', 'SKU', 'Location', 'On hand', 'Reorder point', 'Suggest qty', 'Est. cost'],
                      rows: rows.map((row) => [
                        row.productName,
                        row.variantLabel,
                        row.sku,
                        row.locationName,
                        String(row.onHand),
                        String(row.threshold),
                        String(row.suggestedQty),
                        money(row.estimatedCost),
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
        <Kpi label="Suggestions" value={totals.lines} hint="variant × location lines" />
        <Kpi label="Units to order" value={totals.units} hint="top up to 2× threshold" />
        <Kpi label="Out of stock" value={totals.outOfStock} tone={totals.outOfStock ? 'bad' : 'good'} hint="lines with zero on hand" />
        <Kpi label="Estimated cost" value={currency(totals.value)} hint="at latest purchase cost" />
      </div>

      <Card>
        {rows.length === 0 ? (
          <Empty message="Everything is above its reorder point — no suggestions right now." />
        ) : (
          <TableWrap maxHeight="70vh">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right">SKU</th>
                  <th>Location</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Reorder point</th>
                  <th className="text-right">Suggest</th>
                  <th className="text-right">Unit cost</th>
                  <th className="text-right">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.variantId}|${row.locationId}`} className={row.outOfStock ? 'bg-red-50/50 dark:bg-red-950/20' : undefined}>
                    <td>
                      {row.productName} — {row.variantLabel}
                      {row.category && (
                        <span className="block text-xs text-ink-400 dark:text-ink-500">{row.category}</span>
                      )}
                    </td>
                    <td className="text-right font-mono text-xs">{row.sku}</td>
                    <td className="text-ink-600 dark:text-ink-300">{row.locationName}</td>
                    <td className="text-right tabular-nums">
                      {row.onHand}{' '}
                      {row.outOfStock ? (
                        <Badge tone="red">out of stock</Badge>
                      ) : row.onHand <= row.threshold / 2 ? (
                        <Badge tone="amber">low</Badge>
                      ) : (
                        <Badge tone="neutral">low</Badge>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{row.threshold}</td>
                    <td className="text-right font-medium tabular-nums">{row.suggestedQty}</td>
                    <td className="text-right tabular-nums">{currency(row.unitCost)}</td>
                    <td className="text-right font-medium tabular-nums">{currency(row.estimatedCost)}</td>
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