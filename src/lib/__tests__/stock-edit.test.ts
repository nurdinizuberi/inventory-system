import { beforeEach, describe, expect, it, vi } from 'vitest';

// The service under test only touches the transaction client passed in, but its
// imports pull in the real Prisma client — stub the module out.
vi.mock('../db', () => ({ prisma: {}, TX_OPTIONS: {} }));

// FIFO consumption is stubbed: the adjust path's contract with it is what these
// tests pin down (called for decreases, never for increases).
const consumeFifoMock = vi.fn();
vi.mock('../fifo', () => ({ consumeFifo: (...args: unknown[]) => consumeFifoMock(...args) }));

import { adjustVariantStock, revalueVariantBatches } from '../stock-edit';
import type { Prisma } from '@prisma/client';

interface CreatedBatch {
  variantId: string;
  locationId: string;
  unitCost: number;
  quantity: number;
  remainingQty: number;
}

interface RecordedMovement {
  type: string;
  quantity: number;
  unitCost: number | null;
}

function makeTx(batches: { id: string; unitCost: number; remainingQty: number; locationId: string }[] = []) {
  const createdBatches: CreatedBatch[] = [];
  const movements: RecordedMovement[] = [];
  const updatedBatches: { id: string; data: { unitCost?: number; remainingQty?: { decrement: number } } }[] = [];
  const tx = {
    batch: {
      create: async ({ data }: { data: CreatedBatch & { code: string; receivedAt: Date } }) => {
        createdBatches.push(data);
        return { id: 'new-batch' };
      },
      update: async ({ where, data }: { where: { id: string }; data: { unitCost?: number; remainingQty?: { decrement: number } } }) => {
        updatedBatches.push({ id: where.id, data });
        return { id: where.id };
      },
      findMany: async () => batches,
    },
    stockMovement: {
      create: async ({ data }: { data: RecordedMovement }) => {
        movements.push(data);
        return data;
      },
    },
  };
  // Only the surface the service uses is mocked; the rest of TransactionClient
  // is never touched (fifo is stubbed below), so a cast keeps the test honest
  // without hand-writing 26 no-op methods.
  return { tx: tx as unknown as Prisma.TransactionClient, createdBatches, movements, updatedBatches };
}

beforeEach(() => {
  consumeFifoMock.mockReset();
  consumeFifoMock.mockResolvedValue({ totalCost: 0, unitCost: 0, totalQuantity: 0, allocations: [] });
});

describe('adjustVariantStock (Add New Stock / Recount backend)', () => {
  it('adds a NEW batch with the entered cost and leaves existing batches untouched', async () => {
    const { tx, createdBatches, movements, updatedBatches } = makeTx([
      { id: 'old-1', unitCost: 1000, remainingQty: 10, locationId: 'loc-1' },
    ]);

    await adjustVariantStock(tx, {
      variantId: 'v1',
      locationId: 'loc-1',
      delta: 5,
      unitCost: 1200,
      reason: 'New stock added',
      referenceLabel: 'Product — Standard',
    });

    // One new batch at the NEW cost; old batches were never updated.
    expect(createdBatches).toHaveLength(1);
    expect(createdBatches[0]).toMatchObject({ unitCost: 1200, quantity: 5, remainingQty: 5 });
    expect(updatedBatches).toHaveLength(0);
    expect(consumeFifoMock).not.toHaveBeenCalled();
    // One ledger row with a positive quantity (old batches keep their cost).
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: 'product_edit', quantity: 5, unitCost: 1200 });
  });

  it('deducts via FIFO on a decrease and never creates batches', async () => {
    const { tx, createdBatches, movements } = makeTx([
      { id: 'old-1', unitCost: 1000, remainingQty: 10, locationId: 'loc-1' },
    ]);

    await adjustVariantStock(tx, {
      variantId: 'v1',
      locationId: 'loc-1',
      delta: -4,
      unitCost: 1200,
      reason: 'Count correction',
      referenceLabel: 'Product — Standard',
    });

    expect(createdBatches).toHaveLength(0);
    expect(consumeFifoMock).toHaveBeenCalledTimes(1);
    const opts = consumeFifoMock.mock.calls[0][1];
    expect(opts).toMatchObject({ variantId: 'v1', locationId: 'loc-1', quantity: 4, type: 'product_edit' });
    expect(movements).toHaveLength(0);
  });

  it('rejects a zero delta', async () => {
    const { tx } = makeTx([]);
    await expect(
      adjustVariantStock(tx, {
        variantId: 'v1',
        locationId: 'loc-1',
        delta: 0,
        unitCost: 10,
        reason: 'x',
        referenceLabel: 'y',
      }),
    ).rejects.toThrow('non-zero integer');
  });
});

describe('revalueVariantBatches (explicit cost revaluation)', () => {
  it('re-prices existing batches in place and writes a zero-quantity revaluation row', async () => {
    const { tx, createdBatches, movements, updatedBatches } = makeTx([
      { id: 'b1', unitCost: 1000, remainingQty: 3, locationId: 'loc-1' },
      { id: 'b2', unitCost: 1500, remainingQty: 2, locationId: 'loc-1' },
    ]);

    await revalueVariantBatches(tx, {
      variantId: 'v1',
      newCost: 2000,
      reason: 'Supplier price change',
      referenceLabel: 'Product — Standard',
    });

    expect(createdBatches).toHaveLength(0);
    expect(updatedBatches).toEqual([
      { id: 'b1', data: { unitCost: 2000 } },
      { id: 'b2', data: { unitCost: 2000 } },
    ]);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: 'revaluation', quantity: 0, unitCost: 2000 });
  });
});
