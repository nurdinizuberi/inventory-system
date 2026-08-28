'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Kpi, TableWrap } from '@/components/ui';
import { api, errorMessage } from '@/lib/client';
import { useToast } from '@/components/toast';
import { currency } from '@/lib/utils';

interface Row {
  variantId: string;
  locationId: string;
  productName: string;
  category: string | null;
  variantLabel: string;
  sku: string;
  locationName: string;
  locationType: string;
  onHand: number;
  reserved: number;
  sellable: number;
  sold: number;
  lowStockThreshold: number;
  lowStock: boolean;
  outOfStock: boolean;
  unitCost: number;
  stockValue: number;
}

interface LocationOption {
  id: string;
  name: string;
  type: string;
}

export default function StockReportPage() {
  const toast = useToast();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<Row[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [totals, setTotals] = useState({ units: 0, value: 0, lowStock: 0, outOfStock: 0 });
  const [locationId, setLocationId] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [onlyLow, setOnlyLow] = useState(searchParams.get('onlyLow') === '1');
  const [hideZero, setHideZero] = useState(true);
  const [asOfDate, setAsOfDate] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (locationId) params.set('locationId', locationId);
      if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());
      if (onlyLow) params.set('onlyLow', '1');
      if (asOfDate) params.set('asOfDate', asOfDate);
      const data = await api.get<{ rows: Row[]; locations: LocationOption[]; totals: typeof totals }>(
        `/api/reports/stock?${params.toString()}`,
      );
      setRows(data.rows);
      setLocations(data.locations);
      setTotals(data.totals);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [locationId, debouncedQuery, onlyLow, asOfDate, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = hideZero ? rows.filter((row) => row.onHand !== 0) : rows;

  return (
    <>
      <PageHeader
        title="Current stock report"
        description="On hand per variant per location, derived live from the movement ledger, with low-stock flags."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-56" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All locations</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
            <input
              className="input w-48"
              placeholder="Search variant or SKU…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="flex items-center gap-1.5 text-sm text-ink-600 dark:text-ink-300">
              <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
              low only
            </label>
            <label className="flex items-center gap-1.5 text-sm text-ink-600 dark:text-ink-300">
              <span>As of</span>
              <input className="input w-36" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
            </label>
            <label className="flex items-center gap-1.5 text-sm text-ink-600 dark:text-ink-300">
              <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
              hide empty
            </label>
          </div>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Units on hand" value={totals.units.toLocaleString()} />
        <Kpi label="Stock value" value={currency(totals.value)} hint="At latest purchase cost" />
        <Kpi label="Low stock lines" value={totals.lowStock} tone={totals.lowStock ? 'warn' : 'good'} />
        <Kpi label="Out of stock" value={totals.outOfStock} tone={totals.outOfStock ? 'bad' : 'good'} />
      </div>

      <Card>
        {visible.length === 0 ? (
          <Empty message="No stock rows match these filters." />
        ) : (
          <TableWrap maxHeight="70vh">
            <table className="table">
              <thead>
                <tr>
                  <th>Variant</th>
                  <th>SKU</th>
                  <th>Location</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Reserved</th>
                  <th className="text-right">Sellable</th>
                  <th className="text-right">Sold to date</th>
                  <th className="text-right">Unit cost</th>
                  <th className="text-right">Value</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={`${row.variantId}-${row.locationId}`}>
                    <td>
                      <span className="font-medium">{row.productName}</span>
                      <span className="text-ink-500 dark:text-ink-400"> — {row.variantLabel}</span>
                      {row.category && <span className="block text-xs text-ink-400 dark:text-ink-500">{row.category}</span>}
                    </td>
                    <td className="font-mono text-xs">{row.sku}</td>
                    <td className="text-ink-600 dark:text-ink-300">{row.locationName}</td>
                    <td className="text-right font-semibold tabular-nums">{row.onHand}</td>
                    <td className="text-right tabular-nums text-violet-700 dark:text-violet-300">{row.reserved}</td>
                    <td className="text-right tabular-nums">{row.sellable}</td>
                    <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{row.sold}</td>
                    <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(row.unitCost)}</td>
                    <td className="text-right tabular-nums">{currency(row.stockValue)}</td>
                    <td>
                      {row.outOfStock ? (
                        <Badge tone="red">out of stock</Badge>
                      ) : row.lowStock ? (
                        <Badge tone="amber">≤ {row.lowStockThreshold}</Badge>
                      ) : (
                        <Badge tone="green">ok</Badge>
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
