'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap, statusTone } from '@/components/ui';
import { BackdateDialog, isBackdated, todayISO } from '@/components/backdate-dialog';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { currency, formatDate } from '@/lib/utils';
import type { BackdateReason } from '@/lib/types';

interface Transfer {
  id: string;
  number: string;
  status: string;
  requestedAt: string;
  shippedAt: string | null;
  completedAt: string | null;
  fromLocation: { id: string; name: string };
  toLocation: { id: string; name: string };
  createdBy: { name: string } | null;
  lines: { id: string; quantity: number; receivedQty: number; variant: { product: { name: string }; label: string } }[];
}

interface StockOption {
  id: string;
  displayName: string;
  sku: string;
  sellable: number;
}

interface LocationOption {
  id: string;
  name: string;
  type: string;
}

export default function TransfersPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [stock, setStock] = useState<StockOption[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ fromLocationId: '', toLocationId: '', notes: '' });
  const [lines, setLines] = useState<{ variantId: string; quantity: string }[]>([]);
  const [filter, setFilter] = useState('all');
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [backdateWarningOpen, setBackdateWarningOpen] = useState(false);

  const load = useCallback(async () => {
    const [transferResult, locationResult] = await Promise.allSettled([
      api.get<{ transfers: Transfer[] }>(`/api/transfers${filter === 'all' ? '' : `?status=${filter}`}`),
      api.get<{ locations: LocationOption[] }>('/api/locations'),
    ]);
    if (transferResult.status === 'fulfilled') setTransfers(transferResult.value.transfers);
    else toast.push('error', errorMessage(transferResult.reason));
    if (locationResult.status === 'fulfilled')
      setLocations(locationResult.value.locations.filter((l) => l.type !== 'DAMAGED'));
    else toast.push('error', errorMessage(locationResult.reason));
  }, [filter, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadStock = async (locationId: string) => {
    if (!locationId) return setStock([]);
    try {
      const data = await api.get<{ variants: StockOption[] }>(`/api/variants?locationId=${locationId}`);
      setStock(data.variants);
    } catch (err) {
      toast.push('error', errorMessage(err));
      setStock([]);
    }
  };

  const submit = async (backdateReason?: BackdateReason | null) => {
    setBusy(true);
    try {
      await api.post('/api/transfers', {
        fromLocationId: form.fromLocationId,
        toLocationId: form.toLocationId,
        notes: form.notes || null,
        effectiveDate,
        backdateReason: backdateReason ?? null,
        lines: lines.filter((l) => l.variantId).map((l) => ({ variantId: l.variantId, quantity: Number(l.quantity) })),
      });
      toast.push('success', 'Transfer created — ship it to move the stock.');
      setOpen(false);
      setLines([]);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: 'ship' | 'complete' | 'cancel') => {
    try {
      await api.patch(`/api/transfers/${id}`, { action });
      toast.push(
        'success',
        action === 'ship'
          ? 'Shipped — transfer_out written, destination batches opened.'
          : action === 'complete'
            ? 'Received — transfer_in written at the destination.'
            : 'Transfer cancelled.',
      );
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  return (
    <Shell>
      <PageHeader
        title="Stock transfers"
        description="Warehouse → front store. Both sides of the move are written to the ledger: transfer_out at the source, transfer_in on receipt."
        action={
          can('transfer.create') && (
            <button
              className="btn-primary"
              onClick={() => {
                setForm({ fromLocationId: '', toLocationId: '', notes: '' });
                setLines([{ variantId: '', quantity: '1' }]);
                setOpen(true);
              }}
              type="button"
            >
              New transfer
            </button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {['all', 'pending', 'in_transit', 'completed', 'cancelled'].map((status) => (
          <button
            key={status}
            className={`btn btn-sm ${filter === status ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter(status)}
            type="button"
          >
            {status.replace('_', ' ')}
          </button>
        ))}
      </div>

      <Card>
        {transfers.length === 0 ? (
          <Empty message="No transfers in this view." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Route</th>
                  <th>Requested</th>
                  <th>Shipped</th>
                  <th>Received</th>
                  <th className="text-right">Units</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {transfers.map((transfer) => (
                  <tr key={transfer.id}>
                    <td className="font-mono font-medium">{transfer.number}</td>
                    <td>
                      <span className="text-ink-600 dark:text-ink-300">{transfer.fromLocation.name}</span>
                      <span className="mx-1.5 text-ink-400 dark:text-ink-500">→</span>
                      <span className="font-medium">{transfer.toLocation.name}</span>
                    </td>
                    <td>{formatDate(transfer.requestedAt)}</td>
                    <td>{formatDate(transfer.shippedAt)}</td>
                    <td>{formatDate(transfer.completedAt)}</td>
                    <td className="text-right tabular-nums">
                      {transfer.lines.reduce((sum, line) => sum + line.quantity, 0)}
                    </td>
                    <td>
                      <Badge tone={statusTone(transfer.status)}>{transfer.status.replace('_', ' ')}</Badge>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {transfer.status === 'pending' && can('transfer.ship') && (
                        <button className="btn-primary btn-sm" onClick={() => act(transfer.id, 'ship')} type="button">
                          Ship
                        </button>
                      )}
                      {transfer.status === 'in_transit' && can('transfer.complete') && (
                        <button className="btn-primary btn-sm" onClick={() => act(transfer.id, 'complete')} type="button">
                          Receive
                        </button>
                      )}
                      {(transfer.status === 'pending' || transfer.status === 'in_transit') && can('transfer.cancel') && (
                        <button className="btn-ghost btn-sm" onClick={() => act(transfer.id, 'cancel')} type="button">
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Modal
        open={open}
        title="New stock transfer"
        wide
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={busy || !form.fromLocationId || !form.toLocationId || !lines.some((l) => l.variantId)}
              onClick={() => {
                if (isBackdated(effectiveDate)) {
                  setBackdateWarningOpen(true);
                } else {
                  submit(null);
                }
              }}
              type="button"
            >
              {busy ? 'Creating…' : 'Create transfer'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="label">Transaction date</span>
            <input className="input" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} max={todayISO()} />
            {isBackdated(effectiveDate) && (
              <span className="mt-1 block text-xs text-amber-600 dark:text-amber-400">⚠ Backdated entry — a reason will be required</span>
            )}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From">
              <select
                className="input"
                value={form.fromLocationId}
                onChange={(e) => {
                  setForm({ ...form, fromLocationId: e.target.value });
                  void loadStock(e.target.value);
                }}
              >
                <option value="">Select…</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="To">
              <select
                className="input"
                value={form.toLocationId}
                onChange={(e) => setForm({ ...form, toLocationId: e.target.value })}
              >
                <option value="">Select…</option>
                {locations
                  .filter((l) => l.id !== form.fromLocationId)
                  .map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">Lines</span>
              <button
                className="btn-secondary btn-sm"
                onClick={() => setLines([...lines, { variantId: '', quantity: '1' }])}
                type="button"
              >
                Add line
              </button>
            </div>
            <p className="mb-2 text-xs text-ink-500 dark:text-ink-400">
              Availability shown is what the source location can actually release (on hand less reservations).
            </p>
            <div className="space-y-2">
              {!form.fromLocationId && (
                <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                  Choose a <strong>From</strong> location first — the item list loads from the stock available there.
                </p>
              )}
              {form.fromLocationId && stock.length === 0 && (
                <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                  No sellable stock at the selected From location. Add stock (e.g. via a purchase or opening stock), or
                  pick a different source location.
                </p>
              )}
              {lines.map((line, index) => {
                const option = stock.find((s) => s.id === line.variantId);
                const over = option && Number(line.quantity) > option.sellable;
                return (
                  <div key={index} className="grid grid-cols-[1fr_7rem_auto] items-center gap-2">
                    <select
                      className="input"
                      value={line.variantId}
                      onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, variantId: e.target.value } : l)))}
                    >
                      <option value="">Select variant…</option>
                      {stock.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.displayName} — {item.sellable} available
                        </option>
                      ))}
                    </select>
                    <input
                      className={`input ${over ? 'border-red-400' : ''}`}
                      type="number"
                      value={line.quantity}
                      onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))}
                    />
                    <button className="btn-ghost btn-sm" onClick={() => setLines(lines.filter((_, i) => i !== index))} type="button">
                      ✕
                    </button>
                    {over && (
                      <span className="col-span-3 text-xs text-red-600 dark:text-red-400">
                        Only {option?.sellable} available at the source — this transfer will be rejected.
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <Field label="Notes">
            <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </div>
      </Modal>

      {transfers.some((t) => t.status === 'in_transit') && (
        <p className="muted mt-4">
          In-transit units have already left the source (transfer_out is written) but are not yet on the destination
          shelf — transfer_in is only written when the store receives them.
        </p>
      )}

      <BackdateDialog
        open={backdateWarningOpen}
        date={effectiveDate}
        onConfirm={(reason) => {
          setBackdateWarningOpen(false);
          submit(reason);
        }}
        onCancel={() => setBackdateWarningOpen(false)}
      />
    </Shell>
  );
}
