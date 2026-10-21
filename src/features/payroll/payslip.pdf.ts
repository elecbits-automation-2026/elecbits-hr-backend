import PDFDocument from 'pdfkit';
import type { PayslipDto } from './payroll.schema.js';

/** Everything printed on one payslip — assembled by the service. */
export interface PayslipPdfInput {
  company: { name: string; address: string };
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

    if (input.runStatus === 'draft') {
      doc.save();
      doc.fillColor('#e2e8f0').fontSize(90).font('Helvetica-Bold');
      doc
        .rotate(-30, { origin: [300, 420] })
        .text('DRAFT', 120, 380, { lineBreak: false });
      doc.restore();
    }

    // ── header
    doc
      .fillColor(ink)
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(input.company.name, left, 40);
    if (input.company.address) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(muted)
        .text(input.company.address, { width });
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(ink)
      .text(
        slip.exitId
          ? `Full & final settlement — ${monthLabel(input.month)}`
          : `Payslip for ${monthLabel(input.month)}`,
        left,
        40,
        {
        width,
        align: 'right',
      });
    doc.moveDown(2.2);
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .strokeColor(line)
      .stroke();
    doc.moveDown(0.8);

    // ── employee block: two columns of label/value pairs
    const facts: Array<[string, string]> = [
      ['Employee', `${employee.name} (${employee.employeeCode})`],
      ['Designation', employee.designation ?? '—'],
      ['Department', employee.department ?? '—'],
      ['Date of joining', employee.dateOfJoining ?? '—'],
      ['PAN', employee.panLast4 ? `XXXXXX${employee.panLast4}` : '—'],
      [
        'Bank account',
        employee.accountLast4
          ? `${employee.bankName ? `${employee.bankName} ` : ''}XXXX${employee.accountLast4}`
          : '—',
      ],
      ['Days in month (base)', '30'],
      ['Working days', String(slip.workingDays)],
      ['Loss of pay days', String(slip.lopDays)],
      ['Paid days', String(Math.max(0, 30 - slip.lopDays))],
    ];
    const top = doc.y;
    const colW = width / 2;
    facts.forEach(([k, v], i) => {
      const x = left + (i % 2) * colW;
      const y = top + Math.floor(i / 2) * 16;
      doc.font('Helvetica').fontSize(9).fillColor(muted).text(k, x, y, { width: 110 });
      doc.fillColor(ink).text(v, x + 110, y, { width: colW - 120 });
    });
    doc.y = top + Math.ceil(facts.length / 2) * 16 + 10;

    // ── earnings | deductions, side by side
    const earnings: Row[] = [
      ['Basic', slip.basic],
      ['House rent allowance', slip.hra],
      ['Leave travel allowance', slip.lta],
      ['Special allowance', slip.specialAllowance],
      ['PF share of CTC', slip.pf],
    ];
    const deductions: Row[] = [
      ['Provident fund (employee)', slip.pf],
      ['Provident fund (employer)', slip.pfEmployer],
      ['Income tax (TDS)', slip.tds],
      ['Professional tax', slip.professionalTax],
      ...(slip.healthInsurance
        ? ([['Health insurance', slip.healthInsurance]] as Row[])
        : []),
      ...(slip.cnpsEmployer ? ([['CNPS', slip.cnpsEmployer]] as Row[]) : []),
      ...(slip.otherDeduction ? ([['Loan / other', slip.otherDeduction]] as Row[]) : []),
    ];
    const tableTop = doc.y;
    const half = (width - 20) / 2;
    const drawTable = (
      x: number,
      title: string,
      rows: Row[],
      totalLabel: string,
      total: number,
    ) => {
      let y = tableTop;
      doc.rect(x, y, half, 18).fill('#f1f5f9');
      doc.fillColor(ink).font('Helvetica-Bold').fontSize(9);
      doc.text(title, x + 6, y + 5, { width: half - 100 });
      doc.text(slip.currency, x + half - 96, y + 5, { width: 90, align: 'right' });
      y += 22;
      doc.font('Helvetica').fontSize(9);
      for (const [label, value] of rows) {
        doc.fillColor(ink).text(label, x + 6, y, { width: half - 100 });
        doc.text(amount(value), x + half - 96, y, { width: 90, align: 'right' });
        y += 15;
      }
      return { y, totalLabel, total, x };
    };
    const a = drawTable(
      left,
      'Earnings',
      earnings,
      'Salary for the month',
      slip.earningsTotal,
    );
    const b = drawTable(
      left + half + 20,
      'Deductions',
      deductions,
      'Total deductions',
      slip.deductionsTotal,
    );
    const totalY = Math.max(a.y, b.y) + 4;
    for (const t of [a, b]) {
      doc
        .moveTo(t.x, totalY)
        .lineTo(t.x + half, totalY)
        .strokeColor(line)
        .stroke();
      doc.font('Helvetica-Bold').fillColor(ink).fontSize(9);
      doc.text(t.totalLabel, t.x + 6, totalY + 5, { width: half - 100 });
      doc.text(amount(t.total), t.x + half - 96, totalY + 5, {
        width: 90,
        align: 'right',
      });
    }
    doc.y = totalY + 26;

    if (slip.lopDays > 0) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(muted)
        .text(
          `Monthly CTC ${amount(slip.monthlyGross)} less loss of pay ${amount(slip.lopAmount)} (${slip.lopDays} of 30 days).`,
          left,
          doc.y,
          { width },
        );
      doc.moveDown(0.6);
    }

    // ── net, additions, final pay
    const additions: Row[] = [
      ['Reimbursement', slip.reimbursement],
      ['Performance bonus', slip.performanceBonus],
      ['Recognition awards (last month)', slip.recognitionBonus],
      ['Other bonus', slip.otherBonus],
      [
        slip.exitId
          ? `Leave encashment (${slip.encashedElDays} EL days on Basic)`
          : 'Leave encashment',
        slip.leaveEncashment,
      ],
      ['Advance', slip.advance],
      [`Gratuity (${slip.gratuityYears} years)`, slip.gratuity],
      ['Notice pay in lieu', slip.noticePay],
      ['Notice shortfall recovered', -slip.noticeRecovery],
      [`Sick leave without a certificate (${slip.sickLopDays} days)`, -slip.sickLopDeduction],
      ['Recoveries (full & final)', -slip.fnfRecovery],
      [slip.exitId ? 'Loan / advance balance recovered' : 'Loan / advance EMI', -slip.loanEmi],
      ...slip.corrections.map((c): Row => [
        `Correction to ${c.sourceMonth}: ${c.reason}`,
        c.amount,
      ]),
    ].filter(([, v]) => v !== 0) as Row[];
    const summary = (label: string, value: number, bold = false) => {
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(bold ? 11 : 9)
        .fillColor(ink);
      const y = doc.y;
      doc.text(label, left + 6, y, { width: width - 140 });
      const after = doc.y;
      doc.text(`${slip.currency} ${amount(value)}`, left + width - 136, y, {
        width: 130,
        align: 'right',
      });
      doc.y = Math.max(after, doc.y) + 3;
    };
    summary('Net pay (salary for the month less deductions)', slip.netPay);
    for (const [label, value] of additions) summary(label, value);
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .strokeColor(line)
      .stroke();
    doc.moveDown(0.4);
    summary('Final pay', slip.finalPay, true);
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor(muted)
      .text(rupeesInWords(slip.finalPay), left + 6, doc.y, {
        width,
      });

    const later = slip.correctedBy.filter((c) => c.status !== 'cancelled');
    if (later.length > 0) {
      doc.moveDown(1);
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
