import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { sendActivationEmail } from '@/lib/account-email';
import { prisma } from '@/lib/db';
import { badRequest, guard, jsonError } from '@/lib/rbac';
import { getAppBaseUrl } from '@/lib/app-url';
import { issueActivation } from '@/lib/tokens';

const schema = z.object({
  userId: z.string().min(1, 'userId is required'),
});

/**
 * Send (or resend) an activation invitation for a PENDING account. Each call
 * mints a FRESH single-use token, so any previously emailed link is implicitly
 * invalidated. ACTIVE accounts don't need invitations.
 */
export async function POST(request: Request) {
  try {
    const ctx = await guard({ action: 'user.manage' });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join(', '));

    const user = await prisma.user.findFirst({
      where: { id: parsed.data.userId, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) },
    });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (user.status !== 'PENDING') {
      return badRequest('Only accounts pending activation can be invited.');
    }

    const invited = await issueActivation({ email: user.email, tenantId: ctx.tenantId ?? null, invitedById: ctx.id });
    if (!invited) return badRequest('Could not issue an activation token for this account.');

    const link = `${await getAppBaseUrl()}/activate?token=${invited.token}`;
    const mail = await sendActivationEmail({
      to: invited.user.email,
      name: invited.user.name,
      link,
      invitedBy: ctx.name,
      isNew: !user.lastInvitedAt, // first send vs. resend
    });

    await audit({
      ctx,
      action: 'create',
      entityType: 'User',
      entityId: user.id,
      entityLabel: user.email,
      metadata: { invitation: user.lastInvitedAt ? 'resent' : 'sent', emailDelivered: mail.ok },
    });

    return NextResponse.json({
      ok: true,
      invitation: {
        sentAt: invited.expiresAt ? new Date() : null,
        expiresAt: invited.expiresAt,
        emailDelivered: mail.ok,
        ...(mail.ok ? {} : { emailError: mail.error ?? 'Email provider not configured' }),
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
