const FALLBACK_SECRET = 'dev-only-change-me-please-0123456789abcdef';

/**
 * JWT secret for signing sessions. Development falls back to a well-known
 * value so a fresh clone "just works"; production MUST supply its own secret
 * and fails loudly instead of signing tokens with a key everyone can read.
 */
export function sessionSecret(): string {
  const secret = (process.env.JWT_SECRET ?? '').trim();
  if (!secret || secret === FALLBACK_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is not configured: set a strong, unique JWT_SECRET in production.');
    }
    return secret || FALLBACK_SECRET;
  }
  return secret;
}