import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { TX_OPTIONS, prisma } from '@/lib/db';
import { assertAction, assertLocationAccess, badRequest, guard, jsonError } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';
import { adjustVariantStock } from '@/lib/stock-edit';
import { generateBarcode, generateSku } from '@/lib/utils';

const createSchema = z.object({
  productId: z.string().min(1, 'productId is required'),
  label: z.string().optional(),
  attributes: z.record(z.string()).default({}),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  costPrice: z.coerce.number().min(0).nullable().optional(),
  sellingPrice: z.coerce.number().min(0).nullable().optional(),
  lowStockThreshold: z.coerce.number().int().min(0).default(10),
  /** Initial on-hand quantity when created from the product editor. */
  quantity: z.coerce.number().int().optional(),
  locationId: z.string().optional(),
  /** Reason for the initial stock (required when quantity > 0). */
  reason: z.string().optional(),
});

/** Flat, POS-friendly list of sellable variants with per-location stock. */
export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'variant.view' });
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
    const locationId = url.searchParams.get('locationId');
    const barcode = url.searchParams.get('barcode')?.trim();
    // Light mode: pickers (purchase / adjustment lines) only need id + label +
    // sku + price. Skipping the stock matrix and the category join keeps these
    // dropdowns cheap instead of computing per-location stock for the whole
    // catalog every time the page opens or a line is edited.
    const light = url.searchParams.get('light') === '1';

    const variants = await prisma.variant.findMany({
      where: {
        isActive: true,
        product: { isActive: true },
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        ...(barcode ? { barcode } : {}),
        ...(q
          ? {
              OR: [
                { sku: { contains: q } },
                { barcode: { contains: q } },
                { label: { contains: q } },
                { product: { name: { contains: q } } },
              ],
            }
          : {}),
      },
      include: light
        ? { product: { select: { name: true, costPrice: true, basePrice: true } } }
        : { product: { include: { category: true } } },
      orderBy: [{ product: { name: 'asc' } }, { label: 'asc' }],
      take: 400,
    });

    const stock = light
      ? []
      : await getStockMatrix(prisma, {
          variantIds: variants.map((v) => v.id),
          ...(locationId ? { locationIds: [locationId] } : {}),
        });
    const stockByVariant = new Map<string, (typeof stock)[number][]>();
    for (const row of stock) {
      const list = stockByVariant.get(row.variantId) ?? [];
      list.push(row);
      stockByVariant.set(row.variantId, list);
    }

    const items = variants.map((v) => {
      const attributes = JSON.parse(v.attributes || '{}') as Record<string, string>;
      const attrText = Object.values(attributes).filter(Boolean).join(' / ');
      const rows = stockByVariant.get(v.id) ?? [];
      const category = (v.product as { category?: { name: string } | null }).category?.name ?? null;
      const onHand = rows.reduce((s, r) => s + r.onHand, 0);
      const reserved = rows.reduce((s, r) => s + r.reserved, 0);
      const sellable = rows.reduce((s, r) => s + r.sellable, 0);
      return {
        id: v.id,
        productId: v.productId,
        productName: v.product.name,
        category,
        label: v.label,
        displayName: attrText ? `${v.product.name} — ${attrText}` : v.product.name,
        attributes,
        sku: v.sku,
        barcode: v.barcode,
        costPrice: v.costPrice ?? v.product.costPrice,
        sellingPrice: v.sellingPrice ?? v.product.basePrice,
        lowStockThreshold: v.lowStockThreshold,
        isDefault: v.isDefault,
        onHand,
        reserved,
        sellable,
        lowStock: onHand <= v.lowStockThreshold,
        stock: rows.map((r) => ({
          locationId: r.locationId,
          onHand: r.onHand,
          reserved: r.reserved,
          sellable: r.sellable,
        })),
      };
    });

    return NextResponse.json({ variants: items, scopedRole: ctx.role });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'variant.create' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const data = parsed.data;
    const product = await prisma.product.findFirst({
      where: { id: data.productId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: { variants: true },
    });
    if (!product) return badRequest('Product not found');

    const quantity = data.quantity ?? 0;
    if (quantity > 0) {
      if (!data.locationId) return badRequest('A location is required for opening stock.');
      if (!data.reason?.trim()) return badRequest('A reason is required for opening stock.');
      await assertAction(ctx, 'stock.adjust');
      await assertLocationAccess(ctx, data.locationId);
    }

    // A new variant is sold and valued on its own. It may inherit the product
    // default only when that default is itself greater than 0 — otherwise a blank
    // price/cost would silently sell or value the variant at 0.
    if (!((data.sellingPrice ?? product.basePrice) > 0)) {
      return badRequest('Selling price must be greater than 0 (set it on the variant or raise the product default).');
    }
    if (!((data.costPrice ?? product.costPrice) > 0)) {
      return badRequest('Cost must be greater than 0 (set it on the variant or raise the product default).');
    }

    const attrPairs = Object.entries(data.attributes).filter(([, value]) => value);
    const label =
      data.label?.trim() ||
      (attrPairs.length ? attrPairs.map(([, value]) => value).join(' / ') : 'Standard');
    const sku = data.sku?.trim() || generateSku(product.name, data.attributes, product.variants.length + 1);
    const barcode = data.barcode?.trim() || generateBarcode(sku);

    const variant = await prisma.$transaction(async (tx) => {
      const created = await tx.variant.create({
        data: {
          tenantId: ctx.tenantId ?? null,
          productId: product.id,
          attributes: JSON.stringify(data.attributes),
          label,
          sku,
          barcode,
          costPrice: data.costPrice ?? null,
          sellingPrice: data.sellingPrice ?? null,
          lowStockThreshold: data.lowStockThreshold,
          isDefault: product.variants.length === 0,
        },
        include: { product: true },
      });

      if (quantity > 0) {
        const effectiveCost = created.costPrice ?? created.product.costPrice ?? 0;
        await adjustVariantStock(tx, {
          variantId: created.id,
          locationId: data.locationId as string,
          delta: quantity,
          unitCost: effectiveCost,
          reason: (data.reason as string).trim(),
          referenceLabel: `${created.product.name} — ${created.label}`,
          referenceId: created.id,
          referenceType: 'variant',
          tenantId: ctx.tenantId ?? null,
          createdById: ctx.id,
        });
      }

      return created;
    }, TX_OPTIONS);

    await audit({
      ctx,
      action: 'create',
      entityType: 'Variant',
      entityId: variant.id,
      entityLabel: `${product.name} — ${label}`,
      after: variant,
      metadata: quantity > 0 ? { openingQuantity: quantity, openingLocationId: data.locationId, reason: data.reason } : undefined,
    });

    return NextResponse.json({ variant }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unique constraint')) {
      return badRequest('SKU or barcode already exists — both must be unique.');
    }
    return jsonError(err);
  }
}
