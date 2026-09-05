-- ---------------------------------------------------------------------------
-- Data migration: normalize legacy variant products.
--
-- The app now follows a single pricing model:
--   * a plain product prices itself on the product row (basePrice/costPrice);
--   * a variant product prices each variant individually, with the product
--     row kept at 0 (it no longer owns a price).
--
-- Products created before this model was introduced may still carry their
-- price/cost on the product row with NULL per-variant overrides. Those rows
-- made the products page fall back to the parent default (so every variant
-- appeared to share the parent's cost/price) and, worse, kept a hidden parent
-- price alive that POS / reservations / adjustments / valuation all inherited.
--
-- This backfills the product default onto each sellable variant that does not
-- already price itself, then clears the now-redundant product-level price/cost
-- for those variant products, so legacy rows behave exactly like new ones.
--
-- It is idempotent and safe to run again: it only touches genuinely variant
-- products (products that own at least one variant and are not a plain single
-- default 'Standard' variant) and only fills a variant slot that is still NULL.
-- ---------------------------------------------------------------------------

-- 1. Snapshot the product default onto each sellable variant that has none.
--    A value is only written when the parent default is positive, so we never
--    stamp 0 over a blank slot (an unpriced item is a separate data problem).
--    Only active variants are priced; archived variants are not sold.
WITH variant_product AS (
    SELECT "id" AS "productId"
    FROM "Product"
    WHERE (SELECT COUNT(*) FROM "Variant" v WHERE v."productId" = "Product"."id") > 0
      AND (
          (SELECT COUNT(*) FROM "Variant" v WHERE v."productId" = "Product"."id") > 1
          OR NOT EXISTS (
              SELECT 1 FROM "Variant" v
              WHERE v."productId" = "Product"."id"
                AND v."isDefault" = true
                AND v."label" = 'Standard'
          )
      )
)
UPDATE "Variant" AS v
SET "sellingPrice" = CASE WHEN p."basePrice" > 0 THEN p."basePrice" ELSE v."sellingPrice" END,
    "costPrice"    = CASE WHEN p."costPrice" > 0 THEN p."costPrice" ELSE v."costPrice" END
FROM "Product" AS p
JOIN variant_product vp ON vp."productId" = p."id"
WHERE v."productId" = p."id"
  AND v."isActive" = true
  AND (v."sellingPrice" IS NULL OR v."costPrice" IS NULL);

-- 2. Clear the now-redundant product-level price/cost for variant products so
--    nothing anywhere inherits a hidden parent price.
WITH variant_product AS (
    SELECT "id" AS "productId"
    FROM "Product"
    WHERE (SELECT COUNT(*) FROM "Variant" v WHERE v."productId" = "Product"."id") > 0
      AND (
          (SELECT COUNT(*) FROM "Variant" v WHERE v."productId" = "Product"."id") > 1
          OR NOT EXISTS (
              SELECT 1 FROM "Variant" v
              WHERE v."productId" = "Product"."id"
                AND v."isDefault" = true
                AND v."label" = 'Standard'
          )
      )
)
UPDATE "Product" AS p
SET "basePrice" = 0,
    "costPrice" = 0
FROM variant_product vp
WHERE vp."productId" = p."id";
