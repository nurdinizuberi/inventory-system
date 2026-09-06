'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/shell';
import { Badge, Card, Empty, TableWrap } from '@/components/ui';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { formatDate } from '@/lib/utils';

interface LocationOption {
  id: string;
  name: string;
  type: string;
}

interface SheetRow {
  variantId: string;
  productName: string;
  category: string | null;
  variantLabel: string;
  sku: string;
  barcode: string | null;
  onHand: number;
  reserved: number;
}

interface PendingAdjustment {
  id: string;
  number: string;
  quantity: number;
  notes: string | null;
  createdAt: string;
  variant: { id: string; product: { name: string }; label: string };
  createdBy: { name: string } | null;
}

export default function StockCountPage() {
  const toast = useToast();
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [sheet, setSheet] = useState<SheetRow[]>([]);
  const [pending, setPending] = useState<PendingAdjustment[]>([]);
  const [locationId, setLocationId] = useState('');
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(
    async (locId: string) => {
      try {
        const params = new URLSearchParams();
        if (locId) params.set('locationId', locId);
        const data = await api.get<{ locations: LocationOption[]; sheet: SheetRow[]; pending: PendingAdjustment[] }>(
          `/api/stock-counts?${params.toString()}`,
        );
        setLocations(data.locations);
        setSheet(data.sheet);
        setPending(data.pending);
        if (!locId && data.locations.length > 0) setLocationId(data.locations[0].id);
      } catch (err) {
        toast.push('error', errorMessage(err));
      }
    },
    [toast],
  );

  useEffect(() => {
    void load(locationId);
  }, [load, locationId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sheet;
    return sheet.filter(
      (row) =>
        row.productName.toLowerCase().includes(q) ||
        row.variantLabel.toLowerCase().includes(q) ||
        row.sku.toLowerCase().includes(q) ||
        (row.barcode ?? '').toLowerCase().includes(q),
    );
  }, [sheet, search]);

  const pendingVariantIds = useMemo(() => new Set(pending.map((p) => p.variant.id)), [pending]);

  const fillAll = () => {
    const next: Record<string, string> = {};
    for (const row of sheet) next[row.variantId] = String(row.onHand);
    setCounted(next);
  };

  const submit = async () => {
    const entries = filtered
      .map((row) => ({
        variantId: row.variantId,
        counted: Number(counted[row.variantId] ?? ''),
      }))
      .filter((e) => !Number.isNaN(e.counted) && e.counted >= 0);
    if (entries.length === 0) {
      toast.push('error', 'Enter at least one counted quantity.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.post<{ created: number }>('/api/stock-counts', { locationId, entries });
      toast.push(
        'success',
        result.created === 0
          ? 'Count matches the ledger — no corrections needed.'
          : `${result.created} count correction(s) raised — pending manager approval.`,
      );
      setCounted({});
      await load(locationId);
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Stock counts"
        description="Count a shelf, shelf by shelf. Anything that differs from the ledger is raised as a count_correction adjustment that only moves stock once a manager approves it."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-56" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.length === 0 && <option value="">No locations</option>}
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
            <button className="btn-secondary btn-sm" onClick={fillAll} type="button">
              All match ledger
            </button>
            <button className="btn-primary btn-sm" onClick={() => void submit()} disabled={submitting} type="button">
              {submitting ? 'Counting…' : 'Submit count'}
            </button>
          </div>
        }
      />

      {pending.length > 0 && (
        <div className="mb-5">
          <Card
            title="Awaiting review"
            subtitle="Count corrections already raised for this location — approve or reject them first so a second count does not pile up."
            action={
              <Link className="btn-secondary btn-sm" href="/adjustments?status=pending">
                Review all
              </Link>
            }
          >
            <TableWrap maxHeight="240px">
              <table className="table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Variant</th>
                    <th className="text-right">Correction</th>
                    <th>Notes</th>
                    <th>By</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((adjustment) => (
                    <tr key={adjustment.id}>
                      <td className="font-mono font-medium">{adjustment.number}</td>
                      <td>
                        {adjustment.variant.product.name} — {adjustment.variant.label}
                      </td>
                      <td className="text-right font-medium tabular-nums">
                        {adjustment.quantity > 0 ? '+' : ''}
                        {adjustment.quantity}
                      </td>
                      <td className="max-w-[20rem] truncate text-ink-500 dark:text-ink-400">{adjustment.notes ?? '—'}</td>
                      <td className="text-ink-600 dark:text-ink-300">{adjustment.createdBy?.name ?? '—'}</td>
                      <td className="whitespace-nowrap text-ink-500 dark:text-ink-400">
                        {formatDate(adjustment.createdAt, true)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </div>
      )}

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-500 dark:text-ink-400">
            {filtered.length} line(s) · only lines with stock are listed — leave the count blank to skip a line, or enter it and differences are submitted.
          </p>
          <input
            className="input w-64"
            placeholder="Search product, label, SKU or barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {filtered.length === 0 ? (
          <Empty message="No stock on hand at this location — nothing to count." />
        ) : (
          <TableWrap maxHeight="65vh">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-2/5">Variant</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Reserved</th>
                  <th className="w-32 text-right">Counted qty</th>
                  <th className="text-right">Delta</th>
                  <th className="text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const entered = Number(counted[row.variantId] ?? '');
                  const hasEntry = !Number.isNaN(entered) && counted[row.variantId] !== '';
                  const delta = hasEntry ? entered - row.onHand : null;
                  const awaiting = pendingVariantIds.has(row.variantId);
                  const pendingAdjustment = pending.find((p) => p.variant.id === row.variantId);
                  return (
                    <tr key={row.variantId}>
                      <td>
                        <p className="font-medium">{row.productName} — {row.variantLabel}</p>
                        <p className="font-mono text-xs text-ink-400 dark:text-ink-500">
                          {row.sku}
                          {row.barcode ? ` · ${row.barcode}` : ''}
                        </p>
                      </td>
                      <td className="text-right tabular-nums">{row.onHand}</td>
                      <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{row.reserved}</td>
                      <td className="text-right">
                        <input
                          className="input w-28 text-right tabular-nums"
                          type="number"
                          min={0}
                          value={counted[row.variantId] ?? ''}
                          placeholder={String(row.onHand)}
                          disabled={awaiting}
                          onChange={(e) => setCounted((prev) => ({ ...prev, [row.variantId]: e.target.value }))}
                        />
                      </td>
                      <td className="text-right tabular-nums">
                        {awaiting ? (
                          <span className="text-xs text-ink-400 dark:text-ink-500">in review</span>
                        ) : delta === null ? (
                          <span className="text-ink-400 dark:text-ink-500">—</span>
                        ) : delta === 0 ? (
                          <Badge tone="green">0</Badge>
                        ) : (
                          <Badge tone={delta > 0 ? 'blue' : 'red'}>
                            {delta > 0 ? '+' : ''}
                            {delta}
                          </Badge>
                        )}
                      </td>
                      <td className="text-right whitespace-nowrap">
                        {awaiting ? (
                          <span className="text-xs text-amber-600 dark:text-amber-400">
                            {pendingAdjustment?.number ?? 'pending'}
                          </span>
                        ) : delta === 0 ? (
                          <span className="text-xs text-emerald-600 dark:text-emerald-400">matches ledger</span>
                        ) : delta === null ? (
                          <span className="text-xs text-ink-400 dark:text-ink-500">not entered</span>
                        ) : (
                          <span className="text-xs text-ink-500 dark:text-ink-400">to adjust</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}