'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { currency } from '@/lib/utils';

interface Variant {
  id: string;
  label: string;
  sku: string;
  barcode: string;
  costPrice: number | null;
  sellingPrice: number | null;
  lowStockThreshold: number;
  attributes: string;
  isDefault: boolean;
  isActive: boolean;
  onHand?: number;
  sellable?: number;
  reserved?: number;
  stock?: { locationId: string; onHand: number; sellable: number; reserved: number }[];
}

interface Product {
  id: string;
  name: string;
  description: string | null;
  basePrice: number;
  costPrice: number;
  optionNames: string | null;
  isActive: boolean;
  category: { id: string; name: string } | null;
  variants: Variant[];
  totalOnHand?: number;
}

interface Category {
  id: string;
  name: string;
  productCount?: number;
  children?: { id: string }[];
}

interface Location {
  id: string;
  name: string;
  type: string;
  canReceivePurchase: boolean;
}

const EMPTY_FORM = {
  name: '',
  description: '',
  basePrice: '',
  costPrice: '',
  categoryId: '',
  optionNames: 'Size,Color',
  openingQuantity: 0,
  openingLocationId: '',
};

const EMPTY_VARIANT = { label: '', cost: '', price: '', lowStock: 10, quantity: 0, locationId: '' };

interface VariantEdit {
  id: string;
  label: string;
  sku: string;
  barcode: string;
  cost: string;
  price: string;
  lowStock: number;
  isActive: boolean;
}

export default function ProductsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [variantDrafts, setVariantDrafts] = useState<typeof EMPTY_VARIANT[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const [view, setView] = useState<'active' | 'archived'>('active');

  // Edit state
  const [editing, setEditing] = useState<Product | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editVariants, setEditVariants] = useState<VariantEdit[]>([]);

  // Category management
  const [catOpen, setCatOpen] = useState(false);
  const [catName, setCatName] = useState('');
  const [catBusy, setCatBusy] = useState(false);
  const [editingCat, setEditingCat] = useState<Category | null>(null);
  const [catEditName, setCatEditName] = useState('');

  const reqSeq = useRef(0);

  const load = useCallback(
    async (targetView: 'active' | 'archived' = view) => {
      const seq = ++reqSeq.current;
      setLoading(true);
      try {
        const [productData, categoryData, locationData] = await Promise.all([
          api.get<{ products: Product[] }>(`/api/products?status=${targetView}`),
          api.get<{ categories: Category[] }>('/api/categories'),
          api.get<{ locations: Location[] }>('/api/locations'),
        ]);
        if (seq !== reqSeq.current) return;
        setProducts(productData.products);
        setCategories(categoryData.categories);
        setLocations(locationData.locations);
      } catch (err) {
        if (seq !== reqSeq.current) return;
        toast.push('error', errorMessage(err));
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [toast, view],
  );

  useEffect(() => {
    setExpanded(null);
    setQuery('');
    setProducts([]);
    void load(view);
  }, [view, load]);

  const optionNames = form.optionNames.split(',').map((s) => s.trim()).filter(Boolean);
  const isSimpleProduct = variantDrafts.length === 0;

  // ---- Form validation --------------------------------------------------
  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = 'Product name is required.';
    if (Number(form.basePrice) < 0) errors.basePrice = 'Price cannot be negative.';
    if (Number(form.costPrice) < 0) errors.costPrice = 'Cost cannot be negative.';
    if (isSimpleProduct && form.openingQuantity < 0) {
      errors.openingQuantity = 'Quantity cannot be negative.';
    }
    if (isSimpleProduct && form.openingQuantity > 0 && !form.openingLocationId) {
      errors.openingQuantity = 'Choose a location for opening stock.';
    }
    for (let i = 0; i < variantDrafts.length; i++) {
      const v = variantDrafts[i];
      if (v.label.trim() === '' && v.quantity > 0) {
        errors[`variant_${i}_label`] = 'Label required when setting quantity.';
      }
      if (v.quantity > 0 && !v.locationId) {
        errors[`variant_${i}_location`] = 'Choose a location for this variant.';
      }
    }
    return errors;
  };

  const hasErrors = useMemo(() => Object.keys(validate()).length > 0, [form, variantDrafts]);

  const create = async () => {
    const errors = validate();
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    try {
      const variants = variantDrafts
        .filter((v) => v.label.trim())
        .map((v) => {
          const attributes: Record<string, string> = {};
          v.label.split('/').forEach((part, index) => {
            const name = optionNames[index] ?? `Option ${index + 1}`;
            attributes[name] = part.trim();
          });
          return {
            label: v.label.trim(),
            attributes,
            costPrice: v.cost ? Number(v.cost) : null,
            sellingPrice: v.price ? Number(v.price) : null,
            lowStockThreshold: Number(v.lowStock) || 10,
            quantity: v.quantity > 0 ? v.quantity : undefined,
            locationId: v.locationId || undefined,
          };
        });

      await api.post('/api/products', {
        ...form,
        basePrice: Number(form.basePrice || 0),
        costPrice: Number(form.costPrice || 0),
        categoryId: form.categoryId || null,
        optionNames,
        variants,
        openingQuantity: isSimpleProduct && form.openingQuantity > 0 ? form.openingQuantity : undefined,
        openingLocationId: isSimpleProduct && form.openingQuantity > 0 ? form.openingLocationId : undefined,
      });
      toast.push('success', 'Product created with its variants.');
      setOpen(false);
      setForm(EMPTY_FORM);
      setVariantDrafts([]);
      setFormErrors({});
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (product: Product) => {
    try {
      await api.patch(`/api/products/${product.id}`, { isActive: false });
      toast.push('info', `${product.name} archived (ledger preserved).`);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  const restore = async (product: Product) => {
    try {
      await api.patch(`/api/products/${product.id}`, { isActive: true });
      toast.push('success', `${product.name} restored.`);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  const deleteProduct = async (product: Product) => {
    const confirmed = window.confirm(
      `Permanently delete "${product.name}"?\n\nThis cannot be undone and will remove its variants and full stock ledger (batches, movements, history).`,
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.del(`/api/products/${product.id}`);
      toast.push('info', `${product.name} permanently deleted.`);
      setExpanded(null);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // ----- Edit -------------------------------------------------------------

  const openEdit = (product: Product) => {
    setEditing(product);
    setEditForm({
      name: product.name,
      description: product.description ?? '',
      basePrice: product.basePrice ? String(product.basePrice) : '',
      costPrice: product.costPrice ? String(product.costPrice) : '',
      categoryId: product.category?.id ?? '',
      optionNames: product.optionNames ?? '',
      openingQuantity: 0,
      openingLocationId: '',
    });
    setEditVariants(
      product.variants.map((v) => ({
        id: v.id,
        label: v.label,
        sku: v.sku,
        barcode: v.barcode,
        cost: v.costPrice != null ? String(v.costPrice) : '',
        price: v.sellingPrice != null ? String(v.sellingPrice) : '',
        lowStock: v.lowStockThreshold,
        isActive: v.isActive,
      })),
    );
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editForm.name.trim()) {
      toast.push('error', 'Product name is required.');
      return;
    }
    if (Number(editForm.basePrice) < 0 || Number(editForm.costPrice) < 0) {
      toast.push('error', 'Prices cannot be negative.');
      return;
    }
    setBusy(true);
    try {
      const newOptionNames = editForm.optionNames.split(',').map((s) => s.trim()).filter(Boolean);

      await api.patch(`/api/products/${editing.id}`, {
        name: editForm.name,
        description: editForm.description || null,
        basePrice: Number(editForm.basePrice || 0),
        costPrice: Number(editForm.costPrice || 0),
        categoryId: editForm.categoryId || null,
        optionNames: newOptionNames,
      });

      if (can('variant.update')) {
        for (const v of editVariants) {
          await api.patch(`/api/variants/${v.id}`, {
            label: v.label,
            sku: v.sku,
            barcode: v.barcode,
            costPrice: v.cost !== '' ? Number(v.cost) : null,
            sellingPrice: v.price !== '' ? Number(v.price) : null,
            lowStockThreshold: Number(v.lowStock) || 10,
          });
        }
      }

      toast.push('success', 'Product updated.');
      setEditing(null);
      await load();
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const setVariant = (id: string, patch: Partial<VariantEdit>) => {
    setEditVariants((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  };

  // ----- Category management ------------------------------------------------

  const addCategory = async () => {
    setCatBusy(true);
    try {
      await api.post('/api/categories', { name: catName.trim() });
      toast.push('success', `Category "${catName.trim()}" created.`);
      setCatName('');
      const data = await api.get<{ categories: Category[] }>('/api/categories');
      setCategories(data.categories);
      setOpen(true);
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setCatBusy(false);
    }
  };

  const saveCategory = async () => {
    if (!editingCat) return;
    setCatBusy(true);
    try {
      await api.patch(`/api/categories/${editingCat.id}`, { name: catEditName.trim() });
      toast.push('success', 'Category updated.');
      setEditingCat(null);
      const data = await api.get<{ categories: Category[] }>('/api/categories');
      setCategories(data.categories);
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setCatBusy(false);
    }
  };

  const deleteCategory = async (category: Category) => {
    try {
      await api.del(`/api/categories/${category.id}`);
      toast.push('success', `Category "${category.name}" deleted.`);
      const data = await api.get<{ categories: Category[] }>('/api/categories');
      setCategories(data.categories);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  };

  // Quick inline create from a small prompt — reuses the category modal flow.
  const [quickCat, setQuickCat] = useState(false);
  const quickAddCategory = async () => {
    setCatBusy(true);
    try {
      const data = await api.post<{ category: Category }>('/api/categories', { name: catName.trim() });
      toast.push('success', `Category "${catName.trim()}" created.`);
      setForm({ ...form, categoryId: data.category.id });
      const catData = await api.get<{ categories: Category[] }>('/api/categories');
      setCategories(catData.categories);
      setCatName('');
      setQuickCat(false);
    } catch (err) {
      toast.push('error', errorMessage(err));
    } finally {
      setCatBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.variants.some((v) => v.sku.toLowerCase().includes(q) || v.barcode.includes(q)),
    );
  }, [products, query]);

  const canManageCatalog = can('product.create') || can('product.update');

  const warehouseLocations = locations.filter((l) => l.canReceivePurchase || l.type === 'WAREHOUSE');

  const isSimpleProductDisplay = (p: Product) => {
    const active = p.variants.filter((v) => v.isActive);
    return active.length === 1 && active[0].isDefault && active[0].label === 'Standard';
  };

  return (
    <Shell>
      <PageHeader
        title="Products & variants"
        description="Products are catalogue entries. Every variant is a stockable unit with its own SKU, barcode, cost and price."
        action={
          can('product.create') && (
            <button className="btn-primary" onClick={() => setOpen(true)} type="button">
              New product
            </button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            className={`btn btn-sm ${view === 'active' ? 'btn-primary' : 'btn-secondary'}`}
            disabled={loading && view !== 'active'}
            onClick={() => setView('active')}
            type="button"
          >
            Active
          </button>
          <button
            className={`btn btn-sm ${view === 'archived' ? 'btn-primary' : 'btn-secondary'}`}
            disabled={loading && view !== 'archived'}
            onClick={() => setView('archived')}
            type="button"
          >
            Archived
          </button>
          {canManageCatalog && (
            <button
              className="btn-secondary btn-sm"
              onClick={() => setCatOpen(true)}
              type="button"
            >
              Manage categories
            </button>
          )}
        </div>
        <input
          className="input max-w-md"
          placeholder="Search by product, SKU or barcode…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <Card>
        {loading && filtered.length === 0 ? (
          <Empty message="Loading…" />
        ) : filtered.length === 0 ? (
          <Empty message={view === 'archived' ? 'No archived products.' : 'No products yet.'} />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th className="text-right">Base price</th>
                  <th className="text-right">{view === 'active' ? 'Quantity' : 'Variants'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => {
                  const simple = isSimpleProductDisplay(product);
                  return (
                    <Fragment key={product.id}>
                      <tr>
                        <td>
                          <button
                            className="text-left font-medium text-ink-900 hover:underline dark:text-ink-100"
                            onClick={() => setExpanded(expanded === product.id ? null : product.id)}
                            type="button"
                          >
                            {expanded === product.id ? '▾ ' : '▸ '}
                            {product.name}
                          </button>
                          {product.description && <p className="text-xs text-ink-500 dark:text-ink-400">{product.description}</p>}
                        </td>
                        <td className="text-ink-600 dark:text-ink-300">{product.category?.name ?? '—'}</td>
                        <td className="text-right tabular-nums">{currency(product.basePrice)}</td>
                        <td className="text-right tabular-nums">
                          {simple ? (
                            <Badge tone={product.totalOnHand && product.totalOnHand > 0 ? 'green' : 'neutral'}>
                              {product.totalOnHand ?? 0}
                            </Badge>
                          ) : (
                            <span>
                              <Badge tone="blue">{product.variants.length}</Badge>
                              <span className="ml-1.5 tabular-nums text-ink-500 dark:text-ink-400">
                                ({product.totalOnHand ?? 0} on hand)
                              </span>
                            </span>
                          )}
                        </td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {view === 'active' && can('product.update') && (
                              <button className="btn-ghost btn-sm" onClick={() => openEdit(product)} type="button">
                                Edit
                              </button>
                            )}
                            {can('product.delete') && view === 'active' && (
                              <button className="btn-ghost btn-sm" onClick={() => archive(product)} type="button">
                                Archive
                              </button>
                            )}
                            {can('product.update') && view === 'archived' && (
                              <button className="btn-ghost btn-sm" onClick={() => restore(product)} type="button">
                                Restore
                              </button>
                            )}
                            {can('product.delete') && view === 'archived' && (
                              <button
                                className="btn-ghost btn-sm text-red-600 dark:text-red-400"
                                onClick={() => void deleteProduct(product)}
                                type="button"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expanded === product.id && (
                        <tr>
                          <td colSpan={5} className="bg-ink-50 dark:bg-ink-800/50">
                            <div className="space-y-3 p-3">
                              <table className="table">
                                <thead>
                                  <tr>
                                    <th>Variant</th>
                                    <th>SKU</th>
                                    <th>Barcode</th>
                                    <th className="text-right">Cost</th>
                                    <th className="text-right">Price</th>
                                    <th className="text-right">Low at</th>
                                    <th className="text-right">On hand</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {product.variants.map((variant) => (
                                    <tr key={variant.id}>
                                      <td>
                                        {variant.label}
                                        {variant.isDefault && <Badge tone="blue"> default</Badge>}
                                        {!variant.isActive && <Badge tone="red"> archived</Badge>}
                                      </td>
                                      <td className="font-mono text-xs">{variant.sku}</td>
                                      <td className="font-mono text-xs text-ink-500 dark:text-ink-400">{variant.barcode}</td>
                                      <td className="text-right tabular-nums">
                                        {currency(variant.costPrice ?? product.costPrice)}
                                      </td>
                                      <td className="text-right tabular-nums">
                                        {currency(variant.sellingPrice ?? product.basePrice)}
                                      </td>
                                      <td className="text-right tabular-nums text-ink-500 dark:text-ink-400">{variant.lowStockThreshold}</td>
                                      <td className="text-right tabular-nums">
                                        <span className="tabular-nums">
                                          <Badge tone={variant.onHand && variant.onHand > 0 ? 'green' : 'neutral'}>{variant.onHand ?? 0}</Badge>
                                          {variant.reserved ? <span className="ml-1 text-xs text-ink-400">res {variant.reserved}</span> : null}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {product.variants.some((v) => (v.stock?.length ?? 0) > 0) && (
                                <div className="grid gap-2 sm:grid-cols-2">
                                  {product.variants.flatMap((v) =>
                                    (v.stock ?? []).map((row) => (
                                      <div
                                        key={`${v.id}-${row.locationId}`}
                                        className="flex items-center justify-between rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs dark:border-ink-700 dark:bg-ink-900/40"
                                      >
                                        <span className="text-ink-600 dark:text-ink-300">{v.label}: location {row.locationId.slice(-6)}</span>
                                        <span className="font-medium tabular-nums">
                                          {row.onHand} <span className="text-ink-400">(sell {row.sellable})</span>
                                        </span>
                                      </div>
                                    )),
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {/* New product modal */}
      <Modal
        open={open}
        title="New product"
        wide
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => { setOpen(false); setFormErrors({}); }} type="button">
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || !form.name.trim()} onClick={create} type="button">
              {busy ? 'Creating…' : 'Create product'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input className="input" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setFormErrors({ ...formErrors, name: '' }); }} />
              {formErrors.name && <p className="mt-1 text-xs text-red-500">{formErrors.name}</p>}
            </Field>
            <Field label="Category">
              <div className="flex gap-2">
                <select
                  className="input flex-1"
                  value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                >
                  <option value="">— none —</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-secondary btn-sm shrink-0"
                  onClick={() => {
                    setCatName('');
                    setQuickCat(!quickCat);
                  }}
                  type="button"
                >
                  + New
                </button>
              </div>
              {quickCat && (
                <div className="mt-1 flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder="Category name"
                    value={catName}
                    onChange={(e) => setCatName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void quickAddCategory();
                    }}
                  />
                  <button className="btn-primary btn-sm shrink-0" disabled={catBusy || !catName.trim()} onClick={() => void quickAddCategory()} type="button">
                    Add
                  </button>
                </div>
              )}
            </Field>
            <Field label="Default selling price">
              <input
                className="input"
                inputMode="decimal"
                type="number"
                value={form.basePrice}
                placeholder="0"
                onChange={(e) => setForm({ ...form, basePrice: e.target.value })}
              />
              {formErrors.basePrice && <p className="mt-1 text-xs text-red-500">{formErrors.basePrice}</p>}
            </Field>
            <Field label="Default cost price">
              <input
                className="input"
                inputMode="decimal"
                type="number"
                value={form.costPrice}
                placeholder="0"
                onChange={(e) => setForm({ ...form, costPrice: e.target.value })}
              />
              {formErrors.costPrice && <p className="mt-1 text-xs text-red-500">{formErrors.costPrice}</p>}
            </Field>
            <Field label="Option names" hint="Comma separated, e.g. Size,Color" className="sm:col-span-2">
              <input
                className="input"
                value={form.optionNames}
                onChange={(e) => setForm({ ...form, optionNames: e.target.value })}
              />
            </Field>
            <Field label="Description" className="sm:col-span-2">
              <textarea
                className="input"
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>
          </div>

          {/* Opening stock for simple products (no explicit variants) */}
          {isSimpleProduct && (
            <div className="rounded-lg border border-ink-200 p-3 dark:border-ink-700">
              <p className="label mb-2">Starting stock (optional)</p>
              <p className="mb-2 text-xs text-ink-500 dark:text-ink-400">
                Enter a starting quantity to open initial stock. This creates an opening batch so the product is immediately available.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Quantity">
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={form.openingQuantity}
                    onChange={(e) => { setForm({ ...form, openingQuantity: Number(e.target.value) }); setFormErrors({ ...formErrors, openingQuantity: '' }); }}
                  />
                  {formErrors.openingQuantity && <p className="mt-1 text-xs text-red-500">{formErrors.openingQuantity}</p>}
                </Field>
                <Field label="Location">
                  <select
                    className="input"
                    value={form.openingLocationId}
                    onChange={(e) => setForm({ ...form, openingLocationId: e.target.value })}
                  >
                    <option value="">— choose —</option>
                    {warehouseLocations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">Variants</span>
              <button
                className="btn-secondary btn-sm"
                onClick={() => setVariantDrafts([...variantDrafts, { ...EMPTY_VARIANT }])}
                type="button"
              >
                Add variant
              </button>
            </div>
            <p className="mb-2 text-xs text-ink-500 dark:text-ink-400">
              Leave the list empty and a default variant is created automatically — SKUs and EAN-13 barcodes are
              generated for you. Enter a variant label as “{optionNames.join(' / ') || 'Standard'}”.
            </p>
            <div className="space-y-2">
              {variantDrafts.map((draft, index) => (
                <div key={index} className="grid grid-cols-[1fr_5rem_5rem_5rem_5rem_auto] gap-2">
                  <input
                    className="input"
                    placeholder={optionNames.join(' / ') || 'Standard'}
                    value={draft.label}
                    onChange={(e) => setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, label: e.target.value } : d)))}
                  />
                  <input className="input" placeholder="cost" type="number" value={draft.cost}
                    onChange={(e) => setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, cost: e.target.value } : d)))} />
                  <input className="input" placeholder="price" type="number" value={draft.price}
                    onChange={(e) => setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, price: e.target.value } : d)))} />
                  <input className="input" placeholder="qty" type="number" min={0} value={draft.quantity || ''}
                    onChange={(e) => setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, quantity: Number(e.target.value), locationId: Number(e.target.value) > 0 && !d.locationId ? (warehouseLocations[0]?.id ?? '') : d.locationId } : d)))} />
                  <button className="btn-ghost btn-sm"
                    onClick={() => setVariantDrafts(variantDrafts.filter((_, i) => i !== index))} type="button">✕</button>
                  {formErrors[`variant_${index}_label`] && (
                    <p className="col-span-6 text-xs text-red-500">{formErrors[`variant_${index}_label`]}</p>
                  )}
                  {draft.quantity > 0 && (
                    <div className="col-span-6 flex gap-2">
                      <select className="input" value={draft.locationId}
                        onChange={(e) => setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, locationId: e.target.value } : d)))}>
                        <option value="">— location —</option>
                        {warehouseLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                      {formErrors[`variant_${index}_location`] && (
                        <p className="text-xs text-red-500">{formErrors[`variant_${index}_location`]}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* Edit product modal */}
      <Modal
        open={!!editing}
        title="Edit product"
        wide
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEditing(null)} type="button">
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || !editForm.name.trim()} onClick={() => void saveEdit()} type="button">
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input className="input" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
              {!editForm.name.trim() && <p className="mt-1 text-xs text-red-500">Product name is required.</p>}
            </Field>
            <Field label="Category">
              <select
                className="input"
                value={editForm.categoryId}
                onChange={(e) => setEditForm({ ...editForm, categoryId: e.target.value })}
              >
                <option value="">— none —</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Default selling price">
              <input
                className="input"
                inputMode="decimal"
                type="number"
                value={editForm.basePrice}
                placeholder="0"
                onChange={(e) => setEditForm({ ...editForm, basePrice: e.target.value })}
              />
            </Field>
            <Field label="Default cost price">
              <input
                className="input"
                inputMode="decimal"
                type="number"
                value={editForm.costPrice}
                placeholder="0"
                onChange={(e) => setEditForm({ ...editForm, costPrice: e.target.value })}
              />
            </Field>
            <Field label="Option names" hint="Comma separated, e.g. Size,Color" className="sm:col-span-2">
              <input
                className="input"
                value={editForm.optionNames}
                onChange={(e) => setEditForm({ ...editForm, optionNames: e.target.value })}
              />
            </Field>
            <Field label="Description" className="sm:col-span-2">
              <textarea
                className="input"
                rows={2}
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">Variants</span>
              {!can('variant.update') && (
                <span className="text-xs text-ink-400">You don’t have variant.edit permission — product fields only.</span>
              )}
            </div>
            {can('variant.update') ? (
              <div className="space-y-3">
                {editVariants.map((v) => (
                  <div key={v.id} className="space-y-2 rounded-lg border border-ink-200 p-3 dark:border-ink-700">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      <Field label="Label">
                        <input className="input" value={v.label} onChange={(e) => setVariant(v.id, { label: e.target.value })} />
                        {!v.label.trim() && <p className="mt-1 text-xs text-red-500">Label is required.</p>}
                      </Field>
                      <Field label="SKU">
                        <input className="input" value={v.sku} onChange={(e) => setVariant(v.id, { sku: e.target.value })} />
                        {!v.sku.trim() && <p className="mt-1 text-xs text-red-500">SKU is required.</p>}
                      </Field>
                      <Field label="Barcode">
                        <input className="input" value={v.barcode} onChange={(e) => setVariant(v.id, { barcode: e.target.value })} />
                        {!v.barcode.trim() && <p className="mt-1 text-xs text-red-500">Barcode is required.</p>}
                      </Field>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Field label="Cost">
                        <input className="input" type="number" value={v.cost}
                          onChange={(e) => setVariant(v.id, { cost: e.target.value })} />
                      </Field>
                      <Field label="Price">
                        <input className="input" type="number" value={v.price}
                          onChange={(e) => setVariant(v.id, { price: e.target.value })} />
                      </Field>
                      <Field label="Low at">
                        <input className="input" type="number" value={v.lowStock}
                          onChange={(e) => setVariant(v.id, { lowStock: Number(e.target.value) })} />
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-500 dark:text-ink-400">
                {editVariants.map((v) => v.label).join(', ') || 'No variants'}
              </p>
            )}
          </div>
        </div>
      </Modal>

      {/* Manage categories modal */}
      <Modal
        open={catOpen}
        title="Manage categories"
        onClose={() => setCatOpen(false)}
        footer={
          <button className="btn-secondary" onClick={() => setCatOpen(false)} type="button">
            Done
          </button>
        }
      >
        <div className="space-y-4">
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="New category name"
              value={catName}
              onChange={(e) => setCatName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addCategory();
              }}
            />
            <button className="btn-primary" disabled={catBusy || !catName.trim()} onClick={() => void addCategory()} type="button">
              Add
            </button>
          </div>
          {categories.length === 0 ? (
            <Empty message="No categories yet." />
          ) : (
            <div className="space-y-1">
              {categories.map((category) => (
                <div key={category.id} className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 px-3 py-2 dark:border-ink-700">
                  {editingCat?.id === category.id ? (
                    <div className="flex flex-1 items-center gap-2">
                      <input
                        className="input flex-1"
                        value={catEditName}
                        onChange={(e) => setCatEditName(e.target.value)}
                      />
                      <button className="btn-primary btn-sm" disabled={catBusy} onClick={() => void saveCategory()} type="button">
                        Save
                      </button>
                      <button className="btn-ghost btn-sm" onClick={() => setEditingCat(null)} type="button">
                        ✕
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="text-sm font-medium">
                        {category.name}
                        {category.productCount ? (
                          <span className="ml-2 text-xs text-ink-400">{category.productCount} product(s)</span>
                        ) : null}
                      </span>
                      <div className="flex items-center gap-1">
                        {can('product.update') && (
                          <button
                            className="btn-ghost btn-sm"
                            onClick={() => {
                              setEditingCat(category);
                              setCatEditName(category.name);
                            }}
                            type="button"
                          >
                            Edit
                          </button>
                        )}
                        {can('product.delete') && (
                          <button className="btn-ghost btn-sm" onClick={() => void deleteCategory(category)} type="button">
                            Delete
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </Shell>
  );
}
