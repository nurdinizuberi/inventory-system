/* eslint-disable no-console */
/**
 * Production bootstrap: wipes demo data and creates a real global admin.
 *
 * DANGEROUS — deletes ALL rows in every app table. Only run against a database
 * you intend to start clean (a fresh production DB). Refuses to run unless you
 * pass CONFIRM_RESET=1 and a real NODE_ENV !== "development" (or explicitly
 * set FORCE_RESET=1 for a local/staging reset).
 *
 * Required env:
 *   DATABASE_URL          target database
 *   ADMIN_EMAIL           global admin email
 *   ADMIN_PASSWORD        global admin password
 *   ADMIN_NAME            optional display name (default "Global Admin")
 *
 * Run from your machine (where the DB is reachable):
 *   DATABASE_URL="postgresql://..." ADMIN_EMAIL=you@example.com \
 *   ADMIN_PASSWORD='hunter2' CONFIRM_RESET=1 npx tsx prisma/reset-production.ts
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const confirm = process.env.CONFIRM_RESET === '1';
  const force = process.env.FORCE_RESET === '1';
  const production = process.env.NODE_ENV === 'production';
  if (!confirm) {
    console.error('Refusing: set CONFIRM_RESET=1 to wipe and re-bootstrap.');
    process.exitCode = 1;
    return;
  }
  if ((!production && !force)) {
    console.error(
      'Refusing: this wipes a database. Set NODE_ENV=production, or FORCE_RESET=1 for local/staging.',
    );
    process.exitCode = 1;
    return;
  }

  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!email || password.length < 6) {
    console.error('Refusing: ADMIN_EMAIL and ADMIN_PASSWORD (>=6 chars) are required.');
    process.exitCode = 1;
    return;
  }

  // Clear all app data (FK order solved by TRUNCATE CASCADE).
  const tables = [
    'AuditLog', 'RolePermission', 'UserLocation', 'LoginAttempt',
    'Batch', 'Variant', 'Category', 'Supplier', 'Location', 'Product',
    'StockAdjustment', 'TransferLine', 'ReturnLine', 'SaleLine', 'PurchaseLine',
    'Reservation', 'StockTransfer', 'Return', 'Sale', 'Purchase',
    'User', 'Role', 'Tenant',
  ];
  for (const t of tables) {
    await prisma.$queryRawUnsafe(`TRUNCATE TABLE "${t}" CASCADE`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.user.create({
    data: {
      email,
      name: process.env.ADMIN_NAME || 'Global Admin',
      role: 'ADMIN',
      passwordHash,
      tenantId: null,
    },
  });

  const counts = await Promise.all([
    prisma.user.count(), prisma.tenant.count(), prisma.role.count(),
    prisma.product.count(), prisma.sale.count(), prisma.stockMovement.count(),
  ]);
  console.log('[reset] done. users=%d tenants=%d roles=%d products=%d sales=%d movements=%d', ...counts);
  console.log('[reset] global admin created: %s', admin.email);
}

main()
  .catch((err) => {
    console.error('[reset] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });