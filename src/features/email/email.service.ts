import createError from 'http-errors';
import type { Env } from '../../config/env.js';
import type { SettingsReader } from '../settings/index.js';
import type { EmailDriver, OutgoingEmail } from './email.drivers.js';
import type { EmailOutboxRow, EmailRepository } from './email.repository.js';
import type { EmailStatusDto } from './email.schema.js';
import { renderEmail } from './email.template.js';

/** Emails handled per drain — the next minute takes the rest. */
const BATCH = 20;
/** Attempt N failed -> wait RETRY_MINUTES[N-1]; after the last, the email is failed. */
const RETRY_MINUTES = [1, 5, 15, 60];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

/**
 * Email delivery rules (email service, 2026-11-16): the outbox is drained a
 * few emails at a time; each failure waits longer before the next try, and
 * after five tries the email is marked failed for the Admin card. With
 * EMAIL_REDIRECT_TO set, every email goes to that one address instead.
 */
export const createEmailService = (deps: {
  repo: EmailRepository;
  settings: SettingsReader;
  driver: () => EmailDriver;
  config: Env['email'];
  appUrl: string;
}) => {
  const { repo, settings, config } = deps;

  const brand = async () => {
    const header = await settings.effective('payroll.payslipHeader');
    return { companyName: header.companyName, address: header.address };
  };

  /** Render one message, applying the testing redirect. */
  const compose = async (message: {
    to: string;
    subject: string;
    body: string | null;
    link: string | null;
  }): Promise<OutgoingEmail> => {
    const redirected = config.redirectTo && config.redirectTo !== message.to;
    const rendered = renderEmail({
      subject: message.subject,
      body: message.body,
      link: message.link,
      brand: await brand(),
      appUrl: deps.appUrl,
    });
    return {
      to: redirected ? config.redirectTo! : message.to,
      subject: redirected ? `[for ${message.to}] ${rendered.subject}` : rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
  };

  const errorText = (err: unknown): string =>
    (err instanceof Error ? err.message : String(err)).slice(0, 500);

  const sendRow = async (
    row: EmailOutboxRow,
    now: Date,
  ): Promise<'sent' | 'retry' | 'failed'> => {
    try {
      await deps.driver().send(
        await compose({
          to: row.toAddress,
          subject: row.subject,
          body: row.body,
          link: row.link,
        }),
      );
      await repo.markSent(row.id);
      return 'sent';
    } catch (err) {
      const wait =
        row.attempts < MAX_ATTEMPTS ? RETRY_MINUTES[row.attempts - 1] : undefined;
      await repo.markFailedAttempt(
        row.id,
        errorText(err),
        wait === undefined ? null : new Date(now.getTime() + wait * 60_000),
      );
      return wait === undefined ? 'failed' : 'retry';
    }
  };

  /** One pass of the sender: claim what is due and deliver it. */
  const drain = async (now = new Date()) => {
    const tally = { sent: 0, retry: 0, failed: 0 };
    if (!(await settings.effective('email.delivery')).enabled) return tally;
    const rows = await repo.claimDue(BATCH);
    for (const row of rows) tally[await sendRow(row, now)] += 1;
    return tally;
  };

  const status = async (): Promise<EmailStatusDto> => {
    const [counts, failures, delivery] = await Promise.all([
      repo.stats(),
      repo.recentFailures(),
      settings.effective('email.delivery'),
    ]);
    return {
      enabled: delivery.enabled,
      driver: config.driver,
      from: config.from,
      replyTo: config.replyTo,
      redirectTo: config.redirectTo,
      pending: counts.pending,
      failed: counts.failed,
      sentLastDay: counts.sent_24h,
      sentLast30Days: counts.sent_30d,
      recentFailures: failures.map((f) => ({
        id: f.id,
        toAddress: f.to_address,
        type: f.type,
        subject: f.subject,
        attempts: f.attempts,
        lastError: f.last_error,
        createdAt: new Date(f.created_at).toISOString(),
      })),
    };
  };

  const retryFailed = async () => ({ requeued: await repo.retryFailed() });

  /**
   * "Send a test email to me": straight through the driver, not the outbox,
   * so the Admin sees the real error at once — and it works while the master
   * switch is still off (that is when the setup gets checked).
   */
  const sendTest = async (actorEmployeeId: string | null) => {
    const address = actorEmployeeId
      ? await repo.employeeEmail(actorEmployeeId)
      : undefined;
    if (!address) {
      throw createError(422, 'Your account has no email address', { code: 'NO_EMAIL' });
    }
    const email = await compose({
      to: address,
      subject: 'Test email from Elecbits HR',
      body: 'If you can read this, HR emails are set up correctly.\n\nNothing else needs doing.',
      link: '/',
    });
    try {
      await deps.driver().send(email);
    } catch (err) {
      // expose: the Admin needs Google's reason on the card, not "Bad Gateway".
      throw createError(502, `The test email was not sent: ${errorText(err)}`, {
        code: 'EMAIL_SEND_FAILED',
        expose: true,
      });
    }
    return { sentTo: email.to, driver: config.driver };
  };

  return { drain, status, retryFailed, sendTest };
};

export type EmailService = ReturnType<typeof createEmailService>;
