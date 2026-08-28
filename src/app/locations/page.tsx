'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { LOCATION_TYPE_LABELS, type LocationType } from '@/lib/types';

interface Location {
  id: string;
  code: string;
  name: string;
  type: string;
  address: string | null;
  phone: string | null;
  canReceivePurchase: boolean;
  canSellPos: boolean;
  isDamagedLocation: boolean;
  unitsOnHand: number;
  variantsWithStock: number;
  users: { id: string; name: string; role: string }[];
}

const EMPTY = {
  code: '',
  name: '',
  type: 'RETAIL_STORE' as LocationType,
  address: '',
  phone: '',
  canReceivePurchase: false,
  canSellPos: true,
};

export default function LocationsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [locations, setLocations] = useState<Location[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ locations: Location[] }>('/api/locations');
      setLocations(data.locations);
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
      await api.post('/api/locations', {
        ...form,
        address: form.address || null,
        phone: form.phone || null,
      });
      toast.push('success', 'Location created.');
      setOpen(false);
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
        title="Locations"
        description="Warehouses and retail stores share one schema — only the capability flags differ."
        action={
          can('location.manage') && (
            <button className="btn-primary" onClick={() => setOpen(true)} type="button">
              New location
            </button>
          )
        }
      />

      <Card>
        {locations.length === 0 ? (
          <Empty message="No locations yet." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Capabilities</th>
                  <th className="text-right">Units on hand</th>
                  <th className="text-right">Variants</th>
                  <th>Assigned users</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((location) => (
                  <tr key={location.id}>
                    <td className="font-mono font-medium">{location.code}</td>
                    <td>
                      {location.name}
                      {location.address && <p className="text-xs text-ink-500 dark:text-ink-400">{location.address}</p>}
                    </td>
                    <td>
                      <Badge tone={location.type === 'WAREHOUSE' ? 'blue' : location.type === 'RETAIL_STORE' ? 'green' : 'red'}>
                        {LOCATION_TYPE_LABELS[location.type as LocationType] ?? location.type}
                      </Badge>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {location.canReceivePurchase && <Badge tone="blue">receives purchases</Badge>}
                        {location.canSellPos && <Badge tone="green">POS enabled</Badge>}
                        {location.isDamagedLocation && <Badge tone="red">write-off</Badge>}
                        {!location.canReceivePurchase && !location.canSellPos && !location.isDamagedLocation && (
                          <Badge>storage only</Badge>
                        )}
                      </div>
                    </td>
                    <td className="text-right tabular-nums">{location.unitsOnHand.toLocaleString()}</td>
                    <td className="text-right tabular-nums">{location.variantsWithStock}</td>
                    <td className="text-xs text-ink-600 dark:text-ink-300">
                      {location.users.length
                        ? location.users.map((u) => `${u.name} (${u.role})`).join(', ')
                        : '—'}
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
        title="New location"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || !form.code || !form.name} onClick={submit} type="button">
              {busy ? 'Saving…' : 'Create location'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code">
              <input className="input font-mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
            <Field label="Type">
              <select
                className="input"
                value={form.type}
                onChange={(e) => {
                  const type = e.target.value as LocationType;
                  setForm({
                    ...form,
                    type,
                    canReceivePurchase: type === 'WAREHOUSE',
                    canSellPos: type === 'RETAIL_STORE',
                  });
                }}
              >
                <option value="WAREHOUSE">Warehouse</option>
                <option value="RETAIL_STORE">Retail store</option>
                <option value="DAMAGED">Damaged / write-off</option>
              </select>
            </Field>
          </div>
          <Field label="Name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Address">
            <input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
          <Field label="Phone">
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.canReceivePurchase}
                onChange={(e) => setForm({ ...form, canReceivePurchase: e.target.checked })}
              />
              Can receive purchases
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.canSellPos} onChange={(e) => setForm({ ...form, canSellPos: e.target.checked })} />
              Can sell at POS
            </label>
          </div>
        </div>
      </Modal>
    </Shell>
  );
}
