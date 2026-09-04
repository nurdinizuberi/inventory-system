import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { allocateFifo, consumeFifo, createTransferBatches } from '../src/lib/fifo';
import { recordMovement } from '../src/lib/stock';
import { generateBarcode } from '../src/lib/utils';
import { SYSTEM_ROLES } from '../src/lib/rbac';

// ---------------------------------------------------------------------------
// Demo dataset: a realistic warehouse -> retail flow with FIFO batches at two
// different costs, completed + in-transit transfers, POS sales, returns and
// adjustments. Idempotent: it stops if the admin user already exists.
// ---------------------------------------------------------------------------

const at = (daysAgo: number, hour = 10, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
};

interface SeedUser {
  email: string;
  name: string;
  role: string;
  password: string;
  locations: string[];
}

export const DEMO_PASSWORD_NOTE =
  'Demo logins: admin@ims.tz / admin123 · wh.manager@ims.tz / warehouse123 · store.mbezi@ims.tz / store123 · cashier@ims.tz / cashier123 · auditor@ims.tz / audit123';

const USERS: SeedUser[] = [
  { email: 'admin@ims.tz', name: 'Amina Hassan', role: 'ADMIN', password: 'admin123', locations: [] },
  {
    email: 'wh.manager@ims.tz',
    name: 'Joseph Mwangi',
    role: 'WAREHOUSE_MANAGER',
    password: 'warehouse123',
    locations: ['WH-MAIN'],
  },
  {
    email: 'store.mbezi@ims.tz',
    name: 'Neema Kimaro',
    role: 'STORE_MANAGER',
    password: 'store123',
    locations: ['ST-MBEZI'],
  },
  {
    email: 'store.kariakoo@ims.tz',
    name: 'Baraka Juma',
    role: 'STORE_MANAGER',
    password: 'store123',
    locations: ['ST-KAR'],
  },
  {
    email: 'cashier@ims.tz',
    name: 'Fatma Ally',
    role: 'CASHIER',
    password: 'cashier123',
    locations: ['ST-MBEZI'],
  },
  { email: 'auditor@ims.tz', name: 'Grace Mollel', role: 'AUDITOR', password: 'audit123', locations: [] },
];

interface ProductSeed {
  name: string;
  description: string;
  category: string;
  basePrice: number;
  costPrice: number;
  optionNames: string[];
  variants: { attrs: Record<string, string>; cost: number; price: number; low: number }[];
}

const PRODUCTS: ProductSeed[] = [
  {
    name: 'Cotton T-Shirt',
    description: 'Heavyweight combed cotton tee, unisex fit.',
    category: 'Apparel',
    basePrice: 25000,
    costPrice: 12000,
    optionNames: ['Size', 'Color'],
    variants: [
      { attrs: { Size: 'S', Color: 'Black' } as Record<string, string>, cost: 11000, price: 22000, low: 10 },
      { attrs: { Size: 'M', Color: 'Black' } as Record<string, string>, cost: 11000, price: 22000, low: 12 },
      { attrs: { Size: 'L', Color: 'Red' } as Record<string, string>, cost: 12000, price: 25000, low: 12 },
      { attrs: { Size: 'XL', Color: 'Red' } as Record<string, string>, cost: 12500, price: 26000, low: 8 },
    ],
  },
  {
    name: 'Denim Jeans',
    description: 'Straight-leg denim, 12oz.',
    category: 'Apparel',
    basePrice: 55000,
    costPrice: 30000,
    optionNames: ['Size', 'Wash'],
    variants: [
      { attrs: { Size: '32', Wash: 'Indigo' } as Record<string, string>, cost: 30000, price: 55000, low: 6 },
      { attrs: { Size: '34', Wash: 'Indigo' } as Record<string, string>, cost: 30000, price: 55000, low: 6 },
      { attrs: { Size: '36', Wash: 'Stone' } as Record<string, string>, cost: 31500, price: 58000, low: 6 },
    ],
  },
  {
    name: 'Running Sneakers',
    description: 'Lightweight mesh runners with EVA midsole.',
    category: 'Footwear',
    basePrice: 85000,
    costPrice: 48000,
    optionNames: ['Size', 'Color'],
    variants: [
      { attrs: { Size: '40', Color: 'White' } as Record<string, string>, cost: 48000, price: 85000, low: 4 },
      { attrs: { Size: '42', Color: 'White' } as Record<string, string>, cost: 48000, price: 85000, low: 4 },
      { attrs: { Size: '43', Color: 'Navy' } as Record<string, string>, cost: 49000, price: 88000, low: 4 },
    ],
  },
  {
    name: 'Rice 5kg (Kyela)',
    description: 'Premium Kyela aromatic rice, 5kg bag.',
    category: 'Groceries',
    basePrice: 18000,
    costPrice: 13500,
    optionNames: [],
    variants: [{ attrs: {} as Record<string, string>, cost: 13500, price: 18000, low: 25 }],
  },
  {
    name: 'Cooking Oil 1L',
    description: 'Refined sunflower cooking oil.',
    category: 'Groceries',
    basePrice: 6500,
    costPrice: 4800,
    optionNames: [],
    variants: [{ attrs: {} as Record<string, string>, cost: 4800, price: 6500, low: 30 }],
  },
  {
    name: 'Wireless Mouse',
    description: '2.4GHz wireless mouse, USB receiver included.',
    category: 'Electronics',
    basePrice: 32000,
    costPrice: 18000,
    optionNames: ['Color'],
    variants: [
      { attrs: { Color: 'Black' } as Record<string, string>, cost: 18000, price: 32000, low: 8 },
      { attrs: { Color: 'Grey' } as Record<string, string>, cost: 18500, price: 32000, low: 8 },
    ],
  },
];

const PURCHASES = [
  {
    number: 'PO-0001',
    supplier: 'Kariakoo Traders Ltd',
    location: 'WH-MAIN',
    daysAgo: 45,
    lines: [
      { product: 'Cotton T-Shirt', attrs: { Size: 'M', Color: 'Black' } as Record<string, string>, qty: 100, cost: 11000 },
      { product: 'Cotton T-Shirt', attrs: { Size: 'L', Color: 'Red' } as Record<string, string>, qty: 80, cost: 12000 },
      { product: 'Denim Jeans', attrs: { Size: '32', Wash: 'Indigo' } as Record<string, string>, qty: 40, cost: 30000 },
      { product: 'Rice 5kg (Kyela)', attrs: {} as Record<string, string>, qty: 200, cost: 13500 },
      { product: 'Cooking Oil 1L', attrs: {} as Record<string, string>, qty: 150, cost: 4800 },
    ],
  },
  {
    // Higher cost on the same variants -> demonstrates FIFO layering and margin
    // compression once the cheaper batch is exhausted.
    number: 'PO-0002',
    supplier: 'Coastal Beverages Co.',
    location: 'WH-MAIN',
    daysAgo: 18,
    lines: [
      { product: 'Rice 5kg (Kyela)', attrs: {} as Record<string, string>, qty: 150, cost: 14200 },
      { product: 'Cooking Oil 1L', attrs: {} as Record<string, string>, qty: 120, cost: 5100 },
      { product: 'Wireless Mouse', attrs: { Color: 'Black' } as Record<string, string>, qty: 60, cost: 18000 },
    ],
  },
  {
    number: 'PO-0003',
    supplier: 'TechPoint Distributors',
    location: 'WH-MAIN',
    daysAgo: 9,
    lines: [
      { product: 'Running Sneakers', attrs: { Size: '42', Color: 'White' } as Record<string, string>, qty: 30, cost: 48000 },
      { product: 'Running Sneakers', attrs: { Size: '43', Color: 'Navy' } as Record<string, string>, qty: 25, cost: 49000 },
      { product: 'Wireless Mouse', attrs: { Color: 'Grey' } as Record<string, string>, qty: 40, cost: 18500 },
      { product: 'Cotton T-Shirt', attrs: { Size: 'XL', Color: 'Red' } as Record<string, string>, qty: 50, cost: 12500 },
    ],
  },
];

const TRANSFERS = [
  {
    number: 'TR-0001',
    from: 'WH-MAIN',
    to: 'ST-MBEZI',
    daysAgo: 30,
    status: 'completed',
    lines: [
      { product: 'Cotton T-Shirt', attrs: { Size: 'M', Color: 'Black' } as Record<string, string>, qty: 40 },
      { product: 'Cotton T-Shirt', attrs: { Size: 'L', Color: 'Red' } as Record<string, string>, qty: 30 },
      { product: 'Rice 5kg (Kyela)', attrs: {} as Record<string, string>, qty: 60 },
      { product: 'Cooking Oil 1L', attrs: {} as Record<string, string>, qty: 50 },
    ],
  },
  {
    number: 'TR-0002',
    from: 'WH-MAIN',
    to: 'ST-KAR',
    daysAgo: 21,
    status: 'completed',
    lines: [
      { product: 'Denim Jeans', attrs: { Size: '32', Wash: 'Indigo' } as Record<string, string>, qty: 15 },
      { product: 'Rice 5kg (Kyela)', attrs: {} as Record<string, string>, qty: 40 },
      { product: 'Wireless Mouse', attrs: { Color: 'Black' } as Record<string, string>, qty: 20 },
    ],
  },
  {
    number: 'TR-0003',
    from: 'WH-MAIN',
    to: 'ST-MBEZI',
    daysAgo: 6,
    status: 'completed',
    lines: [
      { product: 'Running Sneakers', attrs: { Size: '42', Color: 'White' } as Record<string, string>, qty: 10 },
      { product: 'Running Sneakers', attrs: { Size: '43', Color: 'Navy' } as Record<string, string>, qty: 8 },
      { product: 'Wireless Mouse', attrs: { Color: 'Black' } as Record<string, string>, qty: 12 },
      { product: 'Cooking Oil 1L', attrs: {} as Record<string, string>, qty: 40 },
    ],
  },
  {
    // On the road right now: transfer_out written, transfer_in deliberately not.
    number: 'TR-0004',
    from: 'WH-MAIN',
    to: 'ST-KAR',
    daysAgo: 1,
    status: 'in_transit',
    lines: [
      { product: 'Cotton T-Shirt', attrs: { Size: 'L', Color: 'Red' } as Record<string, string>, qty: 20 },
      { product: 'Wireless Mouse', attrs: { Color: 'Grey' } as Record<string, string>, qty: 15 },
      { product: 'Rice 5kg (Kyela)', attrs: {} as Record<string, string>, qty: 30 },
    ],
  },
];

interface SaleSeed {
  location: string;
  cashier: string;
  daysAgo: number;
  hour: number;
  customer?: string;
  payment: string;
  voided?: boolean;
  lines: { product: string; attrs: Record<string, string>; qty: number; discount?: number }[];
}

const SALES: SaleSeed[] = [
  {
    location: 'ST-MBEZI',
    cashier: 'cashier@ims.tz',
    daysAgo: 12,
    hour: 9,
    customer: 'Walk-in',
    payment: 'cash',
    lines: [
      { product: 'Cotton T-Shirt', attrs: { Size: 'M', Color: 'Black' } as Record<string, string>, qty: 3 },
      { product: 'Rice 5kg (Kyela)', attrs: {} as Record<string, string>, qty: 2 },
    ],
  },
  {
    location: 'ST-MBEZI',
    cashier: 'cashier@ims.tz',
    daysAgo: 8,
    hour: 13,
    customer: 'Halima S.',
    payment: 'mobile_money',
    lines: [
      { product: 'Cooking Oil 1L', attrs: {} as Record<string, string>, qty: 6 },
      { product: 'Cotton T-Shirt', attrs: { Size: 'L', Color: 'Red' } as Record<string, string>, qty: 2, discount: 1000 },
    ],
  },
  {
    location: 'ST-KAR',
    cashier: 'store.kariakoo@ims.tz',
    daysAgo: 7,
    hour: 11,
    customer: 'Walk-in',
    payment: 'card',
    lines: [
      { product: 'Denim Jeans', attrs: { Size: '32', Wash: 'Indigo' } as Record<string, string>, qty: 2 },
      { product: 'Wireless Mouse', attrs: { Color: 'Black' } as Record<string, string>, qty: 1 },
    ],
  },
  {
    location: 'ST-MBEZI',
    cashier: 'cashier@ims.tz',
    daysAgo: 4,
    hour: 16,
    customer: 'Juma R.',
    payment: 'cash',
    lines: [{ product: 'Running Sneakers', attrs: { Size: '42', Color: 'White' } as Record<string, string>, qty: 2, discount: 5000 }],
  },
  {
    location: 'ST-KAR',
    cashier: 'store.kariakoo@ims.tz',
    daysAgo: 3,
    hour: 15,
    customer: 'Walk-in',
    payment: 'cash',
    lines: [
      { product: 'Rice 5kg (Kyela)', attrs: {} as Record<string, string>, qty: 10 },
      { product: 'Wireless Mouse', attrs: { Color: 'Black' } as Record<string, string>, qty: 2 },
    ],
  },
  {
    location: 'ST-MBEZI',
    cashier: 'cashier@ims.tz',
    daysAgo: 0,
    hour: 9,
    customer: 'Walk-in',
    payment: 'cash',
    lines: [
      { product: 'Rice 5kg (Kyela)', attrs: {} as Record<string, string>, qty: 8 },
      { product: 'Cooking Oil 1L', attrs: {} as Record<string, string>, qty: 4 },
      { product: 'Cotton T-Shirt', attrs: { Size: 'M', Color: 'Black' } as Record<string, string>, qty: 2 },
    ],
  },
  {
    location: 'ST-MBEZI',
    cashier: 'cashier@ims.tz',
    daysAgo: 0,
    hour: 12,
    customer: 'Asha M.',
    payment: 'mobile_money',
    lines: [
      { product: 'Running Sneakers', attrs: { Size: '43', Color: 'Navy' } as Record<string, string>, qty: 1 },
      { product: 'Wireless Mouse', attrs: { Color: 'Black' } as Record<string, string>, qty: 3, discount: 2000 },
    ],
  },
  {
    location: 'ST-KAR',
    cashier: 'store.kariakoo@ims.tz',
    daysAgo: 0,
    hour: 10,
    customer: 'Walk-in',
    payment: 'cash',
    lines: [
      { product: 'Denim Jeans', attrs: { Size: '32', Wash: 'Indigo' } as Record<string, string>, qty: 1 },
      { product: 'Rice 5kg (Kyela)', attrs: {} as Record<string, string>, qty: 5 },
    ],
  },
  {
    location: 'ST-MBEZI',
    cashier: 'cashier@ims.tz',
    daysAgo: 2,
    hour: 17,
    customer: 'Cancelled ticket',
    payment: 'cash',
    voided: true,
    lines: [{ product: 'Cotton T-Shirt', attrs: { Size: 'L', Color: 'Red' } as Record<string, string>, qty: 1 }],
  },
];

const RETURNS = [
  {
    number: 'RT-0001',
    daysAgo: 6,
    reason: 'customer_return',
    lines: [
      { product: 'Cotton T-Shirt', attrs: { Size: 'L', Color: 'Red' } as Record<string, string>, qty: 1, condition: 'sellable' },
      { product: 'Cooking Oil 1L', attrs: {} as Record<string, string>, qty: 2, condition: 'damaged' },
    ],
  },
];

export async function seedDatabase(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.user.findFirst({ where: { email: 'admin@ims.tz' } });
  if (existing) return;

  // ---- demo tenant -------------------------------------------------------
  const tenant = await prisma.tenant.create({
    data: {
      name: 'Demo Company',
      slug: 'demo',
      isActive: true,
    },
  });
  const tenantId = tenant.id;

  // ---- system roles (scoped to tenant) -----------------------------------
  const roleMap: Record<string, { id: string }> = {};
  for (const sys of SYSTEM_ROLES) {
    const role = await prisma.role.create({
      data: {
        tenantId,
        name: sys.name,
        slug: sys.slug,
        description: sys.description,
        isSystemRole: true,
        permissions: {
          create: sys.permissions.map((action) => ({ action })),
        },
      },
    });
    roleMap[sys.slug] = { id: role.id };
  }

  // ---- locations ----------------------------------------------------------
  const locations = await Promise.all(
    [
      {
        code: 'WH-MAIN',
        name: 'Main Warehouse — Vingunguti',
        type: 'WAREHOUSE',
        address: 'Plot 44, Nyerere Road, Vingunguti, Dar es Salaam',
        phone: '+255 22 219 4000',
        canReceivePurchase: true,
        canSellPos: false,
      },
      {
        code: 'ST-MBEZI',
        name: 'Front Store — Mbezi Beach',
        type: 'RETAIL_STORE',
        address: 'Mbezi Beach Road, Kinondoni, Dar es Salaam',
        phone: '+255 22 277 1180',
        canReceivePurchase: true,
        canSellPos: true,
      },
      {
        code: 'ST-KAR',
        name: 'Front Store — Kariakoo',
        type: 'RETAIL_STORE',
        address: 'Msimbazi Street, Kariakoo, Dar es Salaam',
        phone: '+255 22 246 3390',
        canReceivePurchase: true,
        canSellPos: true,
      },
      {
        code: 'DAMAGED',
        name: 'Damaged / Write-off',
        type: 'DAMAGED',
        address: 'Cage 3, Main Warehouse, Vingunguti',
        canReceivePurchase: false,
        canSellPos: false,
        isDamagedLocation: true,
      },
    ].map((data) => prisma.location.create({ data: { ...data, tenantId } })),
  );
  const loc = Object.fromEntries(locations.map((l) => [l.code, l]));

  // ---- users --------------------------------------------------------------
  const users: Record<string, { id: string; email: string; role: string; name: string }> = {};
  for (const u of USERS) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    const created = await prisma.user.create({
      data: { tenantId, email: u.email, name: u.name, role: u.role, roleId: roleMap[u.role].id, passwordHash },
    });
    for (const code of u.locations) {
      await prisma.userLocation.create({ data: { userId: created.id, locationId: loc[code].id } });
    }
    users[u.email] = { id: created.id, email: created.email, role: created.role, name: created.name };
  }
  const admin = users['admin@ims.tz'];
  const whManager = users['wh.manager@ims.tz'];
  const cashier = users['cashier@ims.tz'];

  const log = async (args: {
    action: string;
    entityType: string;
    entityId?: string;
    entityLabel?: string;
    userEmail: string;
    userRole: string;
    userId?: string;
    after?: unknown;
    createdAt?: Date;
  }) => {
    await prisma.auditLog.create({
      data: {
        tenantId,
        action: args.action,
        entityType: args.entityType,
        entityId: args.entityId ?? null,
        entityLabel: args.entityLabel ?? null,
        userEmail: args.userEmail,
        userRole: args.userRole,
        userId: args.userId ?? null,
        after: args.after === undefined ? null : JSON.stringify(args.after),
        ipAddress: '127.0.0.1',
        userAgent: 'seed-script',
        createdAt: args.createdAt ?? new Date(),
      },
    });
  };

  // ---- categories ---------------------------------------------------------
  const categories: Record<string, { id: string }> = {};
  for (const name of [...new Set(PRODUCTS.map((p) => p.category))]) {
    categories[name] = await prisma.category.create({
      data: { tenantId, name, slug: name.toLowerCase().replace(/\s+/g, '-') },
    });
  }

  // ---- products + variants ------------------------------------------------
  type VariantRef = { id: string; label: string; barcode: string; cost: number; price: number };
  const variants: Record<string, VariantRef> = {};
  const variantById: Record<string, VariantRef> = {};
  const keyOf = (product: string, attrs: Record<string, string>) =>
    `${product}::${Object.entries(attrs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')}`;

  for (const p of PRODUCTS) {
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: p.name,
        description: p.description,
        basePrice: p.basePrice,
        costPrice: p.costPrice,
        categoryId: categories[p.category].id,
        optionNames: p.optionNames.join(','),
      },
    });

    let index = 0;
    for (const v of p.variants) {
      index += 1;
      const attrPairs = Object.entries(v.attrs);
      const label = attrPairs.length ? attrPairs.map(([, val]) => val).join(' / ') : 'Standard';
      const sku = `${p.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}-${label
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 6)
        .toUpperCase()
        .padEnd(3, 'X')}-${String(index).padStart(2, '0')}`;
      const created = await prisma.variant.create({
        data: {
          tenantId,
          productId: product.id,
          attributes: JSON.stringify(v.attrs),
          label,
          sku,
          barcode: generateBarcode(sku),
          costPrice: v.cost,
          sellingPrice: v.price,
          isDefault: index === 1,
          lowStockThreshold: v.low,
        },
      });
      const ref: VariantRef = {
        id: created.id,
        label: `${p.name} — ${label}`,
        barcode: created.barcode,
        cost: v.cost,
        price: v.price,
      };
      variants[keyOf(p.name, v.attrs)] = ref;
      variantById[created.id] = ref;
    }

    await log({
      action: 'create',
      entityType: 'Product',
      entityId: product.id,
      entityLabel: product.name,
      userEmail: admin.email,
      userRole: admin.role,
      userId: admin.id,
      after: { name: product.name, variants: p.variants.length },
      createdAt: at(60, 9),
    });
  }

  // ---- suppliers ----------------------------------------------------------
  const suppliers: Record<string, { id: string }> = {};
  for (const s of [
    {
      code: 'SUP-001',
      name: 'Kariakoo Traders Ltd',
      contactPerson: 'Salim Mzee',
      email: 'sales@kariakootraders.co.tz',
      phone: '+255 754 112 233',
      taxId: 'TIN-118-445-902',
      address: 'Kariakoo Market, Block C, Dar es Salaam',
    },
    {
      code: 'SUP-002',
      name: 'Coastal Beverages Co.',
      contactPerson: 'Esther Lyimo',
      email: 'orders@coastalbev.co.tz',
      phone: '+255 713 887 001',
      taxId: 'TIN-204-771-556',
      address: 'Industrial Area, Temeke, Dar es Salaam',
    },
    {
      code: 'SUP-003',
      name: 'TechPoint Distributors',
      contactPerson: 'Daudi Msigwa',
      email: 'info@techpoint.co.tz',
      phone: '+255 762 445 190',
      taxId: 'TIN-330-118-774',
      address: 'Samora Avenue, CBD, Dar es Salaam',
    },
  ]) {
    const created = await prisma.supplier.create({ data: { ...s, tenantId } });
    suppliers[s.name] = { id: created.id };
  }

  // ---- purchases -> warehouse batches -------------------------------------
  for (const p of PURCHASES) {
    const purchase = await prisma.purchase.create({
      data: {
        tenantId,
        number: p.number,
        supplierId: suppliers[p.supplier].id,
        locationId: loc[p.location].id,
        status: 'confirmed',
        orderDate: at(p.daysAgo, 8),
        total: p.lines.reduce((s, l) => s + l.qty * l.cost, 0),
        notes: 'Seeded purchase order.',
        createdById: whManager.id,
        approvedById: admin.id,
        createdAt: at(p.daysAgo, 8),
        updatedAt: at(p.daysAgo, 9),
        lines: {
          create: p.lines.map((l) => ({
            variantId: variants[keyOf(l.product, l.attrs)].id,
            quantity: l.qty,
            receivedQty: l.qty,
            unitCost: l.cost,
            lineTotal: l.qty * l.cost,
          })),
        },
      },
      include: { lines: true },
    });

    let lineNo = 0;
    for (const line of purchase.lines) {
      lineNo += 1;
      const batch = await prisma.batch.create({
        data: {
          tenantId,
          code: `B-${p.number}-${String(lineNo).padStart(2, '0')}`,
          variantId: line.variantId,
          locationId: loc[p.location].id,
          unitCost: line.unitCost,
          quantity: line.quantity,
          remainingQty: line.quantity,
          receivedAt: at(p.daysAgo, 9),
          purchaseLineId: line.id,
        },
      });
      await recordMovement(prisma, {
        type: 'purchase_in',
        variantId: line.variantId,
        locationId: loc[p.location].id,
        quantity: line.quantity,
        batchId: batch.id,
        status: 'available',
        unitCost: line.unitCost,
        totalCost: line.lineTotal,
        referenceType: 'Purchase',
        referenceId: purchase.id,
        referenceLabel: p.number,
        approvedById: admin.id,
        createdById: whManager.id,
        tenantId,
        notes: `Received ${line.quantity} units on batch ${batch.code}`,
      });
      await prisma.stockMovement.updateMany({
        where: { referenceId: purchase.id, variantId: line.variantId },
        data: { createdAt: at(p.daysAgo, 9) },
      });
    }

    await log({
      action: 'confirm',
      entityType: 'Purchase',
      entityId: purchase.id,
      entityLabel: p.number,
      userEmail: whManager.email,
      userRole: whManager.role,
      userId: whManager.id,
      after: { status: 'confirmed', total: purchase.total, lines: p.lines.length },
      createdAt: at(p.daysAgo, 9),
    });
  }

  // ---- transfers ----------------------------------------------------------
  for (const t of TRANSFERS) {
    const transfer = await prisma.stockTransfer.create({
      data: {
        tenantId,
        number: t.number,
        fromLocationId: loc[t.from].id,
        toLocationId: loc[t.to].id,
        status: t.status,
        requestedAt: at(t.daysAgo, 8),
        shippedAt: at(t.daysAgo, 9),
        completedAt: t.status === 'completed' ? at(t.daysAgo, 11) : null,
        createdById: whManager.id,
        approvedById: whManager.id,
        createdAt: at(t.daysAgo, 8),
        updatedAt: at(t.daysAgo, 11),
        notes: 'Seeded transfer.',
        lines: {
          create: t.lines.map((l) => ({
            variantId: variants[keyOf(l.product, l.attrs)].id,
            quantity: l.qty,
            receivedQty: t.status === 'completed' ? l.qty : 0,
          })),
        },
      },
      include: { lines: true },
    });

    let lineNo = 0;
    for (const line of transfer.lines) {
      lineNo += 1;
      const created = await createTransferBatches(prisma, {
        variantId: line.variantId,
        fromLocationId: loc[t.from].id,
        toLocationId: loc[t.to].id,
        quantity: line.quantity,
        codePrefix: `B-${t.number}-${String(lineNo).padStart(2, '0')}`,
        tenantId,
      });
      for (const piece of created) {
        await consumeFifo(prisma, {
          type: 'transfer_out',
          variantId: line.variantId,
          locationId: loc[t.from].id,
          quantity: piece.quantity,
          status: 'available',
          referenceType: 'StockTransfer',
          referenceId: transfer.id,
          referenceLabel: t.number,
          createdById: whManager.id,
          tenantId,
          notes: `Shipped to ${loc[t.to].name}`,
          onAllocation: () => ({ resultingBatchId: piece.id }),
        });
        await prisma.stockMovement.updateMany({
          where: { referenceId: transfer.id, type: 'transfer_out', resultingBatchId: piece.id },
          data: { createdAt: at(t.daysAgo, 9) },
        });

        if (t.status === 'completed') {
          await recordMovement(prisma, {
            type: 'transfer_in',
            variantId: line.variantId,
            locationId: loc[t.to].id,
            quantity: piece.quantity,
            batchId: piece.id,
            status: 'available',
            unitCost: piece.unitCost,
            totalCost: piece.unitCost * piece.quantity,
            referenceType: 'StockTransfer',
            referenceId: transfer.id,
            referenceLabel: t.number,
            createdById: whManager.id,
            tenantId,
            notes: `Received from ${loc[t.from].name}`,
          });
          await prisma.stockMovement.updateMany({
            where: { referenceId: transfer.id, type: 'transfer_in', batchId: piece.id },
            data: { createdAt: at(t.daysAgo, 11) },
          });
        }
      }
    }

    await log({
      action: t.status === 'completed' ? 'complete' : 'ship',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      entityLabel: t.number,
      userEmail: whManager.email,
      userRole: whManager.role,
      userId: whManager.id,
      after: { status: t.status, from: loc[t.from].name, to: loc[t.to].name },
      createdAt: at(t.daysAgo, 10),
    });
  }

  // ---- POS sales ----------------------------------------------------------
  let saleSeq = 0;
  const saleIds: string[] = [];
  for (const s of SALES) {
    saleSeq += 1;
    const number = `SLE-${String(saleSeq).padStart(5, '0')}`;
    const cashierUser = users[s.cashier];
    const saleLocation = loc[s.location];

    const sale = await prisma.sale.create({
      data: {
        tenantId,
        number,
        locationId: saleLocation.id,
        cashierId: cashierUser.id,
        status: 'draft',
        customerName: s.customer ?? null,
        paymentMethod: s.payment,
        soldAt: at(s.daysAgo, s.hour),
        createdAt: at(s.daysAgo, s.hour),
      },
    });

    let subtotal = 0;
    let discountTotal = 0;
    let totalCost = 0;
    let lineNo = 0;

    for (const l of s.lines) {
      lineNo += 1;
      const variant = variants[keyOf(l.product, l.attrs)];
      const unitPrice = variant.price;
      const discount = l.discount ?? 0;
      const actualPrice = unitPrice - discount;
      const lineTotal = actualPrice * l.qty;

      let fifoUnitCost = variant.cost;
      if (!s.voided) {
        const result = await consumeFifo(prisma, {
          type: 'sale_out',
          variantId: variant.id,
          locationId: saleLocation.id,
          quantity: l.qty,
          status: 'sold',
          referenceType: 'Sale',
          referenceId: sale.id,
          referenceLabel: number,
          createdById: cashierUser.id,
          tenantId,
          variantLabel: variant.label,
          locationName: saleLocation.name,
        });
        fifoUnitCost = result.unitCost;
        await prisma.stockMovement.updateMany({
          where: { referenceId: sale.id, variantId: variant.id },
          data: { createdAt: at(s.daysAgo, s.hour, lineNo) },
        });
      }

      const lineCost = fifoUnitCost * l.qty;
      subtotal += unitPrice * l.qty;
      discountTotal += discount * l.qty;
      totalCost += lineCost;

      await prisma.saleLine.create({
        data: {
          saleId: sale.id,
          variantId: variant.id,
          quantity: l.qty,
          unitCost: fifoUnitCost,
          unitPrice,
          discountAmount: discount * l.qty,
          actualPrice,
          lineTotal,
          lineCost,
          lineProfit: lineTotal - lineCost,
        },
      });
    }

    const total = subtotal - discountTotal;
    await prisma.sale.update({
      where: { id: sale.id },
      data: {
        status: s.voided ? 'voided' : 'completed',
        subtotal,
        discountAmount: discountTotal,
        total,
        amountPaid: s.voided ? 0 : total,
        changeDue: 0,
        totalCost: s.voided ? 0 : totalCost,
        profit: s.voided ? 0 : total - totalCost,
      },
    });
    if (!s.voided) saleIds.push(sale.id);

    await log({
      action: s.voided ? 'void' : 'create',
      entityType: 'Sale',
      entityId: sale.id,
      entityLabel: number,
      userEmail: cashierUser.email,
      userRole: cashierUser.role,
      userId: cashierUser.id,
      after: { status: s.voided ? 'voided' : 'completed', total, location: saleLocation.name },
      createdAt: at(s.daysAgo, s.hour),
    });
  }

  // ---- returns ------------------------------------------------------------
  let returnSeq = 0;
  for (const r of RETURNS) {
    returnSeq += 1;
    const originId = saleIds[Math.min(1, saleIds.length - 1)];
    const originSale = await prisma.sale.findUnique({ where: { id: originId } });
    const returnLocationId = originSale?.locationId ?? loc['ST-MBEZI'].id;

    const returnRecord = await prisma.return.create({
      data: {
        tenantId,
        number: r.number,
        saleId: originId,
        locationId: returnLocationId,
        reason: r.reason,
        status: 'completed',
        createdById: cashier.id,
        createdAt: at(r.daysAgo, 14),
        updatedAt: at(r.daysAgo, 14),
        lines: {
          create: r.lines.map((l) => {
            const variant = variants[keyOf(l.product, l.attrs)];
            return {
              variantId: variant.id,
              quantity: l.qty,
              condition: l.condition,
              unitCost: variant.cost,
              refundAmount: l.condition === 'sellable' ? variant.price * l.qty : 0,
            };
          }),
        },
      },
      include: { lines: true },
    });

    let refund = 0;
    for (const line of returnRecord.lines) {
      if (line.condition === 'sellable') {
        const batches = await prisma.batch.findMany({
          where: { variantId: line.variantId, locationId: returnLocationId },
          orderBy: [{ receivedAt: 'asc' }],
          take: 1,
        });
        const batch = batches[0];
        if (batch) {
          await prisma.batch.update({
            where: { id: batch.id },
            data: { remainingQty: { increment: line.quantity } },
          });
          await recordMovement(prisma, {
            type: 'return_in',
            variantId: line.variantId,
            locationId: returnLocationId,
            quantity: line.quantity,
            batchId: batch.id,
            status: 'available',
            unitCost: batch.unitCost,
            totalCost: batch.unitCost * line.quantity,
            referenceType: 'Return',
            referenceId: returnRecord.id,
            referenceLabel: r.number,
            createdById: cashier.id,
            tenantId,
            notes: 'Customer return, restocked as sellable',
          });
        }
        refund += line.refundAmount;
      } else {
        await recordMovement(prisma, {
          type: 'return_damaged',
          variantId: line.variantId,
          locationId: loc['DAMAGED'].id,
          quantity: line.quantity,
          status: 'available',
          unitCost: line.unitCost,
          totalCost: line.unitCost * line.quantity,
          referenceType: 'Return',
          referenceId: returnRecord.id,
          referenceLabel: r.number,
          createdById: cashier.id,
          tenantId,
          notes: 'Customer return, written off as damaged',
        });
      }
    }

    await prisma.stockMovement.updateMany({
      where: { referenceId: returnRecord.id },
      data: { createdAt: at(r.daysAgo, 14) },
    });
    await prisma.return.update({ where: { id: returnRecord.id }, data: { totalRefund: refund } });
    await log({
      action: 'create',
      entityType: 'Return',
      entityId: returnRecord.id,
      entityLabel: r.number,
      userEmail: cashier.email,
      userRole: cashier.role,
      userId: cashier.id,
      after: { refund, lines: returnRecord.lines.length },
      createdAt: at(r.daysAgo, 14),
    });
  }

  // ---- adjustments --------------------------------------------------------
  const riceId = variants[keyOf('Rice 5kg (Kyela)', {})].id;
  const adj1 = await prisma.stockAdjustment.create({
    data: {
      tenantId,
      number: 'ADJ-0001',
      variantId: riceId,
      locationId: loc['WH-MAIN'].id,
      reason: 'count_correction',
      quantity: -6,
      notes: 'Physical count during month-end audit found 6 bags short.',
      status: 'approved',
      createdById: whManager.id,
      approvedById: admin.id,
      approvedAt: at(15, 16),
      createdAt: at(15, 15),
    },
  });
  const adjBatches = await prisma.batch.findMany({
    where: { variantId: riceId, locationId: loc['WH-MAIN'].id, remainingQty: { gt: 0 } },
    orderBy: [{ receivedAt: 'asc' }],
  });
  if (adjBatches[0]) {
    await prisma.batch.update({
      where: { id: adjBatches[0].id },
      data: { remainingQty: { decrement: 6 } },
    });
    await recordMovement(prisma, {
      type: 'adjustment',
      variantId: riceId,
      locationId: loc['WH-MAIN'].id,
      quantity: -6,
      batchId: adjBatches[0].id,
      status: 'available',
      adjustmentReason: 'count_correction',
      unitCost: adjBatches[0].unitCost,
      totalCost: adjBatches[0].unitCost * 6,
      approvedById: admin.id,
      referenceType: 'StockAdjustment',
      referenceId: adj1.id,
      referenceLabel: 'ADJ-0001',
      createdById: whManager.id,
      tenantId,
      notes: 'Count correction approved',
    });
    await prisma.stockMovement.updateMany({
      where: { referenceId: adj1.id },
      data: { createdAt: at(15, 16) },
    });
  }

  await prisma.stockAdjustment.create({
    data: {
      tenantId,
      number: 'ADJ-0002',
      variantId: variants[keyOf('Cooking Oil 1L', {})].id,
      locationId: loc['ST-MBEZI'].id,
      reason: 'damaged',
      quantity: -4,
      notes: '4 bottles leaked during shelf restocking. Awaiting manager approval.',
      status: 'pending',
      createdById: cashier.id,
      createdAt: at(1, 17),
    },
  });

  // ---- reservations -------------------------------------------------------
  const resv = await prisma.reservation.create({
    data: {
      tenantId,
      number: 'RSV-0001',
      variantId: variants[keyOf('Running Sneakers', { Size: '42', Color: 'White' })].id,
      locationId: loc['ST-MBEZI'].id,
      quantity: 2,
      customerRef: 'Zawadi Hotel — staff uniforms',
      status: 'active',
      createdById: cashier.id,
      createdAt: at(1, 10),
    },
  });
  // A reservation is a reclassification, not a physical move: the held units
  // stay on the shelf (on-hand and lot counters are untouched) but shift from
  // the sellable pool into `reserved`. sellable = onHand - reserved, and FIFO
  // allocation subtracts the reserved balance, so no later sale can take them.
  const resvPieces = await allocateFifo(prisma, {
    variantId: resv.variantId,
    locationId: resv.locationId,
    quantity: resv.quantity,
  });
  for (const piece of resvPieces) {
    await recordMovement(prisma, {
      type: 'reservation',
      variantId: resv.variantId,
      locationId: resv.locationId,
      tenantId,
      quantity: -piece.quantity,
      batchId: piece.batchId,
      status: 'available',
      unitCost: piece.unitCost,
      totalCost: -piece.unitCost * piece.quantity,
      reservationId: resv.id,
      referenceType: 'Reservation',
      referenceId: resv.id,
      referenceLabel: resv.number,
      createdById: cashier.id,
      notes: 'Held for customer',
    });
    await recordMovement(prisma, {
      type: 'reservation',
      variantId: resv.variantId,
      locationId: resv.locationId,
      tenantId,
      quantity: piece.quantity,
      batchId: piece.batchId,
      status: 'reserved',
      unitCost: piece.unitCost,
      totalCost: piece.unitCost * piece.quantity,
      reservationId: resv.id,
      referenceType: 'Reservation',
      referenceId: resv.id,
      referenceLabel: resv.number,
      createdById: cashier.id,
      notes: 'Held for customer',
    });
  }

  // ---- a draft purchase (shows the pending workflow) ----------------------
  await prisma.purchase.create({
    data: {
      tenantId,
      number: 'PO-0004',
      supplierId: suppliers['Kariakoo Traders Ltd'].id,
      locationId: loc['WH-MAIN'].id,
      status: 'draft',
      orderDate: new Date(),
      notes: 'Draft reorder — not confirmed yet, so no stock movement exists.',
      createdById: whManager.id,
      total: 660000 + 720000,
      lines: {
        create: [
          {
            variantId: variants[keyOf('Cotton T-Shirt', { Size: 'S', Color: 'Black' })].id,
            quantity: 60,
            unitCost: 11000,
            lineTotal: 660000,
          },
          {
            variantId: variants[keyOf('Denim Jeans', { Size: '34', Wash: 'Indigo' })].id,
            quantity: 24,
            unitCost: 30000,
            lineTotal: 720000,
          },
        ],
      },
    },
  });

  await log({
    action: 'login',
    entityType: 'User',
    entityId: admin.id,
    entityLabel: admin.email,
    userEmail: admin.email,
    userRole: admin.role,
    userId: admin.id,
    after: { note: 'Demo dataset loaded' },
  });

  // eslint-disable-next-line no-console
  console.log(`[seed] demo dataset created for tenant "${tenant.name}".\n[seed] ${DEMO_PASSWORD_NOTE}`);
}
