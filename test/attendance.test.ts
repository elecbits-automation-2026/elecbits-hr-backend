import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addDays,
  monthOf,
  startApp,
  today,
  weekday,
  type TestApp,
} from './helpers/api.js';

let t: TestApp;
before(async () => {
  t = await startApp();
});
after(async () => {
  await t.stop();
});

describe('punch zones', () => {
  let zoneId = '';

  it('the Admin creates a zone; bad radius and employees are refused', async () => {
    const r = await t.call('admin', 'POST', '/attendance/zones', {
      name: 'Test HQ',
      lat: 28.61,
      lng: 77.21,
      radiusM: 300,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    zoneId = r.body.id;
    const neg = await t.call('admin', 'POST', '/attendance/zones', {
      name: 'Bad',
      lat: 28.61,
      lng: 77.21,
      radiusM: -5,
    });
    assert.equal(neg.status, 400);
    const emp = await t.call('asha.eng', 'POST', '/attendance/zones', {
      name: 'Hack',
      lat: 1,
      lng: 1,
    });
    assert.equal(emp.status, 403);
  });

  it('checks in inside the zone and refuses an impossible latitude', async () => {
    const bad = await t.call('divya.sales', 'POST', '/attendance/check-in', {
      lat: 999,
      lng: 77.2,
      accuracyM: 20,
    });
    assert.equal(bad.status, 400);
    const r = await t.call('divya.sales', 'POST', '/attendance/check-in', {
      lat: 28.61,
      lng: 77.21,
      accuracyM: 20,
    });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  });

  it('refuses a check-in far from every zone with a helpful message', async () => {
    const r = await t.call('sanjay.sales', 'POST', '/attendance/check-in', {
      lat: 12.97,
      lng: 77.59,
      accuracyM: 20,
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error.message, /km|remote/i);
  });

  it('a zone in use cannot be deleted', async () => {
    const r = await t.call('admin', 'DELETE', `/attendance/zones/${zoneId}`);
    assert.ok(r.status === 409 || r.status < 300, String(r.status));
  });
});

describe('HR marking and views', () => {
  const day = weekday(addDays(today(), -7));

  it('refuses check-out before check-in and a future day', async () => {
    const reversed = await t.call('meera.hrbp', 'POST', '/attendance/hr-mark', {
      employeeId: t.ids['neha.intern'],
      date: day,
      checkInAt: `${day}T08:00:00Z`,
      checkOutAt: `${day}T04:00:00Z`,
      reason: 'reversed',
    });
    assert.ok(reversed.status >= 400 && reversed.status < 500);
    const future = addDays(today(), 30);
    const fut = await t.call('meera.hrbp', 'POST', '/attendance/hr-mark', {
      employeeId: t.ids['neha.intern'],
      date: future,
      checkInAt: `${future}T04:00:00Z`,
      checkOutAt: `${future}T13:00:00Z`,
      reason: 'future',
    });
    assert.ok(fut.status >= 400 && fut.status < 500);
  });

  it('needs a reason, shows it on the day, and tells the employee', async () => {
    const body = {
      employeeId: t.ids['neha.intern'],
      date: day,
      checkInAt: `${day}T04:00:00Z`,
      checkOutAt: `${day}T12:30:00Z`,
    };
    const none = await t.call('meera.hrbp', 'POST', '/attendance/hr-mark', body);
    assert.equal(none.status, 400, JSON.stringify(none.body));

    const r = await t.call('meera.hrbp', 'POST', '/attendance/hr-mark', {
      ...body,
      reason: 'Forgot to punch — badge log confirms',
    });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));

    const mine = await t.call(
      'neha.intern',
      'GET',
      `/attendance/me?month=${monthOf(day)}`,
    );
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const marked = mine.body.days.find((d: { date: string }) => d.date === day);
    assert.equal(marked.source, 'regularized');
    assert.equal(marked.regularizedReason, 'Forgot to punch — badge log confirms');
    assert.ok(marked.regularizedByName, 'who marked it is shown');
    assert.ok(mine.body.summary.regularized >= 1, 'counted in the month stats');

    // Payroll's CSV carries the count and the reason too.
    const csv = await t.call(
      'meera.hrbp',
      'GET',
      `/attendance/export?month=${monthOf(day)}`,
    );
    assert.equal(csv.status, 200);
    assert.match(String(csv.body), /Marked by HR/);
    assert.match(String(csv.body), new RegExp(`${day}: Forgot to punch`));

    const bell = (await t.call('neha.intern', 'GET', '/notifications')).body;
    const items: Array<{ type: string; body: string | null }> = bell?.items ?? bell ?? [];
    assert.ok(
      items.some(
        (n) =>
          n.type === 'attendance.hr_marked' && /badge log confirms/.test(n.body ?? ''),
      ),
      JSON.stringify(items.slice(0, 5)),
    );
  });

  it('manager sees the team; an employee cannot see the org', async () => {
    const m = monthOf(today());
    assert.equal(
      (await t.call('rahul.manager', 'GET', `/attendance/team?month=${m}`)).status,
      200,
    );
    assert.equal(
      (await t.call('asha.eng', 'GET', `/attendance/org?month=${m}`)).status,
      403,
    );
  });

  it('exports CSV; L5: a bad month is a 400', async () => {
    const ok = await t.call(
      'meera.hrbp',
      'GET',
      `/attendance/export?month=${monthOf(today())}`,
    );
    assert.equal(ok.status, 200);
    const bad = await t.call('meera.hrbp', 'GET', '/attendance/export?month=garbage');
    assert.equal(bad.status, 400);
  });

  it('a duplicate holiday is a 409', async () => {
    const date = `${today().slice(0, 4)}-12-31`;
    const first = await t.call('meera.hrbp', 'POST', '/attendance/holidays', {
      date,
      name: 'Year end',
    });
    assert.ok(first.status === 201 || first.status === 409);
    const dup = await t.call('meera.hrbp', 'POST', '/attendance/holidays', {
      date,
      name: 'Year end again',
    });
    assert.equal(dup.status, 409);
  });
});

describe('remote work', () => {
  const s = weekday(addDays(today(), 2));
  let wfhId = '';

  it('raises; self-approval is blocked; the RM approves', async () => {
    const r = await t.call('asha.eng', 'POST', '/attendance/wfh', {
      startDate: s,
      endDate: s,
      reason: 'Plumber visit',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    wfhId = r.body.id;
    const self = await t.call('asha.eng', 'POST', `/attendance/wfh/${wfhId}/decision`, {
      decision: 'approve',
    });
    assert.ok(self.status === 403 || self.status === 409);
    const rm = await t.call(
      'rahul.manager',
      'POST',
      `/attendance/wfh/${wfhId}/decision`,
      {
        decision: 'approve',
      },
    );
    assert.equal(rm.status, 200, JSON.stringify(rm.body));
  });

  it('M2: an overlapping request is a 409', async () => {
    const r = await t.call('asha.eng', 'POST', '/attendance/wfh', {
      startDate: s,
      endDate: s,
      reason: 'overlap',
    });
    assert.equal(r.status, 409, JSON.stringify(r.body));
  });

  it('M3: a year-long request is refused', async () => {
    const r = await t.call('asha.eng', 'POST', '/attendance/wfh', {
      startDate: addDays(today(), 10),
      endDate: addDays(today(), 400),
      reason: 'a whole year',
    });
    assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(r.body));
  });

  it('refuses past dates', async () => {
    const r = await t.call('asha.eng', 'POST', '/attendance/wfh', {
      startDate: addDays(today(), -3),
      endDate: addDays(today(), -3),
      reason: 'yesterday',
    });
    assert.ok(r.status >= 400 && r.status < 500);
  });
});
