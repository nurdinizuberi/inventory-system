import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from './db';

/**
 * Single-use, hashed, expiring tokens for password reset and email
 * verification.
 *
 *  1. `issueForEmail(...)` mints a random 32-byte token, stores only its
 *     SHA-256 hash on the User row (with an expiry for resets), and returns
 *     the raw token to place in the email link.
 *  2. `consumeReset(...)` / `verifyEmailToken(...)` recompute the hash and
 *     compare against the stored one, enforcing expiry, and clear it on use.
 *
 * Storing a hash (never the raw token) means a leaked database does not yield
 * usable links.
 */

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const RESET_TOKEN_ROUNDS = 12;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Issue a reset token for an existing account. Returns null when no user has
 * that email (so callers can answer generically without leaking which emails
 * are registered). When `scope` is provided it must match the user's tenantId
 * — pass { tenantId: null } for global-admin reset links so they never collide
 * with a like-named tenant user.
 */
export async function issueResetForEmail(
  email: string,
  scope?: { tenantId: string | null },
) {
  const user = await prisma.user.findFirst({ where: { email: email.toLowerCase() } });
  if (!user) return null;
  if (scope && user.tenantId !== scope.tenantId) return null;
  const raw = crypto.randomBytes(32).toString('hex');
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: hashToken(raw),
      passwordResetTokenExpiresAt: new Date(Date.now() + RESET_TTL_MS),
    },
  });
  return { user, token: raw };
}

/**
 * Verify a reset token and, if valid, set a new password (and consider the
 * account verified). Clears the token either way on success.
 */
export async function consumeReset(
  raw: string,
  newPassword: string,
): Promise<{ ok: boolean; user?: { id: string; email: string } }> {
  const hash = hashToken(raw);
  const user = await prisma.user.findFirst({ where: { passwordResetTokenHash: hash } });
  if (!user || !user.passwordResetTokenHash) return { ok: false };
  if (!user.passwordResetTokenExpiresAt || Date.now() > user.passwordResetTokenExpiresAt.getTime()) {
    return { ok: false };
  }
  if (!safeEqual(hash, user.passwordResetTokenHash)) return { ok: false };

  const passwordHash = await bcrypt.hash(newPassword, RESET_TOKEN_ROUNDS);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordResetTokenHash: null,
      passwordResetTokenExpiresAt: null,
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
    },
  });
  return { ok: true, user: { id: user.id, email: user.email } };
}

/**
 * Confirm an email address by consuming a one-time verification token.
 */
export async function verifyEmailToken(
  raw: string,
): Promise<{ ok: boolean; user?: { id: string; email: string } }> {
  const hash = hashToken(raw);
  const user = await prisma.user.findFirst({ where: { emailVerificationTokenHash: hash } });
  if (!user) return { ok: false };
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerificationTokenHash: null, emailVerifiedAt: new Date() },
  });
  return { ok: true, user: { id: user.id, email: user.email } };
}

/** Issue a verification token. The email must already exist. */
export async function issueVerificationForEmail(email: string) {
  const user = await prisma.user.findFirst({ where: { email: email.toLowerCase() } });
  if (!user) return null;
  const raw = crypto.randomBytes(32).toString('hex');
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerificationTokenHash: hashToken(raw) },
  });
  return { user, token: raw };
}
