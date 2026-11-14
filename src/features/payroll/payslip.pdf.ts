import PDFDocument from 'pdfkit';
import type { PayslipDto } from './payroll.schema.js';

/** Everything printed on one payslip — assembled by the service. */
export interface PayslipPdfInput {
  /** `logo`: a PNG / JPEG data URL from payroll.payslipHeader, or null. */
  company: { name: string; address: string; logo: string | null };
  month: string; // YYYY-MM
  runStatus: 'draft' | 'finalized' | 'paid';
  employee: {
    name: string;
    employeeCode: string;
    designation: string | null;
    department: string | null;
    dateOfJoining: string | null;
    /** Last four only — the full numbers never leave the salary row. */
    panLast4: string | null;
    /** EPFO UAN — shown in full, as on a standard payslip. */
    uan: string | null;
    bankName: string | null;
    accountLast4: string | null;
  };
  slip: PayslipDto;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

const amount = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

const belowHundred = (n: number): string =>
  n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;

const belowThousand = (n: number): string => {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? belowHundred(rest) : '']
    .filter(Boolean)
    .join(' ');
};

/** Indian numbering (crore / lakh / thousand), whole rupees + paise. */
export const rupeesInWords = (value: number): string => {
  const rupees = Math.floor(Math.abs(value));
  const paise = Math.round((Math.abs(value) - rupees) * 100);
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1000);
  const rest = rupees % 1000;
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  const words = parts.length ? parts.join(' ') : 'Zero';
  return `${value < 0 ? 'Minus ' : ''}Rupees ${words}${paise ? ` and ${belowHundred(paise)} Paise` : ''} Only`;
};

type Row = [label: string, value: number];

/**
 * The slip's lines in the standard Indian layout (learner, 2026-11-14): every
 * amount sits under Earnings or Deductions — bonuses, encashment, F&F lines
 * and corrections included — so Total earnings − Total deductions = Net pay.
 * Pure: the PDF and the My payslips screen show the same split. Nothing is
 * recomputed; each line is a stored snapshot value.
 */
export const payslipLines = (slip: PayslipDto) => {
  const earnings: Row[] = [
    ['Basic', slip.basic],
    ['House rent allowance', slip.hra],
    ['Leave travel allowance', slip.lta],
    ['Special allowance', slip.specialAllowance],
    ['Employer PF (part of CTC)', slip.pf],
    ['Performance bonus', slip.performanceBonus],
    ['Recognition awards (last month)', slip.recognitionBonus],
    ['Other bonus', slip.otherBonus],
    [
      slip.exitId
        ? `Leave encashment (${slip.encashedElDays} EL days on Basic)`
        : 'Leave encashment',
      slip.leaveEncashment,
    ],
    [`Gratuity (${slip.gratuityYears} years)`, slip.gratuity],
    ['Notice pay in lieu', slip.noticePay],
    ['Advance', slip.advance],
    // Only runs published before claims moved to the reimbursement sheet.
    ['Reimbursement', slip.reimbursement],
    ...slip.corrections
      .filter((c) => c.amount > 0)
      .map((c): Row => [`Correction to ${c.sourceMonth}: ${c.reason}`, c.amount]),
  ];
  const deductions: Row[] = [
    ['Provident fund (employee)', slip.pf],
    ['Provident fund (employer)', slip.pfEmployer],
    ['Professional tax', slip.professionalTax],
    ['Income tax (TDS)', slip.tds],
    ['Health insurance', slip.healthInsurance],
    ['CNPS', slip.cnpsEmployer],
    ['Other deduction', slip.otherDeduction],
    [slip.exitId ? 'Loan / advance balance recovered' : 'Loan / advance EMI', slip.loanEmi],
    ['Notice shortfall recovered', slip.noticeRecovery],
    [`Sick leave without a certificate (${slip.sickLopDays} days)`, slip.sickLopDeduction],
    ['Recoveries (full & final)', slip.fnfRecovery],
    ...slip.corrections
      .filter((c) => c.amount < 0)
      .map((c): Row => [`Correction to ${c.sourceMonth}: ${c.reason}`, -c.amount]),
  ];
  // The CTC components always show (even at zero); extras only when present.
  const keep = (rows: Row[], fixed: number) =>
    rows.filter(([, v], i) => i < fixed || v !== 0);
  const e = keep(earnings, 5);
  const d = keep(deductions, 4);
  const sum = (rows: Row[]) => Math.round(rows.reduce((a, [, v]) => a + v, 0) * 100) / 100;
  return { earnings: e, deductions: d, totalEarnings: sum(e), totalDeductions: sum(d) };
};

/**
 * The payslip as an A4 PDF, drawn from the stored SNAPSHOT only — nothing is
 * recomputed, so the document always matches what was published. Standard
 * Helvetica has no rupee glyph, so amounts print in the slip's currency code.
 */
export const renderPayslipPdf = (input: PayslipPdfInput): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const { slip, employee } = input;
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: { Title: `Payslip ${input.month}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 40;
    const width = doc.page.width - 80;
    const ink = '#1e293b';
    const muted = '#64748b';
    const line = '#cbd5e1';
    const brand = '#1d4ed8';
    const shade = '#f1f5f9';

    if (input.runStatus === 'draft') {
      doc.save();
      doc.fillColor('#e2e8f0').fontSize(90).font('Helvetica-Bold');
      doc
        .rotate(-30, { origin: [300, 420] })
        .text('DRAFT', 120, 380, { lineBreak: false });
      doc.restore();
    }

    // ── header band: logo + company left, document title right
    const bandH = 64;
    doc.rect(left, 40, width, bandH).fill(brand);
    let textX = left + 14;
    if (input.company.logo) {
      // On a white tile so any logo colour reads on the brand band. A logo
      // pdfkit can't decode is skipped rather than failing the payslip.
      const data = Buffer.from(
        input.company.logo.slice(input.company.logo.indexOf(',') + 1),
        'base64',
      );
      doc.roundedRect(left + 8, 48, 48, 48, 6).fill('#ffffff');
      try {
        doc.image(data, left + 12, 52, { fit: [40, 40], align: 'center', valign: 'center' });
        textX = left + 66;
      } catch {
        // Undecodable image: paint the tile back over with the band colour.
        doc.rect(left + 6, 46, 52, 52).fill(brand);
      }
    }
    const textW = width * 0.62 - (textX - left);
    doc
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(input.company.name, textX, 52, { width: textW });
    if (input.company.address) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .text(input.company.address, textX, doc.y + 2, {
          width: textW,
          height: bandH - 32,
          ellipsis: true,
        });
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .text(slip.exitId ? 'Full & final settlement' : 'Payslip', left, 54, {
        width: width - 14,
        align: 'right',
      });
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(monthLabel(input.month), left, 72, { width: width - 14, align: 'right' });

    // ── employee details: a bordered two-column grid
    const facts: Array<[string, string]> = [
      ['Employee name', employee.name],
      ['Employee code', employee.employeeCode],
      ['Designation', employee.designation ?? '—'],
      ['Department', employee.department ?? '—'],
      ['Date of joining', employee.dateOfJoining ?? '—'],
      ['PAN', employee.panLast4 ? `XXXXXX${employee.panLast4}` : '—'],
      ['UAN', employee.uan ?? '—'],
      [
        'Bank account',
        employee.accountLast4
          ? `${employee.bankName ? `${employee.bankName} ` : ''}XXXX${employee.accountLast4}`
          : '—',
      ],
      ['Working days', String(slip.workingDays)],
      ['Days paid (of 30)', String(Math.max(0, 30 - slip.lopDays))],
      ['Loss of pay days', String(slip.lopDays)],
    ];
    const gridTop = 40 + bandH + 14;
    const rowH = 18;
    const colW = width / 2;
    const gridRows = Math.ceil(facts.length / 2);
    facts.forEach(([k, v], i) => {
      const x = left + (i % 2) * colW;
      const y = gridTop + Math.floor(i / 2) * rowH;
      doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(k, x + 8, y + 5, { width: 100 });
      doc
        .font('Helvetica-Bold')
        .fillColor(ink)
        .text(v, x + 110, y + 5, { width: colW - 118, lineBreak: false, ellipsis: true });
    });
    doc.lineWidth(0.6).strokeColor(line);
    doc.rect(left, gridTop, width, gridRows * rowH).stroke();
    doc
      .moveTo(left + colW, gridTop)
      .lineTo(left + colW, gridTop + gridRows * rowH)
      .stroke();

    // ── earnings | deductions: one table, totals on the same line
    const lines = payslipLines(slip);
    const tableTop = gridTop + gridRows * rowH + 16;
    const half = width / 2;
    const amtW = 80;
    const labelW = half - amtW - 16;
    const header = (x: number, title: string) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(ink);
      doc.text(title, x + 8, tableTop + 6, { width: labelW });
      doc.text(`Amount (${slip.currency})`, x + half - amtW - 8, tableTop + 6, {
        width: amtW,
        align: 'right',
      });
    };
    doc.rect(left, tableTop, width, 20).fill(shade);
    header(left, 'Earnings');
    header(left + half, 'Deductions');

    doc.font('Helvetica').fontSize(9);
    let y = tableTop + 24;
    const rows = Math.max(lines.earnings.length, lines.deductions.length);
    for (let i = 0; i < rows; i++) {
      const cells = [lines.earnings[i], lines.deductions[i]];
      const h =
        Math.max(
          ...cells.map((c) => (c ? doc.heightOfString(c[0], { width: labelW }) : 0)),
          11,
        ) + 5;
      cells.forEach((c, side) => {
        if (!c) return;
        const x = left + side * half;
        doc.fillColor(ink).text(c[0], x + 8, y, { width: labelW });
        doc.text(amount(c[1]), x + half - amtW - 8, y, { width: amtW, align: 'right' });
      });
      y += h;
    }
    const totalsY = y + 2;
    doc.rect(left, totalsY, width, 20).fill(shade);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ink);
    (
      [
        ['Total earnings', lines.totalEarnings],
        ['Total deductions', lines.totalDeductions],
      ] as Row[]
    ).forEach(([label, value], side) => {
      const x = left + side * half;
      doc.text(label, x + 8, totalsY + 6, { width: labelW });
      doc.text(amount(value), x + half - amtW - 8, totalsY + 6, { width: amtW, align: 'right' });
    });
    const tableBottom = totalsY + 20;
    doc.lineWidth(0.6).strokeColor(line);
    doc.rect(left, tableTop, width, tableBottom - tableTop).stroke();
    doc.moveTo(left + half, tableTop).lineTo(left + half, tableBottom).stroke();

    // ── net pay box
    const netTop = tableBottom + 14;
    doc.rect(left, netTop, width, 52).fill('#eff6ff');
    doc.rect(left, netTop, 4, 52).fill(brand);
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(ink)
      .text(`Net pay for ${monthLabel(input.month)}`, left + 16, netTop + 10, {
        width: width - 200,
      });
    doc
      .fontSize(15)
      .fillColor(brand)
      .text(`${slip.currency} ${amount(slip.finalPay)}`, left + width - 200, netTop + 9, {
        width: 186,
        align: 'right',
      });
    doc
      .font('Helvetica-Oblique')
      .fontSize(8.5)
      .fillColor(muted)
      .text(rupeesInWords(slip.finalPay), left + 16, netTop + 32, { width: width - 32 });
    doc.y = netTop + 64;

    // ── notes
    const notes: string[] = [];
    if (slip.lopDays > 0) {
      notes.push(
        `Monthly CTC ${amount(slip.monthlyGross)} less loss of pay ${amount(slip.lopAmount)} (${slip.lopDays} of 30 days).`,
      );
    }
    if (slip.pf > 0) {
      notes.push(
        'Your CTC includes the employer’s PF share, so it shows under Earnings and is deposited to your PF account under Deductions.',
      );
    }
    if (Math.abs(lines.totalEarnings - lines.totalDeductions - slip.finalPay) > 0.01) {
      // Only when deductions exceeded the month's salary (net is floored at 0).
      notes.push('Deductions above this month’s salary were capped; net pay cannot go below zero.');
    }
    doc.font('Helvetica').fontSize(8).fillColor(muted);
    for (const n of notes) {
      doc.text(`• ${n}`, left, doc.y, { width });
      doc.moveDown(0.2);
    }

    const later = slip.correctedBy.filter((c) => c.status !== 'cancelled');
    if (later.length > 0) {
      doc.moveDown(0.6);
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(ink)
        .text('Corrected afterwards', left, doc.y);
      doc.font('Helvetica').fontSize(9);
      for (const c of later) {
        doc.text(
          `${c.amount < 0 ? '-' : '+'}${amount(Math.abs(c.amount))} — ${c.reason} (${
            c.status === 'applied' ? `paid in ${c.appliedMonth}` : 'on the next payslip'
          })`,
          { width },
        );
      }
    }

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(muted)
      .text(
        input.runStatus === 'draft'
          ? 'DRAFT — not yet finalized; these numbers can still change.'
          : 'This is a computer-generated payslip and does not need a signature.',
        left,
        doc.page.height - 60,
        { width, align: 'center' },
      );
    doc.end();
  });
