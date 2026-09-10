'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shell, PageHeader } from '@/components/shell';
import { Badge, Card, Empty, Field, Modal, TableWrap } from '@/components/ui';
import { useAuth } from '@/components/auth-context';
import { useToast } from '@/components/toast';
import { api, errorMessage } from '@/lib/client';
import {
  PRODUCT_EDIT_MODE_LABELS,
  RECOUNT_REASONS,
  RECOUNT_REASON_LABELS,
  type ProductEditMode,
  type RecountReason,
} from '@/lib/types';
import { currency, escapeHtml } from '@/lib/utils';

interface BatchInfo {
  code: string;
  unitCost: number;
  remainingQty: number;
  receivedAt: string;
  locationName: string;
}

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
  /** Signed quantity delta for existing variants ('' = unchanged). */
  qty: string;
  /** Location a qty change applies to. */
  locationId: string;
  /** Total units on hand (used to sanity-check a deduction). */
  onHand: number;
  /** Per-location stock rows (drive per-location recount lines). */
  stock: { locationId: string; onHand: number; sellable: number; reserved: number }[];
  /** Cost the row opened with, so we can detect a revaluation. */
  origCost: number | null;
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
  const [editMode, setEditMode] = useState<ProductEditMode | null>(null);
  // Mode picked on the selection screen but not confirmed with [Continue] yet.
  const [modeDraft, setModeDraft] = useState<ProductEditMode | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editVariants, setEditVariants] = useState<VariantEdit[]>([]);
  const [editBatches, setEditBatches] = useState<Map<string, BatchInfo[]>>(new Map());
  const [editBatchesLoading, setEditBatchesLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [physicalCounts, setPhysicalCounts] = useState<Record<string, string>>({});
  const [recountReason, setRecountReason] = useState<RecountReason | ''>('');
  const [recountReasonOther, setRecountReasonOther] = useState('');
  const [editNotes, setEditNotes] = useState('');

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
    setEditMode(null);
    setModeDraft(null);
    setRecountReason('');
    setRecountReasonOther('');
    setEditNotes('');
    setPhysicalCounts({});
    setShowConfirm(false);
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
          qty: '',
          locationId: locations[0]?.id ?? '',
          onHand: (v.stock ?? []).reduce((s, r) => s + r.onHand, 0),
          stock: (v.stock ?? []).map((row) => ({ ...row })),
          origCost: v.costPrice,
        };
      }),
    );
    // Fetch batch breakdown for each variant (async, non-blocking).
    setEditBatchesLoading(true);
    api
      .get<{ batches: { variantId: string; batches: BatchInfo[] }[] }>(`/api/products/${product.id}`)
      .then((data) => {
        const map = new Map<string, BatchInfo[]>();
        for (const entry of data.batches) {
          map.set(entry.variantId, entry.batches);
        }
        setEditBatches(map);
      })
      .catch(() => {})
      .finally(() => setEditBatchesLoading(false));
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editForm.name.trim()) {
      toast.push('error', 'Product name is required.');
      return;
    }

    // --- Mode-specific validation ---
    if (editMode === 'add_stock') {
      for (const v of editVariants.filter((vv) => vv.isActive || vv.isNew)) {
        const q = editQtyNum(v);
        if (q < 0 || (q > 0 && !Number.isInteger(q))) {
          toast.push('error', `Quantity for ${v.label || 'variant'} must be a positive whole number.`);
          return;
        }
        if (q > 0 && !(Number(v.cost) > 0)) {
          toast.push('error', `Unit cost for ${v.label || 'variant'} must be greater than 0.`);
          return;
        }
        // A brand-new variant is sold on its own price, so it must be explicit.
        // An existing variant keeps its current selling price when left blank,
        // but a typed invalid value is blocked rather than silently dropped.
        if (v.isNew && !(Number(v.price) > 0)) {
          toast.push('error', `Selling price for ${v.label || 'new variant'} must be greater than 0.`);
          return;
        }
        if (!v.isNew && v.price !== '' && !(Number(v.price) > 0)) {
          toast.push('error', `Selling price for ${v.label || 'variant'} must be greater than 0.`);
          return;
        }
        if (q > 0 && v.cost !== '' && !(Number(v.cost) > 0)) {
          toast.push('error', `Unit cost for ${v.label || 'variant'} must be greater than 0.`);
          return;
        }
        if (q > 0 && !v.locationId) {
          toast.push('error', `Choose a location for ${v.label || 'variant'}.`);
          return;
        }
      }
      const anyQty = editVariants.some((v) => (v.isActive || v.isNew) && editQtyNum(v) > 0);
      if (!anyQty) {
        toast.push('error', 'Enter a quantity for at least one variant.');
        return;
      }
      if (!showConfirm) {
        setShowConfirm(true);
        return;
      }
    }

    if (editMode === 'recount') {
      const hasAnyDifference = editVariants.some((v) => {
        if (!v.isActive || v.isNew) return false;
        return recountRows(v).some((row) => {
          const physical = physicalCounts[countKey(v.id, row.locationId)];
          if (physical === undefined || physical === '') return false;
          return Number(physical) !== row.onHand;
        });
      });
      if (!hasAnyDifference) {
        toast.push('error', 'No quantity changes detected. Enter a physical count different from the system quantity.');
        return;
      }
      // All variants with a difference need a location
      for (const v of editVariants) {
        if (!v.isActive || v.isNew) continue;
        for (const row of recountRows(v)) {
          const physical = physicalCounts[countKey(v.id, row.locationId)];
          if (physical === undefined || physical === '') continue;
          const diff = Number(physical) - row.onHand;
          if (diff !== 0 && !row.locationId) {
            toast.push('error', `Choose a location for ${v.label}.`);
            return;
          }
        }
      }
      // Reason required for recounts with differences
      const recountReasonFinal = recountReason === 'other' ? recountReasonOther.trim() : recountReason ? RECOUNT_REASON_LABELS[recountReason] : '';
      if (!recountReasonFinal) {
        toast.push('error', 'A reason is required for stock count adjustments.');
        return;
      }
      if (!showConfirm) {
        setShowConfirm(true);
        return;
      }
    }

    if (editMode === 'edit_details') {
      const writeProductPrices = showProductPrices || !variantsEditable;
      if (writeProductPrices && Number(editForm.basePrice) < 0) {
        toast.push('error', 'Selling price cannot be negative.');
        return;
      }
      if (showProductPrices && !(Number(editForm.basePrice) > 0)) {
        toast.push('error', 'A plain product needs a selling price greater than 0.');
        return;
      }
      // No stock confirmation needed for details-only edits
    }

    if (!editMode) return;

    setBusy(true);
    try {
      if (editMode === 'add_stock') {
        // Add New Stock: every variant with a quantity gets a NEW batch at the
        // cost entered here; old batches keep their old cost and the catalog is
        // not touched. Prices only travel when the user actually typed one.
        const reason = editNotes.trim() || 'New stock added';
        for (const v of editVariants.filter((vv) => vv.isActive || vv.isNew)) {
          const q = editQtyNum(v);
          if (q <= 0) continue;
          if (v.isNew) {
            if (!can('variant.create')) continue;
            await api.post('/api/variants', {
              productId: editing.id,
              label: v.label || 'Standard',
              sku: v.sku,
              barcode: v.barcode,
              costPrice: Number(v.cost),
              sellingPrice: Number(v.price),
              lowStockThreshold: Number(v.lowStock) || 10,
              quantity: q,
              locationId: v.locationId,
              reason,
            });
          } else {
            if (!can('variant.update')) continue;
            await api.patch(`/api/variants/${v.id}`, {
              ...(Number(v.cost) > 0 ? { costPrice: Number(v.cost) } : {}),
              ...(v.price !== '' && Number(v.price) > 0 ? { sellingPrice: Number(v.price) } : {}),
              reason,
              stockLocationId: v.locationId,
              quantityDelta: q,
            });
          }
        }
      }

      if (editMode === 'recount') {
        const recountReasonFinal = recountReason === 'other' ? recountReasonOther.trim() : recountReason ? RECOUNT_REASON_LABELS[recountReason] : '';
        for (const v of editVariants.filter((vv) => vv.isActive && !vv.isNew)) {
          if (!can('variant.update')) continue;
          for (const row of recountRows(v)) {
            const physical = physicalCounts[countKey(v.id, row.locationId)];
            if (physical === undefined || physical === '') continue;
            const diff = Number(physical) - row.onHand;
            if (diff === 0 || !row.locationId) continue;
            await api.patch(`/api/variants/${v.id}`, {
              quantityDelta: diff,
              stockLocationId: row.locationId,
              reason: recountReasonFinal,
            });
          }
        }
      }

      if (editMode === 'edit_details') {
        const newOptionNames = editForm.optionNames.split(',').map((s) => s.trim()).filter(Boolean);
        const writeProductPrices = showProductPrices || !variantsEditable;
        // Variants first: a plain product keeps its price on the product row, so
        // when real variants just appeared the product PATCH below must see the
        // fresh variant prices — otherwise the "needs a selling price > 0" check
        // runs against the variants' stale (inherited) values.
        if (variantsEditable) {
          for (const v of editVariants) {
            const payload: Record<string, unknown> = {
              label: v.label,
              sku: v.sku,
              barcode: v.barcode,
              lowStockThreshold: Number(v.lowStock) || 10,
            };
            // Selling price is only updated in edit_details mode if not on product row
            if (!showProductPrices && v.price !== '') {
              payload.sellingPrice = Number(v.price);
            }
            if (v.isNew) {
              if (!can('variant.create')) continue;
              const blank = !v.label.trim() && !v.sku.trim() && !v.barcode.trim();
              if (blank) continue;
              await api.post('/api/variants', {
                productId: editing.id,
                ...payload,
                // A brand-new variant is sold and valued on its own price/cost.
                // Sending them explicitly also keeps the product-defaults PATCH
                // below from stranding the variant on a zeroed default.
                ...(Number(v.cost) > 0 ? { costPrice: Number(v.cost) } : {}),
                ...(v.price !== '' && Number(v.price) > 0 ? { sellingPrice: Number(v.price) } : {}),
              });
            } else {
              if (!can('variant.update')) continue;
              await api.patch(`/api/variants/${v.id}`, payload);
            }
          }
        }
        // Keep the product defaults when any variant still inherits them (no
        // explicit price/cost of its own): zeroing them would strand that variant
        // at 0 and fail the server's >0 validation. Only a fully self-priced
        // variant product clears the (now hidden) product-level defaults.
        const detailRows = editVariants.filter((v) => v.isActive || v.isNew);
        const allSelfPriced = detailRows.every((v) => Number(v.price) > 0 && Number(v.cost) > 0);
        // Update product metadata
        await api.patch(`/api/products/${editing.id}`, {
          name: editForm.name,
          description: editForm.description || null,
          basePrice: writeProductPrices ? Number(editForm.basePrice || 0) : allSelfPriced ? 0 : editing.basePrice,
          costPrice: writeProductPrices ? Number(editForm.costPrice || 0) : allSelfPriced ? 0 : editing.costPrice,
          categoryId: editForm.categoryId || null,
          optionNames: newOptionNames,
        });
      }

      const successMsg =
        editMode === 'add_stock' ? 'New stock added successfully.' :
        editMode === 'recount' ? 'Stock recount saved.' :
        'Product details updated.';
      toast.push('success', successMsg);
      setEditing(null);
      setEditMode(null);
      setModeDraft(null);
      setShowConfirm(false);
      setEditBatches(new Map());
      setPhysicalCounts({});
      setRecountReason('');
      setRecountReasonOther('');
      setEditNotes('');
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
          qty: '',
          locationId: locations[0]?.id ?? '',
          onHand: 0,
          stock: [],
          origCost: null,
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

  // Smart stock edits (spec 16): quantity/cost changes move stock or revalue
  // its cost basis, so they need a reason and the stock.adjust permission.
  const editQtyNum = (v: VariantEdit) => (v.qty.trim() === '' ? 0 : Number(v.qty));

  // Recount rows: one per location holding stock (server-provided), or a single
  // variant-wide row when per-location stock is unavailable. The fallback row
  // lets the user pick a location; real rows are bound to their location.
  const recountRows = (v: VariantEdit) => {
    if (v.stock?.length) return v.stock.map((row) => ({ ...row, fallback: false as const }));
    return [{ locationId: v.locationId, onHand: v.onHand, sellable: v.onHand, reserved: 0, fallback: true as const }];
  };
  const countKey = (variantId: string, locationId: string) => `${variantId}:${locationId}`;

  const variantsEditable = can('variant.update') || can('variant.create');

  // Price shown in the table: the single effective price for a plain product, or
  // a min–max range across active variants once there are real variants.
  const priceSummary = (p: Product) => {
    const prices = p.variants.filter((v) => v.isActive).map((v) => v.sellingPrice ?? p.basePrice);
    if (prices.length === 0) return currency(p.basePrice);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    return min === max ? currency(min) : `${currency(min)} – ${currency(max)}`;
  };

  // Barcode label printing: opens a print-only popup window so the main page is
  // never affected by the print stylesheet.
  const printLabels = (items: { productName: string; variantLabel: string; sku: string; barcode: string }[]) => {
    const w = window.open('', '_blank', 'width=420,height=640');
    if (!w) {
      toast.push('error', 'Pop-up blocked — allow pop-ups to print labels.');
      return;
    }
    w.document.write(`<!doctype html><html><head><title>Product labels</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; background: #fff; color: #000; padding: 24px; }
  .label { border: 2px solid #000; border-radius: 8px; padding: 14px 16px; margin: 0 0 16px; width: 248px; page-break-inside: avoid; }
  .product { font-size: 13px; font-weight: 700; }
  .variant { font-size: 12px; color: #444; margin-top: 2px; }
  .barcode { font-family: 'OCRB', 'Courier New', monospace; font-size: 15px; letter-spacing: 3px; text-align: center; margin: 12px 0 4px; }
  .sku { font-size: 10px; color: #666; text-align: center; }
</style></head><body>
  ${items
    .map(
      (item) => `<div class="label">
        <div class="product">${escapeHtml(item.productName)}</div>
        <div class="variant">${escapeHtml(item.variantLabel)}</div>
        <div class="barcode">${escapeHtml(item.barcode)}</div>
        <div class="sku">${escapeHtml(item.sku)}</div>
      </div>`,
    )
    .join('')}
</body></html>`);
    w.document.close();
    w.focus();
    w.print();
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
                                    <th />
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
                                      <td className="text-right whitespace-nowrap">
                                        <button
                                          className="btn-ghost btn-sm"
                                          onClick={() =>
                                            printLabels([
                                              {
                                                productName: product.name,
                                                variantLabel: variant.label,
                                                sku: variant.sku,
                                                barcode: variant.barcode,
                                              },
                                            ])
                                          }
                                          type="button"
                                        >
                                          Label
                                        </button>
                                        {product.variants.length > 1 && (
                                          <button
                                            className="btn-ghost btn-sm"
                                            onClick={() =>
                                              printLabels(product.variants.map((v) => ({
                                                productName: product.name,
                                                variantLabel: v.label,
                                                sku: v.sku,
                                                barcode: v.barcode,
                                              })))
                                            }
                                            type="button"
                                          >
                                            All
                                          </button>
                                        )}
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
        title={editMode ? `${PRODUCT_EDIT_MODE_LABELS[editMode]} — ${editing?.name ?? ''}` : 'Edit product'}
        wide
        onClose={() => { setEditing(null); setEditMode(null); setModeDraft(null); setShowConfirm(false); setEditBatches(new Map()); }}
        footer={
          editMode === null ? (
            <>
              <button className="btn-secondary" onClick={() => { setEditing(null); setModeDraft(null); }} type="button">
                Cancel
              </button>
              <button className="btn-primary" disabled={!modeDraft} onClick={() => { if (modeDraft) setEditMode(modeDraft); }} type="button">
                Continue
              </button>
            </>
          ) : (
            <>
              <button className="btn-secondary" onClick={() => { setEditMode(null); setModeDraft(null); }} type="button">
                Back
              </button>
              <button className="btn-primary" disabled={busy || !editForm.name.trim()} onClick={() => void saveEdit()} type="button">
                {busy ? 'Saving…' : editMode === 'recount' ? 'Save recount' : 'Save changes'}
              </button>
            </>
          )
        }
      >
        {/* Mode selection screen */}
        {editMode === null && (
          <div className="space-y-3">
            <p className="text-sm text-ink-600 dark:text-ink-300">What do you want to do?</p>
            {([
              { mode: 'add_stock' as const, icon: '📦', title: 'Add New Stock (New Batch)', desc: 'I received new stock. Enter new quantity, new cost, and new selling price. Old stock keeps its old cost.' },
              { mode: 'recount' as const, icon: '🔢', title: 'Stock Recount (Adjust Quantity)', desc: 'I counted my stock. Correct the quantity. Cost and selling price stay the same.' },
              { mode: 'edit_details' as const, icon: '✏️', title: 'Edit Details Only', desc: 'Change name, description, SKU, or selling price. No stock changes.' },
            ]).map((opt) => (
              <label
                key={opt.mode}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-200 p-4 transition hover:border-ink-400 dark:border-ink-700 dark:hover:border-ink-500"
              >
                <input
                  type="radio"
                  name="editMode"
                  className="mt-0.5"
                  value={opt.mode}
                  checked={modeDraft === opt.mode}
                  onChange={() => setModeDraft(opt.mode)}
                />
                <div>
                  <p className="text-sm font-medium text-ink-900 dark:text-ink-100">{opt.icon} {opt.title}</p>
                  <p className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>
        )}

        {/* Add New Stock form */}
        {editMode === 'add_stock' && (
          <div className="space-y-4">
            <p className="text-xs text-ink-500 dark:text-ink-400">
              Enter the new stock you received. Each variant gets a new batch at the cost you specify. Old batches are untouched.
            </p>
            {can('variant.update') || can('variant.create') ? (
              <div className="space-y-3">
                {editVariants.filter((v) => v.isActive || v.isNew).map((v) => (
                  <div key={v.id} className="space-y-2 rounded-lg border border-ink-200 p-3 dark:border-ink-700">
                    {v.isNew && (
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-xs font-medium text-blue-600 dark:text-blue-400">New variant</span>
                        <button className="btn-ghost btn-sm" onClick={() => removeEditVariant(v.id)} type="button">✕ Remove</button>
                      </div>
                    )}
                    <p className="text-sm font-medium text-ink-900 dark:text-ink-100">
                      {v.label || (v.isNew ? 'New variant' : 'Standard')}
                      {!v.isNew && <span className="ml-2 text-xs text-ink-400">({v.onHand} on hand)</span>}
                    </p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Field label="Quantity">
                        <input
                          className="input"
                          type="number"
                          min={0}
                          inputMode="numeric"
                          value={v.qty}
                          placeholder="0"
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            if (/^\d*$/.test(raw)) setVariant(v.id, { qty: raw });
                          }}
                        />
                      </Field>
                      <Field label="Unit Cost">
                        <input
                          className="input"
                          type="number"
                          inputMode="decimal"
                          value={v.cost}
                          placeholder="0"
                          onChange={(e) => setVariant(v.id, { cost: e.target.value })}
                        />
                        {v.cost !== '' && !(Number(v.cost) > 0) && (
                          <p className="mt-1 text-xs text-red-500">Must be &gt; 0.</p>
                        )}
                      </Field>
                      <Field label="Selling Price">
                        <input
                          className="input"
                          type="number"
                          inputMode="decimal"
                          value={v.price}
                          placeholder="0"
                          onChange={(e) => setVariant(v.id, { price: e.target.value })}
                        />
                        {v.price !== '' && !(Number(v.price) > 0) && (
                          <p className="mt-1 text-xs text-red-500">Must be &gt; 0.</p>
                        )}
                      </Field>
                      <Field label="Location">
                        <select
                          className="input"
                          value={v.locationId}
                          onChange={(e) => setVariant(v.id, { locationId: e.target.value })}
                        >
                          <option value="">— select —</option>
                          {locations.map((loc) => (
                            <option key={loc.id} value={loc.id}>
                              {loc.name}{loc.type === 'RETAIL_STORE' ? ' (store)' : ''}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    {Number(v.qty) > 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        Will create a new batch with {v.qty} unit(s) at {currency(Number(v.cost || 0))} each.
                      </p>
                    )}
                    {can('variant.create') && (
                      <button className="btn-ghost btn-sm" onClick={addEditVariant} type="button">+ Add another variant</button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-500 dark:text-ink-400">You don't have permission to add stock.</p>
            )}
            <Field label="Notes (optional)">
              <input
                className="input"
                value={editNotes}
                placeholder="e.g. Delivery note #1234"
                onChange={(e) => setEditNotes(e.target.value)}
              />
            </Field>
          </div>
        )}

        {/* Stock Recount form */}
        {editMode === 'recount' && (
          <div className="space-y-4">
            <p className="text-xs text-ink-500 dark:text-ink-400">
              Enter the physical count for each variant. The system will calculate the difference and adjust stock accordingly (FIFO for decreases).
            </p>
            {(can('variant.update') || can('variant.create')) && can('stock.adjust') ? (
              <div className="space-y-3">
                {editVariants.filter((v) => v.isActive && !v.isNew).flatMap((v) =>
                  recountRows(v).map((row) => {
                  const systemQty = row.onHand;
                  const key = countKey(v.id, row.locationId);
                  const physical = physicalCounts[key] ?? '';
                  const physicalNum = physical === '' ? null : Number(physical);
                  const diff = physicalNum !== null ? physicalNum - systemQty : null;
                  const location = locations.find((l) => l.id === row.locationId);
                  return (
                    <div key={key} className="space-y-2 rounded-lg border border-ink-200 p-3 dark:border-ink-700">
                      <p className="text-sm font-medium text-ink-900 dark:text-ink-100">
                        {v.label}
                        {location && !row.fallback && (
                          <span className="ml-2 text-xs font-normal text-ink-400">{location.name}</span>
                        )}
                      </p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {row.fallback ? (
                          <Field label="Location">
                            <select
                              className="input"
                              value={row.locationId}
                              onChange={(e) => setVariant(v.id, { locationId: e.target.value })}
                            >
                              <option value="">— select —</option>
                              {locations.map((loc) => (
                                <option key={loc.id} value={loc.id}>
                                  {loc.name}{loc.type === 'RETAIL_STORE' ? ' (store)' : ''}
                                </option>
                              ))}
                            </select>
                          </Field>
                        ) : (
                          <Field label="Location">
                            <input
                              className="input bg-ink-50 dark:bg-ink-800/50"
                              value={location?.name ?? row.locationId.slice(-6)}
                              disabled
                              readOnly
                            />
                          </Field>
                        )}
                        <Field label="System Quantity">
                          <input
                            className="input bg-ink-50 dark:bg-ink-800/50"
                            type="number"
                            value={systemQty}
                            disabled
                            readOnly
                          />
                        </Field>
                        <Field label="Physical Count">
                          <input
                            className="input"
                            type="number"
                            min={0}
                            inputMode="numeric"
                            value={physical}
                            placeholder="0"
                            onChange={(e) => {
                              const raw = e.target.value.trim();
                              if (/^\d*$/.test(raw)) setPhysicalCounts({ ...physicalCounts, [key]: raw });
                            }}
                          />
                        </Field>
                        <Field label="Difference">
                          <input
                            className={`input ${diff !== null && diff !== 0 ? (diff > 0 ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-red-50 dark:bg-red-900/20') : ''}`}
                            type="text"
                            value={diff !== null ? (diff > 0 ? `+${diff}` : String(diff)) : '—'}
                            disabled
                            readOnly
                          />
                        </Field>
                      </div>
                      {diff !== null && diff !== 0 && (
                        <p className={`text-xs ${diff > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                          {diff > 0
                            ? `Will add ${diff} unit(s) as a new batch.`
                            : `Will remove ${Math.abs(diff)} unit(s) via FIFO.`}
                        </p>
                      )}
                      {/* Stock breakdown */}
                      {systemQty > 0 && (
                        <div className="mt-1 rounded-lg border border-ink-100 bg-ink-50 p-2.5 dark:border-ink-700 dark:bg-ink-800/30">
                          <p className="mb-1 text-xs font-medium text-ink-600 dark:text-ink-300">
                            Stock breakdown
                            {editBatchesLoading && <span className="ml-1 text-ink-400">loading…</span>}
                          </p>
                          {(() => {
                            const batches = editBatches.get(v.id) ?? [];
                            if (batches.length === 0 && !editBatchesLoading) {
                              return <p className="text-xs text-ink-400">No active batches.</p>;
                            }
                            return (
                              <div className="space-y-1">
                                {batches.map((b) => (
                                  <div key={b.code} className="flex items-center justify-between text-xs">
                                    <span className="text-ink-500 dark:text-ink-400">
                                      {b.code}: {b.remainingQty} unit(s) @ {currency(b.unitCost)}
                                      <span className="ml-1 text-ink-400">
                                        ({b.locationName}, {new Date(b.receivedAt).toLocaleDateString()})
                                      </span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                  }))}
              </div>
            ) : (
              <p className="text-sm text-ink-500 dark:text-ink-400">
                {!can('stock.adjust')
                  ? "You don't have permission to adjust stock."
                  : 'No active variants to recount.'}
              </p>
            )}
            <Field label="Reason" hint="Required when there is a difference between system and physical count.">
              <select
                className="input"
                value={recountReason}
                onChange={(e) => setRecountReason(e.target.value as RecountReason | '')}
              >
                <option value="">— choose a reason —</option>
                {RECOUNT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {RECOUNT_REASON_LABELS[r]}
                  </option>
                ))}
              </select>
              {recountReason === 'other' && (
                <input
                  className="input mt-2"
                  value={recountReasonOther}
                  placeholder="Describe the reason…"
                  onChange={(e) => setRecountReasonOther(e.target.value)}
                />
              )}
            </Field>
          </div>
        )}

        {/* Edit Details Only form */}
        {editMode === 'edit_details' && (
          <div className="space-y-4">
            <p className="text-xs text-ink-500 dark:text-ink-400">
              Update product information. No stock will be added or removed.
            </p>
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
                <Field label="Default selling price" hint="Changes what customers pay. Future sales only.">
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
              )}
              <Field label="Description" className="sm:col-span-2">
                <textarea
                  className="input"
                  rows={2}
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                />
              </Field>
              <Field label="Option names" hint="Comma separated, e.g. Size,Color" className="sm:col-span-2">
                <input
                  className="input"
                  value={editForm.optionNames}
                  onChange={(e) => setEditForm({ ...editForm, optionNames: e.target.value })}
                />
              </Field>
            </div>
            {/* Variant metadata (read-only cost) */}
            {can('variant.update') || can('variant.create') ? (
              <div>
                <p className="label mb-2">Variant details</p>
                <div className="space-y-3">
                  {editVariants.filter((v) => v.isActive || v.isNew).map((v) => (
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
                        </Field>
                        <Field label="SKU">
                          <input className="input" value={v.sku} onChange={(e) => setVariant(v.id, { sku: e.target.value })} />
                        </Field>
                        <Field label="Barcode">
                          <input className="input" value={v.barcode} onChange={(e) => setVariant(v.id, { barcode: e.target.value })} />
                        </Field>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Selling Price" hint="Changes what customers pay. Future sales only.">
                          <input
                            className="input"
                            type="number"
                            inputMode="decimal"
                            value={showProductPrices && v.isActive && !v.isNew ? editForm.basePrice : v.price}
                            placeholder="0"
                            disabled={showProductPrices && v.isActive && !v.isNew}
                            onChange={(e) => setVariant(v.id, { price: e.target.value })}
                          />
                        </Field>
                        <Field label="Cost" hint={v.isNew ? 'Leave blank to use the product default.' : 'Read-only in this mode.'}>
                          {v.isNew ? (
                            <input
                              className="input"
                              type="number"
                              inputMode="decimal"
                              value={v.cost}
                              placeholder="0"
                              onChange={(e) => setVariant(v.id, { cost: e.target.value })}
                            />
                          ) : (
                            <input
                              className="input bg-ink-50 dark:bg-ink-800/50"
                              type="text"
                              value={showProductPrices ? editForm.costPrice : v.cost || ''}
                              disabled
                              readOnly
                            />
                          )}
                        </Field>
                      </div>
                      <Field label="Low stock alert at">
                        <input className="input" type="number" min={0} value={v.lowStock} placeholder="0"
                          onChange={(e) => setVariant(v.id, { lowStock: e.target.value })} />
                      </Field>
                    </div>
                  ))}
                </div>
                {can('variant.create') && (
                  <button className="btn-secondary btn-sm mt-2" onClick={addEditVariant} type="button">+ Add variant</button>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-500 dark:text-ink-400">
                {editVariants.map((v) => v.label).join(', ') || 'No variants'}
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* Confirm stock changes modal */}
      {editing && (
        <Modal
          open={showConfirm}
          title={editMode === 'recount' ? 'Confirm stock recount' : 'Confirm new stock'}
          wide
          onClose={() => setShowConfirm(false)}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setShowConfirm(false)} type="button">
                Cancel
              </button>
              <button className="btn-primary" disabled={busy} onClick={() => void saveEdit()} type="button">
                {busy ? 'Saving…' : editMode === 'recount' ? 'Yes, save recount' : 'Yes, add stock'}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            {editMode === 'add_stock' && (
              <>
                <p className="text-sm text-ink-600 dark:text-ink-300">
                  You are about to add new stock for <strong>{editing.name}</strong>:
                </p>
                <div className="space-y-2">
                  {editVariants.filter((v) => v.isActive || v.isNew).map((v) => {
                    const q = editQtyNum(v);
                    if (q <= 0) return null;
                    const location = locations.find((l) => l.id === v.locationId);
                    return (
                      <div key={v.id} className="rounded-lg border border-ink-200 p-3 dark:border-ink-700">
                        <p className="mb-1 text-xs font-medium text-ink-700 dark:text-ink-200">
                          {v.label || 'New variant'}
                          {v.isNew && <span className="ml-1 text-blue-600 dark:text-blue-400">(new)</span>}
                        </p>
                        <div className="space-y-1 text-sm">
                          <p>
                            Adding <strong>{q}</strong> unit(s) at {currency(Number(v.cost))} each
                            <span className="ml-2 text-xs text-ink-400">(total: {currency(q * Number(v.cost))})</span>
                          </p>
                          <p>Selling price: {currency(Number(v.price))}</p>
                          {location && <p className="text-xs text-ink-400">Location: {location.name}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {editMode === 'recount' && (
              <>
                <p className="text-sm text-ink-600 dark:text-ink-300">
                  You are about to save the following stock adjustments for <strong>{editing.name}</strong>:
                </p>
                <div className="space-y-2">
                  {editVariants.filter((v) => v.isActive && !v.isNew).flatMap((v) =>
                    recountRows(v).map((row) => {
                    const physical = physicalCounts[countKey(v.id, row.locationId)];
                    if (physical === undefined || physical === '') return null;
                    const diff = Number(physical) - row.onHand;
                    if (diff === 0) return null;
                    const location = locations.find((l) => l.id === row.locationId);
                    return (
                      <div key={countKey(v.id, row.locationId)} className="rounded-lg border border-ink-200 p-3 dark:border-ink-700">
                        <p className="mb-1 text-xs font-medium text-ink-700 dark:text-ink-200">{v.label}</p>
                        <div className="space-y-1 text-sm">
                          <p>
                            Quantity: {row.onHand} → {Number(physical)}
                            {diff > 0 ? (
                              <span className="ml-1 text-xs text-green-600 dark:text-green-400">(+{diff} new batch)</span>
                            ) : (
                              <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">({diff} removed FIFO)</span>
                            )}
                          </p>
                          {location && <p className="text-xs text-ink-400">Location: {location.name}</p>}
                        </div>
                      </div>
                    );
                    }))}
                </div>
                {recountReason && (
                  <p className="text-xs text-ink-500 dark:text-ink-400">
                    Reason: {recountReason === 'other' ? recountReasonOther.trim() : RECOUNT_REASON_LABELS[recountReason]}
                  </p>
                )}
              </>
            )}
          </div>
        </Modal>
      )}

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
