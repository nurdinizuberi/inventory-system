import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appBaseDomain, tenantSlugFromHost } from '../app-domain';

const ORIGINAL = process.env.APP_BASE_DOMAIN;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.APP_BASE_DOMAIN;
  else process.env.APP_BASE_DOMAIN = ORIGINAL;
});

describe('tenantSlugFromHost (no APP_BASE_DOMAIN)', () => {
  beforeEach(() => {
    delete process.env.APP_BASE_DOMAIN;
  });

  it('returns null for vercel.app hosts', () => {
    expect(tenantSlugFromHost('app.vercel.app')).toBeNull();
    expect(tenantSlugFromHost('foo-bar-baz.vercel.app')).toBeNull();
  });

  it('returns null for IPs and plain localhost', () => {
    expect(tenantSlugFromHost('127.0.0.1')).toBeNull();
    expect(tenantSlugFromHost('192.168.1.10')).toBeNull();
    expect(tenantSlugFromHost('localhost')).toBeNull();
  });

  it('parses production-style subdomains', () => {
    expect(tenantSlugFromHost('acme.example.com')).toBe('acme');
    expect(tenantSlugFromHost('store.yourapp.co.tz')).toBe('store');
  });

  it('parses dev subdomains (acme.localhost)', () => {
    expect(tenantSlugFromHost('acme.localhost:3004')).toBe('acme');
  });

  it('returns null for bare two-label hosts', () => {
    expect(tenantSlugFromHost('example.com')).toBeNull();
  });
});

describe('tenantSlugFromHost (with APP_BASE_DOMAIN)', () => {
  beforeEach(() => {
    process.env.APP_BASE_DOMAIN = 'mindboxafrica.com';
  });

  it('treats the apex and www as bare', () => {
    expect(appBaseDomain()).toBe('mindboxafrica.com');
    expect(tenantSlugFromHost('mindboxafrica.com')).toBeNull();
    expect(tenantSlugFromHost('www.mindboxafrica.com')).toBeNull();
  });

  it('resolves subdomains of the apex domain', () => {
    expect(tenantSlugFromHost('acme.mindboxafrica.com')).toBe('acme');
    expect(tenantSlugFromHost('moyo.mindboxafrica.com')).toBe('moyo');
  });

  it('still treats vercel.app as bare', () => {
    expect(tenantSlugFromHost('foo.vercel.app')).toBeNull();
  });
});
