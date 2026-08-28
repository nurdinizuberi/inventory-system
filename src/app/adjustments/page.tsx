'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap, statusTone } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { ADJUSTMENT_REASON_LABELS, type AdjustmentReason } from '@/lib/types';
import { formatDate } from '@/lib/utils';

interface Adjustment {
  id: string;
  number: string;
  reason: string;
  quantity: number;
  status: string;
  notes: string | null;
  createdAt: string;
  approvedAt: string | null;
  variant: { product: { name: string }; label: string } | null;
  location: { id: string; name: string };
  createdBy: { name: string } | null;
  approvedBy: { name: string } | null;
}

interface Option {
  id: string;
  name: string;
}
interface VariantOption {
  id: string;
  displayName: string;
  sku: string;
}

export default function AdjustmentsPage() {
  const { can, user } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<Adjustment[]>([]);
  const [locations, setLocations] = useState<Option[]>([]);
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ variantId: '', locationId: '', reason: 'count_correction', quantity: '-1', notes: '' });

  const load = useCallback(async () => {
    try {
      const [adjustmentData, locationData, variantData] = await Promise.all([
        api.get<{ adjustments: Adjustment[] }>('/api/adjustments'),
        api.get<{ locations: Option[] }>('/api/locations'),
        api.get<{ variants: VariantOption[] }>('/api/variants?light=1'),
      ]);
      setItems(adjustmentData.adjustments);
      setLocations(locationData.locations.filter((l) => (l as { type?: string }).type !== 'DAMAGED'));
      setVariants(variantData.variants);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/api/adjustments', {
        variantId: form.variantId,
        locationId: form.locationId,
        reason: form.reason as AdjustmentReason,
        quantity: Number(form.quantity),
        notes: form.notes || null,
      });
      toast.push('success', 'Adjustment raised — it needs manager approval before it touches stock.');
      setOpen(false);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, action: 'approve' | 'reject') => {
    try {
      await api.patch(`/api/adjustments/${id}`, { action });
      toast.push('success', action === 'approve' ? 'Approved — ledger updated.' : 'Adjustment rejected.');
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  const pending = items.filter((i) => i.status === 'pending');

  return (
    <Shell>
      <PageHeader
        title="Stock adjustments"
        description="Damage, theft, expiry, misplacement and count corrections. Nothing is written to the ledger until a manager approves."
        action={
          can('stock.adjust') && (
            <button
              className="btn-primary"
              onClick={() => {
                setForm({
                  variantId: '',
                  locationId: user?.locations[0]?.id ?? '',
                  reason: 'count_correction',
                  quantity: '-1',
                  notes: '',
                });
                setOpen(true);
              }}
              type="button"
            >
              Raise adjustment
            </button>
          )
        }
      />

      {pending.length > 0 && (
        <Card title={`Awaiting approval (${pending.length})`} className="mb-5">
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Variant</th>
                  <th>Location</th>
                  <th>Reason</th>
                  <th className="text-right">Qty</th>
                  <th>Raised by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((item) => (
                  <tr key={item.id}>
                    <td className="font-mono font-medium">{item.number}</td>
                    <td>
                      {item.variant?.product.name} — {item.variant?.label}
                    </td>
                    <td className="text-ink-600 dark:text-ink-300">{item.location.name}</td>
                    <td>{ADJUSTMENT_REASON_LABELS[item.reason as AdjustmentReason] ?? item.reason}</td>
                    <td className={`text-right tabular-nums ${item.quantity < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                      {item.quantity}
                    </td>
                    <td className="text-ink-600 dark:text-ink-300">{item.createdBy?.name ?? '—'}</td>
                    <td className="whitespace-nowrap text-right">
                      {can('stock.adjustApprove') ? (
                        <>
                          <button className="btn-primary btn-sm" onClick={() => decide(item.id, 'approve')} type="button">
                            Approve
                          </button>
                          <button className="btn-ghost btn-sm" onClick={() => decide(item.id, 'reject')} type="button">
                            Reject
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-ink-400 dark:text-ink-500">needs a manager</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <Card title="All adjustments">
        {items.length === 0 ? (
          <Empty message="No adjustments recorded." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Variant</th>
                  <th>Location</th>
                  <th>Reason</th>
                  <th className="text-right">Qty</th>
                  <th>Status</th>
                  <th>Raised</th>
                  <th>Approved by</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="font-mono font-medium">{item.number}</td>
                    <td>
                      {item.variant?.product.name} — {item.variant?.label}
                      {item.notes && <p className="text-xs text-ink-500 dark:text-ink-400">{item.notes}</p>}
                    </td>
                    <td className="text-ink-600 dark:text-ink-300">{item.location.name}</td>
                    <td>{ADJUSTMENT_REASON_LABELS[item.reason as AdjustmentReason] ?? item.reason}</td>
                    <td className={`text-right tabular-nums ${item.quantity < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                      {item.quantity}
                    </td>
                    <td>
                      <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                    </td>
                    <td>{formatDate(item.createdAt)}</td>
                    <td className="text-ink-600 dark:text-ink-300">{item.approvedBy?.name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Modal
        open={open}
        title="Raise a stock adjustment"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || !form.variantId || !form.locationId} onClick={submit} type="button">
              {busy ? 'Saving…' : 'Submit for approval'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Variant">
            <select className="input" value={form.variantId} onChange={(e) => setForm({ ...form, variantId: e.target.value })}>
              <option value="">Select…</option>
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.displayName} · {variant.sku}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Location">
            <select className="input" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
              <option value="">Select…</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Reason">
              <select className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
                {Object.entries(ADJUSTMENT_REASON_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quantity" hint="Negative writes stock off, positive adds found stock">
              <input
                className="input"
                type="number"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Notes">
            <textarea className="input" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </Shell>
  );
}
