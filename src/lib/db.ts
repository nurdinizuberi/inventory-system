import { PrismaClient } from '@prisma/client';
import { ensureSeeded } from './seed-runner';

export type { Prisma } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  seeded?: boolean;
};

/**
 * Transaction defaults. A purchase receipt or a sale writes one ledger row per
 * line inside a single transaction, and on SQLite (dev/demo) the default 5s
 * interactive-transaction budget is not enough — it expired mid-commit and the
 * whole write failed. 20s is generous without hiding a genuine hang.
 */
export const TX_OPTIONS = { maxWait: 5000, timeout: 20000 } as const;

function makeClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * Makes the app usable immediately after `npm install`: if the database has no
 * users yet (fresh clone / fresh docker volume) the demo dataset is loaded.
 * Disable with AUTO_SEED=0.
 */
export async function bootstrapDatabase(): Promise<void> {
  if (globalForPrisma.seeded) return;
  globalForPrisma.seeded = true;
  if (process.env.AUTO_SEED === '0') return;
  try {
    await ensureSeeded(prisma);
  } catch (err) {
    // Never let a seeding hiccup take the app down; surface it in the log.
    console.error('[bootstrap] auto-seed failed:', err);
  }
}
