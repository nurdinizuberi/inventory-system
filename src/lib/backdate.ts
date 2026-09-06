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

  const isBackdated = date < now;
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