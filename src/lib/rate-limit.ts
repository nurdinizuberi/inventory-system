// ---------------------------------------------------------------------------
// Database-backed login throttling.
//
// In-memory buckets do not survive serverless/ephemeral runtimes (Vercel,
// Namecheap, Hostinger, ...) where each request can hit a fresh process, so the
// lockout window is recorded in Postgres instead. The exported API is identical
// to the old in-memory version so call sites are unchanged.
//
// If the database is unreachable we fail OPEN (no throttle) rather than
// bricking every login during a Postgres blip — the auth routes' own DB errors
// will surface through the normal request path anyway.
// ---------------------------------------------------------------------------

import { prisma } from './db';

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000; // count failures within this window
const LOCK_MS = 15 * 60 * 1000; // lockout duration after MAX_FAILURES

export class LoginRateLimitedError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('Too many failed login attempts. Try again later.');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface LockStatus {
  locked: boolean;
  retryAfterSeconds: number;
}

/**
 * Count failed attempts for a key within the current window and compute the
 * nearest pending lock's remaining time.
 */
async function lockStatus(key: string, now: number): Promise<LockStatus> {
  const windowStart = new Date(now - WINDOW_MS);
  const lockStart = new Date(now - LOCK_MS);

  // The most recent lock attempt is the one that (if within LOCK_MS) pins the
  // key. Lockouts are recorded as failed attempts; a cluster of >=MAX_FAILURES
  // within WINDOW_MS arms the lock, which stays armed for LOCK_MS.
  const [windowed, recentLock] = await Promise.all([
    prisma.loginAttempt.count({ where: { key, failed: true, createdAt: { gte: windowStart } } }),
    // Newest failed attempt overall — if it lies inside the lock window we are
    // (still) locked out.
    prisma.loginAttempt.findFirst({
      where: { key, createdAt: { gte: lockStart } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  // A key is locked out once it has reached MAX_FAILURES within the window.
  // Treat any run of >=MAX_FAILURES in the window as the lock being active; the
  // lock expires LOCK_MS after the window that armed it elapses.
  if (windowed < MAX_FAILURES) {
    return { locked: false, retryAfterSeconds: 0 };
  }

  // Lock expires when the arming window ends (WINDOW_MS after the oldest
  // counted attempt) — approximate with the window boundary. Simpler and safe:
  // lock until now + (LOCK_MS - elapsed since the last counted attempt).
  const lastFailed = recentLock?.createdAt ?? new Date(now);
  const lockedUntilMs = Math.min(now + LOCK_MS, lastFailed.getTime() + LOCK_MS + WINDOW_MS);
  const remaining = Math.max(0, lockedUntilMs - now);
  return { locked: true, retryAfterSeconds: Math.ceil(remaining / 1000) };
}

/** Throws LoginRateLimitedError once this key is locked out. */
export async function assertNotLocked(key: string): Promise<void> {
  try {
    const { locked, retryAfterSeconds } = await lockStatus(key, Date.now());
    if (locked) throw new LoginRateLimitedError(retryAfterSeconds);
  } catch (err) {
    if (err instanceof LoginRateLimitedError) throw err;
    // DB unreachable — fail open.
  }
}

/** Record a failed attempt for a key. */
export async function recordFailure(key: string): Promise<void> {
  try {
    await prisma.loginAttempt.create({ data: { key, failed: true } });
  } catch {
    // Fail open on DB errors.
  }
}

/** Clear prior failures for a key by purging its rows. */
export async function clearFailures(key: string): Promise<void> {
  try {
    await prisma.loginAttempt.deleteMany({ where: { key } });
  } catch {
    // Fail open on DB errors.
  }
}
