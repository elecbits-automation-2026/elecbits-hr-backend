const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * EMI for a loan: reducing balance (standard amortization) at the yearly
 * rate; flat principal / months when the rate is 0. An advance is months = 1.
 */
export const emiFor = (principal: number, ratePct: number, months: number): number => {
  if (months <= 0) return round2(principal);
  if (ratePct <= 0) return round2(principal / months);
  const r = ratePct / 1200;
  const f = Math.pow(1 + r, months);
  return round2((principal * r * f) / (f - 1));
};

/**
 * One month's instalment on the current balance: interest first, the rest is
 * principal. A remainder under ₹1 (EMI rounding) rides on this instalment
 * rather than becoming an extra month of paise.
 */
export const instalment = (
  balance: number,
  ratePct: number,
  emi: number,
): { amount: number; interest: number; principal: number } => {
  if (balance <= 0) return { amount: 0, interest: 0, principal: 0 };
  const interest = round2((balance * Math.max(0, ratePct)) / 1200);
  const due = round2(balance + interest);
  const amount = due - emi < 1 ? due : round2(emi);
  return { amount, interest, principal: round2(amount - interest) };
};

/** The projected schedule from a balance (for the loan drawer). */
export const scheduleFrom = (
  balance: number,
  ratePct: number,
  emi: number,
  fromMonth: string,
  maxRows = 120,
): Array<{
  month: string;
  amount: number;
  interest: number;
  principal: number;
  balance: number;
}> => {
  const rows: Array<{
    month: string;
    amount: number;
    interest: number;
    principal: number;
    balance: number;
  }> = [];
  let b = balance;
  let [y, m] = fromMonth.split('-').map(Number) as [number, number];
  while (b > 0.004 && rows.length < maxRows) {
    const i = instalment(b, ratePct, emi);
    if (i.principal <= 0) break; // EMI doesn't cover interest — stop projecting
    b = round2(b - i.principal);
    rows.push({ month: `${y}-${String(m).padStart(2, '0')}`, ...i, balance: b });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return rows;
};
