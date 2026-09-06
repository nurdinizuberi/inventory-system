'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap, statusTone } from '@/components/ui';
import { BackdateDialog, isBackdated, todayISO } from '@/components/backdate-dialog';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { currency, formatDate } from '@/lib/utils';
import type { BackdateReason } from '@/lib/types';

interface Purchase {
  id: string;
  number: string;
  status: string;
  orderDate: string;
  effectiveDate: string;
  isBackdated: boolean;
  total: number;
  notes: string | null;
  supplier: { id: string; name: string };
  location: { id: string; name: string };
  createdBy: { name: string } | null;
  approvedBy: { name: string } | null;
  lines: {
    id: string;
    quantity: number;
    receivedQty: number;
    unitCost: number;
    lineTotal: number;
    expiresAt: string | null;
    variant: { id: string; sku: string; label: string; product: { name: string } };
    batches: { code: string }[];
  }[];
}

interface VariantOption {
  id: string;
  displayName: string;
  sku: string;
  costPrice: number;
}

interface LocationOption {
  id: string;
  name: string;
  type: string;
  canReceivePurchase: boolean;
  canSellPos: boolean;
}

/**
 * Locations that may receive a purchase: any location flagged to receive.
 * Warehouses and retail stores are both flagged by default, so a purchase can
 * be delivered to a shop directly even when the tenant also has a warehouse.
 */
function receivingTargets(locations: LocationOption[]): LocationOption[] {
  return locations.filter((l) => l.canReceivePurchase);
}

interface SupplierOption {
  id: string;
  name: string;
}

interface EditLine {
  variantId: string;
  quantity: string;
  unitCost: string;
  expiresAt: string;
}

const emptyLine = (): EditLine => ({ variantId: '', quantity: '1', unitCost: '0', expiresAt: '' });

export default function PurchasesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Purchase | null>(null);
  const [filter, setFilter] = useState('all');
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveLines, setReceiveLines] = useState<{ lineId: string; quantity: string }[]>([]);

  const [form, setForm] = useState({ supplierId: '', locationId: '', notes: '', confirm: true });
  const [lines, setLines] = useState<EditLine[]>([emptyLine()]);
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [backdateWarningOpen, setBackdateWarningOpen] = useState(false);

  const loadOptions = useCallback(async () => {
    const [variantResult, locationResult, supplierResult] = await Promise.allSettled([
      api.get<{ variants: VariantOption[] }>('/api/variants?light=1'),
      api.get<{ locations: LocationOption[] }>('/api/locations'),
      api.get<{ suppliers: SupplierOption[] }>('/api/suppliers'),
    ]);
    if (variantResult.status === 'fulfilled') setVariants(variantResult.value.variants);
    else toast.push('error', errorMessage(variantResult.reason));
    if (locationResult.status === 'fulfilled') setLocations(locationResult.value.locations);
    else toast.push('error', errorMessage(locationResult.reason));
    if (supplierResult.status === 'fulfilled') setSuppliers(supplierResult.value.suppliers);
    else toast.push('error', errorMessage(supplierResult.reason));
  }, [toast]);

  const load = useCallback(async () => {
    try {
      const purchaseData = await api.get<{ purchases: Purchase[] }>(
        `/api/purchases${filter === 'all' ? '' : `?status=${filter}`}`,
      );
      setPurchases(purchaseData.purchases);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [filter, toast]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    void load();
  }, [load]);

  const receivingLocations = receivingTargets(locations);
  const total = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitCost) || 0), 0);

  const submit = async (backdateReason?: BackdateReason | null) => {
    setBusy(true);
    try {
      await api.post('/api/purchases', {
        supplierId: form.supplierId,
        locationId: form.locationId,
        notes: form.notes || null,
        confirmImmediately: form.confirm,
        effectiveDate,
        backdateReason: backdateReason ?? null,
        lines: lines
          .filter((line) => line.variantId)
          .map((line) => ({
            variantId: line.variantId,
            quantity: Number(line.quantity),
            unitCost: Number(line.unitCost),
            expiresAt: line.expiresAt || null,
          })),
      });
      const targetName = locations.find((l) => l.id === form.locationId)?.name;
      toast.push(
        'success',
        form.confirm
          ? `Order confirmed for ${targetName ?? 'the location'} — receive the goods when they arrive.`
          : 'Draft purchase saved.',
      );
      setOpen(false);
      setLines([emptyLine()]);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: 'confirm' | 'cancel') => {
    try {
      await api.patch(`/api/purchases/${id}`, { action });
      toast.push('success', action === 'confirm' ? 'Order confirmed — awaiting receipt.' : 'Purchase cancelled.');
      await load();
      setDetail(null);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  const openDetail = async (purchase: Purchase) => {
    try {
      const data = await api.get<{ purchase: Purchase }>(`/api/purchases/${purchase.id}`);
      setDetail(data.purchase);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  const openReceive = (purchase: Purchase) => {
    setDetail(purchase);
    setReceiveLines(
      purchase.lines.map((line) => ({ lineId: line.id, quantity: String(line.quantity - line.receivedQty) })),
    );
    setReceiveOpen(true);
  };

  const submitReceive = async () => {
    if (!detail) return;
    const request = receiveLines.filter((l) => Number(l.quantity) > 0);
    if (!request.length) {
      toast.push('error', 'Enter a quantity to receive for at least one line.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.patch<{ purchase: Purchase }>(`/api/purchases/${detail.id}`, {
        action: 'receive',
        lines: request.map((l) => ({ lineId: l.lineId, quantity: Number(l.quantity) })),
      });
      toast.push(
        'success',
        result.purchase.status === 'received'
          ? 'Received — the full order is now on the shelf.'
          : 'Partial receipt recorded — batches opened.',
      );
      setReceiveOpen(false);
      setDetail(result.purchase);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const receivedUnits = (purchase: Purchase) => purchase.lines.reduce((sum, l) => sum + l.receivedQty, 0);

  return (
    <Shell>
      <PageHeader
        title="Purchases"
        description="Ordering and receiving are separate steps: confirm the order, then receive the goods per line as they arrive — in full or in partial lots, each with its own batch."
        action={
          can('purchase.create') && (
            <button
              className="btn-primary"
              onClick={() => {
                setForm({ ...form, locationId: receivingLocations[0]?.id ?? '', supplierId: suppliers[0]?.id ?? '' });
                setLines([emptyLine()]);
                setOpen(true);
              }}
              type="button"
            >
              New purchase
            </button>
          )
        }
      />

      {receivingLocations.length === 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
          No location can receive purchases yet. Open{' '}
          <Link className="underline" href="/locations">
            Locations
          </Link>{' '}
          and create a warehouse or retail store — both receive purchases by default, or tick “Can receive
          purchases” on an existing location.
        </div>
      )}

      <div className="mb-4 flex gap-2">
        {['all', 'draft', 'confirmed', 'received', 'cancelled'].map((status) => (
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
        {purchases.length === 0 ? (
          <Empty message="No purchase orders in this view." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Supplier</th>
                  <th>Receive at</th>
                  <th>Date</th>
                  <th className="text-right">Lines</th>
                  <th className="text-right">Total</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {purchases.map((purchase) => (
                  <tr key={purchase.id}>
                    <td>
                      <button className="font-mono font-medium hover:underline" onClick={() => openDetail(purchase)} type="button">
                        {purchase.number}
                        {purchase.isBackdated && (
                          <span className="ml-2">
                            <Badge tone="amber">Backdated</Badge>
                          </span>
                        )}
                      </button>
                    </td>
                    <td>{purchase.supplier.name}</td>
                    <td className="text-ink-600 dark:text-ink-300">{purchase.location.name}</td>
                    <td>{formatDate(purchase.effectiveDate)}</td>
                    <td className="text-right tabular-nums">
                      {purchase.lines.reduce((s, l) => s + l.quantity, 0)}
                      {receivedUnits(purchase) > 0 && (
                        <span className="block text-xs text-ink-400">rec {receivedUnits(purchase)}</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{currency(purchase.total)}</td>
                    <td>
                      <Badge tone={statusTone(purchase.status)}>{purchase.status.replace('_', ' ')}</Badge>
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {purchase.status === 'draft' && can('purchase.confirm') && (
                        <button className="btn-secondary btn-sm" onClick={() => act(purchase.id, 'confirm')} type="button">
                          Confirm
                        </button>
                      )}
                      {purchase.status === 'confirmed' && can('purchase.confirm') && (
                        <button
                          className="btn-secondary btn-sm"
                          onClick={() => openReceive(purchase)}
                          type="button"
                          {...(purchase.lines.every((l) => l.receivedQty >= l.quantity) ? {} : {})}
                        >
                          Receive
                        </button>
                      )}
                      {purchase.status !== 'cancelled' && receivedUnits(purchase) === 0 && can('purchase.cancel') && (
                        <button className="btn-ghost btn-sm" onClick={() => act(purchase.id, 'cancel')} type="button">
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
        title="New purchase order"
        wide
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={busy || !form.supplierId || !form.locationId || !lines.some((l) => l.variantId)}
              onClick={() => {
                if (isBackdated(effectiveDate)) {
                  setBackdateWarningOpen(true);
                } else {
                  submit(null);
                }
              }}
              type="button"
            >
              {busy ? 'Saving…' : form.confirm ? `Save & confirm order — ${currency(total)}` : 'Save draft'}
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
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Supplier">
              <select className="input" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                <option value="">Select…</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Receiving location" hint="Warehouses and receiving-enabled stores">
              <select className="input" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                <option value="">Select…</option>
                {receivingLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                    {location.type === 'RETAIL_STORE' ? ' (store)' : ''}
                  </option>
                ))}
                {receivingLocations.length === 0 && <option disabled>No receiving location — see Locations page</option>}
              </select>
            </Field>
            <Field label="On save">
              <select
                className="input"
                value={form.confirm ? 'confirm' : 'draft'}
                onChange={(e) => setForm({ ...form, confirm: e.target.value === 'confirm' })}
              >
                <option value="draft">Save as draft (wait for arrival)</option>
                <option value="confirm">Save & confirm order now</option>
              </select>
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">Line items</span>
              <button
                className="btn-secondary btn-sm"
                onClick={() => setLines([...lines, emptyLine()])}
                type="button"
              >
                Add line
              </button>
            </div>
            <div className="space-y-2">
              {variants.length === 0 && (
                <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                  No active products available to add. Create a product on the Products page, or restore one you
                  archived — archived products don’t appear here.
                </p>
              )}
              <div className="grid grid-cols-[1fr_5rem_7rem_9rem_auto] gap-2">
                <span className="label mb-0">Variant</span>
                <span className="label mb-0">Quantity</span>
                <span className="label mb-0">Unit cost</span>
                <span className="label mb-0">Expiry (optional)</span>
                <span />
              </div>
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-[1fr_5rem_7rem_9rem_auto] gap-2">
                  <select
                    className="input"
                    value={line.variantId}
                    onChange={(e) => {
                      const variant = variants.find((v) => v.id === e.target.value);
                      setLines(
                        lines.map((l, i) =>
                          i === index
                            ? { ...l, variantId: e.target.value, unitCost: variant ? String(variant.costPrice) : l.unitCost }
                            : l,
                        ),
                      );
                    }}
                  >
                    <option value="">Select variant…</option>
                    {variants.map((variant) => (
                      <option key={variant.id} value={variant.id}>
                        {variant.displayName} · {variant.sku}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    type="number"
                    placeholder="e.g. 5"
                    value={line.quantity}
                    onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))}
                  />
                  <input
                    className="input"
                    type="number"
                    placeholder="e.g. 2500"
                    value={line.unitCost}
                    onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, unitCost: e.target.value } : l)))}
                  />
                  <input
                    className="input"
                    type="date"
                    value={line.expiresAt}
                    onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, expiresAt: e.target.value } : l)))}
                    title="Best-before date of this lot — copied to the batch when received"
                  />
                  <button className="btn-ghost btn-sm" onClick={() => setLines(lines.filter((_, i) => i !== index))} type="button">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-ink-100 px-4 py-3 dark:bg-ink-800">
            <span className="text-sm text-ink-600 dark:text-ink-300">Order total</span>
            <span className="text-lg font-semibold tabular-nums">{currency(total)}</span>
          </div>

          <Field label="Notes">
            <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </div>
      </Modal>

      <Modal open={Boolean(detail)} title={`Purchase ${detail?.number ?? ''}`} wide onClose={() => setDetail(null)}>
        {detail && (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <span className="label">Status</span>
                <Badge tone={statusTone(detail.status)}>{detail.status}</Badge>
              </div>
              <div>
                <span className="label">Supplier</span>
                <p>{detail.supplier.name}</p>
              </div>
              <div>
                <span className="label">Receive at</span>
                <p>{detail.location.name}</p>
              </div>
              <div>
                <span className="label">Total</span>
                <p className="font-semibold tabular-nums">{currency(detail.total)}</p>
              </div>
            </div>

            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th>SKU</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Received</th>
                    <th className="text-right">Unit cost</th>
                    <th className="text-right">Line total</th>
                    <th>Expiry</th>
                    <th>Batches</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        {line.variant.product.name} — {line.variant.label}
                      </td>
                      <td className="font-mono text-xs">{line.variant.sku}</td>
                      <td className="text-right tabular-nums">{line.quantity}</td>
                      <td className="text-right tabular-nums">{line.receivedQty}</td>
                      <td className="text-right tabular-nums">{currency(line.unitCost)}</td>
                      <td className="text-right tabular-nums">{currency(line.lineTotal)}</td>
                      <td className="whitespace-nowrap tabular-nums">
                        {line.expiresAt ? formatDate(line.expiresAt) : '—'}
                      </td>
                      <td className="font-mono text-xs text-ink-500 dark:text-ink-400">
                        {line.batches.map((b) => b.code).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>

            <div className="flex flex-wrap justify-end gap-2">
              {detail.status === 'draft' && can('purchase.confirm') && (
                <button className="btn-primary" onClick={() => act(detail.id, 'confirm')} type="button">
                  Confirm order
                </button>
              )}
              {detail.status === 'confirmed' && can('purchase.confirm') && (
                <button className="btn-primary" onClick={() => openReceive(detail)} type="button">
                  Receive stock
                </button>
              )}
              {detail.status === 'received' && <p className="muted">Fully received — nothing left to do.</p>}
              {detail.status !== 'cancelled' && receivedUnits(detail) === 0 && can('purchase.cancel') && (
                <button className="btn-danger" onClick={() => act(detail.id, 'cancel')} type="button">
                  Cancel purchase
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={receiveOpen}
        title={`Receive goods — ${detail?.number ?? ''}`}
        wide
        onClose={() => setReceiveOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setReceiveOpen(false)} type="button">
              Back
            </button>
            <button className="btn-primary" disabled={busy} onClick={() => void submitReceive()} type="button">
              {busy ? 'Receiving…' : 'Record receipt'}
            </button>
          </>
        }
      >
        {detail && (
          <div className="space-y-3">
            <p className="muted">
              Receiving into <strong>{detail.location.name}</strong>. Enter the quantity that actually arrived for
              each line — the rest stays on order. Each line you receive opens a fresh costed batch.
            </p>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th className="text-right">Ordered</th>
                    <th className="text-right">Received</th>
                    <th className="text-right">Remaining</th>
                    <th>Expiry</th>
                    <th className="w-32">Receive now</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((line) => {
                    const remaining = line.quantity - line.receivedQty;
                    return (
                      <tr key={line.id}>
                        <td>
                          {line.variant.product.name} — {line.variant.label}
                        </td>
                        <td className="text-right tabular-nums">{line.quantity}</td>
                        <td className="text-right tabular-nums">{line.receivedQty}</td>
                        <td className="text-right tabular-nums">{remaining}</td>
                        <td className="whitespace-nowrap tabular-nums">
                          {line.expiresAt ? formatDate(line.expiresAt) : <span className="text-ink-400">—</span>}
                        </td>
                        <td>
                          <input
                            className="input py-1 text-sm"
                            type="number"
                            min={0}
                            max={remaining}
                            value={receiveLines.find((r) => r.lineId === line.id)?.quantity ?? '0'}
                            onChange={(e) =>
                              setReceiveLines((rows) =>
                                rows.map((r) => (r.lineId === line.id ? { ...r, quantity: e.target.value } : r)),
                              )
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </div>
        )}
      </Modal>

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