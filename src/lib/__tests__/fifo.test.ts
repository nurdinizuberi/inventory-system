import { describe, expect, it } from 'vitest';
import {
  allocateFifo,
  summariseAllocations,
  InsufficientStockError,
  type BatchAllocation,
} from '../fifo';

// Shape returned by fifoBatches for FIFO allocation (BatchAllocation).
const alloc = (over: Partial<BatchAllocation> = {}): BatchAllocation => ({
  batchId: `b-${Math.random()}`,
  batchCode: 'B001',
  unitCost: 10,
  quantity: 5,
  receivedAt: new Date('2026-01-01'),
  ...over,
});

// Shape that Prisma returns from batch.findMany (read by fifoBatches).
interface MockBatch {
  id: string;
  code: string;
  unitCost: number;
  remainingQty: number;
  receivedAt: Date;
}

const batch = (over: Partial<MockBatch> = {}): MockBatch => ({
  id: `b-${Math.random()}`,
  code: 'B001',
  unitCost: 10,
  remainingQty: 5,
  receivedAt: new Date('2026-01-01'),
  ...over,
});

// Mock the Prisma tx surface used by fifoBatches: batch.findMany plus the
// reserved-hold probe (stockMovement.groupBy), which returns no reserves here.
const mockFifoQueue = (batches: MockBatch[]) => ({
  batch: { findMany: async () => batches },
  stockMovement: { groupBy: async () => [] },
} as never);

describe('summariseAllocations', () => {
  it('computes total quantity, cost and weighted average unit cost', () => {
    const allocations = [
      alloc({ batchCode: 'A', unitCost: 10, quantity: 3 }),
      alloc({ batchCode: 'B', unitCost: 20, quantity: 1 }),
    ];
    const result = summariseAllocations(allocations);
    expect(result.totalQuantity).toBe(4);
    expect(result.totalCost).toBe(50);
    expect(result.unitCost).toBe(12.5);
  });

  it('returns zero unit cost for no allocations', () => {
    const result = summariseAllocations([]);
    expect(result.totalQuantity).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.unitCost).toBe(0);
  });
});

describe('allocateFifo', () => {
  it('consumes the oldest batch first (FIFO ordering)', async () => {
    const oldest = batch({ code: 'OLD', unitCost: 10, receivedAt: new Date('2026-01-01') });
    const newest = batch({ code: 'NEW', unitCost: 30, receivedAt: new Date('2026-03-01') });

    const result = await allocateFifo(
      mockFifoQueue([oldest, newest]),
      { variantId: 'v1', locationId: 'l1', quantity: 6 },
    );

    // All of the older, cheaper batch is drained before the newer one is touched.
    expect(result.map((a) => a.batchCode)).toEqual(['OLD', 'NEW']);
    expect(result[0].quantity).toBe(5);
    expect(result[1].quantity).toBe(1);
  });

  it('spreads a request across batches when one does not cover it', async () => {
    const first = batch({ code: 'A', remainingQty: 2 });
    const second = batch({ code: 'B', remainingQty: 2 });
    const result = await allocateFifo(
      mockFifoQueue([first, second]),
      { variantId: 'v1', locationId: 'l1', quantity: 3 },
    );
    expect(result.map((a) => a.batchCode)).toEqual(['A', 'B']);
    expect(result[0].quantity).toBe(2);
    expect(result[1].quantity).toBe(1);
  });

  it('throws InsufficientStockError when the queue cannot cover the request', async () => {
    const first = batch({ code: 'A', remainingQty: 1 });
    await expect(
      allocateFifo(mockFifoQueue([first]), {
        variantId: 'v1',
        locationId: 'l1',
        quantity: 5,
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });
});