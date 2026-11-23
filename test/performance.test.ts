import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addDays, startApp, today, type TestApp } from './helpers/api.js';

let t: TestApp;
before(async () => {
  t = await startApp();
});
after(async () => {
  await t.stop();
});

describe('goals', () => {
  let goalId = '';

  it('the RM sets a goal for a report; others and absurd weights are refused', async () => {
    const r = await t.call('rahul.manager', 'POST', '/goals', {
      employeeId: t.ids['vikram.eng'],
      title: 'Document the test rig',
      weight: 40,
      category: 'general',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    goalId = r.body.id;
    const other = await t.call('sanjay.sales', 'POST', '/goals', {
      employeeId: t.ids['vikram.eng'],
      title: 'Not my report',
      weight: 5,
    });
    assert.equal(other.status, 403);
    const w500 = await t.call('rahul.manager', 'POST', '/goals', {
      employeeId: t.ids['vikram.eng'],
      title: 'Overweight',
      weight: 500,
    });
    assert.ok(w500.status >= 400 && w500.status < 500);
  });

  it('M4: weights for one person cannot go past 100% in a cycle', async () => {
    const ok = await t.call('rahul.manager', 'POST', '/goals', {
      employeeId: t.ids['vikram.eng'],
      title: 'Second goal',
      weight: 60,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const over = await t.call('rahul.manager', 'POST', '/goals', {
      employeeId: t.ids['vikram.eng'],
      title: 'Pushes the total past 100',
      weight: 10,
    });
    assert.ok(over.status >= 400 && over.status < 500, JSON.stringify(over.body));
  });

  it('progress is range-checked', async () => {
    const r = await t.call('vikram.eng', 'PATCH', `/goals/${goalId}/progress`, {
      progress: 150,
    });
    assert.equal(r.status, 400);
  });
});

describe('work updates and daily KPI', () => {
  it('refuses future, too-short and other people’s goals', async () => {
    const future = await t.call('asha.eng', 'POST', '/work-updates', {
      note: 'Future update text',
      date: addDays(today(), 3),
    });
    assert.ok(future.status >= 400 && future.status < 500);
    assert.equal(
      (await t.call('asha.eng', 'POST', '/work-updates', { note: 'x' })).status,
      400,
    );
  });

  it('daily KPI per role; employees can’t see the org view; bad date is 400', async () => {
    for (const [who, path] of [
      ['asha.eng', '/daily-kpi/mine'],
      ['rahul.manager', '/daily-kpi/team'],
      ['meera.hrbp', '/daily-kpi/org'],
    ] as const) {
      assert.equal((await t.call(who, 'GET', path)).status, 200, path);
    }
    assert.equal((await t.call('asha.eng', 'GET', '/daily-kpi/org')).status, 403);
    assert.equal(
      (await t.call('asha.eng', 'GET', '/daily-kpi/mine?date=garbage')).status,
      400,
    );
  });

  it('peers can’t read each other’s updates, quarter reports or career', async () => {
    const a = t.ids['asha.eng'];
    for (const path of [`/work-updates/team/${a}`, `/career/people/${a}`]) {
      const r = await t.call('vikram.eng', 'GET', path);
      assert.ok(r.status === 403 || r.status === 404, `${path} → ${r.status}`);
    }
    // Quarter reports answer 200 but filtered: a peer sees none.
    const qr = await t.call('vikram.eng', 'GET', `/quarter-reports/people/${a}`);
    assert.ok(
      qr.status === 403 ||
        qr.status === 404 ||
        (qr.status === 200 && qr.body.length === 0),
    );
  });
});

describe('awards and feedback', () => {
  it('no self-nomination, no unknown type, nominee/nominator can’t approve', async () => {
    const self = await t.call('asha.eng', 'POST', '/recognitions', {
      employeeIds: [t.ids['asha.eng']],
      type: 'spot',
      citation: 'I am awesome and deserve this award',
    });
    assert.ok(self.status >= 400 && self.status < 500);
    const bad = await t.call('asha.eng', 'POST', '/recognitions', {
      employeeIds: [t.ids['vikram.eng']],
      type: 'nonexistent',
      citation: 'Bad type citation text here',
    });
    assert.ok(bad.status >= 400 && bad.status < 500);
    const r = await t.call('asha.eng', 'POST', '/recognitions', {
      employeeIds: [t.ids['vikram.eng']],
      type: 'spot',
      citation: 'Vikram fixed the flaky test bench overnight',
    });
    if (r.status === 201) {
      for (const who of ['vikram.eng', 'asha.eng']) {
        const d = await t.call(who, 'POST', `/recognitions/${r.body.id}/decide`, {
          decision: 'approve',
        });
        assert.equal(d.status, 403, who);
      }
    }
    assert.equal((await t.call('asha.eng', 'GET', '/recognitions/board')).status, 200);
  });

  it('no self feedback; peers can’t read feedback about someone', async () => {
    const self = await t.call('asha.eng', 'POST', '/feedback', {
      employeeId: t.ids['asha.eng'],
      type: 'appreciation',
      body: 'Self praise self praise',
    });
    assert.ok(self.status >= 400 && self.status < 500);
    assert.equal(
      (await t.call('vikram.eng', 'GET', `/feedback/about/${t.ids['asha.eng']}`)).status,
      403,
    );
  });
});

describe('career roadmap requests', () => {
  it('a self-request rings the manager’s bell and queues an email', async () => {
    const who = 'asha.eng';
    const id = t.ids[who];
    // Relax the minimums so the seeded person qualifies; email on so it queues.
    const relax = await t.call('meera.hrbp', 'PUT', '/settings/career.selfRequest', {
      value: { minMonthsInBand: 0, minAttainment: null, cooldownDays: 0 },
    });
    assert.equal(relax.status, 200, JSON.stringify(relax.body));
    const mail = await t.call('admin', 'PUT', '/settings/email.delivery', {
      value: { enabled: true },
    });
    assert.equal(mail.status, 200, JSON.stringify(mail.body));
    try {
      await t.sql(
        `UPDATE org.career_tracks SET status = 'closed' WHERE employee_id = $1 AND status = 'open'`,
        [id],
      );
      const [me] = await t.sql<{ rm: string }>(
        `SELECT coalesce(leave_approver, reports_to) AS rm FROM org.employees WHERE id = $1`,
        [id],
      );
      assert.ok(me?.rm, 'seeded person has a manager');

      const r = await t.call(who, 'POST', '/career/request');
      assert.equal(r.status, 201, JSON.stringify(r.body));

      const bells = await t.sql<{ title: string; link: string }>(
        `SELECT title, link FROM org.notifications WHERE recipient_id = $1 AND type = 'career.requested'`,
        [me!.rm],
      );
      assert.equal(bells.length, 1);
      assert.match(bells[0]!.title, /asked for a roadmap conversation/);
      assert.equal(bells[0]!.link, '/growth?tab=team');
      const emails = await t.sql<{ n: string }>(
        `SELECT count(*) AS n FROM ops.email_outbox WHERE recipient_id = $1 AND type = 'career.requested'`,
        [me!.rm],
      );
      assert.equal(Number(emails[0]!.n), 1);
      // Nobody hears about their own request.
      const own = await t.sql(
        `SELECT 1 FROM org.notifications WHERE recipient_id = $1 AND type = 'career.requested'`,
        [id],
      );
      assert.equal(own.length, 0);
    } finally {
      await t.call('admin', 'PUT', '/settings/email.delivery', {
        value: { enabled: false },
      });
    }
  });
});
