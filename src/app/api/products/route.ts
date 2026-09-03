import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma, TX_OPTIONS } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { getStockMatrix, recordMovement } from '@/lib/stock';
import { generateBarcode, generateSku } from '@/lib/utils';

const createSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional().nullable(),
  categoryId: z.string().optional().nullable(),
  basePrice: z.coerce.number().min(0).default(0),
  costPrice: z.coerce.number().min(0).default(0),
  optionNames: z.array(z.string().min(1)).max(4).default([]),
  openingQuantity: z.coerce.number().int().min(0).optional(),
  openingLocationId: z.string().optional(),
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
        quantity: z.coerce.number().int().min(0).optional(),
        locationId: z.string().optional(),
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

    // Opening stock: for each variant (or the auto-created default), write a
    // batch + ledger entry so the product shows quantity immediately. This
    // keeps the ledger as the single source of truth while allowing a starting
    // quantity directly on the product form.
    const openingStockEntries: { variantId: string; quantity: number; locationId: string }[] = [];
    if (data.openingQuantity && data.openingQuantity > 0 && data.openingLocationId) {
      // Product with no explicit variants — opening qty goes on the default variant.
      if (data.variants.length === 0) {
        openingStockEntries.push({
          variantId: product.variants[0].id,
          quantity: data.openingQuantity,
          locationId: data.openingLocationId,
        });
      }
    }
    for (const vi of variantInputs) {
      const qty = (vi as Record<string, unknown>).quantity as number | undefined;
      const loc = (vi as Record<string, unknown>).locationId as string | undefined;
      if (qty && qty > 0 && loc) {
        // Find the matching variant by label/sku from the created product.
        const attrPairs = Object.entries(vi.attributes ?? {}).filter(([, value]) => value);
        const label =
          vi.label?.trim() ||
          (attrPairs.length ? attrPairs.map(([, value]) => value).join(' / ') : 'Standard');
        const created = product.variants.find(
          (v) => v.label === label || (data.variants.length === 0 && v.isDefault),
        );
        if (created) {
          openingStockEntries.push({ variantId: created.id, quantity: qty, locationId: loc });
        }
      }
    }

    if (openingStockEntries.length > 0) {
      await prisma.$transaction(
        async (tx) => {
          for (const entry of openingStockEntries) {
            const batch = await tx.batch.create({
              data: {
                tenantId: ctx.tenantId ?? null,
                code: `OS-${product.id.slice(-8)}-${entry.variantId.slice(-4)}`,
                variantId: entry.variantId,
                locationId: entry.locationId,
                unitCost: data.costPrice,
                quantity: entry.quantity,
                remainingQty: entry.quantity,
                receivedAt: new Date(),
              },
            });
            await recordMovement(tx, {
              type: 'opening_stock',
              tenantId: ctx.tenantId ?? null,
              variantId: entry.variantId,
              locationId: entry.locationId,
              quantity: entry.quantity,
              batchId: batch.id,
              status: 'available',
              unitCost: data.costPrice,
              totalCost: data.costPrice * entry.quantity,
              referenceType: 'Product',
              referenceId: product.id,
              referenceLabel: product.name,
              notes: `Opening stock: ${entry.quantity} units`,
            });
          }
        },
        TX_OPTIONS,
      );
    }

    await audit({
      ctx,
      action: 'create',
      entityType: 'Product',
      entityId: product.id,
      entityLabel: product.name,
      after: product,
      metadata: {
        variants: product.variants.length,
        openingStock: openingStockEntries.map((e) => ({
          variantId: e.variantId,
          qty: e.quantity,
          locationId: e.locationId,
        })),
      },
    });

    return NextResponse.json({ product }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
