'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap, statusTone } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { currency, formatDate } from '@/lib/utils';

interface Reservation {
  id: string;
  number: string;
  quantity: number;
  status: string;
  customerRef: string | null;
  createdAt: string;
  expiresAt: string | null;
  variant: {
    id: string;
    label: string;
    sku: string;
    sellingPrice: number | null;
    product: { name: string; basePrice: number };
  };
  location: { id: string; name: string; type: string };
  createdBy: { name: string } | null;
}

interface Location {
  id: string;
  name: string;
  type: string;
}

interface VariantOption {
  id: string;
  displayName: string;
  sku: string;
  onHand: number;
  reserved: number;
  sellable: number;
}

const emptyForm = { locationId: '', variantId: '', quantity: '1', customerRef: '' };

export default function ReservationsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const [filter, setFilter] = useState('active');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [fulfilling, setFulfilling] = useState<Reservation | null>(null);
  const [payment, setPayment] = useState({ method: 'cash', amountPaid: '' });

  const load = useCallback(async () => {
    const [reservationResult, locationResult] = await Promise.allSettled([
      api.get<{ reservations: Reservation[] }>('/api/reservations'),
      api.get<{ locations: Location[] }>('/api/locations'),
    ]);
    if (reservationResult.status === 'fulfilled') setReservations(reservationResult.value.reservations);
    else toast.push('error', errorMessage(reservationResult.reason));
    if (locationResult.status === 'fulfilled') setLocations(locationResult.value.locations);
    else toast.push('error', errorMessage(locationResult.reason));
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadVariants = useCallback(
    async (locationId: string) => {
      if (!locationId) {
        setVariants([]);
        return;
      }
      try {
        const data = await api.get<{ variants: VariantOption[] }>(`/api/variants?locationId=${locationId}`);
        setVariants(data.variants);
      } catch (err) {
        toast.push('error', errorMessage(err));
        setVariants([]);
      }
    },
    [toast],
  );

  const openCreate = () => {
    const first = locations[0]?.id ?? '';
    setForm({ ...emptyForm, locationId: first });
    void loadVariants(first);
    setOpen(true);
  };

  const submit = async () => {
    const qty = Number(form.quantity);
    if (!form.locationId || !form.variantId || !Number.isInteger(qty) || qty < 1) {
      toast.push('error', 'Choose a location, a variant and a positive whole quantity.');
      return;
    }
    const variant = variants.find((v) => v.id === form.variantId);
    if (variant && qty > variant.sellable) {
      toast.push('error', `Only ${variant.sellable} unit(s) of ${variant.displayName} are available to hold.`);
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/reservations', {
        variantId: form.variantId,
        locationId: form.locationId,
        quantity: qty,
        customerRef: form.customerRef.trim() || null,
      });
      toast.push('success', 'Stock held for the customer.');
      setOpen(false);
      setForm(emptyForm);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const release = async (reservation: Reservation) => {
    if (!window.confirm(`Release hold ${reservation.number}? The stock returns to the shelf.`)) return;
    try {
      await api.patch('/api/reservations', { reservationId: reservation.id, action: 'release' });
      toast.push('info', `Hold ${reservation.number} released.`);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  const openFulfil = (reservation: Reservation) => {
    const price = reservation.variant.sellingPrice ?? reservation.variant.product.basePrice;
    const total = price * reservation.quantity;
    setPayment({ method: 'cash', amountPaid: String(total) });
    setFulfilling(reservation);
  };

  const fulfil = async () => {
    if (!fulfilling) return;
    setBusy(true);
    try {
      await api.patch('/api/reservations', {
        reservationId: fulfilling.id,
        action: 'fulfil',
        paymentMethod: payment.method,
        amountPaid: payment.amountPaid === '' ? undefined : Number(payment.amountPaid),
      });
      toast.push('success', `Hold ${fulfilling.number} sold at the till.`);
      setFulfilling(null);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const list = filter === 'all' ? reservations : reservations.filter((r) => r.status === filter);
    list.sort((a, b) => (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1));
    return list;
  }, [reservations, filter]);

  const fulfilPrice = fulfilling
    ? (fulfilling.variant.sellingPrice ?? fulfilling.variant.product.basePrice) * fulfilling.quantity
    : 0;
  const fulfilPaid = Number(payment.amountPaid || 0);
  const fulfilChange = Math.max(0, fulfilPaid - fulfilPrice);

  return (
    <Shell>
      <PageHeader
        title="Reservations"
        description="Hold stock for a customer at a location. Fulfilling a hold rings it through the till at the item's list price."
        action={
          can('reservation.manage') && (
            <button className="btn-primary" onClick={openCreate} type="button">
              New reservation
            </button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {['active', 'all', 'released', 'fulfilled', 'expired'].map((status) => (
          <button
            key={status}
            className={`btn btn-sm ${filter === status ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter(status)}
            type="button"
          >
            {status}
          </button>
        ))}
      </div>

      <Card>
        {filtered.length === 0 ? (
          <Empty message="No reservations in this view." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Hold</th>
                  <th>Item</th>
                  <th>Customer</th>
                  <th>Location</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Value</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((reservation) => (
                  <tr key={reservation.id}>
                    <td className="font-mono font-medium">{reservation.number}</td>
                    <td>
                      {reservation.variant.product.name} — {reservation.variant.label}
                      <p className="font-mono text-xs text-ink-400 dark:text-ink-500">{reservation.variant.sku}</p>
                    </td>
                    <td className="text-ink-600 dark:text-ink-300">{reservation.customerRef ?? '—'}</td>
                    <td className="text-ink-600 dark:text-ink-300">{reservation.location.name}</td>
                    <td className="text-right tabular-nums">{reservation.quantity}</td>
                    <td className="text-right tabular-nums">
                      {currency((reservation.variant.sellingPrice ?? reservation.variant.product.basePrice) * reservation.quantity)}
                    </td>
                    <td>
                      <Badge tone={statusTone(reservation.status)}>{reservation.status}</Badge>
                    </td>
                    <td className="text-ink-500 dark:text-ink-400">{formatDate(reservation.createdAt)}</td>
                    <td className="whitespace-nowrap text-right">
                      {reservation.status === 'active' && (
                        <>
                          {can('sale.create') && (
                            <button className="btn-primary btn-sm" onClick={() => openFulfil(reservation)} type="button">
                              Fulfil
                            </button>
                          )}
                          <button className="btn-ghost btn-sm" onClick={() => release(reservation)} type="button">
                            Release
                          </button>
                        </>
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
        title="New reservation"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || !form.variantId || !form.locationId} onClick={() => void submit()} type="button">
              {busy ? 'Holding…' : 'Hold stock'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Location">
            <select
              className="input"
              value={form.locationId}
              onChange={(e) => {
                const id = e.target.value;
                setForm({ ...form, locationId: id, variantId: '' });
                void loadVariants(id);
              }}
            >
              <option value="">Select…</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                  {location.type === 'RETAIL_STORE' ? ' (store)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Item" hint="Only sellable units (on hand less holds) can be reserved">
            <select
              className="input"
              value={form.variantId}
              onChange={(e) => setForm({ ...form, variantId: e.target.value })}
            >
              <option value="">Select…</option>
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id} disabled={variant.sellable <= 0}>
                  {variant.displayName} · {variant.sku} ({variant.sellable} available)
                </option>
              ))}
              {variants.length === 0 && <option disabled>Choose a location to load the catalogue</option>}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Quantity">
              <input
                className="input"
                type="number"
                min={1}
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </Field>
            <Field label="Customer">
              <input
                className="input"
                placeholder="Name so returns can be matched"
                value={form.customerRef}
                onChange={(e) => setForm({ ...form, customerRef: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(fulfilling)}
        title={`Fulfil ${fulfilling?.number ?? ''}`}
        onClose={() => setFulfilling(null)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setFulfilling(null)} type="button">
              Back
            </button>
            <button className="btn-primary" disabled={busy} onClick={() => void fulfil()} type="button">
              {busy ? 'Selling…' : `Complete sale — ${currency(fulfilPrice)}`}
            </button>
          </>
        }
      >
        {fulfilling && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <span className="label">Item</span>
                <p>
                  {fulfilling.variant.product.name} — {fulfilling.variant.label}
                </p>
              </div>
              <div>
                <span className="label">Quantity</span>
                <p className="tabular-nums">{fulfilling.quantity}</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Payment method">
                <select className="input" value={payment.method} onChange={(e) => setPayment({ ...payment, method: e.target.value })}>
                  <option value="cash">Cash</option>
                  <option value="mobile_money">Mobile money</option>
                  <option value="card">Card</option>
                  <option value="credit">Credit / on account</option>
                </select>
              </Field>
              <Field label="Amount received">
                <input
                  className="input font-semibold tabular-nums"
                  value={payment.amountPaid}
                  onChange={(e) => setPayment({ ...payment, amountPaid: e.target.value })}
                />
              </Field>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-ink-100 px-4 py-3 text-sm dark:bg-ink-800">
              <span className="text-ink-600 dark:text-ink-300">Sale total</span>
              <span className="text-lg font-semibold tabular-nums">{currency(fulfilPrice)}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-ink-100 px-4 py-3 text-sm dark:bg-ink-800">
              <span className="text-ink-600 dark:text-ink-300">Change due</span>
              <span className="text-lg font-semibold tabular-nums">{currency(fulfilChange)}</span>
            </div>
          </div>
        )}
      </Modal>
    </Shell>
  );
}