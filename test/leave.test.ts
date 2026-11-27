import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addDays, startApp, today, weekday, type TestApp } from './helpers/api.js';

let t: TestApp;
before(async () => {
  t = await startApp();
});
after(async () => {
  await t.stop();
});

type Balance = { type: string; remaining: number };
const earnedLeft = async (who: string): Promise<number> => {
  const r = await t.call(who, 'GET', '/leaves/balances');
  assert.equal(r.status, 200);
  return (r.body as Balance[]).find((b) => b.type === 'earned')!.remaining;
};

describe('leave: raise → RM → HR → cancel', () => {
  // Earned leave needs 7 days' notice: plan it three weeks out.
  const start = weekday(addDays(today(), 21));
  const end = start;
  let leaveId = '';
  let before0 = 0;

  it('shows the approval route', async () => {
    const r = await t.call('asha.eng', 'GET', '/leaves/approval-route?type=earned');
    assert.equal(r.status, 200);
  });

  it('raises an earned leave', async () => {
    before0 = await earnedLeft('vikram.eng');
    const r = await t.call('vikram.eng', 'POST', '/leaves', {
      type: 'earned',
      startDate: start,
      endDate: end,
      reason: 'Family trip',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    leaveId = r.body.id;
  });

  it('refuses overlap, reversed dates, 1990 dates, bad dates and huge reasons', async () => {
    const overlap = await t.call('vikram.eng', 'POST', '/leaves', {
      type: 'earned',
      startDate: start,
      endDate: start,
      reason: 'overlap',
    });
    assert.ok([400, 409, 422].includes(overlap.status), String(overlap.status));
    const reversed = await t.call('vikram.eng', 'POST', '/leaves', {
      type: 'earned',
      startDate: addDays(start, 5),
      endDate: addDays(start, 3),
    });
    assert.ok([400, 422].includes(reversed.status), String(reversed.status));
    const ancient = await t.call('vikram.eng', 'POST', '/leaves', {
      type: 'sick',
      startDate: '1990-01-01',
      endDate: '1990-01-01',
    });
    assert.ok(ancient.status >= 400 && ancient.status < 500);
    const bad = await t.call('vikram.eng', 'POST', '/leaves', {
      type: 'sick',
      startDate: 'not-a-date',
      endDate: 'x',
    });
    assert.equal(bad.status, 400);
    const huge = await t.call('vikram.eng', 'POST', '/leaves', {
      type: 'sick',
      startDate: weekday(addDays(today(), 40)),
      endDate: weekday(addDays(today(), 40)),
      reason: 'x'.repeat(20000),
    });
    assert.ok(huge.status === 400 || huge.status === 413, String(huge.status));
  });

  it('refuses leave far beyond the balance', async () => {
    const r = await t.call('vikram.eng', 'POST', '/leaves', {
      type: 'earned',
      startDate: weekday(addDays(today(), 60)),
      endDate: addDays(today(), 150),
      reason: 'way over balance',
    });
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  });

  it('blocks self-approval and managers outside the team', async () => {
    const self = await t.call('vikram.eng', 'POST', `/leaves/${leaveId}/decision`, {
      decision: 'approve',
    });
    assert.ok(self.status === 403 || self.status === 409, String(self.status));
    const other = await t.call('sanjay.sales', 'POST', `/leaves/${leaveId}/decision`, {
      decision: 'approve',
    });
    assert.ok(other.status === 403 || other.status === 404, String(other.status));
  });

  it('a decline needs a reason', async () => {
    const r = await t.call('rahul.manager', 'POST', `/leaves/${leaveId}/decision`, {
      decision: 'decline',
    });
    assert.ok(r.status === 400 || r.status === 422, String(r.status));
  });

  it('RM then HR approve; a second approval is refused; balance drops', async () => {
    const rm = await t.call('rahul.manager', 'POST', `/leaves/${leaveId}/decision`, {
      decision: 'approve',
    });
    assert.equal(rm.status, 200, JSON.stringify(rm.body));
    if (rm.body.status !== 'approved') {
      const hr = await t.call('meera.hrbp', 'POST', `/leaves/${leaveId}/decision`, {
        decision: 'approve',
      });
      assert.equal(hr.status, 200, JSON.stringify(hr.body));
      assert.equal(hr.body.status, 'approved');
    }
    const again = await t.call('rahul.manager', 'POST', `/leaves/${leaveId}/decision`, {
      decision: 'approve',
    });
    assert.ok(again.status >= 400);
    assert.equal(await earnedLeft('vikram.eng'), before0 - 1);
  });

  it('cancelling a future approved leave restores the balance', async () => {
    const r = await t.call('vikram.eng', 'POST', `/leaves/${leaveId}/cancel`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await earnedLeft('vikram.eng'), before0);
  });
});

describe('leave rules', () => {
  it('day-count counts a working Saturday, like raising does (the sick-certificate hint)', async () => {
    // Default week: 1st and 3rd Saturdays off. Jan 2027: the 9th works, the 16th is off.
    const count = async (startDate: string, endDate: string) => {
      const r = await t.call(
        'asha.eng',
        'GET',
        `/leaves/day-count?startDate=${startDate}&endDate=${endDate}`,
      );
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.sickCertificateAfterDays, 3);
      return r.body.days as number;
    };
    assert.equal(await count('2027-01-06', '2027-01-09'), 4); // Wed→Sat (working)
    assert.equal(await count('2027-01-13', '2027-01-17'), 3); // Wed→Sun (Sat off)
    const bad = await t.call(
      'asha.eng',
      'GET',
      '/leaves/day-count?startDate=2027-01-09&endDate=2027-01-06',
    );
    assert.equal(bad.status, 400);
  });

  it('sick leave over 3 days cannot be approved without a certificate', async () => {
    const s = weekday(addDays(today(), 7));
    const r = await t.call('arjun.eng', 'POST', '/leaves', {
      type: 'sick',
      startDate: s,
      endDate: addDays(s, 6),
      reason: 'flu',
    });
    if (r.status !== 201) {
      // Refused outright (balance or certificate up front) — also acceptable.
      assert.ok(r.status >= 400 && r.status < 500, String(r.status));
      return;
    }
    const d = await t.call('rahul.manager', 'POST', `/leaves/${r.body.id}/decision`, {
      decision: 'approve',
    });
    assert.ok(d.status >= 400, String(d.status));
    await t.call('arjun.eng', 'POST', `/leaves/${r.body.id}/cancel`);
  });

  it('a half day cannot span two days', async () => {
    const s = weekday(addDays(today(), 8));
    const r = await t.call('neha.intern', 'POST', '/leaves', {
      type: 'sick',
      startDate: s,
      endDate: addDays(s, 1),
      dayPart: 'first_half',
    });
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  });

  it('a certificate is private to the leave holder and approvers', async () => {
    const s = weekday(addDays(today(), 9));
    const lv = await t.call('arjun.eng', 'POST', '/leaves', {
      type: 'sick',
      startDate: s,
      endDate: s,
      reason: 'cold',
    });
    assert.equal(lv.status, 201, JSON.stringify(lv.body));
    const { PDF } = await import('./helpers/api.js');
    const up = await t.call(
      'arjun.eng',
      'PUT',
      `/leaves/${lv.body.id}/certificate?filename=c.pdf`,
      undefined,
      {
        raw: PDF,
        contentType: 'application/pdf',
      },
    );
    assert.ok(up.status < 300, JSON.stringify(up.body));
    const own = await t.call('arjun.eng', 'GET', `/leaves/${lv.body.id}/certificate`);
    assert.equal(own.status, 200);
    assert.ok(own.head.startsWith('%PDF'));
    const peer = await t.call('asha.eng', 'GET', `/leaves/${lv.body.id}/certificate`);
    assert.ok(peer.status === 403 || peer.status === 404, String(peer.status));
    await t.call('arjun.eng', 'POST', `/leaves/${lv.body.id}/cancel`);
  });

  it('an employee cannot read peer balances or the org list', async () => {
    const peer = await t.call(
      'asha.eng',
      'GET',
      `/leaves/team/${t.ids['vikram.eng']}/balances`,
    );
    assert.ok(peer.status === 403 || peer.status === 404);
    assert.equal((await t.call('asha.eng', 'GET', '/leaves')).status, 403);
  });
});
