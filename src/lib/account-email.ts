import { sendEmail } from './email';

/**
 * Branded transactional email templates for the account lifecycle.
 * All sends are fire-and-forget friendly (sendEmail never throws), so callers
 * can `await` for confirmation in admin flows or `void` them in hot paths.
 */

const BRAND = 'MindBoxAfrica';
const FOOTER = `<p style="color:#6b7280;font-size:12px;margin-top:24px">If you were not expecting this email you can safely ignore it — the link expires on its own and your account is unchanged.</p>`;

function wrap(title: string, body: string): string {
  return `
  <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#111827">
    <h2 style="color:#5b21b6">${BRAND}</h2>
    <h3 style="margin:0 0 12px">${title}</h3>
    ${body}
    ${FOOTER}
  </div>`;
}

function button(link: string, label: string): string {
  return `<p><a href="${link}" style="display:inline-block;background:#5b21b6;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${label}</a></p>
  <p style="word-break:break-all;color:#6b7280;font-size:12px">${link}</p>`;
}

export function activationEmailHtml(opts: { name: string; link: string; invitedBy?: string | null; isNew: boolean }): string {
  const who = opts.invitedBy ? ` — ${opts.invitedBy}` : '';
  return wrap(
    opts.isNew ? `You're invited${who}` : `Activate your account${who}`,
    `
    <p>Hi${opts.name ? ` ${opts.name}` : ''},</p>
    <p>${
      opts.isNew
        ? `An account has been created for you on ${BRAND}. Set up your sign-in: verify your email, confirm your details and choose your own password.`
        : `A new activation link was requested for your ${BRAND} account.`
    }</p>
    ${button(opts.link, 'Activate account')}
    <p style="color:#6b7280;font-size:13px">This link is valid for 72 hours and can be used once.</p>`,
  );
}

export function activationReminderHtml(opts: { link: string; hoursLeft: number }): string {
  return wrap(
    'Reminder: activate your account',
    `
    <p>Your ${BRAND} activation link is still waiting — about <strong>${opts.hoursLeft} hour${opts.hoursLeft === 1 ? '' : 's'}</strong> left before it expires.</p>
    ${button(opts.link, 'Finish setting up your account')}
    <p style="color:#6b7280;font-size:13px">After it expires an admin can send you a fresh link from the Users page.</p>`,
  );
}

export function suspendedEmailHtml(opts: { name: string }): string {
  return wrap(
    'Account suspended',
    `
    <p>Hi${opts.name ? ` ${opts.name}` : ''},</p>
    <p>Your ${BRAND} account has been suspended by an administrator. You can no longer sign in. Contact your organisation's admin if you believe this is a mistake.</p>`,
  );
}

export function reactivatedEmailHtml(opts: { name: string; link?: string | null }): string {
  return wrap(
    'Account reactivated',
    `
    <p>Hi${opts.name ? ` ${opts.name}` : ''},</p>
    <p>Good news — your ${BRAND} account has been reactivated and you can sign in again${opts.link ? ' with your existing password' : ''}.</p>
    ${opts.link ? button(opts.link, 'Sign in') : ''}`,
  );
}

export interface SendActivationEmailInput {
  to: string;
  name: string;
  link: string;
  invitedBy?: string | null;
  isNew: boolean;
}

/** Send the activation email; resolves { ok } so callers can surface failures. */
export function sendActivationEmail(input: SendActivationEmailInput) {
  return sendEmail({
    to: input.to,
    subject: input.isNew ? `Activate your ${BRAND} account` : `New activation link for your ${BRAND} account`,
    html: activationEmailHtml({ name: input.name, link: input.link, invitedBy: input.invitedBy, isNew: input.isNew }),
  });
}
