/** The company block on every email — from the payslip-header setting. */
export interface EmailBrand {
  companyName: string;
  address: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** An app-relative link becomes absolute; anything else is dropped (never an outside URL). */
const absoluteLink = (appUrl: string, link: string | null): string | null => {
  if (!link || !link.startsWith('/') || link.startsWith('//')) return null;
  return `${appUrl.replace(/\/+$/, '')}${link}`;
};

/**
 * The one branded layout (email service): company name, the message, an
 * "Open in Elecbits HR" button and the automated-message footer. Table layout
 * and inline styles only — what mail clients render. No images: Gmail blocks
 * inline data-URL logos, and the message must read fine without them.
 */
export const renderEmail = (input: {
  subject: string;
  body: string | null;
  link: string | null;
  brand: EmailBrand;
  appUrl: string;
}): RenderedEmail => {
  const url = absoluteLink(input.appUrl, input.link);
  const company = input.brand.companyName || 'Elecbits';
  const paragraphs = (input.body ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f6fa;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6fa;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;">
<tr><td style="padding:16px 24px;border-bottom:1px solid #e2e8f0;font-size:15px;font-weight:bold;color:#0f172a;">${escapeHtml(company)} HR</td></tr>
<tr><td style="padding:24px;">
<h1 style="margin:0 0 12px;font-size:18px;line-height:1.4;color:#0f172a;">${escapeHtml(input.subject)}</h1>
${paragraphs
  .map(
    (p) =>
      `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`,
  )
  .join('\n')}
${
  url
    ? `<p style="margin:20px 0 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2a78d6;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:10px 18px;border-radius:6px;">Open in Elecbits HR</a></p>`
    : ''
}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.5;color:#64748b;">
This is an automated message from Elecbits HR. Sign in to see the details.${
    input.brand.address
      ? `<br>${escapeHtml(company)} · ${escapeHtml(input.brand.address)}`
      : ''
  }
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const text = [
    input.subject,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    ...(url ? [`Open in Elecbits HR: ${url}`, ''] : []),
    '--',
    'This is an automated message from Elecbits HR.',
    ...(input.brand.address ? [`${company} · ${input.brand.address}`] : []),
  ].join('\n');

  return { subject: input.subject, html, text };
};
