'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Card, Empty, Field, Modal, TableWrap } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';

interface Supplier {
  id: string;
  code: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  taxId: string | null;
  address: string | null;
  _count: { purchases: number };
}

const EMPTY = { code: '', name: '', contactPerson: '', email: '', phone: '', taxId: '', address: '' };

export default function SuppliersPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<Supplier | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ suppliers: Supplier[] }>('/api/suppliers');
      setSuppliers(data.suppliers);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`/api/suppliers/${editing.id}`, {
          name: form.name,
          contactPerson: form.contactPerson || null,
          email: form.email || null,
          phone: form.phone || null,
          taxId: form.taxId || null,
          address: form.address || null,
        });
        toast.push('success', 'Supplier updated.');
      } else {
        await api.post('/api/suppliers', {
          ...form,
          code: form.code || undefined,
          contactPerson: form.contactPerson || null,
          email: form.email || null,
          phone: form.phone || null,
          taxId: form.taxId || null,
          address: form.address || null,
        });
        toast.push('success', 'Supplier created.');
      }
      setOpen(false);
      setEditing(null);
      setForm(EMPTY);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <PageHeader
        title="Suppliers"
        description="Who goods are bought from. Every purchase order links to one."
        action={
          can('supplier.manage') && (
            <button
              className="btn-primary"
              onClick={() => {
                setEditing(null);
                setForm(EMPTY);
                setOpen(true);
              }}
              type="button"
            >
              New supplier
            </button>
          )
        }
      />

      <Card>
        {suppliers.length === 0 ? (
          <Empty message="No suppliers yet." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Contact</th>
                  <th>Email / phone</th>
                  <th>Tax ID</th>
                  <th className="text-right">Purchases</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {suppliers.map((supplier) => (
                  <tr key={supplier.id}>
                    <td className="font-mono font-medium">{supplier.code}</td>
                    <td>
                      {supplier.name}
                      {supplier.address && <p className="text-xs text-ink-500 dark:text-ink-400">{supplier.address}</p>}
                    </td>
                    <td className="text-ink-600 dark:text-ink-300">{supplier.contactPerson ?? '—'}</td>
                    <td className="text-ink-600 dark:text-ink-300">
                      {supplier.email ?? '—'}
                      {supplier.phone && <span className="block text-xs text-ink-500 dark:text-ink-400">{supplier.phone}</span>}
                    </td>
                    <td className="font-mono text-xs text-ink-600 dark:text-ink-300">{supplier.taxId ?? '—'}</td>
                    <td className="text-right tabular-nums">{supplier._count.purchases}</td>
                    <td className="text-right">
                      {can('supplier.manage') && (
                        <button
                          className="btn-secondary btn-sm"
                          onClick={() => {
                            setEditing(supplier);
                            setForm({
                              code: supplier.code,
                              name: supplier.name,
                              contactPerson: supplier.contactPerson ?? '',
                              email: supplier.email ?? '',
                              phone: supplier.phone ?? '',
                              taxId: supplier.taxId ?? '',
                              address: supplier.address ?? '',
                            });
                            setOpen(true);
                          }}
                          type="button"
                        >
                          Edit
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
        title={editing ? `Edit ${editing.name}` : 'New supplier'}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || !form.name} onClick={submit} type="button">
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create supplier'}
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" hint="Auto-generated if blank">
            <input
              className="input font-mono"
              value={form.code}
              disabled={Boolean(editing)}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </Field>
          <Field label="Name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Contact person">
            <input className="input" value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} />
          </Field>
          <Field label="Tax ID">
            <input className="input" value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} />
          </Field>
          <Field label="Email">
            <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </Shell>
  );
}
