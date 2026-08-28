/** Small shared helpers: ids, numbers, dates, diffing for the audit log. */

const CURRENCY = process.env.NEXT_PUBLIC_CURRENCY || 'TZS';

const numberFmt = new Intl.NumberFormat('en-TZ', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function currency(value: number | null | undefined, currencyCode: string = CURRENCY): string {
  const n = Number.isFinite(Number(value)) ? Number(value) : 0;
  const formatted = numberFmt.format(Math.round(n * 100) / 100);
  return `${currencyCode} ${formatted}`;
}

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function pct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '' : ''}${n.toFixed(1)}%`;
}

/** Zero-padded sequential-ish reference numbers, e.g. PO-20260827-0001 */
export async function nextNumber(
  prefix: string,
  findMany: (args: { orderBy: { createdAt: 'desc' }; take: number }) => Promise<{ number: string }[]>,
): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const recent = await findMany({ orderBy: { createdAt: 'desc' }, take: 1 });
  const last = recent[0]?.number ?? '';
  const tail = last.split('-').pop() ?? '0';
  const seq = (parseInt(tail, 10) || 0) + 1;
  return `${prefix}-${stamp}-${String(seq).padStart(4, '0')}`;
}

/** True when an error is a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002',
  );
}

/**
 * Retry a document creation when two requests race for the same sequential
 * number (count+1 style numbering is otherwise racy). `makeNumber(attempt)`
 * produces the candidate number and `attempt(number)` performs the create —
 * a P2002 is retried with the next candidate. The bound needs to exceed the
 * worst-case burst: every concurrent request that pre-read the same count
 * tumbles forward through the same candidate range, so a narrow bound
 * (5) fails under load. 80 covers realistic POS concurrency.
 */
export async function withRetryNumber<T>(
  makeNumber: (attempt: number) => string,
  attempt: (number: string) => Promise<T>,
  maxAttempts = 80,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt(makeNumber(i));
    } catch (err) {
      lastErr = err;
      if (i < maxAttempts - 1 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw lastErr;
}

export function todayStart(d: Date = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function daysAgo(n: number, from: Date = new Date()): Date {
  const x = new Date(from);
  x.setDate(x.getDate() - n);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function formatDate(d: Date | string | null | undefined, withTime = false): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return (withTime ? dateTimeFmt : dateFmt).format(date);
}

export function parseAttributes(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function variantLabel(name: string, attributes: Record<string, string>): string {
  const parts = Object.values(attributes).filter(Boolean);
  return parts.length ? `${name} — ${parts.join(' / ')}` : name;
}

/** Deterministic short barcode for auto-generation: 13 digits, EAN-13 shaped. */
export function generateBarcode(seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const body = String(Math.abs(hash)).padStart(12, '0').slice(0, 12);
  // EAN-13 check digit
  const digits = body.split('').map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  const check = (10 - (sum % 10)) % 10;
  return `${body}${check}`;
}

export function generateSku(productName: string, attributes: Record<string, string>, index: number): string {
  const base = (productName || 'SKU')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5)
    .padEnd(3, 'X');
  const attrPart = Object.values(attributes)
    .filter(Boolean)
    .map((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3))
    .join('');
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${base}-${attrPart || 'DEF'}${index ? `-${index}` : ''}-${rand}`;
}

/** Minimal before/after diff for the audit trail. */
export function diffObjects(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { changed: string[]; before: Record<string, unknown>; after: Record<string, unknown> } {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed: string[] = [];
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of keys) {
    const bv = before?.[k];
    const av = after?.[k];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      changed.push(k);
      b[k] = bv === undefined ? null : bv;
      a[k] = av === undefined ? null : av;
    }
  }
  return { changed, before: b, after: a };
}

/** Strip secrets / noisy fields before anything hits the audit log. */
export function safeSnapshot(obj: unknown): Record<string, unknown> | null {
  if (obj === null || obj === undefined) return null;
  const record: Record<string, unknown> =
    typeof obj === 'object' ? { ...(obj as Record<string, unknown>) } : { value: obj };
  for (const key of ['password', 'passwordHash', 'token', 'accessToken', 'refreshToken']) {
    if (key in record) record[key] = '[redacted]';
  }
  for (const [k, v] of Object.entries(record)) {
    if (v instanceof Date) record[k] = v.toISOString();
  }
  return record;
}
