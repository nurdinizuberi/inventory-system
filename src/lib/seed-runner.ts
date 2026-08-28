import type { PrismaClient } from '@prisma/client';
import { seedDatabase } from '../../prisma/seed-data';

let running: Promise<void> | null = null;

/** Seeds the demo dataset exactly once per process, only if the DB is empty. */
export function ensureSeeded(prisma: PrismaClient): Promise<void> {
  if (!running) {
    running = seedDatabase(prisma).catch((err) => {
      running = null;
      throw err;
    });
  }
  return running;
}
