import { defineConfig } from 'prisma/config';

// The Prisma CLI does not auto-load `.env` once a config file exists, so load
// it manually (Node >= 20.12). In CI / on Vercel the variables are injected by
// the platform instead, and this becomes a no-op.
try {
  (
    process as unknown as {
      loadEnvFile?: (path?: string) => void;
    }
  ).loadEnvFile?.('.env');
} catch {
  // .env is absent or ignored — use the actual environment as-is.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});