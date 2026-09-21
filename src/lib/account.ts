// ---------------------------------------------------------------------------
// Account lifecycle helpers.
//
// The User table now carries a first-class `status`:
//   PENDING    invited by an admin; cannot sign in until they complete the
//              activation link (verify email -> fill profile -> set password).
//   ACTIVE     can sign in normally.
//   SUSPENDED  blocked from signing in (was `isActive = false` historically).
//
// `User.isActive` is kept as a DERIVED, backward-compatible mirror of status so
// every pre-existing auth path (login, getSessionUser, admin portal) keeps
// working untouched. Rule: isActive === (status === 'ACTIVE'). All writes to
// either field MUST go through the helpers below — never set them separately.
// ---------------------------------------------------------------------------

export const ACCOUNT_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  PENDING: 'Pending activation',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
};

/** The legacy boolean every existing code path reads, derived from status. */
export function derivedIsActive(status: string): boolean {
  return status === 'ACTIVE';
}

/** Coerce an unknown value (query param, API body) into a valid status. */
export function toAccountStatus(value: unknown): AccountStatus | null {
  return typeof value === 'string' && (ACCOUNT_STATUSES as readonly string[]).includes(value)
    ? (value as AccountStatus)
    : null;
}

/** Status payload for a user API response. */
export function accountView(status: string, isActive: boolean, emailVerifiedAt?: Date | null, activatedAt?: Date | null) {
  return {
    status: (toAccountStatus(status) ?? (isActive ? 'ACTIVE' : 'SUSPENDED')) as AccountStatus,
    isActive,
    emailVerified: !!emailVerifiedAt,
    activatedAt: activatedAt ?? null,
  };
}

/**
 * A suspended account may be reactivated, but a PENDING account never jumps
 * straight to ACTIVE from the admin side — the user must finish activation
 * themselves so we know a human controls the mailbox.
 */
export function canAdminReactivate(status: string): boolean {
  return status === 'SUSPENDED';
}

/** Suspension blocks sign-in and invitations; activation/pending do not. */
export function isSigninBlocked(status: string): boolean {
  return status === 'PENDING' || status === 'SUSPENDED';
}
