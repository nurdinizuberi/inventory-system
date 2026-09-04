-- Retail stores were only treated as receiving points when the tenant had no
-- receiving location at all, so accounts that set up a warehouse first could
-- never register products or purchase orders straight into their shop — stock
-- had to flow warehouse -> transfer -> store. Stores are now receiving points
-- by default (see POST /api/locations), so enable the flag on every existing
-- active retail store that sells at POS. The flag remains toggleable on the
-- Locations page for shops that should not take direct deliveries.
UPDATE "Location"
SET "canReceivePurchase" = true
WHERE "type" = 'RETAIL_STORE'
  AND "isActive" = true
  AND "canSellPos" = true
  AND "canReceivePurchase" = false;
