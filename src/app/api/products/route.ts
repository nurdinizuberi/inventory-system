import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { getStockMatrix } from '@/lib/stock';
import { generateBarcode, generateSku } from '@/lib/utils';

const createSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional().nullable(),
  categoryId: z.string().optional().nullable(),
  basePrice: z.coerce.number().min(0).default(0),
  costPrice: z.coerce.number().min(0).default(0),
  optionNames: z.array(z.string().min(1)).max(4).default([]),
  variants: z
    .array(
      z.object({
        label: z.string().optional(),
        attributes: z.record(z.string()).default({}),
        sku: z.string().optional(),
        barcode: z.string().optional(),
        costPrice: z.coerce.number().min(0).optional().nullable(),
        sellingPrice: z.coerce.number().min(0).optional().nullable(),
        lowStockThreshold: z.coerce.number().int().min(0).default(10),
      }),
    )
    .default([]),
});

export async function GET(request: Request) {
  try {
    const ctx = await guard({ action: 'product.view' });
    const url = new URL(request.url);
    const status = url.searchParams.get('status'); // 'active' (default) | 'archived' | 'all'
    const isActive =
      status === 'archived'
        ? false
        : status === 'all'
          ? undefined
          : true;

    const products = await prisma.product.findMany({
      where: {
        ...(isActive !== undefined ? { isActive } : {}),
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      },
      include: {
        category: true,
        variants: { orderBy: { label: 'asc' } },
      },
      orderBy: { name: 'asc' },
    });

    // Derive a per-variant on-hand total so the list can show quantity without
    // a stored figure — the ledger is the only source of truth.
    const variantIds = products.flatMap((p) => p.variants.map((v) => v.id));
    const matrix = variantIds.length ? await getStockMatrix(prisma, { variantIds }) : [];
    const onHandByVariant = new Map<string, number>();
    const sellableByVariant = new Map<string, number>();
    const reservedByVariant = new Map<string, number>();
    const stockByVariant = new Map<string, { locationId: string; onHand: number; sellable: number; reserved: number }[]>();
    for (const row of matrix) {
      onHandByVariant.set(row.variantId, (onHandByVariant.get(row.variantId) ?? 0) + row.onHand);
      sellableByVariant.set(row.variantId, (sellableByVariant.get(row.variantId) ?? 0) + row.sellable);
      reservedByVariant.set(row.variantId, (reservedByVariant.get(row.variantId) ?? 0) + row.reserved);
      const list = stockByVariant.get(row.variantId) ?? [];
      list.push({ locationId: row.locationId, onHand: row.onHand, sellable: row.sellable, reserved: row.reserved });
      stockByVariant.set(row.variantId, list);
    }

    const items = products.map((p) => ({
      ...p,
      variants: p.variants.map((v) => ({
        ...v,
        onHand: onHandByVariant.get(v.id) ?? 0,
        sellable: sellableByVariant.get(v.id) ?? 0,
        reserved: reservedByVariant.get(v.id) ?? 0,
        stock: stockByVariant.get(v.id) ?? [],
      })),
      totalOnHand: p.variants.reduce((s, v) => s + (onHandByVariant.get(v.id) ?? 0), 0),
    }));

    return NextResponse.json({ products: items });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'product.create' });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const data = parsed.data;
    const optionNames = data.optionNames.filter(Boolean);

    // Every product gets at least a default variant so stock, purchase and POS
    // logic stays uniform even for products with no real options.
    const variantInputs =
      data.variants.length > 0
        ? data.variants
        : [{ attributes: {} as Record<string, string>, lowStockThreshold: 10 }];

    const product = await prisma.product.create({
      data: {
        tenantId: ctx.tenantId ?? null,
        name: data.name.trim(),
        description: data.description ?? null,
        categoryId: data.categoryId || null,
        basePrice: data.basePrice,
        costPrice: data.costPrice,
        optionNames: optionNames.join(','),
        variants: {
          create: variantInputs.map((v, index) => {
            const attrPairs = Object.entries(v.attributes ?? {}).filter(([, value]) => value);
            const label =
              v.label?.trim() ||
              (attrPairs.length ? attrPairs.map(([, value]) => value).join(' / ') : 'Standard');
            const sku = v.sku?.trim() || generateSku(data.name, v.attributes ?? {}, index + 1);
            const barcode = v.barcode?.trim() || generateBarcode(sku);
            return {
              label,
              attributes: JSON.stringify(v.attributes ?? {}),
              sku,
              barcode,
              costPrice: v.costPrice ?? null,
              sellingPrice: v.sellingPrice ?? null,
              lowStockThreshold: v.lowStockThreshold ?? 10,
              isDefault: index === 0,
            };
          }),
        },
      },
      include: { variants: true, category: true },
    });

    await audit({
      ctx,
      action: 'create',
      entityType: 'Product',
      entityId: product.id,
      entityLabel: product.name,
      after: product,
      metadata: { variants: product.variants.length },
    });

    return NextResponse.json({ product }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
