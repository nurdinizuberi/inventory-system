'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, TableWrap } from '@/components/ui';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { formatDate } from '@/lib/utils';

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  before: string | null;
  after: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: string | null;
  createdAt: string;
  userEmail: string | null;
  userRole: string | null;
  user: { name: string } | null;
}

const ACTION_TONES: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'neutral'> = {
  create: 'green',
  confirm: 'green',
  approve: 'green',
  complete: 'green',
  login: 'blue',
  logout: 'neutral',
  update: 'amber',
  ship: 'blue',
  cancel: 'red',
  reject: 'red',
  void: 'red',
  delete: 'red',
};

function pretty(json: string | null): string | null {
  if (!json) return null;
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export default function AuditPage() {
  const toast = useToast();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [entityTypes, setEntityTypes] = useState<{ value: string; count: number }[]>([]);
  const [actions, setActions] = useState<{ value: string; count: number }[]>([]);
  const [total, setTotal] = useState(0);
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (entityType) params.set('entityType', entityType);
      if (action) params.set('action', action);
      if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());
      const data = await api.get<{
        logs: AuditEntry[];
        entityTypes: { value: string; count: number }[];
        actions: { value: string; count: number }[];
        total: number;
      }>(`/api/audit?${params.toString()}`);
      setLogs(data.logs);
      setEntityTypes(data.entityTypes);
      setActions(data.actions);
      setTotal(data.total);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [entityType, action, debouncedQuery, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Shell>
      <PageHeader
        title="Audit log"
        description="System activity, separate from the stock ledger. Append-only — the app exposes no update or delete for these records."
        action={
          <button
            className="btn-secondary btn-sm"
            onClick={() => {
              void (async () => {
                try {
                  const data = await api.get<{ days: number; total: number; entries: { type: string; number: string; effectiveDate: string; backdateReason: string | null; enteredAt: string; details: string; value: number | null }[] }>('/api/reports/backdated?days=30');
                  if (data.total === 0) {
                    toast.push('info', 'No backdated entries found in the last 30 days.');
                  } else {
                    const lines = data.entries.slice(0, 10).map((e) => `${e.type} ${e.number}: ${e.details} (effective ${new Date(e.effectiveDate).toISOString().slice(0, 10)}, reason: ${e.backdateReason?.replace(/_/g, ' ') ?? '—'})`);
                    toast.push('info', `${data.total} backdated entry(ies) in last ${data.days} days:\n${lines.join('\n')}`);
                  }
                } catch (err) {
                  toast.push('error', errorMessage(err));
                }
              })();
            }}
            type="button"
          >
            Backdated entries (30d)
          </button>
        }
      />

      <Card
        subtitle={`${total.toLocaleString()} entries recorded in total`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-40" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              <option value="">All entities</option>
              {entityTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.value} ({type.count})
                </option>
              ))}
            </select>
            <select className="input w-36" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">All actions</option>
              {actions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.value} ({item.count})
                </option>
              ))}
            </select>
            <input
              className="input w-52"
              placeholder="Search label, user, id…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        }
      >
        {logs.length === 0 ? (
          <Empty message="No audit entries match these filters." />
        ) : (
          <TableWrap maxHeight="70vh">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Record</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => (
                  <tr key={entry.id} className="cursor-pointer" onClick={() => setSelected(entry)}>
                    <td className="whitespace-nowrap text-ink-600 dark:text-ink-300">{formatDate(entry.createdAt, true)}</td>
                    <td>
                      {entry.user?.name ?? entry.userEmail}
                      <span className="block text-xs text-ink-400 dark:text-ink-500">{entry.userRole}</span>
                    </td>
                    <td>
                      <Badge tone={ACTION_TONES[entry.action] ?? 'neutral'}>{entry.action}</Badge>
                    </td>
                    <td className="text-ink-600 dark:text-ink-300">{entry.entityType}</td>
                    <td className="font-medium">{entry.entityLabel ?? entry.entityId ?? '—'}</td>
                    <td className="font-mono text-xs text-ink-400 dark:text-ink-500">{entry.ipAddress ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4">
          <div className="card my-8 w-full max-w-3xl">
            <header className="flex items-center justify-between border-b border-ink-200 px-5 py-3 dark:border-ink-700">
              <div>
                <h2 className="section-title">
                  {selected.action} · {selected.entityType}
                </h2>
                <p className="muted">{selected.entityLabel ?? selected.entityId}</p>
              </div>
              <button className="btn-ghost btn-sm" onClick={() => setSelected(null)} type="button">
                Close
              </button>
            </header>
            <div className="card-pad space-y-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <span className="label">When</span>
                  <p>{formatDate(selected.createdAt, true)}</p>
                </div>
                <div>
                  <span className="label">Who</span>
                  <p>
                    {selected.user?.name ?? selected.userEmail} ({selected.userRole})
                  </p>
                </div>
                <div>
                  <span className="label">IP / agent</span>
                  <p className="break-all text-xs text-ink-500 dark:text-ink-400">
                    {selected.ipAddress ?? '—'}
                    <span className="block">{selected.userAgent ?? '—'}</span>
                  </p>
                </div>
              </div>

              {selected.before && (
                <div>
                  <span className="label">Before</span>
                  <pre className="overflow-auto rounded-lg bg-ink-900 p-3 font-mono text-xs text-ink-100">
                    {pretty(selected.before)}
                  </pre>
                </div>
              )}
              {selected.after && (
                <div>
                  <span className="label">After</span>
                  <pre className="overflow-auto rounded-lg bg-ink-900 p-3 font-mono text-xs text-ink-100">
                    {pretty(selected.after)}
                  </pre>
                </div>
              )}
              {selected.metadata && (
                <div>
                  <span className="label">Metadata</span>
                  <pre className="overflow-auto rounded-lg bg-ink-100 p-3 font-mono text-xs text-ink-700 dark:bg-ink-800 dark:text-ink-300">
                    {pretty(selected.metadata)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
