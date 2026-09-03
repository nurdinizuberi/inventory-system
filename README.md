# Inventory Management System — Warehouse → Retail

A full-stack, **multi-tenant** inventory system that models the real flow of goods:

```
Purchase → Main Warehouse → Stock Transfer → Retail Store → POS → Reports & Audit
```

Every product is a catalogue entry; every sellable item is a **variant**. Every quantity is
tracked **per variant, per location** on an append-only movement ledger — never as a flat number
on the product. Every record — users, roles, locations, batches, sales, ledger rows — belongs to a
**tenant**, so several organizations can share the same deployment without seeing each other's data.

---

## Run it

```bash
npm install
npm run setup      # prisma generate + migrate dev + seed demo data
npm run dev        # http://localhost:3004 (dev and start both bind 3004)
```

The app uses **PostgreSQL** (schema provider is `postgresql`). Point `DATABASE_URL` in `.env`
at any Postgres instance you control (see `.env.example`). The quickest full environment is the
bundled stack: `docker compose up --build` brings up Postgres + the app on `http://localhost:3004`
and auto-seeds demo data on the empty volume.

### Demo logins

| Role                | Email                  | Password       | Can do                                                    |
| ------------------- | ---------------------- | -------------- | --------------------------------------------------------- |
| Admin               | `admin@ims.tz`         | `admin123`     | Everything, incl. users and the audit log                  |
| Warehouse Manager   | `wh.manager@ims.tz`    | `warehouse123` | Purchases, transfers, warehouse stock, all reports. No POS |
| Store Manager       | `store.mbezi@ims.tz`   | `store123`     | POS + returns + transfers at Mbezi Beach only              |
| Store Manager       | `store.kariakoo@ims.tz`| `store123`     | Same, at Kariakoo only                                     |
| Cashier             | `cashier@ims.tz`       | `cashier123`   | Sells at Mbezi, sees only their own tickets                |
| Auditor             | `auditor@ims.tz`       | `audit123`     | Read-only everywhere, incl. the audit log                  |

Sign in as the **cashier** and try to open a purchase — the server refuses it. That is the point:
permissions are enforced in `src/lib/rbac.ts` on every request, not hidden in the UI.

A separate **global admin** (no tenant, above all of them) manages the organizations themselves —
see [Multi-tenancy](#multi-tenancy) below.

---

## Checks

```bash
npm run typecheck       # tsc --noEmit
npm run build           # prisma generate + next build (validates every route export)
npm run verify:ledger   # ledger invariants against the database
bash scripts/e2e.sh     # 49 end-to-end API assertions (needs a running server on :3004)
```

`BASE=http://127.0.0.1:3004` is the default; override it to point the suite at any server.

`verify:ledger` asserts:

1. on-hand per (variant, location) equals `SUM(quantity)` over the ledger;
2. that figure reconciles with the batch-level counters, accounting for goods in
   transit and damaged write-offs;
3. no negative stock anywhere;
4. reserved stock never exceeds on-hand;
5. FIFO can never allocate more than the sellable pool;
6. cost of goods on sale lines equals `SUM(totalCost)` of the `sale_out` ledger rows.

`scripts/e2e.sh` exercises the real HTTP API: authentication, the RBAC matrix, location
capability flags, purchase receipt, transfer ship/receive, FIFO costing at the till, oversell
blocking, returns (sellable vs damaged), the adjustment approval gate, all six reports, and the
audit trail.

---

## How stock actually works

### The ledger is the only source of truth

`StockMovement` is an append-only table. Nothing stores a running total.

```
onHand   = SUM(quantity)                                  -- over ALL rows for the pair
reserved = SUM(quantity) WHERE status = 'reserved'
sellable = onHand - reserved
```

Outbound rows (`sale_out`, `transfer_out`, `return_damaged`, negative adjustments) are stored
**negative**, so a plain sum is the balance. `status` marks the bucket a row belongs to: a
`sale_out` row is negative and bucketed `sold`; a reservation writes a positive `reserved` row,
which is what removes those units from the sellable pool without changing on-hand (the goods are
still on the shelf).

| `type`                | Direction | Notes                                            |
| --------------------- | --------- | ------------------------------------------------ |
| `purchase_in`         | +         | goods receipt, opens a batch                     |
| `transfer_out`        | −         | source side of a transfer                        |
| `transfer_in`         | +         | destination side, written on receipt             |
| `sale_out`            | −         | POS sale, FIFO consumed                          |
| `return_in`           | +         | sellable return restocked                        |
| `return_damaged`      | +         | damaged return into the write-off location       |
| `reservation`         | +         | hold (bucket `reserved`)                         |
| `reservation_release` | −         | hold cancelled                                   |
| `adjustment`          | ±         | only after a manager approves it                 |

### Batches and FIFO

A confirmed purchase opens one `Batch` per line, carrying `unitCost` and `receivedAt`. Selling or
transferring consumes the oldest batches with remaining stock first, and the cost of the batches
actually consumed becomes the cost of goods on that line:

```
line profit = (actual price − FIFO unit cost) × quantity
```

A transfer creates a new batch at the destination that **inherits the source unit cost and the
source received date**, so FIFO ordering survives the move instead of resetting at the store.

### Transfers write both sides

Shipping writes `transfer_out` at the source (and pre-creates the destination batches). Receiving
writes `transfer_in`. Goods in transit belong to neither shelf — the destination store cannot sell
them until someone receives them.

### Adjustments are gated

Raising an adjustment creates a `pending` record and touches nothing. A manager's approval is what
writes the ledger row — write-offs consume FIFO (so the loss is booked at real cost), found stock
opens a new batch. The approving user's id is stamped on the movement row.

---

## Permissions

Declared once in `src/lib/rbac.ts` and enforced by `guard()` at the top of every route handler:

1. valid session (JWT in an httpOnly cookie, role + location claims, re-checked against the DB);
2. the action against the role matrix;
3. that the location is one the user is assigned to;
4. that the location carries the capability the operation needs
   (`can_receive_purchase`, `can_sell_pos`).

Location scoping follows who actually operates there: you may ship **from** a location you own and
receive **into** a location you own. A warehouse manager therefore ships to any store, and the
store's own manager books the goods in.

---

## Multi-tenancy

Every entity the business touches — users, roles, locations, products, variants, batches, sales,
purchases, transfers, returns, adjustments and **every ledger row and audit entry** — carries a
`tenantId`. Tenant isolation is enforced consistently:

- sessions are JWTs in an httpOnly cookie, minted against exactly one tenant, whose id is stamped
  on every row the session writes (`tenantId` is propagated to the movement ledger, so even
  reservation holds, returns and restore write-offs are never tenant-less);
- every query filters on the session's tenant, and `guard()` re-checks identity against the DB on
  each request.

Provisioning a new organization is atomic: the admin layer creates the tenant, seeds the five
system roles (`SYSTEM_ROLES` in `src/lib/rbac.ts`) and a Tenant Admin user in one transaction.

The **global admin portal** lives at `/admin` — a platform layer above the tenants. It is
deliberately not linked from the application's navigation to keep it out of the way; navigate to
`/admin` directly. Sign in with the global admin seeded by `npm run setup`:

| Layer | Login                | Password   | Can do                                        |
| ----- | -------------------- | ---------- | --------------------------------------------- |
| Global admin | `admin@mindboxafrica.com` | `admin123` | Create/deactivate organizations, inspect tenants |

It lists every organization with live user/location/product/sales counts, drills into a tenant's
users and locations, and activates or deactivates whole organizations.

---

## Backdating

Purchases, transfers, sales, returns and adjustments accept a past `effectiveDate`. The ledger row
is stamped `isBackdated` when its effective date precedes the moment it was entered, along with a
required `backdateReason` (the POS and document forms warn before you submit one). Reports and the
ledger verifier honour effective dates, and the **Backdated entries (30d)** report on the audit
page surfaces anything punched into the past for review by admins.

---

## Audit log vs stock ledger

They are different things and deliberately separate:

- **`StockMovement`** — business data. What physically happened to stock.
- **`AuditLog`** — system activity. Who created/updated/confirmed/approved/voided what, with
  before/after snapshots, IP and user agent.

The audit log has no update or delete path anywhere in the app; `src/app/api/audit/route.ts` only
ever performs a `SELECT`. Visible to Admin and Auditor only.

Every audit entry is stamped with the tenant it was written for, and the audit endpoint is scoped
to the current tenant on read — so an organization can **only ever see its own audit logs**, never
another organization's activity. The audit page also has filters for entity type, action and a
**user filter**, so you can pull up everything one person did (for example, hold one user
accountable for a change a shared login made).

**Archived (inactive) products** still appear exactly where they should: they hold no active
inventory but their historical ledger rows, batches, sales and purchases all remain intact, and
their audit trail is preserved. Archiving never destroys business data.

---

## Products, variants, categories & stock on hand

- **Categories are fully user-managed.** Create them inline while adding a product (the “+ New”
  button next to the category picker), or open **Manage categories** to add, rename or delete them.
  A category with products still assigned cannot be deleted — reassign or archive those products
  first.
- **Editing a product** opens the same form used to create one: name, description, category,
  prices, option names, and per-variant SKU/barcode/cost/price/low-stock. Every change is audited.
  If your role lacks `variant.update`, you can still edit the product-level fields.
- **Stock is displayed, never stored.** The product list shows a **Total on hand** column, and
  expanding a product reveals each variant’s on-hand/sellable/reserved breakdown per location, all
  derived in real time from the movement ledger.
- **Archiving is reversible.** Archive a product to withdraw it (and its variants) from lists and
  the POS. Switch to the **Archived** tab to see what you removed and **Restore** it at any time —
  its stock, batches and history come straight back undamaged.

---

## Reports

All six are queries over the ledger and the sale lines, not hand-maintained tables:

| Report                | Source                                                                  |
| --------------------- | ----------------------------------------------------------------------- |
| Sales                 | completed sales + FIFO cost per line, grouped by day/location/cashier/variant |
| Current stock         | `SUM(quantity)` per variant per location, with low-stock thresholds     |
| Purchase history      | confirmed POs by supplier and variant, with the batches they opened     |
| Transfer history      | transfer ledger rows, valued at batch cost, grouped by lane             |
| Profit & loss         | revenue − FIFO COGS − refunds − damaged write-offs − shrinkage at cost  |
| Inventory valuation   | FIFO/lot value, latest-cost value and weighted-average value side by side |

---

## Stack

- **Next.js 15** (App Router) + TypeScript — UI and API routes in one deployable
- **Prisma** — PostgreSQL-first schema in `prisma/schema.prisma`, versioned migrations in `prisma/migrations`
- **Tailwind CSS** — UI
- **JWT** in an httpOnly cookie, with role and location claims
- **zod** — request validation at every boundary

### PostgreSQL migrations

Schema changes are versioned migrations — every environment applies the same DDL:

```bash
npx prisma migrate dev      # local dev: create the next migration, then apply it
npx prisma migrate deploy   # any environment: apply pending migrations only
npx prisma db seed          # demo data (respects AUTO_SEED=0)
```

`npm run setup` runs the `migrate dev` flow for a fresh clone. Avoid `prisma db push` outside a
throwaway dev database — it does not produce a replayable migration.

Or just `docker compose up --build` — Postgres and the app come up together with demo data.

---

## Layout

```
prisma/
  schema.prisma        entities + relations
  seed.ts              entry point: global admin + demo dataset per tenant
  seed-data.ts         demo dataset (purchases, transfers, sales, returns)
  verify-ledger.ts     ledger invariants
scripts/e2e.sh         end-to-end API test suite (49 assertions)
src/lib/
  rbac.ts              the permission matrix + guard()
  stock.ts             ledger writes and derived stock
  fifo.ts              batch allocation, FIFO consumption, transfer batches
  audit.ts             the only writer to AuditLog
  purchase-service.ts  goods receipt
  transfer-service.ts  ship / receive / cancel
  reservation-service.ts  hold / release / fulfil
  admin-auth.ts        global admin sessions (portal at /admin)
  types.ts             role slugs, payment methods, shared domain types
src/app/
  api/...              43 route handlers
  admin/               global admin portal (undiscoverable from the app nav)
  pos/  sales/  purchases/  transfers/  returns/  adjustments/
  products/  locations/  suppliers/  users/  roles/  audit/  stock/
  reports/{sales,stock,purchases,transfers,pnl,valuation}/
```

---

## Deployment

### Vercel (primary path)

Plain Next.js — import the repo on Vercel, or `npm i -g vercel && vercel`.
`vercel.json` pins the build command (`npx prisma generate && next build`) and npm as the
installer.

1. **Database** — create a Postgres (Vercel Postgres, Neon or Supabase) and set `DATABASE_URL`
   to its **read/write direct** URL. Transactional workloads use `maxWait`/`timeout` tuned for
   direct connections; don't route through a transaction-mode pooler unless it is grant-your-connection type.
2. **Apply migrations once** — Vercel builds only *generate* the client; they never run DDL,
   so apply them yourself before the first deploy and after every schema change:
   ```bash
   npx prisma migrate deploy   # against the production DATABASE_URL
   ```
3. **Environment variables** (Settings → Environment Variables):
   | Variable | Required | Notes |
   | --- | --- | --- |
   | `DATABASE_URL` | yes | direct Postgres connection string |
   | `JWT_SECRET` | yes | the app refuses to start in production without it (`openssl rand -hex 32`) |
   | `JWT_EXPIRES_IN` | no | defaults to `12h` |
   | `NEXT_PUBLIC_CURRENCY` | no | build-time, defaults to `TZS` |
   | `AUTO_SEED` | set to `0` | keeps demo data off a production database |
   | `NEXT_PUBLIC_APP_URL` | no | canonical origin used to build absolute links in emails (defaults to the request `Host`) |
   | `RESEND_API_KEY` | no | enables transactional email (password reset, email verification) via Resend |
   | `EMAIL_FROM` | no | sender line; defaults to `MindBoxAfrica <no-reply@mindboxafrica.vercel.app>` |
   | `EMAIL_PROVIDER` | no | `resend` (default when a key is set) or `console` to print instead of send |
   | `REQUIRE_EMAIL_VERIFICATION` | no | `1` to block sign-in until the email address is confirmed |
   | `APP_BASE_DOMAIN` | no | your apex domain (e.g. `mindboxafrica.com`) once you move off `*.vercel.app`; apex/www are bare, subdomains are tenants |
   | `ERROR_WEBHOOK_URL` | no | if set, server errors are POSTed here (Slack/Zapier/custom endpoint) alongside structured JSON logs |
4. **Multi-tenant subdomains** — each tenant is a subdomain (`acme.yourdomain.com`); the
   middleware reads the `Host` header and forwards the subdomain as `x-tenant-slug`. Add your
   **apex domain** plus **`*.yourdomain.com`** as Vercel domains (Vercel handles wildcard DNS
   records and lets you enable automatic TLS). The global admin portal lives on the **apex**
   under `/admin` and is exempt from tenant resolution.
5. **Health check** — `GET /api/health` returns `{ "ok": true, ... }` and is exempt from tenant
   resolution. Point your uptime monitor at it.
6. **Rollout order** — on any deploy that ships a migration, run `prisma migrate deploy` against
   production *before* Vercel rolls traffic, or users will hit missing-table errors until the
   deploy completes.

### Self-hosted (Docker)

`docker compose up --build` runs Postgres + the app on `http://localhost:3004`. The container
applies `prisma migrate deploy` on boot and seeds demo data only when the DB is empty **and**
`AUTO_SEED=1`. For a real deployment: set `AUTO_SEED=0`, a strong unique `JWT_SECRET`, and put
the stack behind a reverse proxy that terminates TLS **while preserving the Host header**
(subdomain-based tenant routing depends on it). Wildcard DNS plus a wildcard TLS certificate are
required for multi-tenant subdomains.
