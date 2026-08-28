# ---------------------------------------------------------------------------
# Inventory Management System — production image
# ---------------------------------------------------------------------------
FROM node:20-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Public env only — JWT_SECRET is injected at runtime, never baked in.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV AUTO_SEED=0
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build /app ./
RUN mkdir -p /app/prisma && chown -R nextjs:nodejs /app/prisma
USER nextjs
EXPOSE 3004
ENV HOSTNAME=0.0.0.0 PORT=3004
# Apply tracked migrations (never `db push`/`db seed`) then start. The empty-DB
# demo auto-seed runs only when AUTO_SEED=1 (set it explicitly for demos).
CMD ["sh", "-c", "npx prisma migrate deploy --skip-generate && npm run start"]
