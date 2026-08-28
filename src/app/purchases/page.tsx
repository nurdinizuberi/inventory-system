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

interface Purchase {
  id: string;
  number: string;
  status: string;
  orderDate: string;
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
    variant: { id: string; sku: string; label: string; product: { name: string } };
    batch: { code: string } | null;
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
}

interface SupplierOption {
  id: string;
  name: string;
}

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

  const [form, setForm] = useState({ supplierId: '', locationId: '', notes: '', confirm: true });
  const [lines, setLines] = useState<{ variantId: string; quantity: string; unitCost: string }[]>([]);
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [backdateWarningOpen, setBackdateWarningOpen] = useState(false);

  const loadOptions = useCallback(async () => {
    try {
      const [variantData, locationData, supplierData] = await Promise.all([
        api.get<{ variants: VariantOption[] }>('/api/variants?light=1'),
        api.get<{ locations: LocationOption[] }>('/api/locations'),
        api.get<{ suppliers: SupplierOption[] }>('/api/suppliers'),
      ]);
      setVariants(variantData.variants);
      setLocations(locationData.locations);
      setSuppliers(supplierData.suppliers);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
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

  const warehouses = locations.filter((l) => l.canReceivePurchase && l.type === 'WAREHOUSE');
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
          })),
      });
      toast.push('success', form.confirm ? 'Purchase confirmed — stock received into the warehouse.' : 'Draft purchase saved.');
      setOpen(false);
      setLines([]);
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
      toast.push('success', action === 'confirm' ? 'Goods received — batches opened.' : 'Purchase cancelled.');
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

  return (
    <Shell>
      <PageHeader
        title="Purchases"
        description="Recorded against a warehouse. Confirming opens a costed batch per line and writes purchase_in ledger rows."
        action={
          can('purchase.create') && (
            <button
              className="btn-primary"
              onClick={() => {
                setForm({ ...form, locationId: warehouses[0]?.id ?? '', supplierId: suppliers[0]?.id ?? '' });
                setLines([{ variantId: '', quantity: '1', unitCost: '0' }]);
                setOpen(true);
              }}
              type="button"
            >
              New purchase
            </button>
          )
        }
      />

      <div className="mb-4 flex gap-2">
        {['all', 'draft', 'confirmed', 'cancelled'].map((status) => (
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
                  <th>Warehouse</th>
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
                      </button>
                    </td>
                    <td>{purchase.supplier.name}</td>
                    <td className="text-ink-600 dark:text-ink-300">{purchase.location.name}</td>
                    <td>{formatDate(purchase.orderDate)}</td>
                    <td className="text-right tabular-nums">{purchase.lines.length}</td>
                    <td className="text-right tabular-nums">{currency(purchase.total)}</td>
                    <td>
                      <Badge tone={statusTone(purchase.status)}>{purchase.status.replace('_', ' ')}</Badge>
                    </td>
                    <td className="text-right">
                      {purchase.status === 'draft' && can('purchase.confirm') && (
                        <button className="btn-secondary btn-sm" onClick={() => act(purchase.id, 'confirm')} type="button">
                          Receive
                        </button>
                      )}
                      {purchase.status !== 'cancelled' && can('purchase.cancel') && (
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
              {busy ? 'Saving…' : form.confirm ? `Confirm & receive — ${currency(total)}` : 'Save draft'}
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
            <Field label="Receiving warehouse" hint="Only locations with can_receive_purchase">
              <select className="input" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                <option value="">Select…</option>
                {warehouses.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="On confirm">
              <select
                className="input"
                value={form.confirm ? 'confirm' : 'draft'}
                onChange={(e) => setForm({ ...form, confirm: e.target.value === 'confirm' })}
              >
                <option value="confirm">Receive stock now</option>
                <option value="draft">Save as draft</option>
              </select>
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">Line items</span>
              <button
                className="btn-secondary btn-sm"
                onClick={() => setLines([...lines, { variantId: '', quantity: '1', unitCost: '0' }])}
                type="button"
              >
                Add line
              </button>
            </div>
            <div className="space-y-2">
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-[1fr_6rem_8rem_auto] gap-2">
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
                    placeholder="qty"
                    value={line.quantity}
                    onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))}
                  />
                  <input
                    className="input"
                    type="number"
                    placeholder="unit cost"
                    value={line.unitCost}
                    onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, unitCost: e.target.value } : l)))}
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
                <span className="label">Warehouse</span>
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
                    <th>Batch</th>
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
                      <td className="font-mono text-xs text-ink-500 dark:text-ink-400">{line.batch?.code ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>

            <div className="flex flex-wrap justify-end gap-2">
              {detail.status === 'draft' && can('purchase.confirm') && (
                <button className="btn-primary" onClick={() => act(detail.id, 'confirm')} type="button">
                  Confirm & receive
                </button>
              )}
              {detail.status !== 'cancelled' && can('purchase.cancel') && (
                <button className="btn-danger" onClick={() => act(detail.id, 'cancel')} type="button">
                  Cancel purchase
                </button>
              )}
            </div>
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
