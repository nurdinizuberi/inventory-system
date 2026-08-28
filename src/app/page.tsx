'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Kpi, MovementBadge, Sparkline, TableWrap } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { api, errorMessage } from '@/lib/client';
import { currency, formatDate } from '@/lib/utils';

interface DashboardData {
  user: { name: string; role: string; email: string };
  locations: { id: string; name: string; type: string; code: string }[];
  kpis: {
    salesToday: number;
    profitToday: number;
    transactionsToday: number;
    unitsOnHand: number;
    inventoryValue: number;
    lowStockCount: number;
    pendingAdjustments: number;
    inTransit: number;
    draftPurchases: number;
  };
  sparkline: { date: string; revenue: number; profit: number }[];
  lowStock: {
    variantId: string;
    locationId: string;
    name: string;
    sku: string;
    location: string;
    onHand: number;
    reserved: number;
    threshold: number;
    outOfStock: boolean;
  }[];
  recentMovements: {
    id: string;
    type: string;
    quantity: number;
    status: string;
    variant: string;
    location: string;
    reference: string | null;
    reason: string | null;
    createdAt: string;
  }[];
}

export default function DashboardPage() {
  const { can } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<DashboardData>('/api/dashboard')
      .then(setData)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  return (
    <Shell>
      <PageHeader
        title={`Karibu, ${data?.user.name ?? '…'}`}
        description="Live position across every location, derived from the stock movement ledger."
      />

      {error && <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}

      {!data && !error && <p className="muted">Loading dashboard…</p>}

      {data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi
              label="Sales today"
              value={currency(data.kpis.salesToday)}
              hint={`${data.kpis.transactionsToday} transaction(s)`}
            />
            <Kpi
              label="Profit today"
              value={currency(data.kpis.profitToday)}
              tone={data.kpis.profitToday >= 0 ? 'good' : 'bad'}
              hint="Revenue less FIFO cost of goods"
            />
            <Kpi
              label="Inventory value"
              value={currency(data.kpis.inventoryValue)}
              hint={`${data.kpis.unitsOnHand.toLocaleString()} units on hand`}
            />
            <Kpi
              label="Low stock alerts"
              value={data.kpis.lowStockCount}
              tone={data.kpis.lowStockCount ? 'warn' : 'good'}
              hint={`${data.kpis.inTransit} transfer(s) in transit · ${data.kpis.pendingAdjustments} adjustment(s) awaiting approval`}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Revenue — last 7 days" className="lg:col-span-2">
              <Sparkline data={data.sparkline} />
            </Card>

            <Card
              title="Needs attention"
              action={
                can('stock.adjust') && data.kpis.pendingAdjustments > 0 ? (
                  <Link className="btn-secondary btn-sm" href="/adjustments">
                    Review
                  </Link>
                ) : undefined
              }
            >
              <ul className="space-y-2 text-sm">
                <li className="flex items-center justify-between">
                  <span className="text-ink-600 dark:text-ink-300">Adjustments awaiting approval</span>
                  <Badge tone={data.kpis.pendingAdjustments ? 'amber' : 'green'}>{data.kpis.pendingAdjustments}</Badge>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-600 dark:text-ink-300">Transfers in transit</span>
                  <Badge tone="blue">{data.kpis.inTransit}</Badge>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-600 dark:text-ink-300">Draft purchase orders</span>
                  <Badge>{data.kpis.draftPurchases}</Badge>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-ink-600 dark:text-ink-300">Locations in scope</span>
                  <Badge>{data.locations.length}</Badge>
                </li>
              </ul>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card
              title="Low stock"
              subtitle="On hand at or below the variant's threshold"
              action={
                can('report.stock') ? (
                  <Link className="btn-secondary btn-sm" href="/reports/stock?onlyLow=1">
                    Full report
                  </Link>
                ) : undefined
              }
            >
              {data.lowStock.length === 0 ? (
                <Empty message="No low-stock alerts. Everything is above threshold." />
              ) : (
                <TableWrap maxHeight="320px">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Variant</th>
                        <th>Location</th>
                        <th className="text-right">On hand</th>
                        <th className="text-right">Threshold</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.lowStock.map((row) => (
                        <tr key={`${row.variantId}-${row.locationId}`}>
                          <td>
                            <p className="font-medium text-ink-900 dark:text-ink-100">{row.name}</p>
                            <p className="font-mono text-xs text-ink-400 dark:text-ink-500">{row.sku}</p>
                          </td>
                          <td className="text-ink-600 dark:text-ink-300">{row.location}</td>
                          <td className="text-right">
                            <Badge tone={row.outOfStock ? 'red' : 'amber'}>{row.onHand}</Badge>
                          </td>
                          <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{row.threshold}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>

            <Card title="Recent stock movements" subtitle="The ledger — the source of truth">
              <TableWrap maxHeight="320px">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Variant</th>
                      <th>Location</th>
                      <th className="text-right">Qty</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentMovements.map((movement) => (
                      <tr key={movement.id}>
                        <td>
                          <MovementBadge type={movement.type} />
                        </td>
                        <td className="max-w-[16rem] truncate">{movement.variant}</td>
                        <td className="text-ink-600 dark:text-ink-300">{movement.location}</td>
                        <td
                          className={`text-right font-medium tabular-nums ${
                            movement.quantity < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
                          }`}
                        >
                          {movement.quantity > 0 ? '+' : ''}
                          {movement.quantity}
                        </td>
                        <td className="whitespace-nowrap text-ink-500 dark:text-ink-400">
                          {formatDate(movement.createdAt, true)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          </div>
        </div>
      )}
    </Shell>
  );
}
