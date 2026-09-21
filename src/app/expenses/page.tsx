'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackdateDialog, isBackdated, todayISO } from '@/components/backdate-dialog';
import { HBarList } from '@/components/charts';
import { ExportButtons, money } from '@/components/report-tools';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Kpi, Modal, TableWrap, statusTone } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import {
  EXPENSE_PAYMENT_METHODS,
  EXPENSE_PAYMENT_METHOD_LABELS,
  EXPENSE_STATUSES,
  EXPENSE_STATUS_LABELS,
  type ExpensePaymentMethod,
  type ExpenseStatus,
} from '@/lib/types';
import { currency, formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Expenses — operating expenses (rent, transport, salaries...). Kept separate
// from Purchases: inventory spend only enters the P&L as FIFO COGS when goods
// are sold, so nothing is double-counted.
// ---------------------------------------------------------------------------

interface Expense {
  id: string;
  number: string;
  amount: number;
  status: string;
  expenseDate: string;
  paymentMethod: string;
  payee: string | null;
  reference: string | null;
  description: string | null;
  notes: string | null;
  receiptName: string | null;
  hasReceipt: boolean;
  isBackdated: boolean;
  backdateReason: string | null;
  createdAt: string;
  category: { id: string; name: string };
  createdBy: { id: string; name: string } | null;
  updatedBy: { id: string; name: string } | null;
  approvedBy: { id: string; name: string } | null;
}

interface Category {
  id: string;
  name: string;
  isActive: boolean;
}

interface Summary {
  kpis: { today: number; thisMonth: number; thisYear: number; allTime: number; drafts: number; cancelled: number };
  byCategory: { category: string; total: number; count: number }[];
  monthly: { month: string; expenses: number; revenue: number; cogs: number; netProfit: number }[];
}

interface Totals {
  paid: number;
  all: number;
  count: number;
}

const statusLabel = (status: string) => EXPENSE_STATUS_LABELS[status as ExpenseStatus] ?? status;
const methodLabel = (method: string) => EXPENSE_PAYMENT_METHOD_LABELS[method as ExpensePaymentMethod] ?? method;

interface FormState {
  categoryId: string;
  amount: string;
  status: ExpenseStatus;
  expenseDate: string;
  paymentMethod: ExpensePaymentMethod;
  payee: string;
  reference: string;
  description: string;
  receiptName: string;
  receiptData: string;
}

const emptyForm = (): FormState => ({
  categoryId: '',
  amount: '',
  status: 'paid',
  expenseDate: todayISO(),
  paymentMethod: 'cash',
  payee: '',
  reference: '',
  description: '',
  receiptName: '',
  receiptData: '',
});

export default function ExpensesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<Expense[]>([]);
  const [totals, setTotals] = useState<Totals>({ paid: 0, all: 0, count: 0 });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Editor
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [newCategory, setNewCategory] = useState('');
  const [backdateOpen, setBackdateOpen] = useState(false);
  const [backdateReason, setBackdateReason] = useState<string | null>(null);
  const [receiptOpen, setReceiptOpen] = useState<Expense | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (categoryId) params.set('categoryId', categoryId);
      if (status) params.set('status', status);
      if (paymentMethod) params.set('paymentMethod', paymentMethod);
      if (search.trim()) params.set('q', search.trim());
      const [expenseRes, categoryRes, summaryRes] = await Promise.all([
        api.get<{ expenses: Expense[]; totals: Totals }>(`/api/expenses?${params.toString()}`),
        api.get<{ categories: Category[] }>('/api/expenses/categories'),
        api.get<Summary>('/api/expenses/summary'),
      ]);
      setItems(expenseRes.expenses);
      setTotals(expenseRes.totals);
      setCategories(categoryRes.categories.filter((c) => c.isActive));
      setSummary(summaryRes);
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [from, to, categoryId, status, paymentMethod, search, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setNewCategory('');
    setBackdateReason(null);
    setOpen(true);
  };

  const openEdit = (expense: Expense) => {
    setEditing(expense);
    setForm({
      categoryId: expense.category.id,
      amount: String(expense.amount),
      status: (expense.status as ExpenseStatus) ?? 'paid',
      expenseDate: expense.expenseDate.slice(0, 10),
      paymentMethod: (expense.paymentMethod as ExpensePaymentMethod) ?? 'cash',
      payee: expense.payee ?? '',
      reference: expense.reference ?? '',
      description: expense.description ?? '',
      receiptName: expense.receiptName ?? '',
      receiptData: '',
    });
    setNewCategory('');
    setBackdateReason(null);
    setOpen(true);
  };

  const pickReceipt = (file: File | null) => {
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) {
      toast.push('error', 'Receipt must be smaller than 1.5 MB (it is stored with the expense).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setForm((f) => ({ ...f, receiptName: file.name, receiptData: String(reader.result) }));
    };
    reader.readAsDataURL(file);
  };

  const buildPayload = () => ({
    categoryId: form.categoryId,
    amount: Number(form.amount),
    status: form.status,
    expenseDate: form.expenseDate,
    backdateReason: backdateReason,
    paymentMethod: form.paymentMethod,
    payee: form.payee || null,
    reference: form.reference || null,
    description: form.description || null,
    receipt:
      form.receiptData && form.receiptName
        ? { name: form.receiptName, type: form.receiptData.slice(5, form.receiptData.indexOf(';')) || 'application/octet-stream', data: form.receiptData }
        : null,
  });

  const doSubmit = async (reason: string | null) => {
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`/api/expenses/${editing.id}`, buildPayload());
        toast.push('success', `Expense ${editing.number} updated — reports recalculated.`);
      } else {
        const created = await api.post<{ expense: Expense }>('/api/expenses', buildPayload());
        toast.push('success', `Expense ${created.expense.number} saved.`);
      }
      setOpen(false);
      setBackdateReason(null);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!form.categoryId) return toast.push('error', 'Choose a category');
    if (!form.amount || Number(form.amount) <= 0) return toast.push('error', 'Enter an amount greater than zero');
    if (isBackdated(form.expenseDate) && !backdateReason && !editing?.isBackdated) {
      setBackdateOpen(true);
      return;
    }
    void doSubmit(backdateReason);
  };

  const setStatusFor = async (expense: Expense, next: ExpenseStatus) => {
    try {
      await api.patch(`/api/expenses/${expense.id}`, { status: next });
      toast.push(
        'success',
        next === 'paid'
          ? `${expense.number} marked paid — it now counts toward net profit.`
          : `${expense.number} set to ${statusLabel(next)}.`,
      );
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  const remove = async (expense: Expense) => {
    if (!window.confirm(`Cancel expense ${expense.number} (${currency(expense.amount)})? It will stop counting toward profit.`)) return;
    try {
      await api.del(`/api/expenses/${expense.id}`);
      toast.push('success', `${expense.number} cancelled.`);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  const addCategory = async () => {
    if (!newCategory.trim()) return;
    try {
      await api.post('/api/expenses/categories', { name: newCategory.trim() });
      setNewCategory('');
      toast.push('success', 'Category added.');
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  const chartData = useMemo(
    () =>
      (summary?.monthly ?? []).map((m) => ({
        label: m.month.slice(2),
        values: [
          { key: 'expenses', name: 'Expenses', value: m.expenses, color: 'rose' as const },
          { key: 'net', name: 'Net profit', value: Math.max(0, m.netProfit), color: 'emerald' as const },
        ],
      })),
    [summary],
  );

  const exportRows = items.map((e) => [
    e.number,
    e.expenseDate.slice(0, 10),
    e.category.name,
    e.amount,
    e.status,
    methodLabel(e.paymentMethod),
    e.payee ?? '',
    e.reference ?? '',
    e.description ?? '',
    e.createdBy?.name ?? '',
  ]);

  return (
    <Shell>
      <PageHeader
        title="Expenses"
        description="Track and manage business expenses. Operating expenses are kept separate from stock purchases, so inventory cost is never counted twice."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-secondary" onClick={() => setShowFilters((v) => !v)} type="button">
              {showFilters ? 'Hide filters' : 'Filters'}
            </button>
            {can('expense.create') && (
              <button className="btn-primary" onClick={openCreate} type="button">
                Add expense
              </button>
            )}
          </div>
        }
      />

      {/* Dashboard strip */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="This month" value={currency(summary?.kpis.thisMonth ?? 0)} tone="warn" hint="Paid expenses" />
        <Kpi label="Today" value={currency(summary?.kpis.today ?? 0)} hint="Paid expenses" />
        <Kpi label="This year" value={currency(summary?.kpis.thisYear ?? 0)} hint="Paid expenses" />
        <Kpi
          label="All time"
          value={currency(summary?.kpis.allTime ?? 0)}
          hint={`${summary?.kpis.drafts ?? 0} draft · ${summary?.kpis.cancelled ?? 0} cancelled excluded`}
        />
      </div>

      <div className="mb-5 grid gap-5 lg:grid-cols-3">
        <Card title="Expense trend" subtitle="Paid expenses vs net profit, month by month" className="lg:col-span-2">
          <HBarList
            items={[...chartData]
              .reverse()
              .slice(-6)
              .map((bucket) => ({
                label: bucket.label,
                value: bucket.values[0].value,
                hint: `Net profit ${currency(summary?.monthly.find((m) => m.month.slice(2) === bucket.label)?.netProfit ?? 0)}`,
              }))}
            format={(v) => currency(v)}
            color="rose"
            empty="No expenses recorded yet."
          />
        </Card>
        <Card title="This month by category" subtitle="Where the money went">
          {summary && summary.byCategory.length > 0 ? (
            <HBarList
              items={summary.byCategory.slice(0, 6).map((row) => ({ label: row.category, value: row.total, hint: `${row.count} expense(s)` }))}
              format={(v) => currency(v)}
              color="amber"
            />
          ) : (
            <Empty message="No paid expenses this month." />
          )}
        </Card>
      </div>

      {showFilters && (
        <Card title="Filters" className="mb-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Field label="From">
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Category">
              <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">All</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Payment method">
              <select className="input" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                <option value="">All</option>
                {EXPENSE_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {EXPENSE_PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                {EXPENSE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {EXPENSE_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Search">
              <input className="input" placeholder="Payee, ref, notes…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </Field>
          </div>
          {can('expense.create') && (
            <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-ink-200 pt-3 dark:border-ink-700">
              <div className="w-48">
                <Field label="New category">
                  <input
                    className="input"
                    placeholder="e.g. Utilities"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                  />
                </Field>
              </div>
              <button className="btn-secondary btn-sm" onClick={addCategory} type="button">
                Add category
              </button>
            </div>
          )}
        </Card>
      )}

      <Card
        title={`Expenses${totals.count ? ` (${totals.count})` : ''}`}
        subtitle={`Paid in view: ${currency(totals.paid)} · including drafts: ${currency(totals.all)}`}
        action={
          totals.count > 0 ? (
            <ExportButtons
              label="Export"
              csvFilename={`expenses-${from || 'all'}-to-${to || 'now'}`}
              csvHeaders={['Number', 'Date', 'Category', 'Amount', 'Status', 'Payment method', 'Payee', 'Reference', 'Description', 'Recorded by']}
              csvRows={exportRows}
              print={{
                title: 'Expense report',
                subtitle: (
                  <>
                    {from || to ? `Period ${from || '…'} → ${to || '…'} · ` : ''}
                    {status ? `${statusLabel(status)} · ` : ''}
                    {categoryId ? `${categories.find((c) => c.id === categoryId)?.name ?? ''} · ` : ''}
                    {totals.count} expense(s)
                  </>
                ),
                blocks: [
                  {
                    title: 'Summary',
                    headers: ['Metric', 'Value'],
                    rows: [
                      ['Paid total', money(totals.paid)],
                      ['Expenses in view', String(totals.count)],
                      ['Drafts / cancelled excluded from profit', 'yes'],
                    ],
                  },
                  {
                    title: 'Expenses',
                    headers: ['Number', 'Date', 'Category', 'Amount', 'Method', 'Payee', 'Reference'],
                    rows: items.map((e) => [
                      e.number,
                      e.expenseDate.slice(0, 10),
                      e.category.name,
                      money(e.amount),
                      methodLabel(e.paymentMethod),
                      e.payee ?? '—',
                      e.reference ?? '—',
                    ]),
                  },
                ],
              }}
            />
          ) : undefined
        }
      >
        {loading ? (
          <p className="muted">Loading expenses…</p>
        ) : items.length === 0 ? (
          <Empty message="No expenses match the current filters." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Description / payee</th>
                  <th>Method</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                  <th>Recorded by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td className="font-mono font-medium">
                      {e.number}
                      {e.isBackdated && (
                        <span className="ml-2">
                          <Badge tone="amber">Backdated</Badge>
                        </span>
                      )}
                    </td>
                    <td>{formatDate(e.expenseDate)}</td>
                    <td>
                      <Badge tone="violet">{e.category.name}</Badge>
                    </td>
                    <td className="max-w-[16rem]">
                      <p className="truncate" title={e.description ?? undefined}>{e.description ?? '—'}</p>
                      <p className="truncate text-xs text-ink-500 dark:text-ink-400">
                        {e.payee ?? ''}
                        {e.reference ? ` · ${e.reference}` : ''}
                      </p>
                    </td>
                    <td className="text-ink-600 dark:text-ink-300">{methodLabel(e.paymentMethod)}</td>
                    <td className="text-right font-medium tabular-nums">{currency(e.amount)}</td>
                    <td>
                      <Badge tone={statusTone(e.status)}>{statusLabel(e.status)}</Badge>
                    </td>
                    <td className="text-ink-600 dark:text-ink-300">{e.createdBy?.name ?? '—'}</td>
                    <td className="whitespace-nowrap text-right">
                      {e.hasReceipt && (
                        <button className="btn-ghost btn-sm" onClick={() => setReceiptOpen(e)} type="button" title={e.receiptName ?? 'Receipt'}>
                          Receipt
                        </button>
                      )}
                      {can('expense.update') && e.status !== 'cancelled' && (
                        <>
                          <button className="btn-ghost btn-sm" onClick={() => openEdit(e)} type="button">
                            Edit
                          </button>
                          {e.status === 'draft' && (
                            <button className="btn-ghost btn-sm" onClick={() => setStatusFor(e, 'paid')} type="button">
                              Mark paid
                            </button>
                          )}
                        </>
                      )}
                      {can('expense.approve') && e.status === 'draft' && (
                        <button className="btn-primary btn-sm" onClick={() => setStatusFor(e, 'paid')} type="button">
                          Approve
                        </button>
                      )}
                      {can('expense.delete') && e.status !== 'cancelled' && (
                        <button className="btn-ghost btn-sm" onClick={() => remove(e)} type="button">
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

      {/* Add / edit modal */}
      <Modal
        open={open}
        title={editing ? `Edit expense ${editing.number}` : 'Record an expense'}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button className="btn-primary" disabled={busy} onClick={submit} type="button">
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Save expense'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount">
              <input
                className="input"
                type="number"
                min="0"
                step="1"
                placeholder="150000"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </Field>
            <Field label="Category">
              <select className="input" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">Select…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date" hint="The day the expense was incurred. Past dates need a reason.">
              <input
                className="input"
                type="date"
                max={todayISO()}
                value={form.expenseDate}
                onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
              />
            </Field>
            <Field label="Payment method">
              <select
                className="input"
                value={form.paymentMethod}
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value as ExpensePaymentMethod })}
              >
                {EXPENSE_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {EXPENSE_PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Payee">
              <input
                className="input"
                placeholder="ABC Transport"
                value={form.payee}
                onChange={(e) => setForm({ ...form, payee: e.target.value })}
              />
            </Field>
            <Field label="Reference" hint="Auto-numbered when left blank">
              <input
                className="input"
                placeholder="EXP-00045"
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Description">
            <input
              className="input"
              placeholder="Delivery of products"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Status" hint="Only paid expenses count toward net profit">
              <select
                className="input"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as ExpenseStatus })}
              >
                {EXPENSE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {EXPENSE_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Receipt" hint="Image or PDF, up to 1.5 MB">
              <div className="flex items-center gap-2">
                <input
                  ref={fileRef}
                  className="hidden"
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => pickReceipt(e.target.files?.[0] ?? null)}
                />
                <button className="btn-secondary" onClick={() => fileRef.current?.click()} type="button">
                  Upload
                </button>
                {form.receiptName && (
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-600 dark:text-ink-300">
                    {form.receiptName}
                    <button
                      className="ml-2 text-red-600 hover:underline dark:text-red-400"
                      onClick={() => setForm({ ...form, receiptName: '', receiptData: '' })}
                      type="button"
                    >
                      remove
                    </button>
                  </span>
                )}
              </div>
            </Field>
          </div>
          {isBackdated(form.expenseDate) && backdateReason && (
            <p className="text-xs text-ink-500 dark:text-ink-400">Backdated — reason recorded for the audit trail.</p>
          )}
        </div>
      </Modal>

      <BackdateDialog
        open={backdateOpen}
        date={form.expenseDate}
        onCancel={() => setBackdateOpen(false)}
        onConfirm={(reason) => {
          setBackdateReason(reason);
          setBackdateOpen(false);
          void doSubmit(reason);
        }}
      />

      {/* Receipt viewer */}
      <Modal open={receiptOpen !== null} title={receiptOpen ? `Receipt — ${receiptOpen.number}` : 'Receipt'} onClose={() => setReceiptOpen(null)}>
        {receiptOpen && (
          <div className="space-y-3">
            <p className="text-sm text-ink-600 dark:text-ink-300">
              {receiptOpen.receiptName ?? 'Receipt'} · {currency(receiptOpen.amount)}
            </p>
            {receiptOpen.hasReceipt && receiptOpen.receiptName?.toLowerCase().endsWith('.pdf') ? (
              <a className="btn-secondary" href={`/api/expenses/${receiptOpen.id}`} target="_blank" rel="noreferrer">
                Open receipt
              </a>
            ) : (
              <ReceiptImage expenseId={receiptOpen.id} />
            )}
          </div>
        )}
      </Modal>
    </Shell>
  );
}

/** Fetches the receipt data URL on demand so list responses stay light. */
function ReceiptImage({ expenseId }: { expenseId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<{ receipt: { data: string } | null }>(`/api/expenses/${expenseId}`)
      .then((res) => {
        if (!alive) return;
        if (res.receipt?.data) setSrc(res.receipt.data);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [expenseId]);

  if (failed) return <p className="muted text-sm">No receipt attached.</p>;
  if (!src) return <p className="muted text-sm">Loading receipt…</p>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="Expense receipt" className="max-h-[50vh] w-full rounded-lg border border-ink-200 object-contain dark:border-ink-700" />;
}
