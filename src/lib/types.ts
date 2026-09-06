// ---------------------------------------------------------------------------
// Domain constants. Kept as string unions (not provider enums) so the same
// code + schema runs on SQLite and PostgreSQL without changes.
// ---------------------------------------------------------------------------

export const ROLES = ['ADMIN', 'WAREHOUSE_MANAGER', 'STORE_MANAGER', 'CASHIER', 'AUDITOR'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  WAREHOUSE_MANAGER: 'Warehouse Manager',
  STORE_MANAGER: 'Store Manager',
  CASHIER: 'Cashier',
  AUDITOR: 'Auditor / Viewer',
};

export const LOCATION_TYPES = ['WAREHOUSE', 'RETAIL_STORE', 'DAMAGED'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  WAREHOUSE: 'Warehouse',
  RETAIL_STORE: 'Retail Store',
  DAMAGED: 'Damaged / Write-off',
};

export const MOVEMENT_TYPES = [
  'purchase_in',
  'transfer_out',
  'transfer_in',
  'sale_out',
  'return_in',
  'return_damaged',
  'reservation',
  'reservation_release',
  'adjustment',
  'opening_stock',
  'revaluation',
  'product_edit',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  purchase_in: 'Purchase In',
  transfer_out: 'Transfer Out',
  transfer_in: 'Transfer In',
  sale_out: 'Sale Out',
  return_in: 'Return In',
  return_damaged: 'Return (Damaged)',
  reservation: 'Reservation',
  reservation_release: 'Reservation Release',
  adjustment: 'Adjustment',
  opening_stock: 'Opening Stock',
  revaluation: 'Cost Revaluation',
  product_edit: 'Product Edit',
};

export const MOVEMENT_STATUS = ['available', 'reserved', 'sold'] as const;
export type MovementStatus = (typeof MOVEMENT_STATUS)[number];

export const ADJUSTMENT_REASONS = ['damaged', 'theft', 'expired', 'misplaced', 'count_correction'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  damaged: 'Damaged',
  theft: 'Theft / Shrinkage',
  expired: 'Expired',
  misplaced: 'Misplaced',
  count_correction: 'Count Correction',
};

export const PURCHASE_STATUSES = ['draft', 'confirmed', 'received', 'cancelled'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const TRANSFER_STATUSES = ['pending', 'in_transit', 'completed', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const SALE_STATUSES = ['draft', 'completed', 'voided'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const PAYMENT_METHODS = ['cash', 'card', 'mobile_money', 'credit'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const RETURN_CONDITIONS = ['sellable', 'damaged'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export const RESERVATION_STATUSES = ['active', 'released', 'fulfilled', 'expired'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const ADJUSTMENT_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];

export const BACKDATE_REASONS = ['forgot_to_record', 'system_offline', 'manual_correction', 'other'] as const;
export type BackdateReason = (typeof BACKDATE_REASONS)[number];

export const BACKDATE_REASON_LABELS: Record<BackdateReason, string> = {
  forgot_to_record: 'Forgot to record',
  system_offline: 'System was offline',
  manual_correction: 'Manual correction',
  other: 'Other',
};

export const PRODUCT_EDIT_REASONS = [
  'adding_new_variants',
  'stock_recounting',
  'price_update',
  'cost_update',
  'product_info_update',
  'other',
] as const;
export type ProductEditReason = (typeof PRODUCT_EDIT_REASONS)[number];

export const PRODUCT_EDIT_REASON_LABELS: Record<ProductEditReason, string> = {
  adding_new_variants: 'Adding new variants',
  stock_recounting: 'Stock recounting',
  price_update: 'Price update',
  cost_update: 'Cost update',
  product_info_update: 'Product information update',
  other: 'Other',
};
