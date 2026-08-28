'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Card, Empty, MovementBadge, TableWrap } from '@/components/ui';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { MOVEMENT_TYPES } from '@/lib/types';
import { currency, formatDate } from '@/lib/utils';

interface Movement {
  id: string;
  type: string;
  quantity: number;
  status: string;
  unitCost: number | null;
  totalCost: number | null;
  adjustmentReason: string | null;
  referenceLabel: string | null;
  referenceType: string | null;
  notes: string | null;
  createdAt: string;
  effectiveDate: string;
  isBackdated: boolean;
  backdateReason: string | null;
  variant: { product: { name: string }; label: string; sku: string };
  location: { name: string };
  batch: { code: string } | null;
  resultingBatch: { code: string } | null;
  createdBy: { name: string } | null;
  approvedBy: { name: string } | null;
}

interface LocationOption {
  id: string;
  name: string;
}

export default function StockLedgerPage() {
  const toast = useToast();
  const [movements, setMovements] = useState<Movement[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [type, setType] = useState('');
  const [locationId, setLocationId] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (locationId) params.set('locationId', locationId);
      params.set('take', '300');
      const [movementData, locationData] = await Promise.all([
        api.get<{ movements: Movement[] }>(`/api/stock/movements?${params.toString()}`),
        api.get<{ locations: LocationOption[] }>('/api/locations'),
      ]);
      setMovements(movementData.movements);
      setLocations(locationData.locations);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [type, locationId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Shell>
      <PageHeader
        title="Stock movement ledger"
        description="The append-only record of every stock event. Current stock is SUM(quantity) over these rows — it is never stored separately."
      />

      <Card
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-44" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All movement types</option>
              {MOVEMENT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
            <select className="input w-56" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All locations</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {movements.length === 0 ? (
          <Empty message="No movements match these filters." />
        ) : (
          <TableWrap maxHeight="70vh">
            <table className="table">
              <thead>
                <tr>
                  <th>Entered</th>
                  <th>Effective</th>
                  <th>Type</th>
                  <th>Variant</th>
                  <th>Location</th>
                  <th className="text-right">Qty</th>
                  <th>Status</th>
                  <th>Batch</th>
                  <th className="text-right">Unit cost</th>
                  <th className="text-right">Value</th>
                  <th>Reference</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((movement) => (
                  <tr key={movement.id}>
                    <td className="whitespace-nowrap text-ink-600 dark:text-ink-300">{formatDate(movement.createdAt, true)}</td>
                    <td className="whitespace-nowrap">
                      <span className={movement.isBackdated ? 'text-amber-600 font-medium dark:text-amber-400' : 'text-ink-600 dark:text-ink-300'}>
                        {formatDate(movement.effectiveDate)}
                      </span>
                      {movement.isBackdated && (
                        <span className="block text-[10px] text-amber-500">backdated{movement.backdateReason ? `: ${movement.backdateReason.replace(/_/g, ' ')}` : ''}</span>
                      )}
                    </td>
                    <td>
                      <MovementBadge type={movement.type} />
                      {movement.adjustmentReason && (
                        <span className="ml-1 text-xs text-ink-500 dark:text-ink-400">({movement.adjustmentReason.replace(/_/g, ' ')})</span>
                      )}
                    </td>
                    <td>
                      {movement.variant.product.name} — {movement.variant.label}
                      <span className="block font-mono text-xs text-ink-400 dark:text-ink-500">{movement.variant.sku}</span>
                    </td>
                    <td className="text-ink-600 dark:text-ink-300">{movement.location.name}</td>
                    <td
                      className={`text-right font-semibold tabular-nums ${
                        movement.quantity < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {movement.quantity > 0 ? '+' : ''}
                      {movement.quantity}
                    </td>
                    <td className="text-xs text-ink-500 dark:text-ink-400">{movement.status}</td>
                    <td className="font-mono text-xs text-ink-500 dark:text-ink-400">
                      {movement.batch?.code ?? '—'}
                      {movement.resultingBatch && <span className="block">→ {movement.resultingBatch.code}</span>}
                    </td>
                    <td className="text-right tabular-nums">{movement.unitCost ? currency(movement.unitCost) : '—'}</td>
                    <td className="text-right tabular-nums">{movement.totalCost ? currency(movement.totalCost) : '—'}</td>
                    <td className="text-xs text-ink-500 dark:text-ink-400">
                      {movement.referenceType ? `${movement.referenceType}: ` : ''}
                      {movement.referenceLabel ?? '—'}
                    </td>
                    <td className="text-xs text-ink-600 dark:text-ink-300">
                      {movement.createdBy?.name ?? '—'}
                      {movement.approvedBy && <span className="block text-ink-400 dark:text-ink-500">appr. {movement.approvedBy.name}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </Shell>
  );
}
