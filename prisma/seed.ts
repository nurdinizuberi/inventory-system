import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { DEMO_PASSWORD_NOTE, seedDatabase } from './seed-data';

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_IN_PRODUCTION !== '1') {
    // eslint-disable-next-line no-console
    console.log('[seed] skipped (production — set SEED_IN_PRODUCTION=1 to force)');
    return;
  }
  if (process.env.AUTO_SEED === '0') {
    // eslint-disable-next-line no-console
    console.log('[seed] skipped (AUTO_SEED=0)');
    return;
  }
  // Create a global admin user (no tenant) for the admin portal
  const globalAdmin = await prisma.user.findFirst({
    where: { email: 'admin@mindboxafrica.com', tenantId: null },
  });
  if (!globalAdmin) {
    const passwordHash = await bcrypt.hash('admin123', 10);
    await prisma.user.create({
      data: {
        email: 'admin@mindboxafrica.com',
        name: 'Global Admin',
        role: 'ADMIN',
        passwordHash,
        tenantId: null,
      },
    });
    // eslint-disable-next-line no-console
    console.log('[seed] global admin created: admin@mindboxafrica.com / admin123');
  }

  await seedDatabase(prisma);
  const users = await prisma.user.count();
  const movements = await prisma.stockMovement.count();
  // eslint-disable-next-line no-console
  console.log(`[seed] done. users=${users} movements=${movements}`);
  // eslint-disable-next-line no-console
  console.log(`[seed] ${DEMO_PASSWORD_NOTE}`);
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
