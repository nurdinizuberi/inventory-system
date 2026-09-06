'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackdateDialog, isBackdated, todayISO } from '@/components/backdate-dialog';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { BACKDATE_REASON_LABELS, type BackdateReason } from '@/lib/types';
import { currency, formatDate } from '@/lib/utils';

interface ReturnRecord {
  id: string;
  number: string;
  reason: string;
  status: string;
  totalRefund: number;
  createdAt: string;
  effectiveDate: string;
  backdateReason: string | null;
  isBackdated: boolean;
  location: { name: string };
  sale: { number: string } | null;
  createdBy: { name: string } | null;
  lines: { quantity: number; condition: string; refundAmount: number; variant: { product: { name: string }; label: string } }[];
}

interface SaleOption {
  id: string;
  number: string;
  soldAt: string;
  total: number;
  location: { id: string; name: string };
  lines: { variantId: string; quantity: number; variant: { id: string; product: { name: string }; label: string } }[];
}

export default function ReturnsPage() {
  const { can, user } = useAuth();
  const toast = useToast();
  const [returns, setReturns] = useState<ReturnRecord[]>([]);
  const [sales, setSales] = useState<SaleOption[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backdateOpen, setBackdateOpen] = useState(false);
  const [backdateReason, setBackdateReason] = useState<BackdateReason | null>(null);
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [saleId, setSaleId] = useState('');
  const [reason, setReason] = useState('customer_return');
  const [lines, setLines] = useState<{ variantId: string; quantity: string; condition: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ returns: ReturnRecord[] }>('/api/returns');
      setReturns(data.returns);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedSale = useMemo(() => sales.find((s) => s.id === saleId) ?? null, [sales, saleId]);
  const saleLineByVariant = useMemo(
    () => new Map((selectedSale?.lines ?? []).map((l) => [l.variantId, l])),
    [selectedSale],
  );

  const loadSales = async () => {
    try {
      const data = await api.get<{ sales: SaleOption[] }>('/api/sales?status=completed');
      setSales(data.sales);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  const doSubmit = async (backdate: BackdateReason | null) => {
    setBusy(true);
    try {
      await api.post('/api/returns', {
        saleId: saleId || null,
        locationId: selectedSale?.location.id ?? user?.locations[0]?.id,
        reason,
        effectiveDate,
        backdateReason: backdate,
        lines: lines
          .filter((l) => l.variantId)
          .map((l) => ({ variantId: l.variantId, quantity: Number(l.quantity), condition: l.condition })),
      });
      toast.push('success', 'Return recorded — sellable stock restocked, damaged stock written off.');
      setOpen(false);
      setLines([]);
      setSaleId('');
      setBackdateReason(null);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (isBackdated(effectiveDate) && !backdateReason) {
      setBackdateOpen(true);
      return;
    }
    await doSubmit(backdateReason);
  };

  return (
    <Shell>
      <PageHeader
        title="Returns"
        description="Sellable returns go back to the store's stock at batch cost; damaged returns are written off to the damaged location."
        action={
          can('return.create') && (
            <button
              className="btn-primary"
              onClick={() => {
                void loadSales();
                setLines([]);
                setEffectiveDate(todayISO());
                setBackdateReason(null);
                setOpen(true);
              }}
              type="button"
            >
              New return
            </button>
          )
        }
      />

      <Card>
        {returns.length === 0 ? (
          <Empty message="No returns recorded yet." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Original sale</th>
                  <th>Location</th>
                  <th>Reason</th>
                  <th>When</th>
                  <th>Items</th>
                  <th className="text-right">Refund</th>
                </tr>
              </thead>
              <tbody>
                {returns.map((record) => (
                  <tr key={record.id}>
                    <td className="font-mono font-medium">
                      {record.number}
                      {record.isBackdated && (
                        <span className="ml-2">
                          <Badge tone="amber">Backdated</Badge>
                        </span>
                      )}
                    </td>
                    <td className="font-mono text-ink-600 dark:text-ink-300">{record.sale?.number ?? 'standalone'}</td>
                    <td className="text-ink-600 dark:text-ink-300">{record.location.name}</td>
                    <td className="text-ink-600 dark:text-ink-300">{record.reason.replace(/_/g, ' ')}</td>
                    <td>{formatDate(record.effectiveDate, true)}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {record.lines.map((line, index) => (
                          <Badge key={`${record.id}-${line.variant.product.name}-${line.variant.label}-${index}`} tone={line.condition === 'sellable' ? 'green' : 'red'}>
                            {line.quantity} × {line.variant.label} ({line.condition})
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="text-right tabular-nums">{currency(record.totalRefund)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Modal
        open={open}
        title="Record a return"
        wide
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || !lines.some((l) => l.variantId)} onClick={submit} type="button">
              {busy ? 'Saving…' : 'Record return'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Original sale (optional)">
              <select
                className="input"
                value={saleId}
                onChange={(e) => {
                  setSaleId(e.target.value);
                  const sale = sales.find((s) => s.id === e.target.value);
                  setLines(
                    (sale?.lines ?? []).map((line) => ({
                      variantId: line.variantId,
                      quantity: String(line.quantity),
                      condition: 'sellable',
                    })),
                  );
                }}
              >
                <option value="">Standalone return (no ticket)</option>
                {sales.map((sale) => (
                  <option key={sale.id} value={sale.id}>
                    {sale.number} · {formatDate(sale.soldAt)} · {currency(sale.total)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason">
              <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="customer_return">Customer return</option>
                <option value="wrong_item">Wrong item supplied</option>
                <option value="defective">Defective on arrival</option>
                <option value="warranty">Warranty claim</option>
              </select>
            </Field>
            <Field label="Effective date" hint="Backdated returns require a reason">
              <input
                className="input"
                type="date"
                value={effectiveDate}
                max={todayISO()}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
            </Field>
          </div>

          {isBackdated(effectiveDate) && backdateReason && (
            <p className="text-xs text-ink-500 dark:text-ink-400">
              Backdated reason: {BACKDATE_REASON_LABELS[backdateReason]}
            </p>
          )}

          {!saleId && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Standalone return: pick the receiving location implicitly from your assigned store, and choose variants
              below.
            </p>
          )}

          <div>
            <span className="label">Returned items</span>
            <div className="space-y-2">
              {(lines.length ? lines : [{ variantId: '', quantity: '1', condition: 'sellable' }]).map((line, index) => (
                <div key={`${line.variantId}-${index}`} className="grid grid-cols-[1fr_6rem_9rem] gap-2">
                  {selectedSale ? (
                    <span className="input bg-ink-50 dark:bg-ink-800">
                      {saleLineByVariant.get(line.variantId)?.variant.product.name} —{' '}
                      {saleLineByVariant.get(line.variantId)?.variant.label}
                    </span>
                  ) : (
                    <input className="input" placeholder="variant id" value={line.variantId} readOnly />
                  )}
                  <input
                    className="input"
                    type="number"
                    value={line.quantity}
                    onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))}
                  />
                  <select
                    className="input"
                    value={line.condition}
                    onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, condition: e.target.value } : l)))}
                  >
                    <option value="sellable">Sellable</option>
                    <option value="damaged">Damaged</option>
                  </select>
                </div>
              ))}
            </div>
          </div>

          <p className="text-xs text-ink-500 dark:text-ink-400">
            Sellable items are restocked onto the oldest batch of that variant at the store, keeping FIFO costing
            honest. Damaged items move to the Damaged / Write-off location and never return to sale.
          </p>
        </div>
      </Modal>

      <BackdateDialog
        open={backdateOpen}
        date={effectiveDate}
        onCancel={() => setBackdateOpen(false)}
        onConfirm={(bReason) => {
          setBackdateReason(bReason);
          setBackdateOpen(false);
          void doSubmit(bReason);
        }}
      />
    </Shell>
  );
}
