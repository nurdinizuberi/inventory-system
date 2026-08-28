'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Kpi, TableWrap, statusTone } from '@/components/ui';
import { api, errorMessage } from '@/lib/client';
import { useToast } from '@/components/toast';
import { currency, formatDate } from '@/lib/utils';

interface Report {
  transfers: {
    id: string;
    number: string;
    status: string;
    from: string;
    to: string;
    requestedAt: string;
    shippedAt: string | null;
    completedAt: string | null;
    createdBy: string;
    units: number;
    value: number;
    lines: { variant: string; quantity: number; receivedQty: number }[];
  }[];
  byLane: { lane: string; transfers: number; units: number; value: number }[];
  totals: { transfers: number; pending: number; inTransit: number; completed: number; value: number };
}

export default function TransferReportPage() {
  const toast = useToast();
  const [from, setFrom] = useState(() => new Date(Date.now() - 179 * 864e5).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<Report | null>(null);
  const [includeBackdated, setIncludeBackdated] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Report>(`/api/reports/transfers?from=${from}&to=${to}${includeBackdated ? '&includeBackdated=1' : ''}`));
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [from, to, includeBackdated, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Transfer history"
        description="What moved between which locations and when, valued from the transfer ledger rows."
        action={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-ink-600 dark:text-ink-300">
              <input type="checkbox" checked={includeBackdated} onChange={(e) => setIncludeBackdated(e.target.checked)} />
              Include backdated
            </label>
            <input className="input w-40" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-ink-400 dark:text-ink-500">→</span>
            <input className="input w-40" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        }
      />

      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Transfers" value={data.totals.transfers} />
            <Kpi label="In transit" value={data.totals.inTransit} tone={data.totals.inTransit ? 'warn' : 'good'} />
            <Kpi label="Completed" value={data.totals.completed} />
            <Kpi label="Value moved" value={currency(data.totals.value)} hint="At batch cost" />
          </div>

          <Card title="By lane">
            {data.byLane.length === 0 ? (
              <Empty />
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Lane</th>
                      <th className="text-right">Transfers</th>
                      <th className="text-right">Units</th>
                      <th className="text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byLane.map((lane) => (
                      <tr key={lane.lane}>
                        <td className="font-medium">{lane.lane}</td>
                        <td className="text-right tabular-nums">{lane.transfers}</td>
                        <td className="text-right tabular-nums">{lane.units}</td>
                        <td className="text-right tabular-nums">{currency(lane.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          <Card title="Transfers">
            <TableWrap maxHeight="55vh">
              <table className="table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Status</th>
                    <th>Requested</th>
                    <th>Shipped</th>
                    <th>Received</th>
                    <th className="text-right">Units</th>
                    <th className="text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.transfers.map((transfer) => (
                    <tr key={transfer.id}>
                      <td className="font-mono font-medium">{transfer.number}</td>
                      <td className="text-ink-600 dark:text-ink-300">{transfer.from}</td>
                      <td>{transfer.to}</td>
                      <td>
                        <Badge tone={statusTone(transfer.status)}>{transfer.status.replace('_', ' ')}</Badge>
                      </td>
                      <td>{formatDate(transfer.requestedAt)}</td>
                      <td>{formatDate(transfer.shippedAt)}</td>
                      <td>{formatDate(transfer.completedAt)}</td>
                      <td className="text-right tabular-nums">{transfer.units}</td>
                      <td className="text-right tabular-nums">{currency(transfer.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </div>
      )}
    </>
  );
}
