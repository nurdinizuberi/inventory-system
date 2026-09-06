import { round2 } from './utils';

/** One ticket line as priced: list price, discount and quantity. */
export interface TicketLine {
  /** List selling price per unit (variant.sellingPrice ?? product.basePrice). */
  unitPrice: number;
  /** Per-unit discount off the list price. */
  unitDiscount?: number;
  quantity: number;
  /** Manual price override; falls back to unitPrice - unitDiscount. */
  actualPrice?: number | null;
}

export interface TicketTotals {
  /** Sum of list price x quantity before discounts. */
  subtotal: number;
  /** Sum of per-unit discounts x quantity. */
  discountTotal: number;
  /** What the customer is charged: subtotal - discountTotal. */
  total: number;
  /** Number of physical units on the ticket. */
  units: number;
  /** Lines that would sell for 0 or less and must not be charged. */
  freeLines: number;
}

/**
 * Price a ticket exactly as the POS displays it and the sales API charges it.
 * Both sides must call this: the amount the cashier shows the customer has to
 * be the amount that actually lands on the receipt, to the cent.
 *
 * The per-unit price a line is actually charged for is the lower of
 * (list price - discount) and any explicit manual override, never below 0.
 */
export function computeTicketTotals(lines: TicketLine[]): TicketTotals {
  let subtotal = 0;
  let discountTotal = 0;
  let units = 0;
  let freeLines = 0;

  for (const line of lines) {
    const unitPrice = Number.isFinite(line.unitPrice) ? line.unitPrice : 0;
    const quantity = Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
    const actualPrice =
      line.actualPrice != null
        ? Math.max(0, Number(line.actualPrice))
        : round2(Math.max(0, unitPrice - (line.unitDiscount ?? 0)));

    subtotal += unitPrice * quantity;
    discountTotal += round2((unitPrice - actualPrice) * quantity);
    units += quantity;
    if (actualPrice <= 0) freeLines += 1;
  }

  subtotal = round2(subtotal);
  return {
    subtotal,
    discountTotal: round2(discountTotal),
    total: round2(subtotal - discountTotal),
    units,
    freeLines,
  };
}