import PDFDocument from 'pdfkit';

export interface ExitLetterInput {
  which: 'relieving' | 'experience';
  company: { name: string; address: string };
  employee: {
    name: string;
    employeeCode: string;
    designation: string | null;
    department: string | null;
    dateOfJoining: string | null;
  };
  kind: 'resignation' | 'termination';
  noticeStartOn: string;
  lastWorkingDay: string;
  issuedOn: string;
}

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

/**
 * Relieving and experience letters (exit module, always issued once the F&F
 * is settled). Plain A4 on the payslip header's company name and address;
 * worded without pronouns so they fit anyone.
 */
export const renderExitLetter = (input: ExitLetterInput): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const { employee: e } = input;
    const title =
      input.which === 'relieving' ? 'Relieving Letter' : 'Experience Certificate';
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: title } });
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
      .text(`Date: ${longDate(input.issuedOn)}`, {
        align: 'right',
      });
    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(14).text(title, { align: 'center' });
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(10).fillColor(muted).text('To whom it may concern', {
      align: 'center',
    });
    doc.moveDown(1.6);

    const role = [e.designation, e.department ? `${e.department} department` : null]
      .filter(Boolean)
      .join(', ');
    const paras: string[] =
      input.which === 'relieving'
        ? [
            `This is to certify that ${e.name} (employee code ${e.employeeCode})${role ? `, ${role},` : ''} has been relieved from the services of ${input.company.name} with effect from the close of business on ${longDate(input.lastWorkingDay)}.`,
            input.kind === 'resignation'
              ? `${e.name}'s resignation, submitted on ${longDate(input.noticeStartOn)}, was accepted, and all clearances and the full and final settlement have been completed.`
              : `All clearances and the full and final settlement have been completed.`,
            `We wish ${e.name} every success in the future.`,
          ]
        : [
            `This is to certify that ${e.name} (employee code ${e.employeeCode}) worked with ${input.company.name}${e.dateOfJoining ? ` from ${longDate(e.dateOfJoining)}` : ''} to ${longDate(input.lastWorkingDay)}.`,
            role ? `At the time of leaving, ${e.name} held the position of ${role}.` : '',
            `We thank ${e.name} for the contribution made during this time and wish ${e.name} the very best for the future.`,
          ].filter(Boolean);

    doc.fillColor(ink).fontSize(11);
    for (const p of paras) {
      doc.font('Helvetica').text(p, { width, align: 'justify', lineGap: 3 });
      doc.moveDown(1);
    }

    doc.moveDown(3);
    doc.font('Helvetica-Bold').fontSize(11).text(`For ${input.company.name}`);
    doc.moveDown(3);
    doc.font('Helvetica').fontSize(10).text('Authorised signatory');
    doc.font('Helvetica').fontSize(8).fillColor(muted).text('Human Resources');
    doc.end();
  });
