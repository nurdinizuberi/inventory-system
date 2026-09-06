-- DropIndex
DROP INDEX "Batch_purchaseLineId_key";

-- AlterTable
ALTER TABLE "PurchaseLine" ADD COLUMN     "expiresAt" TIMESTAMP(3);
