export interface ResolvedBackdate {
  effectiveDate: Date;
  backdateReason: string | null;
  isBackdated: boolean;
  error?: string;
}

/**
 * Resolves the effective date of a transaction.
 *
 * Without an explicit `effectiveDate` the entry is dated NOW. When the chosen
 * date is in the past the transaction is treated as backdated and a reason is
 * required (matches the flow used by sales/purchases/transfers).
 */
export function resolveBackdate(
  effectiveDateStr?: string | null,
  backdateReason?: string | null,
  now: Date = new Date(),
): ResolvedBackdate {
  if (!effectiveDateStr) {
    return { effectiveDate: now, backdateReason: backdateReason ?? null, isBackdated: false };
  }

  const date = new Date(effectiveDateStr);
  if (Number.isNaN(date.getTime())) {
    return { effectiveDate: now, backdateReason: null, isBackdated: false, error: 'Invalid effective date' };
  }

  // Compare at day granularity: a date is only backdated when it is a strictly
  // earlier calendar day than today — a YYYY-MM-DD date input like "today"
  // parses to midnight UTC, which must not read as "this morning already
  // passed". This matches the UI's isBackdated() and recordMovement().
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const effective = new Date(date);
  effective.setHours(0, 0, 0, 0);
  const isBackdated = effective < today;

  if (isBackdated && !backdateReason) {
    return {
      effectiveDate: date,
      backdateReason: null,
      isBackdated,
      error: 'A backdated entry requires a reason',
    };
  }

  return { effectiveDate: date, backdateReason: backdateReason ?? null, isBackdated };
}