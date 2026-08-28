import { NextResponse } from 'next/server';
import { audit } from '@/lib/audit';
import { SESSION_COOKIE, getSessionUser } from '@/lib/auth';

export async function POST() {
  const user = await getSessionUser();
  if (user) {
    await audit({ ctx: user, action: 'logout', entityType: 'User', entityId: user.id, entityLabel: user.email });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
