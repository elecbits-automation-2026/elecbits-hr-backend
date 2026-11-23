import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PDF, PNG, prevMonth, startApp, today, type TestApp } from './helpers/api.js';

let t: TestApp;
before(async () => {
  t = await startApp();
});
after(async () => {
  await t.stop();
});

describe('payroll run → payslip', () => {
  // Two months back: lifecycle.test.ts settles an F&F in last month's run.
  const month = prevMonth(`${prevMonth()}-15`);
  let runId = '';
  let ashaSlip = '';
  let vikramSlip = '';

  it('only payroll can create runs; bad and future months are refused', async () => {
    assert.equal(
      (await t.call('asha.eng', 'POST', '/payroll/runs', { month })).status,
      403,
    );
    assert.equal(
      (await t.call('priya.pr', 'POST', '/payroll/runs', { month: '2026-13' })).status,
      400,
    );
    // M5: a month that hasn't started yet is refused.
    const future = await t.call('priya.pr', 'POST', '/payroll/runs', {
      month: '2030-02',
    });
    assert.ok(future.status >= 400 && future.status < 500, JSON.stringify(future.body));
  });

  it('creates last month’s run; a duplicate is a 409', async () => {
    const r = await t.call('priya.pr', 'POST', '/payroll/runs', { month });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    runId = r.body.run.id;
    assert.equal(
      (await t.call('priya.pr', 'POST', '/payroll/runs', { month })).status,
      409,
    );
    const got = await t.call('priya.pr', 'GET', `/payroll/runs/${runId}`);
    assert.equal(got.status, 200);
    const slips: Array<{
      id: string;
      employeeId?: string;
      employee?: { id: string };
      netPay?: string;
    }> = got.body.payslips ?? [];
    const of = (k: string) =>
      slips.find((p) => (p.employeeId ?? p.employee?.id) === t.ids[k])?.id ?? '';
    ashaSlip = of('asha.eng');
    vikramSlip = of('vikram.eng');
    assert.ok(ashaSlip && vikramSlip, 'payslips for the roster');
    for (const p of slips) assert.ok(Number(p.netPay ?? 0) >= 0, 'no negative net pay');
  });

  it('validates payslip edits', async () => {
    const path = `/payroll/runs/${runId}/payslips/${ashaSlip}`;
    assert.equal((await t.call('priya.pr', 'PATCH', path, { lopDays: -3 })).status, 400);
    const tooMany = await t.call('priya.pr', 'PATCH', path, { lopDays: 45 });
    assert.ok(tooMany.status >= 400 && tooMany.status < 500);
    const ok = await t.call('priya.pr', 'PATCH', path, { performanceBonus: 1000 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it('draft PDF for payroll; not for another employee', async () => {
    const pdf = await t.call(
      'priya.pr',
      'GET',
      `/payroll/runs/${runId}/payslips/${ashaSlip}/pdf`,
    );
    assert.equal(pdf.status, 200);
    assert.ok(pdf.head.startsWith('%PDF'));
    const idor = await t.call(
      'asha.eng',
      'GET',
      `/payroll/runs/${runId}/payslips/${vikramSlip}/pdf`,
    );
    assert.ok(idor.status === 403 || idor.status === 404);
  });

  it('finalizes and locks the run', async () => {
    const f = await t.call('priya.pr', 'POST', `/payroll/runs/${runId}/finalize`);
    assert.equal(f.status, 200, JSON.stringify(f.body));
    const edit = await t.call(
      'priya.pr',
      'PATCH',
      `/payroll/runs/${runId}/payslips/${ashaSlip}`,
      {
        performanceBonus: 2,
      },
    );
    assert.ok(edit.status === 409 || edit.status === 400);
    const del = await t.call('priya.pr', 'DELETE', `/payroll/runs/${runId}`);
    assert.ok(del.status === 409 || del.status === 400);
  });

  it('the employee downloads their own payslip only', async () => {
    const mine = await t.call('asha.eng', 'GET', '/payroll/payslips/mine');
    assert.equal(mine.status, 200);
    const slip = mine.body[0];
    assert.ok(slip);
    const own = await t.call('asha.eng', 'GET', `/payroll/payslips/mine/${slip.id}/pdf`);
    assert.equal(own.status, 200);
    assert.ok(own.head.startsWith('%PDF'));
    const idor = await t.call(
      'vikram.eng',
      'GET',
      `/payroll/payslips/mine/${slip.id}/pdf`,
    );
    assert.ok(idor.status === 403 || idor.status === 404);
  });

  it('corrections: real amounts only', async () => {
    const ok = await t.call(
      'priya.pr',
      'POST',
      `/payroll/payslips/${ashaSlip}/corrections`,
      {
        amount: 500,
        reason: 'missed allowance',
      },
    );
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const zero = await t.call(
      'priya.pr',
      'POST',
      `/payroll/payslips/${ashaSlip}/corrections`,
      {
        amount: 0,
        reason: 'zero',
      },
    );
    assert.equal(zero.status, 400);
    const huge = await t.call(
      'priya.pr',
      'POST',
      `/payroll/payslips/${ashaSlip}/corrections`,
      {
        amount: 1e12,
        reason: 'huge',
      },
    );
    assert.ok(huge.status >= 400 && huge.status < 500);
  });

  it('marks the run paid', async () => {
    const r = await t.call('priya.pr', 'POST', `/payroll/runs/${runId}/mark-paid`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe('salary and bank details', () => {
  it('refuses negative CTC, a bad PAN (L4) and a bad IFSC', async () => {
    const neha = t.ids['neha.intern'];
    assert.equal(
      (await t.call('priya.pr', 'PUT', `/employees/${neha}/salary`, { ctc: '-50000' }))
        .status,
      400,
    );
    assert.equal(
      (
        await t.call('priya.pr', 'PUT', `/employees/${neha}/salary`, {
          panNumber: 'NOTAPAN',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await t.call('priya.pr', 'PUT', `/employees/${neha}/bank-details`, {
          ifscCode: 'BAD',
        })
      ).status,
      400,
    );
  });

  it('a valid PAN is accepted', async () => {
    const r = await t.call(
      'priya.pr',
      'PUT',
      `/employees/${t.ids['neha.intern']}/salary`,
      {
        panNumber: 'ABCDE1234F',
      },
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('managers and OPS cannot read salary or bank details', async () => {
    const asha = t.ids['asha.eng'];
    const s = await t.call('kiran.ops', 'GET', `/employees/${asha}/salary`);
    assert.ok(s.status === 403 || s.status === 404);
    const b = await t.call('rahul.manager', 'GET', `/employees/${asha}/bank-details`);
    assert.ok(b.status === 403 || b.status === 404);
    const peer = await t.call(
      'asha.eng',
      'GET',
      `/employees/${t.ids['arjun.eng']}/salary`,
    );
    assert.ok(peer.status === 403 || peer.status === 404);
  });
});

describe('loans', () => {
  let loanId = '';
  const startMonth = today().slice(0, 7);

  it('creates a loan and validates the terms', async () => {
    const r = await t.call('priya.pr', 'POST', '/payroll/loans', {
      employeeId: t.ids['asha.eng'],
      kind: 'loan',
      principal: 60000,
      interestRatePct: 0,
      months: 6,
      startMonth,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    loanId = r.body.id;
    const neg = await t.call('priya.pr', 'POST', '/payroll/loans', {
      employeeId: t.ids['asha.eng'],
      kind: 'loan',
      principal: -1,
      interestRatePct: 0,
      months: 6,
      startMonth,
    });
    assert.equal(neg.status, 400);
  });

  it('only the borrower reads their loan', async () => {
    assert.equal(
      (await t.call('asha.eng', 'GET', `/payroll/loans/mine/${loanId}`)).status,
      200,
    );
    const idor = await t.call('vikram.eng', 'GET', `/payroll/loans/mine/${loanId}`);
    assert.ok(idor.status === 403 || idor.status === 404);
  });
});

describe('reimbursements: Employee → PR → Admin', () => {
  let claimId = '';
  const spentOn = today();

  it('creates a claim; negative, future and absurd amounts are refused', async () => {
    const r = await t.call('asha.eng', 'POST', '/reimbursements', {
      spentOn,
      category: 'travel',
      description: 'Cab to client',
      amount: 850,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    claimId = r.body.id;
    const neg = await t.call('asha.eng', 'POST', '/reimbursements', {
      spentOn,
      category: 'travel',
      description: 'neg',
      amount: -50,
    });
    assert.equal(neg.status, 400);
    const huge = await t.call('asha.eng', 'POST', '/reimbursements', {
      spentOn,
      category: 'travel',
      description: 'huge',
      amount: 99999999999,
    });
    assert.ok(huge.status >= 400 && huge.status < 500);
  });

  it('receipts: magic-byte checked, owner only, required before approval', async () => {
    const exe = await t.call(
      'asha.eng',
      'PUT',
      `/reimbursements/${claimId}/receipt?filename=r.exe`,
      undefined,
      {
        raw: Buffer.from('MZ\x90\x00 evil'),
        contentType: 'application/pdf',
      },
    );
    assert.ok([400, 415, 422].includes(exe.status), String(exe.status));
    const other = await t.call(
      'vikram.eng',
      'PUT',
      `/reimbursements/${claimId}/receipt?filename=r.pdf`,
      undefined,
      {
        raw: PDF,
        contentType: 'application/pdf',
      },
    );
    assert.ok(other.status === 403 || other.status === 404);
    const early = await t.call(
      'priya.pr',
      'POST',
      `/reimbursements/${claimId}/decision`,
      {
        decision: 'approve',
      },
    );
    assert.ok(early.status >= 400);
    const up = await t.call(
      'asha.eng',
      'PUT',
      `/reimbursements/${claimId}/receipt?filename=r.pdf`,
      undefined,
      {
        raw: PDF,
        contentType: 'application/pdf',
      },
    );
    assert.ok(up.status < 300, JSON.stringify(up.body));
    const idor = await t.call('vikram.eng', 'GET', `/reimbursements/${claimId}/receipt`);
    assert.ok(idor.status === 403 || idor.status === 404);
  });

  it('self-approval blocked; PR then Admin approve; bank file; paid once', async () => {
    assert.equal(
      (
        await t.call('asha.eng', 'POST', `/reimbursements/${claimId}/decision`, {
          decision: 'approve',
        })
      ).status,
      403,
    );
    const pr = await t.call('priya.pr', 'POST', `/reimbursements/${claimId}/decision`, {
      decision: 'approve',
    });
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    const prAgain = await t.call(
      'priya.pr',
      'POST',
      `/reimbursements/${claimId}/decision`,
      {
        decision: 'approve',
      },
    );
    assert.ok(prAgain.status >= 400);
    const admin = await t.call('admin', 'POST', `/reimbursements/${claimId}/decision`, {
      decision: 'approve',
    });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    const file = await t.call('priya.pr', 'GET', '/reimbursements/bank-file');
    assert.equal(file.status, 200);
    assert.ok(file.bytes > 100);
    const paid = await t.call('priya.pr', 'POST', '/reimbursements/mark-paid', {
      claimIds: [claimId],
      paidOn: today(),
      reference: 'UTR123',
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const twice = await t.call('priya.pr', 'POST', '/reimbursements/mark-paid', {
      claimIds: [claimId],
      paidOn: today(),
      reference: 'UTR123',
    });
    assert.ok(twice.status >= 400);
  });

  it('a PR person’s own claim skips PR; the Owner cannot claim', async () => {
    const r = await t.call('priya.pr', 'POST', '/reimbursements', {
      spentOn,
      category: 'food',
      description: 'Lunch',
      amount: 300,
    });
    assert.equal(r.status, 201);
    await t.call(
      'priya.pr',
      'PUT',
      `/reimbursements/${r.body.id}/receipt?filename=r.png`,
      undefined,
      {
        raw: PNG,
        contentType: 'image/png',
      },
    );
    const self = await t.call(
      'priya.pr',
      'POST',
      `/reimbursements/${r.body.id}/decision`,
      {
        decision: 'approve',
      },
    );
    assert.equal(self.status, 403);
    const owner = await t.call('admin', 'POST', '/reimbursements', {
      spentOn,
      category: 'food',
      description: 'Owner lunch',
      amount: 300,
    });
    assert.ok(
      owner.status === 403 || owner.status === 422,
      `owner claim: ${owner.status} ${JSON.stringify(owner.body)}`,
    );
  });
});
