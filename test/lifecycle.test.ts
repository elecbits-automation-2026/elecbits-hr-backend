import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addDays, prevMonth, startApp, today, type TestApp } from './helpers/api.js';

let t: TestApp;
before(async () => {
  t = await startApp();
});
after(async () => {
  await t.stop();
});

describe('probation', () => {
  let reviewId = '';

  it('the probation job opens a review for someone ending probation soon', async () => {
    const set = await t.call('meera.hrbp', 'PATCH', `/employees/${t.ids['rohan.lab']}`, {
      confirmationDate: addDays(today(), 4),
    });
    assert.ok(set.status < 300, JSON.stringify(set.body));
    const job = await t.call('admin', 'POST', '/admin/jobs/probation/run');
    assert.ok(job.status < 300, JSON.stringify(job.body));
    const list = await t.call('kiran.ops', 'GET', '/probation');
    assert.equal(list.status, 200);
    reviewId =
      (list.body as Array<{ id: string; employee?: { id: string } }>).find(
        (x) => x.employee?.id === t.ids['rohan.lab'],
      )?.id ?? '';
    assert.ok(reviewId, 'review opened for Rohan');
  });

  it('subject can’t recommend; RM recommends but can’t decide; HR confirms', async () => {
    const self = await t.call('rohan.lab', 'POST', `/probation/${reviewId}/recommend`, {
      recommendation: 'confirm',
      note: 'Me, myself',
    });
    assert.equal(self.status, 403);
    const rm = await t.call('kiran.ops', 'POST', `/probation/${reviewId}/recommend`, {
      recommendation: 'confirm',
      note: 'Good work in the lab',
    });
    assert.equal(rm.status, 200, JSON.stringify(rm.body));
    const rmDecide = await t.call('kiran.ops', 'POST', `/probation/${reviewId}/decide`, {
      decision: 'confirm',
      note: 'Self decision',
    });
    assert.equal(rmDecide.status, 403);
    const hr = await t.call('meera.hrbp', 'POST', `/probation/${reviewId}/decide`, {
      decision: 'confirm',
      note: 'Confirmed',
    });
    assert.equal(hr.status, 200, JSON.stringify(hr.body));
  });

  it('confirmation letter: HR yes, a peer no', async () => {
    const pdf = await t.call('meera.hrbp', 'GET', `/probation/${reviewId}/letter`);
    assert.equal(pdf.status, 200);
    assert.ok(pdf.head.startsWith('%PDF'));
    const peer = await t.call('asha.eng', 'GET', `/probation/${reviewId}/letter`);
    assert.ok(peer.status === 403 || peer.status === 404);
  });
});

describe('PIP', () => {
  const plan = {
    reason: 'Missed sprint goals three times',
    targets: [{ title: 'Ship two features', measure: 'merged PRs' }],
    support: 'Weekly 1:1 with the RM',
  };
  let pipId = '';

  it('outside the team and self are refused', async () => {
    const other = await t.call('sanjay.sales', 'POST', '/pips', {
      employeeId: t.ids['asha.eng'],
      ...plan,
    });
    assert.equal(other.status, 403);
    const self = await t.call('asha.eng', 'POST', '/pips', {
      employeeId: t.ids['asha.eng'],
      ...plan,
    });
    assert.equal(self.status, 403);
  });

  it('M1: the reporting manager can start a PIP even when the leave approver is someone else', async () => {
    // Seed: Neha reports to Rahul, but Priya is her leave approver.
    const can = await t.call(
      'rahul.manager',
      'GET',
      `/pips/can-start/${t.ids['neha.intern']}`,
    );
    assert.equal(can.status, 200);
    assert.equal(
      can.body.canStart ?? can.body.allowed ?? can.body,
      true,
      JSON.stringify(can.body),
    );
    const priya = await t.call('priya.pr', 'POST', '/pips', {
      employeeId: t.ids['neha.intern'],
      ...plan,
    });
    assert.equal(priya.status, 403, 'the leave approver is not the RM');
  });

  it('the RM starts one; a second concurrent PIP is refused', async () => {
    const r = await t.call('rahul.manager', 'POST', '/pips', {
      employeeId: t.ids['asha.eng'],
      ...plan,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    pipId = r.body.id;
    const again = await t.call('rahul.manager', 'POST', '/pips', {
      employeeId: t.ids['asha.eng'],
      ...plan,
    });
    assert.ok(again.status === 409 || again.status === 400);
  });

  it('the subject reads it, a peer cannot, the subject cannot record the outcome', async () => {
    assert.equal((await t.call('asha.eng', 'GET', `/pips/${pipId}`)).status, 200);
    const peer = await t.call('vikram.eng', 'GET', `/pips/${pipId}`);
    assert.ok(peer.status === 403 || peer.status === 404);
    const outcome = await t.call('asha.eng', 'POST', `/pips/${pipId}/outcome`, {
      outcome: 'passed',
      note: 'Self decision',
    });
    // 403 (not theirs) or 409 (the outcome is date-locked until the PIP ends) — never allowed.
    assert.ok(outcome.status === 403 || outcome.status === 409, String(outcome.status));
  });

  it('L10: cancelling twice says it is already closed (409)', async () => {
    const first = await t.call('rahul.manager', 'POST', `/pips/${pipId}/cancel`, {
      note: 'Test clean-up',
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await t.call('rahul.manager', 'POST', `/pips/${pipId}/cancel`, {
      note: 'Cancel again',
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
  });
});

describe('exits', () => {
  let exitId = '';

  it('resigns once; peers and the leaver can’t act on it', async () => {
    const r = await t.call('divya.sales', 'POST', '/exits/resign', {
      reason: 'Relocating to another city',
    });
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
    exitId = r.body?.exit?.id ?? r.body?.id;
    assert.ok(exitId);
    assert.equal(
      (await t.call('divya.sales', 'POST', '/exits/resign', { reason: 'again again' }))
        .status,
      409,
    );
    const peer = await t.call('asha.eng', 'GET', `/exits/${exitId}`);
    assert.ok(peer.status === 403 || peer.status === 404);
    const selfAccept = await t.call('divya.sales', 'POST', `/exits/${exitId}/accept`, {
      lastWorkingDay: addDays(today(), 5),
    });
    assert.equal(selfAccept.status, 403);
  });

  it('the manager acknowledges with a handover plan', async () => {
    const r = await t.call('sanjay.sales', 'POST', `/exits/${exitId}/acknowledge`, {
      handoverPlan: 'Hand the key accounts to Sanjay and brief the team',
    });
    assert.ok(r.status < 300, JSON.stringify(r.body));
  });

  it('HR accepts with a future last day; a past day is refused', async () => {
    const past = await t.call('meera.hrbp', 'POST', `/exits/${exitId}/accept`, {
      lastWorkingDay: '2020-01-01',
    });
    assert.ok(past.status >= 400 && past.status < 500);
    const ok = await t.call('meera.hrbp', 'POST', `/exits/${exitId}/accept`, {
      lastWorkingDay: addDays(today(), 1),
      shortfallAction: 'waive',
      shortfallReason: 'Agreed with the manager',
    });
    assert.ok(ok.status < 300, JSON.stringify(ok.body));
  });

  it('the leaver cannot clear themselves; ratings are range-checked', async () => {
    assert.equal(
      (await t.call('divya.sales', 'POST', `/exits/${exitId}/clear`, { kind: 'hr' }))
        .status,
      403,
    );
    const bad = await t.call('divya.sales', 'POST', `/exits/${exitId}/interview`, {
      reason: 'Relocation',
      liked: 'team',
      improve: 'process',
      managerRating: 9,
      roleRating: 4,
    });
    assert.equal(bad.status, 400);
  });

  it('HR can’t terminate themselves or the Owner; managers can’t terminate', async () => {
    const body = {
      reason: 'Test reason text',
      mode: 'serve',
      lastWorkingDay: addDays(today(), 30),
    };
    const rm = await t.call('rahul.manager', 'POST', '/exits/terminate', {
      employeeId: t.ids['vikram.eng'],
      ...body,
    });
    assert.equal(rm.status, 403, `RM: ${JSON.stringify(rm.body)}`);
    const self = await t.call('meera.hrbp', 'POST', '/exits/terminate', {
      employeeId: t.ids['meera.hrbp'],
      ...body,
    });
    assert.ok(self.status >= 400 && self.status < 500, `self: ${self.status}`);
    const owner = await t.call('meera.hrbp', 'POST', '/exits/terminate', {
      employeeId: t.ids['admin'],
      ...body,
    });
    assert.ok(owner.status >= 400 && owner.status < 500, `owner: ${owner.status}`);
  });

  it('a bad letter name is a 4xx; a peer can’t read letters', async () => {
    const bad = await t.call(
      'meera.hrbp',
      'GET',
      `/exits/${exitId}/letters/..%2F..%2Fetc`,
    );
    assert.ok(bad.status >= 400 && bad.status < 500);
    const peer = await t.call('asha.eng', 'GET', `/exits/${exitId}/letters/relieving`);
    assert.ok(peer.status === 403 || peer.status === 404);
  });

  it('exit day: clearances, the job relieves the leaver, who is then locked out', async () => {
    // Last working day = the last day of last month, so the F&F lands in last
    // month's (closed) run — payroll.test.ts uses the month before that.
    await t.sql(
      `update org.exits set last_working_day = date_trunc('month', current_date)::date - 1 where id = $1`,
      [exitId],
    );
    for (const [who, kind] of [
      ['meera.hrbp', 'hr'],
      ['sanjay.sales', 'manager'],
      ['kiran.ops', 'ops'],
    ] as const) {
      const r = await t.call(who, 'POST', `/exits/${exitId}/clear`, {
        kind,
        note: 'Cleared',
      });
      assert.ok(r.status < 300, `${kind}: ${JSON.stringify(r.body)}`);
    }
    const job = await t.call('admin', 'POST', '/admin/jobs/exit-day/run');
    assert.ok(job.status < 300, JSON.stringify(job.body));
    const login = await t.login('divya.sales');
    assert.ok(
      login.status === 401 || login.status === 403,
      `relieved leaver login: ${login.status}`,
    );
  });

  it('F&F settles in payroll; statement and letters are PDFs', async () => {
    const month = prevMonth();
    const run = await t.call('priya.pr', 'POST', '/payroll/runs', { month });
    assert.ok(run.status === 201 || run.status === 409, JSON.stringify(run.body));
    const runId =
      run.body?.run?.id ??
      (
        (await t.call('priya.pr', 'GET', '/payroll/runs')).body as Array<{
          id: string;
          month: string;
        }>
      ).find((r) => r.month === month)?.id;
    const fin = await t.call('priya.pr', 'POST', `/payroll/runs/${runId}/finalize`);
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    const st = await t.call('priya.pr', 'GET', `/payroll/exits/${exitId}/statement`);
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.ok(st.head.startsWith('%PDF'));
    for (const which of ['relieving', 'experience']) {
      const l = await t.call('meera.hrbp', 'GET', `/exits/${exitId}/letters/${which}`);
      assert.equal(l.status, 200, `${which}: ${JSON.stringify(l.body)}`);
      assert.ok(l.head.startsWith('%PDF'));
    }
  });
});
