'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Modal, TableWrap, statusTone } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { currency, escapeHtml, formatDate } from '@/lib/utils';

interface Sale {
  id: string;
  number: string;
  status: string;
  soldAt: string;
  total: number;
  profit: number;
  totalCost: number;
  discountAmount: number;
  paymentMethod: string;
  customerName: string | null;
  location: { name: string };
  cashier: { name: string };
  lines: {
    quantity: number;
    lineTotal: number;
    actualPrice: number;
    unitCost: number;
    lineProfit: number;
    variant: { product: { name: string }; label: string };
  }[];
}

export default function SalesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [sales, setSales] = useState<Sale[]>([]);
  const [detail, setDetail] = useState<Sale | null>(null);
  const [from, setFrom] = useState(() => new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ sales: Sale[] }>(`/api/sales?status=all&from=${from}&to=${to}T23:59`);
      setSales(data.sales);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [from, to, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const voidSale = async (id: string) => {
    if (!confirm('Void this sale? Stock returns to the batches it came from.')) return;
    try {
      await api.patch(`/api/sales/${id}`, { action: 'void' });
      toast.push('success', 'Sale voided and stock restored.');
      setDetail(null);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  // Reprint a completed ticket as a 80 mm-style receipt in a print-only popup.
  const printReceipt = (sale: Sale) => {
    const w = window.open('', '_blank', 'width=320,height=640');
    if (!w) {
      toast.push('error', 'Pop-up blocked — allow pop-ups to reprint receipts.');
      return;
    }
    const rows = sale.lines
      .map(
        (line) => `<tr><td style="padding:2px 0;">
          ${escapeHtml(line.variant.product.name)} — ${escapeHtml(line.variant.label)}
          <div style="color:#666;font-size:10px;">${line.quantity} × ${currency(line.actualPrice)}</div>
        </td><td style="text-align:right;padding:2px 0;white-space:nowrap;">${currency(line.lineTotal)}</td></tr>`,
      )
      .join('');
    w.document.write(`<!doctype html><html><head><title>Receipt ${sale.number}</title>
<style>
  body { font-family: 'Courier New', monospace; font-size: 12px; color: #000; width: 280px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 13px; text-align: center; margin: 0 0 2px; }
  .meta { text-align: center; color: #444; line-height: 1.4; margin-bottom: 8px; }
  .rule { border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; }
  .total td { font-weight: 700; }
  .foot { margin-top: 10px; color: #444; line-height: 1.5; }
</style></head><body>
  <h1>${escapeHtml(sale.location.name)}</h1>
  <div class="meta">${escapeHtml(sale.number)}<br>${formatDate(sale.soldAt, true)}</div>
  <div class="rule"></div>
  <table>${rows}</table>
  <div class="rule"></div>
  <table class="total">
    <tr><td>Total</td><td style="text-align:right">${currency(sale.total)}</td></tr>
    <tr><td>Payment</td><td style="text-align:right">${sale.paymentMethod.replace('_', ' ')}</td></tr>
  </table>
  <div class="foot">
    Cashier: ${escapeHtml(sale.cashier.name)}<br>
    ${sale.customerName ? `Customer: ${escapeHtml(sale.customerName)}<br>` : ''}
  </div>
</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <Shell>
      <PageHeader
        title="Sales history"
        description="Completed POS tickets with FIFO cost of goods and profit per ticket."
        action={
          can('sale.create') && (
            <Link className="btn-primary" href="/pos">
              Open POS
            </Link>
          )
        }
      />

      <Card
        action={
          <div className="flex items-center gap-2">
            <input className="input w-40" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-ink-400 dark:text-ink-500">→</span>
            <input className="input w-40" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        }
      >
        {sales.length === 0 ? (
          <Empty message="No sales in this period." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>When</th>
                  <th>Location</th>
                  <th>Cashier</th>
                  <th className="text-right">Items</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Profit</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((sale) => (
                  <tr key={sale.id}>
                    <td>
                      <button
                        className="font-mono font-medium hover:underline"
                        onClick={async () => {
                          try {
                            const data = await api.get<{ sale: Sale }>(`/api/sales/${sale.id}`);
                            setDetail(data.sale);
                          } catch (err) {
                            toast.push('error', errorMessage(err));
                          }
                        }}
                        type="button"
                      >
                        {sale.number}
                      </button>
                    </td>
                    <td>{formatDate(sale.soldAt, true)}</td>
                    <td className="text-ink-600 dark:text-ink-300">{sale.location.name}</td>
                    <td className="text-ink-600 dark:text-ink-300">{sale.cashier.name}</td>
                    <td className="text-right tabular-nums">{sale.lines.reduce((s, l) => s + l.quantity, 0)}</td>
                    <td className="text-right tabular-nums">{currency(sale.total)}</td>
                    <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(sale.totalCost)}</td>
                    <td
                      className={`text-right font-medium tabular-nums ${
                        sale.profit >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {currency(sale.profit)}
                    </td>
                    <td>
                      <Badge tone={statusTone(sale.status)}>{sale.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Modal
        open={Boolean(detail)}
        title={`Ticket ${detail?.number ?? ''}`}
        wide
        onClose={() => setDetail(null)}
        footer={
          detail ? (
            <div className="flex w-full items-center justify-between gap-3">
              <button className="btn-secondary" onClick={() => printReceipt(detail)} type="button">
                Reprint receipt
              </button>
              {detail.status === 'completed' && can('sale.void') ? (
                <button className="btn-danger" onClick={() => voidSale(detail.id)} type="button">
                  Void sale
                </button>
              ) : undefined}
            </div>
          ) : undefined
        }
      >
        {detail && (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <span className="label">Location</span>
                <p>{detail.location.name}</p>
              </div>
              <div>
                <span className="label">Cashier</span>
                <p>{detail.cashier.name}</p>
              </div>
              <div>
                <span className="label">Payment</span>
                <p>{detail.paymentMethod.replace('_', ' ')}</p>
              </div>
              <div>
                <span className="label">Customer</span>
                <p>{detail.customerName ?? '—'}</p>
              </div>
            </div>

            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">FIFO cost</th>
                    <th className="text-right">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((line, index) => (
                    <tr key={index}>
                      <td>
                        {line.variant.product.name} — {line.variant.label}
                      </td>
                      <td className="text-right tabular-nums">{line.quantity}</td>
                      <td className="text-right tabular-nums">{currency(line.actualPrice)}</td>
                      <td className="text-right tabular-nums">{currency(line.lineTotal)}</td>
                      <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{currency(line.unitCost)}</td>
                      <td className="text-right tabular-nums text-emerald-700 dark:text-emerald-400">{currency(line.lineProfit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>

            <div className="flex flex-wrap justify-end gap-6 border-t border-ink-200 pt-3 dark:border-ink-700">
              <span>
                <span className="muted">Total </span>
                <strong className="tabular-nums">{currency(detail.total)}</strong>
              </span>
              <span>
                <span className="muted">Cost </span>
                <strong className="tabular-nums">{currency(detail.totalCost)}</strong>
              </span>
              <span>
                <span className="muted">Profit </span>
                <strong className="tabular-nums text-emerald-700 dark:text-emerald-400">{currency(detail.profit)}</strong>
              </span>
            </div>
          </div>
        )}
      </Modal>
    </Shell>
  );
}
