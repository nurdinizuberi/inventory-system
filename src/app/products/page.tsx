'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import { currency } from '@/lib/utils';

interface Product {
  id: string;
  name: string;
  description: string | null;
  basePrice: number;
  costPrice: number;
  optionNames: string | null;
  category: { id: string; name: string } | null;
  variants: {
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
  }[];
}

interface Category {
  id: string;
  name: string;
}

const EMPTY_FORM = {
  name: '',
  description: '',
  basePrice: 0,
  costPrice: 0,
  categoryId: '',
  optionNames: 'Size,Color',
};

export default function ProductsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [variantDrafts, setVariantDrafts] = useState<{ label: string; cost: string; price: string }[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [productData, categoryData] = await Promise.all([
        api.get<{ products: Product[] }>('/api/products'),
        api.get<{ categories: Category[] }>('/api/categories'),
      ]);
      setProducts(productData.products);
      setCategories(categoryData.categories);
    } catch (err) {
      toast.push('error', errorMessage(err));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const optionNames = form.optionNames.split(',').map((s) => s.trim()).filter(Boolean);

  const create = async () => {
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
          };
        });

      await api.post('/api/products', {
        ...form,
        basePrice: Number(form.basePrice),
        costPrice: Number(form.costPrice),
        categoryId: form.categoryId || null,
        optionNames,
        variants,
      });
      toast.push('success', 'Product created with its variants.');
      setOpen(false);
      setForm(EMPTY_FORM);
      setVariantDrafts([]);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.variants.some((v) => v.sku.toLowerCase().includes(q) || v.barcode.includes(q)),
    );
  }, [products, query]);

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

      <Card>
        <div className="mb-4">
          <input
            className="input max-w-md"
            placeholder="Search by product, SKU or barcode…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {filtered.length === 0 ? (
          <Empty message="No products yet." />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th className="text-right">Base price</th>
                  <th className="text-right">Variants</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => (
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
                      <td className="text-right tabular-nums">{product.variants.length}</td>
                      <td className="text-right">
                        {can('product.delete') && (
                          <button className="btn-ghost btn-sm" onClick={() => archive(product)} type="button">
                            Archive
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded === product.id && (
                      <tr>
                        <td colSpan={5} className="bg-ink-50 dark:bg-ink-800/50">
                          <table className="table">
                            <thead>
                              <tr>
                                <th>Variant</th>
                                <th>SKU</th>
                                <th>Barcode</th>
                                <th className="text-right">Cost</th>
                                <th className="text-right">Price</th>
                                <th className="text-right">Low at</th>
                              </tr>
                            </thead>
                            <tbody>
                              {product.variants.map((variant) => (
                                <tr key={variant.id}>
                                  <td>
                                    {variant.label}
                                    {variant.isDefault && <Badge tone="blue"> default</Badge>}
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
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Modal
        open={open}
        title="New product"
        wide
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} type="button">
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || !form.name} onClick={create} type="button">
              {busy ? 'Creating…' : 'Create product'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Category">
              <select
                className="input"
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
            </Field>
            <Field label="Default selling price">
              <input
                className="input"
                type="number"
                value={form.basePrice}
                onChange={(e) => setForm({ ...form, basePrice: Number(e.target.value) })}
              />
            </Field>
            <Field label="Default cost price">
              <input
                className="input"
                type="number"
                value={form.costPrice}
                onChange={(e) => setForm({ ...form, costPrice: Number(e.target.value) })}
              />
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

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">Variants</span>
              <button
                className="btn-secondary btn-sm"
                onClick={() => setVariantDrafts([...variantDrafts, { label: '', cost: '', price: '' }])}
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
                <div key={index} className="grid grid-cols-[1fr_7rem_7rem_auto] gap-2">
                  <input
                    className="input"
                    placeholder={optionNames.join(' / ') || 'Standard'}
                    value={draft.label}
                    onChange={(e) =>
                      setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, label: e.target.value } : d)))
                    }
                  />
                  <input
                    className="input"
                    placeholder="cost"
                    type="number"
                    value={draft.cost}
                    onChange={(e) =>
                      setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, cost: e.target.value } : d)))
                    }
                  />
                  <input
                    className="input"
                    placeholder="price"
                    type="number"
                    value={draft.price}
                    onChange={(e) =>
                      setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, price: e.target.value } : d)))
                    }
                  />
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => setVariantDrafts(variantDrafts.filter((_, i) => i !== index))}
                    type="button"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </Shell>
  );
}
