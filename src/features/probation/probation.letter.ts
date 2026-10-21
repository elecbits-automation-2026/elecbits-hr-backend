import PDFDocument from 'pdfkit';

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

/**
 * The confirmation letter (policy §5.3: probationers are informed in writing).
 * Same look as the exit letters; worded without pronouns.
 */
export const renderConfirmationLetter = (input: {
  company: { name: string; address: string };
  employee: {
    name: string;
    employeeCode: string;
    designation: string | null;
    department: string | null;
    dateOfJoining: string | null;
  };
  confirmedOn: string;
}): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const e = input.employee;
    const doc = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: { Title: 'Confirmation of Employment' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const ink = '#1e293b';
    const muted = '#64748b';
    const left = 56;
    const width = doc.page.width - 112;

    doc
      .fillColor(ink)
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(input.company.name, left, 56);
    if (input.company.address) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(muted)
        .text(input.company.address, { width });
    }
    doc.moveDown(1.5);
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .strokeColor('#cbd5e1')
      .stroke();
    doc.moveDown(1.2);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(ink)
      .text(`Date: ${longDate(input.confirmedOn)}`, { align: 'right' });
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(11).text(`${e.name}`);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(muted)
      .text(`Employee code ${e.employeeCode}`);
    doc.moveDown(1.2);
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor(ink)
      .text('Confirmation of Employment', { align: 'center' });
    doc.moveDown(1.4);

    const role = [e.designation, e.department ? `${e.department} department` : null]
      .filter(Boolean)
      .join(', ');
    const paras = [
      `Dear ${e.name},`,
      `We are pleased to confirm that, following the review of the probation period${e.dateOfJoining ? ` that began on ${longDate(e.dateOfJoining)}` : ''}, your employment with ${input.company.name}${role ? ` as ${role}` : ''} is confirmed with effect from ${longDate(input.confirmedOn)}.`,
      `All other terms of your appointment remain unchanged. From this date the leave and other provisions for confirmed employees apply to you.`,
      `We look forward to your continued contribution.`,
    ];
    doc.fontSize(11);
    for (const p of paras) {
      doc.font('Helvetica').text(p, { width, align: 'justify', lineGap: 3 });
      doc.moveDown(1);
    }
    doc.moveDown(2.5);
    doc.font('Helvetica-Bold').fontSize(11).text(`For ${input.company.name}`);
    doc.moveDown(3);
    doc.font('Helvetica').fontSize(10).text('Authorised signatory');
    doc.font('Helvetica').fontSize(8).fillColor(muted).text('Human Resources');
    doc.end();
  });
