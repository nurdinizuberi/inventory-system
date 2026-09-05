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
  canSellPos: boolean;
}

/**
 * Locations that may hold opening stock for a new product: any location
 * flagged to receive purchases. Warehouses and retail stores are both flagged
 * by default, so a shop can receive products directly even when the tenant
 * also has a warehouse — no transfer required.
 */
function receivingTargets(locations: Location[]): Location[] {
  return locations.filter((l) => l.canReceivePurchase);
}

const EMPTY_FORM = {
  name: '',
  description: '',
  basePrice: '',
  costPrice: '',
  categoryId: '',
  optionNames: 'Size,Color',
  openingQuantity: '',
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
  lowStock: string;
  isActive: boolean;
  isNew: boolean;
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
  // A product counts as "simple" only while no variant row has been added at
  // all. The moment the user clicks "Add variant" the product becomes a variant
  // product: the parent selling/cost price fields are hidden immediately (each
  // variant will own its own price/cost, pre-filled from the parent defaults).
  const isSimpleProduct = variantDrafts.length === 0;

  // ---- Form validation --------------------------------------------------
  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = 'Product name is required.';
    // A plain product has no variants to carry its price/cost, so its own selling
    // price and cost must be explicit and above 0 — a blank, zero or negative
    // value would silently sell or value stock at 0.
    if (isSimpleProduct && !(Number(form.basePrice) > 0)) {
      errors.basePrice = 'Selling price must be greater than 0.';
    }
    if (isSimpleProduct && !(Number(form.costPrice) > 0)) {
      errors.costPrice = 'Cost must be greater than 0.';
    }
    const oq = Number(form.openingQuantity);
    if (isSimpleProduct && oq < 0) {
      errors.openingQuantity = 'Quantity cannot be negative.';
    }
    if (isSimpleProduct && oq > 0 && !form.openingLocationId) {
      errors.openingQuantity = 'Choose a location for opening stock.';
    }
    for (let i = 0; i < variantDrafts.length; i++) {
      const v = variantDrafts[i];
      if (v.label.trim() === '' && v.quantity > 0) {
        errors[`variant_${i}_label`] = 'Label required when setting quantity.';
      }
      // Every real variant is sold and valued on its own — its selling price and
      // cost must be explicit and above 0 so nothing is ever sold or valued at 0.
      if (v.label.trim() !== '' && !(Number(v.price) > 0)) {
        errors[`variant_${i}_price`] = 'Selling price must be greater than 0.';
      }
      if (v.label.trim() !== '' && !(Number(v.cost) > 0)) {
        errors[`variant_${i}_cost`] = 'Cost must be greater than 0.';
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
        // Only a plain product keeps its price on the product row. Once real
        // variants exist the product-level fields are hidden and each variant
        // owns its price, so nothing is stored at the product level.
        basePrice: isSimpleProduct ? Number(form.basePrice || 0) : 0,
        costPrice: isSimpleProduct ? Number(form.costPrice || 0) : 0,
        categoryId: form.categoryId || null,
        optionNames,
        variants,
        openingQuantity: isSimpleProduct && Number(form.openingQuantity) > 0 ? Number(form.openingQuantity) : undefined,
        openingLocationId: isSimpleProduct && Number(form.openingQuantity) > 0 ? form.openingLocationId : undefined,
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
    const active = product.variants.filter((v) => v.isActive);
    const isSimple = active.length === 1 && active[0].isDefault && active[0].label === 'Standard';
    const defaultVariant = isSimple ? active[0] : undefined;

    setEditForm({
      name: product.name,
      description: product.description ?? '',
      // A plain product keeps a single source of truth on the product row — fold
      // any legacy per-variant price back onto the product so its price is not
      // editable in two places. Its own values are shown verbatim (including 0)
      // so a stored price is never presented as blank.
      basePrice: defaultVariant ? String(defaultVariant.sellingPrice ?? product.basePrice) : product.basePrice ? String(product.basePrice) : '',
      costPrice: defaultVariant ? String(defaultVariant.costPrice ?? product.costPrice) : product.costPrice ? String(product.costPrice) : '',
      categoryId: product.category?.id ?? '',
      optionNames: product.optionNames ?? '',
      openingQuantity: '',
      openingLocationId: '',
    });
    setEditVariants(
      product.variants.map((v) => {
        const pricedOnProduct = isSimple && v.id === defaultVariant?.id;
        return {
          id: v.id,
          label: v.label,
          sku: v.sku,
          barcode: v.barcode,
          // Real variant products: prefill every row with its effective price (its
          // own, else the product default) so no variant silently inherits a hidden
          // product-level price. The default variant of a plain product keeps its
          // own price fields empty (null) — its price lives on the product row.
          cost: pricedOnProduct ? '' : v.costPrice != null ? String(v.costPrice) : product.costPrice ? String(product.costPrice) : '',
          price: pricedOnProduct ? '' : v.sellingPrice != null ? String(v.sellingPrice) : product.basePrice ? String(product.basePrice) : '',
          lowStock: String(v.lowStockThreshold),
          isActive: v.isActive,
          isNew: false,
        };
      }),
    );
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editForm.name.trim()) {
      toast.push('error', 'Product name is required.');
      return;
    }
    // Product-level prices are written only when they are actually used: plain
    // products, or variant products the current user cannot reprice through the
    // variant rows. Once real variants are priced, product-level defaults are
    // cleared so a price is never stored in two places.
    const writeProductPrices = showProductPrices || !variantsEditable;
    if (writeProductPrices && (Number(editForm.basePrice) < 0 || Number(editForm.costPrice) < 0)) {
      toast.push('error', 'Prices cannot be negative.');
      return;
    }
    // Plain products carry their price/cost on the product row, so a selling
    // price or cost of 0 would sell or value stock at 0.
    if (showProductPrices && (!(Number(editForm.basePrice) > 0) || !(Number(editForm.costPrice) > 0))) {
      toast.push('error', 'A plain product needs a selling price and cost greater than 0.');
      return;
    }
    if (editVariants.some((v) => invalidVariantPrice(v) || invalidVariantCost(v))) {
      toast.push('error', 'Every variant needs a selling price and cost greater than 0.');
      return;
    }
    setBusy(true);
    try {
      const newOptionNames = editForm.optionNames.split(',').map((s) => s.trim()).filter(Boolean);

      const updateProduct = () =>
        api.patch(`/api/products/${editing.id}`, {
          name: editForm.name,
          description: editForm.description || null,
          basePrice: writeProductPrices ? Number(editForm.basePrice || 0) : 0,
          costPrice: writeProductPrices ? Number(editForm.costPrice || 0) : 0,
          categoryId: editForm.categoryId || null,
          optionNames: newOptionNames,
        });

      const updateVariants = async () => {
        if (!variantsEditable) return;
        for (const v of editVariants) {
          const payload = {
            label: v.label,
            sku: v.sku,
            barcode: v.barcode,
            costPrice: v.cost !== '' ? Number(v.cost) : null,
            sellingPrice: v.price !== '' ? Number(v.price) : null,
            lowStockThreshold: Number(v.lowStock) || 10,
          };
          if (v.isNew) {
            if (!can('variant.create')) continue;
            const blank = !v.label.trim() && !v.sku.trim() && !v.barcode.trim() && v.cost === '' && v.price === '';
            if (blank) continue;
            await api.post('/api/variants', { productId: editing.id, ...payload });
          } else {
            if (!can('variant.update')) continue;
            await api.patch(`/api/variants/${v.id}`, payload);
          }
        }
      };

      // Order matters because of how the server validates price changes:
      // - Plain products are priced on the product row, so update those defaults
      //   first and let the default variant keep inheriting them.
      // - Variant products own their price on each variant, so price the variants
      //   first, then clear the (now unused) product-level defaults.
      if (showProductPrices) {
        await updateProduct();
        await updateVariants();
      } else {
        await updateVariants();
        await updateProduct();
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

  const addEditVariant = () => {
    setEditVariants((prev) => {
      const next = [
        ...prev,
        {
          id: `new-${Date.now()}`,
          label: '',
          sku: '',
          barcode: '',
          cost: '',
          price: '',
          lowStock: '10',
          isActive: true,
          isNew: true,
        },
      ];
      // Turning a plain product into a variant product: the default 'Standard'
      // variant inherits the product-level price/cost, because those product
      // fields are hidden and cleared as soon as real variants exist.
      if (editing && isSimpleProductDisplay(editing) && !prev.some((v) => v.isNew)) {
        const standard = prev.find((v) => v.isActive && !v.isNew);
        if (standard) {
          const index = prev.indexOf(standard);
          next[index] = {
            ...standard,
            cost: standard.cost || editForm.costPrice,
            price: standard.price || editForm.basePrice,
          };
        }
      }
      return next;
    });
  };

  const removeEditVariant = (id: string) => {
    setEditVariants((prev) => prev.filter((v) => !(v.isNew && v.id === id)));
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

  const openingLocations = receivingTargets(locations);

  const isSimpleProductDisplay = (p: Product) => {
    const active = p.variants.filter((v) => v.isActive);
    return active.length === 1 && active[0].isDefault && active[0].label === 'Standard';
  };

  // The product-level price/cost fields only apply while the product being edited
  // is still a plain product (its single default 'Standard' variant) and no extra
  // variant row has been added. Once real variants exist each variant carries its
  // own price, so the product fields are hidden.
  const activeEditVariants = editVariants.filter((v) => v.isActive || v.isNew);
  const showProductPrices = !!editing && isSimpleProductDisplay(editing) && activeEditVariants.length === 1;

  // A variant product sells and values each variant on its own, so a selling
  // price or cost of 0 (or blank) would sell or value stock at 0. Require both to
  // be greater than 0 on every variant that will be sold — except while the
  // product is still plain (its price/cost live on the product) or when the
  // current user cannot edit variant pricing at all.
  const variantsEditable = can('variant.update') || can('variant.create');
  const variantPricedOnRow = (v: VariantEdit) => {
    if (!variantsEditable || showProductPrices) return false;
    if (!v.isNew && !v.isActive) return false; // archived variants aren't sold
    if (v.isNew) {
      // New rows that are left completely blank are never created — they are
      // fine without a price or cost.
      const blankRow = !v.label.trim() && !v.sku.trim() && !v.barcode.trim() && v.cost === '' && v.price === '';
      if (blankRow) return false;
    }
    return true;
  };
  const invalidVariantPrice = (v: VariantEdit) => variantPricedOnRow(v) && !(Number(v.price) > 0);
  const invalidVariantCost = (v: VariantEdit) => variantPricedOnRow(v) && !(Number(v.cost) > 0);

  // Price shown in the table: the single effective price for a plain product, or
  // a min–max range across active variants once there are real variants.
  const priceSummary = (p: Product) => {
    const prices = p.variants.filter((v) => v.isActive).map((v) => v.sellingPrice ?? p.basePrice);
    if (prices.length === 0) return currency(p.basePrice);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    return min === max ? currency(min) : `${currency(min)} – ${currency(max)}`;
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
                  <th className="text-right">Price</th>
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
                        <td className="text-right tabular-nums">{priceSummary(product)}</td>
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
            {isSimpleProduct && (
              <>
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
              </>
            )}
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
                    placeholder="0"
                    value={form.openingQuantity}
                    onChange={(e) => { setForm({ ...form, openingQuantity: e.target.value }); setFormErrors({ ...formErrors, openingQuantity: '' }); }}
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
                    {openingLocations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.type === 'RETAIL_STORE' ? ' (store)' : ''}
                      </option>
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
                onClick={() =>
                  setVariantDrafts((prev) => [
                    ...prev,
                    // Pre-fill each new row from the product-level defaults (they
                    // are hidden once variants exist) so a shared price/cost only
                    // has to be typed once — each row can still be adjusted
                    // individually.
                    { ...EMPTY_VARIANT, cost: form.costPrice, price: form.basePrice },
                  ])
                }
                type="button"
              >
                Add variant
              </button>
            </div>
            <div className="space-y-2">
              {variantDrafts.map((draft, index) => (
                <div
                  key={index}
                  className="relative rounded-lg border border-ink-200 p-2.5 dark:border-ink-700 sm:rounded-none sm:border-0 sm:p-0"
                >
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-[1fr_5rem_5rem_5rem_auto] sm:items-center sm:gap-3">
                    <input
                      className="input col-span-3 pr-9 sm:col-span-1 sm:pr-0"
                      placeholder={optionNames.join(' / ') || 'Standard'}
                      value={draft.label}
                      onChange={(e) => setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, label: e.target.value } : d)))}
                    />
                    <input className="input" placeholder="cost" type="number" value={draft.cost}
                      onChange={(e) => setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, cost: e.target.value } : d)))} />
                    <input className="input" placeholder="price" type="number" value={draft.price}
                      onChange={(e) => setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, price: e.target.value } : d)))} />
                    <input className="input" placeholder="qty" type="number" min={0} value={draft.quantity || ''}
                      onChange={(e) => setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, quantity: Number(e.target.value), locationId: Number(e.target.value) > 0 && !d.locationId ? (openingLocations[0]?.id ?? '') : d.locationId } : d)))} />
                    <button className="btn-ghost btn-sm absolute right-1 top-1 sm:static"
                      onClick={() => setVariantDrafts(variantDrafts.filter((_, i) => i !== index))} type="button">✕</button>
                  </div>
                  {formErrors[`variant_${index}_label`] && (
                    <p className="mt-1 text-xs text-red-500">{formErrors[`variant_${index}_label`]}</p>
                  )}
                  {formErrors[`variant_${index}_price`] && (
                    <p className="mt-1 text-xs text-red-500">{formErrors[`variant_${index}_price`]}</p>
                  )}
                  {formErrors[`variant_${index}_cost`] && (
                    <p className="mt-1 text-xs text-red-500">{formErrors[`variant_${index}_cost`]}</p>
                  )}
                  {draft.quantity > 0 && (
                    <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                      <select className="input sm:flex-1" value={draft.locationId}
                        onChange={(e) => setVariantDrafts(variantDrafts.map((d, i) => (i === index ? { ...d, locationId: e.target.value } : d)))}>
                        <option value="">— location —</option>
                        {openingLocations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                            {l.type === 'RETAIL_STORE' ? ' (store)' : ''}
                          </option>
                        ))}
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
            {showProductPrices && (
              <>
                <Field label="Default selling price">
                  <input
                    className="input"
                    inputMode="decimal"
                    type="number"
                    value={editForm.basePrice}
                    placeholder="0"
                    onChange={(e) => setEditForm({ ...editForm, basePrice: e.target.value })}
                  />
                  {!(Number(editForm.basePrice) > 0) && (
                    <p className="mt-1 text-xs text-red-500">Selling price must be greater than 0.</p>
                  )}
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
                  {!(Number(editForm.costPrice) > 0) && (
                    <p className="mt-1 text-xs text-red-500">Cost must be greater than 0.</p>
                  )}
                </Field>
              </>
            )}
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
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="label mb-0">Variants</span>
              <div className="flex items-center gap-2">
                {can('variant.create') && (
                  <button
                    className="btn-secondary btn-sm"
                    onClick={addEditVariant}
                    type="button"
                  >
                    + Add variant
                  </button>
                )}
                {!can('variant.update') && !can('variant.create') && (
                  <span className="text-xs text-ink-400">You don’t have variant edit permission — product fields only.</span>
                )}
              </div>
            </div>
            {can('variant.update') || can('variant.create') ? (
              <div className="space-y-3">
                {editVariants.map((v) => (
                  <div key={v.id} className="space-y-2 rounded-lg border border-ink-200 p-3 dark:border-ink-700">
                    {v.isNew && (
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-xs font-medium text-blue-600 dark:text-blue-400">New variant</span>
                        <button className="btn-ghost btn-sm" onClick={() => removeEditVariant(v.id)} type="button">✕ Remove</button>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      <Field label="Label">
                        <input className="input" value={v.label} onChange={(e) => setVariant(v.id, { label: e.target.value })} />
                        {!v.label.trim() && !v.isNew && <p className="mt-1 text-xs text-red-500">Label is required.</p>}
                      </Field>
                      <Field label="SKU">
                        <input className="input" value={v.sku} onChange={(e) => setVariant(v.id, { sku: e.target.value })} />
                        {!v.sku.trim() && !v.isNew && <p className="mt-1 text-xs text-red-500">SKU is required.</p>}
                      </Field>
                      <Field label="Barcode">
                        <input className="input" value={v.barcode} onChange={(e) => setVariant(v.id, { barcode: e.target.value })} />
                        {!v.barcode.trim() && !v.isNew && <p className="mt-1 text-xs text-red-500">Barcode is required.</p>}
                      </Field>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Field
                        label="Cost"
                        hint={showProductPrices && v.isActive && !v.isNew ? 'Set on the product' : undefined}
                      >
                        <input
                          className="input"
                          type="number"
                          inputMode="decimal"
                          value={showProductPrices && v.isActive && !v.isNew ? editForm.costPrice : v.cost}
                          placeholder="0"
                          disabled={showProductPrices && v.isActive && !v.isNew}
                          onChange={(e) => setVariant(v.id, { cost: e.target.value })}
                        />
                        {invalidVariantCost(v) && (
                          <p className="mt-1 text-xs text-red-500">Cost must be greater than 0.</p>
                        )}
                      </Field>
                      <Field
                        label="Price"
                        hint={showProductPrices && v.isActive && !v.isNew ? 'Set on the product' : undefined}
                      >
                        <input
                          className="input"
                          type="number"
                          inputMode="decimal"
                          value={showProductPrices && v.isActive && !v.isNew ? editForm.basePrice : v.price}
                          placeholder="0"
                          disabled={showProductPrices && v.isActive && !v.isNew}
                          onChange={(e) => setVariant(v.id, { price: e.target.value })}
                        />
                        {invalidVariantPrice(v) && (
                          <p className="mt-1 text-xs text-red-500">Selling price must be greater than 0.</p>
                        )}
                      </Field>
                      <Field label="Low at">
                        <input className="input" type="number" min={0} value={v.lowStock} placeholder="0"
                          onChange={(e) => setVariant(v.id, { lowStock: e.target.value })} />
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
