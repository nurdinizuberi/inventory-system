import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
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

export async function GET() {
  try {
    const ctx = await guard({ action: 'product.view' });
    const products = await prisma.product.findMany({
      where: { isActive: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
      include: {
        category: true,
        variants: { where: { isActive: true }, orderBy: { label: 'asc' } },
      },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json({ products });
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
