import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATUSES,
  accountView,
  canAdminReactivate,
  derivedIsActive,
  isSigninBlocked,
  toAccountStatus,
} from '../account';

describe('account status helpers', () => {
  it('derives isActive only from ACTIVE', () => {
    expect(derivedIsActive('ACTIVE')).toBe(true);
    expect(derivedIsActive('PENDING')).toBe(false);
    expect(derivedIsActive('SUSPENDED')).toBe(false);
  });

  it('coerces unknown status values safely', () => {
    expect(toAccountStatus('ACTIVE')).toBe('ACTIVE');
    expect(toAccountStatus('PENDING')).toBe('PENDING');
    expect(toAccountStatus('SUSPENDED')).toBe('SUSPENDED');
    expect(toAccountStatus('hacked')).toBeNull();
    expect(toAccountStatus(42)).toBeNull();
    expect(toAccountStatus(undefined)).toBeNull();
  });

  it('exposes the full status vocabulary', () => {
    expect(ACCOUNT_STATUSES).toEqual(['PENDING', 'ACTIVE', 'SUSPENDED']);
  });

  it('builds a consistent API view payload', () => {
    const now = new Date('2026-09-21T10:00:00Z');
    expect(
      accountView('ACTIVE', true, now, now),
    ).toEqual({ status: 'ACTIVE', isActive: true, emailVerified: true, activatedAt: now });

    // Legacy rows predating the status column: infer from isActive.
    expect(accountView('', true, null, null).status).toBe('ACTIVE');
    expect(accountView('', false, null, null).status).toBe('SUSPENDED');
  });

  it('allows admins to reactivate suspended accounts only', () => {
    expect(canAdminReactivate('SUSPENDED')).toBe(true);
    expect(canAdminReactivate('ACTIVE')).toBe(false);
    expect(canAdminReactivate('PENDING')).toBe(false);
  });

  it('blocks sign-in for pending and suspended accounts', () => {
    expect(isSigninBlocked('PENDING')).toBe(true);
    expect(isSigninBlocked('SUSPENDED')).toBe(true);
    expect(isSigninBlocked('ACTIVE')).toBe(false);
  });
});
