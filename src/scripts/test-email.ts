/**
 * One-off: send a single email straight through the configured driver, to
 * prove the Gmail API + service account + domain-wide delegation all work —
 * no HTTP, no outbox, no master switch. Usage:
 *   npx tsx src/scripts/test-email.ts [recipient@elecbits.in]
 * Defaults the recipient to EMAIL_REPLY_TO (or EMAIL_FROM).
 */
import { env } from '../config/env.js';
import { driverFor } from '../features/email/email.drivers.js';

const main = async (): Promise<void> => {
  const to = process.argv[2] ?? env.email.replyTo ?? env.email.from;
  if (env.email.driver !== 'gmail') {
    console.error(
      `EMAIL_DRIVER is "${env.email.driver}", not "gmail" — set EMAIL_DRIVER=gmail in .env first.`,
    );
    process.exit(1);
  }
  console.log(`Sending a test email as ${env.email.from} -> ${to} ...`);
  try {
    await driverFor(env.email).send({
      to,
      subject: 'Elecbits HR — Gmail API test',
      text: 'If you can read this, the Gmail API, service account and domain-wide delegation all work.',
      html: '<p>If you can read this, the Gmail API, service account and domain-wide delegation all work.</p>',
    });
    console.log(
      'OK — sent. Check the inbox (and Spam, in case DKIM is still propagating).',
    );
  } catch (err) {
    console.error('FAILED to send:');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
};

void main();
