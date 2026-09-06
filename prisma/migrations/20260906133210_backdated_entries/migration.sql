-- AlterTable
ALTER TABLE "Return" ADD COLUMN     "backdateReason" TEXT,
ADD COLUMN     "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "isBackdated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StockAdjustment" ADD COLUMN     "backdateReason" TEXT,
ADD COLUMN     "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "isBackdated" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: pre-existing rows were recorded on the day they were entered, so
-- their effective date is their creation time — never today (the column
-- default), which would wrongly surface them as brand-new/backdated activity.
UPDATE "Return" SET "effectiveDate" = "createdAt" WHERE "effectiveDate" IS DISTINCT FROM "createdAt";
UPDATE "StockAdjustment" SET "effectiveDate" = "createdAt" WHERE "effectiveDate" IS DISTINCT FROM "createdAt";
