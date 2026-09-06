import { describe, expect, it } from 'vitest';
import { computeTicketTotals } from '../pricing';
import { round2 } from '../utils';

const price = (over: Partial<{ unitPrice: number; unitDiscount: number; quantity: number; actualPrice: number | null }> = {}) => ({
  unitPrice: 0,
  unitDiscount: 0,
  quantity: 1,
  ...over,
});

describe('computeTicketTotals', () => {
  it('charges qty x list price for a plain line', () => {
    const totals = computeTicketTotals([
      price({ unitPrice: 15000, quantity: 2 }),
    ]);
    expect(totals.subtotal).toBe(30000);
    expect(totals.discountTotal).toBe(0);
    expect(totals.total).toBe(30000);
    expect(totals.units).toBe(2);
    expect(totals.freeLines).toBe(0);
  });

  it('sums the selling price of every selected product, discount per unit, per its user-entered price', () => {
    // A mixed ticket as a cashier would build it: Rice 5 kg (TZS 18,500 x 3),
    // Cooking Oil 1 L (TZS 8,200 x 2 with 600 discount), T-shirt (TZS 12,000 x 2).
    const totals = computeTicketTotals([
      price({ unitPrice: 18500, quantity: 3 }),
      price({ unitPrice: 8200, unitDiscount: 600, quantity: 2 }),
      price({ unitPrice: 12000, quantity: 2 }),
    ]);
    expect(totals.units).toBe(7);
    expect(totals.subtotal).toBe(18500 * 3 + 8200 * 2 + 12000 * 2);
    expect(totals.discountTotal).toBe(600 * 2);
    expect(totals.total).toBe(totals.subtotal - totals.discountTotal);
    expect(totals.freeLines).toBe(0);
  });

  it('matches the sales API receipt math line for line', () => {
    const lines = [
      { unitPrice: 15000, unitDiscount: 0, quantity: 3 },
      { unitPrice: 8200, unitDiscount: 600, quantity: 2 },
      { unitPrice: 12500, unitDiscount: 2500, quantity: 1 },
    ];
    const totals = computeTicketTotals(lines);

    const perLine = lines.map((line) => {
      const actualPrice = line.unitDiscount > 0 ? line.unitPrice - line.unitDiscount : line.unitPrice;
      const lineTotal = round2(actualPrice * line.quantity);
      const discountAmount = round2((line.unitPrice - actualPrice) * line.quantity);
      return { actualPrice, lineTotal, discountAmount };
    });

    // What lands on the receipt: the sum of per-line totals equals the charged total.
    const sumLineTotals = round2(perLine.reduce((s, l) => s + l.lineTotal, 0));
    const sumDiscounts = round2(perLine.reduce((s, l) => s + l.discountAmount, 0));
    expect(totals.total).toBe(sumLineTotals);
    expect(totals.discountTotal).toBe(sumDiscounts);
    expect(totals.subtotal).toBe(round2(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0)));
  });

  it('uses a manual price override when given', () => {
    const totals = computeTicketTotals([
      price({ unitPrice: 10000, actualPrice: 9000, quantity: 2 }),
    ]);
    expect(totals.subtotal).toBe(20000);
    expect(totals.discountTotal).toBe(2000);
    expect(totals.total).toBe(18000);
  });

  it('flags lines that would sell for zero so the ticket cannot be charged', () => {
    const totals = computeTicketTotals([
      price({ unitPrice: 5000, unitDiscount: 0, quantity: 1 }),
      price({ unitPrice: 8000, unitDiscount: 8000, quantity: 1 }),
      price({ unitPrice: 3000, unitDiscount: 0, quantity: 1 }),
      price({ unitPrice: 0, quantity: 2 }),
    ]);
    expect(totals.freeLines).toBe(2);
  });

  it('never over-discounts a line below zero', () => {
    const totals = computeTicketTotals([
      price({ unitPrice: 5000, unitDiscount: 12000, quantity: 1 }),
    ]);
    expect(totals.discountTotal).toBe(5000);
    expect(totals.total).toBe(0);
    expect(totals.freeLines).toBe(1);
  });

  it('rounds money to 2 decimals like the API', () => {
    const totals = computeTicketTotals([
      price({ unitPrice: 1000, unitDiscount: 0.45, quantity: 3 }),
    ]);
    // round2((1000 - 999.55) * 3) fuses the cents drift away for the receipt.
    expect(totals.total).toBe(round2(999.55 * 3));
  });
});