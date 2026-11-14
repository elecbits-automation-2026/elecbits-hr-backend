/** The payroll.payslipHeader values every company document prints. */
export interface Letterhead {
  name: string;
  address: string;
  /** A PNG / JPEG data URL, or null. */
  logo: string | null;
}

/** The logo's raw bytes, or null when there is none. */
export const logoBytes = (logo: string | null): Buffer | null =>
  logo ? Buffer.from(logo.slice(logo.indexOf(',') + 1), 'base64') : null;

/**
 * The letterhead shared by the confirmation, relieving and experience
 * letters: company name + address on the left, the logo top right, then a
 * rule. Leaves doc.y just below the rule. A logo pdfkit can't decode is
 * skipped rather than failing the letter.
 */
export const drawLetterhead = (
  doc: PDFKit.PDFDocument,
  company: Letterhead,
  left: number,
  width: number,
): void => {
  const ink = '#1e293b';
  const muted = '#64748b';
  const top = 56;
  const size = 56;
  let logoBottom = 0;
  const data = logoBytes(company.logo);
  if (data) {
    try {
      doc.image(data, left + width - size, top - 6, {
        fit: [size, size],
        align: 'right',
      });
      logoBottom = top - 6 + size;
    } catch {
      logoBottom = 0;
    }
  }
  const textW = logoBottom ? width - size - 16 : width;
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(16).text(company.name, left, top, {
    width: textW,
  });
  if (company.address) {
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(company.address, { width: textW });
  }
  doc.moveDown(1.5);
  doc.y = Math.max(doc.y, logoBottom + 10);
  doc
    .moveTo(left, doc.y)
    .lineTo(left + width, doc.y)
    .strokeColor('#cbd5e1')
    .stroke();
  doc.moveDown(1.2);
};
