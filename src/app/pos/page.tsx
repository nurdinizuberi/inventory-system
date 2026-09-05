'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shell } from '@/components/shell';
import { Badge, Modal } from '@/components/ui';
import { BackdateDialog, isBackdated, todayISO } from '@/components/backdate-dialog';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { currency } from '@/lib/utils';
import type { BackdateReason } from '@/lib/types';

interface PosVariant {
  id: string;
  productName: string;
  label: string;
  displayName: string;
  sku: string;
  barcode: string;
  sellingPrice: number;
  costPrice: number;
  sellable: number;
  onHand: number;
  reserved: number;
  lowStock: boolean;
  category: string | null;
}

interface CartLine {
  variant: PosVariant;
  quantity: number;
  unitDiscount: number;
}

interface Receipt {
  number: string;
  total: number;
  profit: number;
  totalCost: number;
  changeDue: number;
  amountPaid: number;
  location: { name: string };
  lines: {
    variant: { product: { name: string }; label: string; sku: string };
    quantity: number;
    unitPrice: number;
    actualPrice: number;
    discountAmount: number;
    lineTotal: number;
    lineCost: number;
    lineProfit: number;
    unitCost: number;
  }[];
}

export default function PosPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [locationId, setLocationId] = useState('');
  const [variants, setVariants] = useState<PosVariant[]>([]);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [amountPaid, setAmountPaid] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [backdateWarningOpen, setBackdateWarningOpen] = useState(false);
  const [pendingBackdateReason, setPendingBackdateReason] = useState<BackdateReason | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const sellableLocations = useMemo(
    () => (user?.locations ?? []).filter((l) => l.type === 'RETAIL_STORE'),
    [user],
  );

  useEffect(() => {
    if (!locationId && sellableLocations.length) setLocationId(sellableLocations[0].id);
  }, [sellableLocations, locationId]);

  const loadVariants = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    try {
      const data = await api.get<{ variants: PosVariant[] }>(`/api/variants?locationId=${locationId}`);
      setVariants(data.variants);
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [locationId, toast]);

  useEffect(() => {
    void loadVariants();
  }, [loadVariants]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F2') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return variants;
    return variants.filter(
      (v) =>
        v.displayName.toLowerCase().includes(q) ||
        v.sku.toLowerCase().includes(q) ||
        v.barcode.includes(q) ||
        (v.category ?? '').toLowerCase().includes(q),
    );
  }, [variants, query]);

  const addLine = (variant: PosVariant, quantity = 1) => {
    setCart((current) => {
      const existing = current.find((line) => line.variant.id === variant.id);
      const nextQuantity = (existing?.quantity ?? 0) + quantity;
      if (nextQuantity > variant.sellable) {
        toast.push('error', `Only ${variant.sellable} × ${variant.displayName} available at this store.`);
        return current;
      }
      if (existing) {
        return current.map((line) =>
          line.variant.id === variant.id ? { ...line, quantity: nextQuantity } : line,
        );
      }
      return [...current, { variant, quantity, unitDiscount: 0 }];
    });
  };

  const setQuantity = (variantId: string, quantity: number) => {
    setCart((current) =>
      current.flatMap((line) => {
        if (line.variant.id !== variantId) return [line];
        if (quantity <= 0) return [];
        if (quantity > line.variant.sellable) {
          toast.push('error', `Only ${line.variant.sellable} available.`);
          return [{ ...line, quantity: line.variant.sellable }];
        }
        return [{ ...line, quantity }];
      }),
    );
  };

  const setDiscount = (variantId: string, unitDiscount: number) => {
    setCart((current) =>
      current.map((line) =>
        line.variant.id === variantId
          ? { ...line, unitDiscount: Math.max(0, Math.min(unitDiscount, line.variant.sellingPrice)) }
          : line,
      ),
    );
  };

  const { subtotal, discountTotal, total, units } = useMemo(() => {
  const sub = cart.reduce((sum, line) => sum + line.variant.sellingPrice * line.quantity, 0);
  const disc = cart.reduce((sum, line) => sum + line.unitDiscount * line.quantity, 0);
  return {
    subtotal: sub,
    discountTotal: disc,
    total: sub - disc,
    units: cart.reduce((sum, line) => sum + line.quantity, 0),
  };
}, [cart]);

const paid = Number(amountPaid || 0);
  const change = useMemo(() => Math.max(0, paid - total), [paid, total]);

  // A line may never sell for 0 — a full per-unit discount (or a 0 override)
  // would give the item away. While any line is free the ticket cannot be charged.
  const freeLineCount = useMemo(
    () => cart.filter((line) => line.variant.sellingPrice - line.unitDiscount <= 0).length,
    [cart],
  );

  const submit = async (backdateReason?: BackdateReason | null) => {
    if (!cart.length) return;
    if (freeLineCount > 0) {
      toast.push('error', 'Every item must sell for more than 0 — adjust the discounts.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ sale: Receipt }>('/api/sales', {
        locationId,
        customerName: customerName || null,
        paymentMethod,
        amountPaid: paid || null,
        effectiveDate,
        backdateReason: backdateReason ?? null,
        lines: cart.map((line) => ({
          variantId: line.variant.id,
          quantity: line.quantity,
          unitDiscount: line.unitDiscount,
        })),
      });
      setReceipt(result.sale);
      setCart([]);
      setAmountPaid('');
      setCustomerName('');
      setCheckoutOpen(false);
      toast.push('success', `Sale ${result.sale.number} completed — ${currency(result.sale.total)}`);
      await loadVariants();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!sellableLocations.length) {
    return (
      <Shell>
        <div className="card card-pad">
          <h1 className="section-title">No retail location assigned</h1>
          <p className="muted mt-2">
            Your account is not assigned to a location with POS rights. Ask an administrator to assign you to a retail
            store.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="grid gap-5 xl:grid-cols-[1fr_26rem]">
        <div className="space-y-4">
          <div className="card card-pad flex flex-wrap items-end gap-3">
            <label className="min-w-[14rem] flex-1">
              <span className="label">Selling location</span>
              <select className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {sellableLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-[16rem] flex-[2]">
              <span className="label">Search or scan (F2)</span>
              <input
                ref={searchRef}
                className="input font-mono"
                placeholder="Type a product name, SKU, or scan a barcode…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {loading && <p className="muted">Loading catalogue…</p>}
            {!loading &&
              filtered.slice(0, 60).map((variant) => {
                const disabled = variant.sellable <= 0;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => addLine(variant)}
                    className={`card card-pad text-left transition ${
                      disabled ? 'opacity-50' : 'hover:border-ink-400 dark:hover:border-ink-500 hover:shadow'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-ink-900 dark:text-ink-100">{variant.displayName}</p>
                      {variant.lowStock && !disabled && <Badge tone="amber">low</Badge>}
                      {disabled && <Badge tone="red">out</Badge>}
                    </div>
                    <p className="mt-1 font-mono text-xs text-ink-400 dark:text-ink-500">{variant.sku}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="font-semibold text-ink-900 dark:text-ink-100">{currency(variant.sellingPrice)}</span>
                      <span className="text-xs text-ink-500 dark:text-ink-400">
                        {variant.sellable} avail{variant.reserved ? ` · ${variant.reserved} held` : ''}
                      </span>
                    </div>
                  </button>
                );
              })}
          </div>
        </div>

        <aside className="card flex h-fit flex-col xl:sticky xl:top-20">
          <header className="flex items-center justify-between border-b border-ink-200 px-4 py-3 dark:border-ink-700">
            <h2 className="section-title">Current ticket</h2>
            {cart.length > 0 && (
              <button className="btn-ghost btn-sm" onClick={() => setCart([])} type="button">
                Clear
              </button>
            )}
          </header>

          <div className="max-h-[45vh] overflow-y-auto px-4 py-3">
            {cart.length === 0 && <p className="muted py-6 text-center">Tap a product to add it.</p>}
            <ul className="space-y-3">
              {cart.map((line) => (
                <li key={line.variant.id} className="rounded-lg border border-ink-200 p-2.5 dark:border-ink-700">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-ink-900 dark:text-ink-100">{line.variant.displayName}</p>
                    <button
                      className="text-xs text-ink-400 hover:text-red-600 dark:text-ink-500 dark:hover:text-red-400"
                      onClick={() => setQuantity(line.variant.id, 0)}
                      type="button"
                    >
                      remove
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="flex items-center rounded-lg border border-ink-300 dark:border-ink-600">
                      <button
                        className="px-2 py-1 text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-700"
                        onClick={() => setQuantity(line.variant.id, line.quantity - 1)}
                        type="button"
                      >
                        −
                      </button>
                      <input
                        className="w-12 border-x border-ink-200 py-1 text-center text-sm tabular-nums dark:border-ink-700"
                        value={line.quantity}
                        onChange={(e) => setQuantity(line.variant.id, Number(e.target.value) || 0)}
                      />
                      <button
                        className="px-2 py-1 text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-700"
                        onClick={() => setQuantity(line.variant.id, line.quantity + 1)}
                        type="button"
                      >
                        +
                      </button>
                    </div>
                    <label className="flex items-center gap-1 text-xs text-ink-500 dark:text-ink-400">
                      disc/unit
                      <input
                        className="input w-24 py-1 text-xs"
                        value={line.unitDiscount}
                        onChange={(e) => setDiscount(line.variant.id, Number(e.target.value) || 0)}
                      />
                    </label>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-sm">
                    <span className="text-ink-500 dark:text-ink-400">
                    {currency(line.variant.sellingPrice - line.unitDiscount)} × {line.quantity}
                  </span>
                    <span className="font-semibold tabular-nums">
                      {currency((line.variant.sellingPrice - line.unitDiscount) * line.quantity)}
                    </span>
                  </div>
                  {line.variant.sellingPrice - line.unitDiscount <= 0 && (
                    <p className="mt-1 text-xs text-red-500">Price after discount must be greater than 0.</p>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <footer className="space-y-2 border-t border-ink-200 px-4 py-3 text-sm dark:border-ink-700">
            <div className="flex justify-between text-ink-600 dark:text-ink-300">
              <span>Subtotal ({units} units)</span>
              <span className="tabular-nums">{currency(subtotal)}</span>
            </div>
            <div className="flex justify-between text-ink-600 dark:text-ink-300">
              <span>Discounts</span>
              <span className="tabular-nums">−{currency(discountTotal)}</span>
            </div>
            <div className="flex justify-between text-lg font-semibold text-ink-900 dark:text-ink-100">
              <span>Total</span>
              <span className="tabular-nums">{currency(total)}</span>
            </div>
            {freeLineCount > 0 && (
              <p className="text-xs text-red-500">
                {freeLineCount} line{freeLineCount === 1 ? '' : 's'} {freeLineCount === 1 ? 'is' : 'are'} priced at 0 — lower the
                discount before charging.
              </p>
            )}
            <button
              className="btn-primary w-full"
              disabled={!cart.length || freeLineCount > 0}
              onClick={() => {
                setAmountPaid(String(total));
                setCheckoutOpen(true);
              }}
              type="button"
            >
              Charge {currency(total)}
            </button>
          </footer>
        </aside>
      </div>

      <Modal
        open={checkoutOpen}
        title="Take payment"
        onClose={() => setCheckoutOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setCheckoutOpen(false)} type="button">
              Back
            </button>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() => {
                if (isBackdated(effectiveDate)) {
                  setBackdateWarningOpen(true);
                } else {
                  submit(null);
                }
              }}
              type="button"
            >
              {busy ? 'Processing…' : `Complete sale — ${currency(total)}`}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="label">Transaction date</span>
            <input className="input" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} max={todayISO()} />
            {isBackdated(effectiveDate) && (
              <span className="mt-1 block text-xs text-amber-600">⚠ Backdated entry — a reason will be required</span>
            )}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Payment method</span>
              <select className="input" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                <option value="cash">Cash</option>
                <option value="mobile_money">Mobile money</option>
                <option value="card">Card</option>
                <option value="credit">Credit / on account</option>
              </select>
            </label>
            <label className="block">
              <span className="label">Customer (optional)</span>
              <input className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </label>
          </div>
          <label className="block">
            <span className="label">Amount received</span>
            <input
              className="input text-lg font-semibold tabular-nums"
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
            />
          </label>
          <div className="flex items-center justify-between rounded-lg bg-ink-100 px-4 py-3 dark:bg-ink-800">
            <span className="text-sm text-ink-600 dark:text-ink-300">Change due</span>
            <span className="text-lg font-semibold tabular-nums text-ink-900 dark:text-ink-100">{currency(change)}</span>
          </div>
          <p className="text-xs text-ink-500 dark:text-ink-400">
            Stock is consumed FIFO — the oldest batch at this store goes first, and its cost becomes the cost of goods
            on this ticket.
          </p>
        </div>
      </Modal>

      <Modal
        open={Boolean(receipt)}
        title={`Receipt ${receipt?.number ?? ''}`}
        onClose={() => setReceipt(null)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => window.print()} type="button">
              Print
            </button>
            <button className="btn-primary" onClick={() => setReceipt(null)} type="button">
              New sale
            </button>
          </>
        }
      >
        {receipt && (
          <div className="space-y-3 text-sm">
            <p className="muted">{receipt.location.name}</p>
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {receipt.lines.map((line, index) => (
                  <tr key={`${line.variant.product.name}-${line.variant.label}-${index}`}>
                    <td>
                      {line.variant.product.name} — {line.variant.label}
                      {line.discountAmount > 0 && (
                        <span className="block text-xs text-emerald-700 dark:text-emerald-400">
                          discount {currency(line.discountAmount)}
                        </span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{line.quantity}</td>
                    <td className="text-right tabular-nums">{currency(line.actualPrice)}</td>
                    <td className="text-right tabular-nums">{currency(line.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
<div className="space-y-1 border-t border-ink-200 pt-3 dark:border-ink-700">
                <div className="flex justify-between">
                  <span className="text-ink-600 dark:text-ink-300">Total</span>
                <span className="font-semibold tabular-nums">{currency(receipt.total)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-600 dark:text-ink-300">Paid</span>
                <span className="tabular-nums">{currency(receipt.amountPaid)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-600 dark:text-ink-300">Change</span>
                <span className="tabular-nums">{currency(receipt.changeDue)}</span>
              </div>
              <div className="flex justify-between text-ink-500 dark:text-ink-400">
                <span>Cost of goods (FIFO)</span>
                <span className="tabular-nums">{currency(receipt.totalCost)}</span>
              </div>
              <div className="flex justify-between font-medium text-emerald-700 dark:text-emerald-400">
                <span>Profit on ticket</span>
                <span className="tabular-nums">{currency(receipt.profit)}</span>
              </div>
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
