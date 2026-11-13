import ExcelJS from 'exceljs';
import type { ReimbursementsRepository } from './reimbursements.repository.js';

type ToPayRow = Awaited<ReturnType<ReimbursementsRepository['toPay']>>[number];

const CATEGORY: Record<string, string> = {
  travel: 'Travel',
  food: 'Food',
  internet_phone: 'Internet / phone',
  equipment: 'Equipment',
  other: 'Other',
};

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IN', {
    month: 'short',
    year: 'numeric',
  });

const bold = (row: ExcelJS.Row) => {
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
};

/**
 * The bank file PR hands to the bank (learner, 2026-11-05). Tab 1, "Bank
 * transfer": one row per person with the total of their approved claims —
 * the usual bulk-payment columns (beneficiary, account, IFSC, amount,
 * narration). People with no bank details on file are listed after the
 * transfer rows, in red, so they can be paid by hand. Tab 2, "Claims": one
 * row per claim behind those totals.
 */
export const buildBankFile = async (rows: ToPayRow[], month: string): Promise<Buffer> => {
  const book = new ExcelJS.Workbook();
  book.creator = 'Elecbits HRMS';
  book.created = new Date();

  const people = new Map<string, { first: ToPayRow; total: number; count: number }>();
  for (const r of rows) {
    const p = people.get(r.employeeId);
    if (p) {
      p.total += Number(r.amount);
      p.count += 1;
    } else people.set(r.employeeId, { first: r, total: Number(r.amount), count: 1 });
  }
  const all = [...people.values()];
  const payable = all.filter((p) => p.first.accountNo && p.first.ifsc);
  const missing = all.filter((p) => !(p.first.accountNo && p.first.ifsc));
  const narration = (code: string) => `Reimb ${monthLabel(month)} ${code}`;

  const bank = book.addWorksheet('Bank transfer');
  bank.columns = [
    { header: 'Sr No', key: 'sr', width: 7 },
    { header: 'Beneficiary Name', key: 'name', width: 28 },
    { header: 'Beneficiary Account Number', key: 'account', width: 24 },
    { header: 'IFSC Code', key: 'ifsc', width: 14 },
    { header: 'Bank Name', key: 'bank', width: 22 },
    { header: 'Amount', key: 'amount', width: 14 },
    { header: 'Narration', key: 'narration', width: 28 },
    { header: 'Employee Code', key: 'code', width: 14 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Claims', key: 'claims', width: 8 },
  ];
  bold(bank.getRow(1));
  payable.forEach((p, i) => {
    bank.addRow({
      sr: i + 1,
      name: p.first.name,
      // Text, so Excel keeps leading zeros and long numbers exact.
      account: String(p.first.accountNo),
      ifsc: p.first.ifsc,
      bank: p.first.bankName ?? '',
      amount: Math.round(p.total * 100) / 100,
      narration: narration(p.first.employeeCode),
      code: p.first.employeeCode,
      email: p.first.email,
      claims: p.count,
    });
  });
  const totalRow = bank.addRow({
    name: 'Total',
    amount: Math.round(payable.reduce((a, p) => a + p.total, 0) * 100) / 100,
    claims: payable.reduce((a, p) => a + p.count, 0),
  });
  totalRow.font = { bold: true };
  if (missing.length > 0) {
    bank.addRow({});
    const note = bank.addRow({ name: 'No bank details on file — pay by hand:' });
    note.font = { bold: true, color: { argb: 'FFB91C1C' } };
    for (const p of missing) {
      const row = bank.addRow({
        name: p.first.name,
        amount: Math.round(p.total * 100) / 100,
        narration: narration(p.first.employeeCode),
        code: p.first.employeeCode,
        email: p.first.email,
        claims: p.count,
      });
      row.font = { color: { argb: 'FFB91C1C' } };
    }
  }
  bank.getColumn('account').numFmt = '@';
  bank.getColumn('amount').numFmt = '#,##0.00';

  const claims = book.addWorksheet('Claims');
  claims.columns = [
    { header: 'Employee', key: 'name', width: 26 },
    { header: 'Employee Code', key: 'code', width: 14 },
    { header: 'Department', key: 'dept', width: 18 },
    { header: 'Spent on', key: 'spent', width: 12 },
    { header: 'Category', key: 'category', width: 16 },
    { header: 'Description', key: 'desc', width: 40 },
    { header: 'Amount', key: 'amount', width: 12 },
    { header: 'Approved (month)', key: 'month', width: 16 },
    { header: 'PR approver', key: 'pr', width: 22 },
    { header: 'Admin approver', key: 'admin', width: 22 },
  ];
  bold(claims.getRow(1));
  for (const r of rows) {
    claims.addRow({
      name: r.name,
      code: r.employeeCode,
      dept: r.department ?? '',
      spent: r.spentOn,
      category: CATEGORY[r.category] ?? r.category,
      desc: r.description,
      amount: Number(r.amount),
      month: r.approvedMonth ?? '',
      pr: r.prName ?? '—',
      admin: r.adminName ?? '—',
    });
  }
  claims.getColumn('amount').numFmt = '#,##0.00';

  return Buffer.from(await book.xlsx.writeBuffer());
};
