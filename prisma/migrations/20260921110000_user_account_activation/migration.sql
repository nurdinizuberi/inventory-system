-- Account activation / lifecycle (backward compatible, purely additive).
--
-- Adds a first-class account status to User without touching existing rows:
--   PENDING   invited, no usable password yet, cannot sign in until activated
--   ACTIVE    can sign in
--   SUSPENDED blocked from signing in
--
-- Backfill policy:
--   * every existing user becomes ACTIVE, keeping their id, role, password and
--     all historical data exactly as-is;
--   * users who were already disabled (isActive = false) map to SUSPENDED so
--     they remain blocked, preserving prior behaviour.
-- `isActive` is kept as a derived mirror of status (isActive = status=ACTIVE)
-- so pre-existing auth paths (login, sessions, admin portal) are unaffected.

ALTER TABLE "User" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "User" ADD COLUMN "activatedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
ALTER TABLE "User" ADD COLUMN "invitedById" TEXT;
ALTER TABLE "User" ADD COLUMN "activationTokenHash" TEXT;
ALTER TABLE "User" ADD COLUMN "activationTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "lastInvitedAt" TIMESTAMP(3);

-- Existing disabled users were effectively suspended; keep them blocked.
UPDATE "User" SET "status" = 'SUSPENDED' WHERE "isActive" = false;

-- Users who are active today are considered verified-and-active as of now;
-- stamp their activation time so ACTIVE accounts always have one.
UPDATE "User" SET "activatedAt" = COALESCE("activatedAt", "createdAt") WHERE "status" = 'ACTIVE';

ALTER TABLE "User" ADD CONSTRAINT "User_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "User_status_idx" ON "User"("status");
CREATE INDEX "User_invitedById_idx" ON "User"("invitedById");
