// ---------------------------------------------------------------------------
// In-memory login throttling.
//
// Single-instance only (fine for this deployment). Buckets are keyed per
// `email|ip`; after N failed logins within a window the key is locked out for
// the lock period. Successful logins clear the counter.
// ---------------------------------------------------------------------------

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

interface Bucket {
  failures: number;
  windowStart: number;
  lockedUntil: number | null;
}

const buckets = new Map<string, Bucket>();

export class LoginRateLimitedError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('Too many failed login attempts. Try again later.');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function sweep(now: number): void {
  for (const [key, b] of buckets) {
    const fullyStale = now - b.windowStart > WINDOW_MS * 2;
    const lockExpired = b.lockedUntil !== null && b.lockedUntil <= now;
    if (fullyStale || lockExpired) buckets.delete(key);
  }
}

/** Throws LoginRateLimitedError once this key is locked out. */
export function assertNotLocked(key: string): void {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);
  if (bucket?.lockedUntil && bucket.lockedUntil > now) {
    throw new LoginRateLimitedError(Math.ceil((bucket.lockedUntil - now) / 1000));
  }
}

export function recordFailure(key: string): void {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key) ?? { failures: 0, windowStart: now, lockedUntil: null };
  if (now - bucket.windowStart > WINDOW_MS) {
    bucket.failures = 0;
    bucket.windowStart = now;
  }
  bucket.failures += 1;
  if (bucket.failures >= MAX_FAILURES) {
    bucket.lockedUntil = now + LOCK_MS;
  }
  buckets.set(key, bucket);
}

export function clearFailures(key: string): void {
  buckets.delete(key);
}