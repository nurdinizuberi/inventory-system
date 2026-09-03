-- Variants created through POST /api/products used to be written without a
-- tenantId (the nested create omitted it), so they ended up stamped NULL while
-- their owning product carried the tenant's id. Tenant-scoped variant queries
-- (e.g. /api/variants?light=1 behind the purchases/transfers/adjustments item
-- pickers) filter on variant.tenantId, which silently hid those variants and
-- made every picker empty. Inherit the owning product's tenantId for any
-- variant that is missing one. Variants whose product is also tenant-less are
-- left untouched (nothing to inherit from).
UPDATE "Variant" v
SET "tenantId" = p."tenantId"
FROM "Product" p
WHERE v."productId" = p.id
  AND v."tenantId" IS NULL
  AND p."tenantId" IS NOT NULL;
