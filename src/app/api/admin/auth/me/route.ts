import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({
    user: { id: admin.id, email: admin.email, name: admin.name, role: 'GLOBAL_ADMIN' },
  });
}