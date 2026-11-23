import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addDays, errorCode, startApp, today, type TestApp } from './helpers/api.js';

let t: TestApp;
before(async () => {
  t = await startApp();
});
after(async () => {
  await t.stop();
});

describe('who can see what (authorization matrix)', () => {
  const forbiddenForEmployee = [
    '/employees/incomplete',
    '/payroll/people',
    '/payroll/loans',
    '/payroll/corrections',
    '/reimbursements',
    '/exits',
    '/policies/tracker',
    '/onboarding',
    '/trainings',
    '/audit-log',
    '/hiring/candidates',
  ];
  for (const path of forbiddenForEmployee) {
    it(`an employee gets 403 on ${path}`, async () => {
      assert.equal((await t.call('asha.eng', 'GET', path)).status, 403);
    });
  }

  it('managers only see their own team', async () => {
    const a = t.ids['asha.eng'];
    for (const path of [
      `/goals/team/${a}`,
      `/leaves/team/${a}/balances`,
      `/feedback/about/${a}`,
    ]) {
      const r = await t.call('sanjay.sales', 'GET', path);
      assert.ok(r.status === 403 || r.status === 404, `${path} → ${r.status}`);
    }
    assert.equal((await t.call('rahul.manager', 'GET', '/reimbursements')).status, 403);
  });
});

describe('profile (L3)', () => {
  it('refuses a 5,000-character name and a future date of birth', async () => {
    assert.equal(
      (await t.call('asha.eng', 'PATCH', '/me', { firstName: 'A'.repeat(5000) })).status,
      400,
    );
    assert.equal(
      (await t.call('asha.eng', 'PATCH', '/me', { dateOfBirth: '2099-13-45' })).status,
      400,
    );
    assert.equal(
      (await t.call('asha.eng', 'PATCH', '/me', { dateOfBirth: addDays(today(), 30) }))
        .status,
      400,
    );
  });

  it('an employee can’t self-promote', async () => {
    const r = await t.call('asha.eng', 'PATCH', `/employees/${t.ids['asha.eng']}`, {
      level: 'L6',
    });
    assert.equal(r.status, 403);
  });
});

describe('people records', () => {
  it('refuses duplicate codes, unknown managers and reporting loops', async () => {
    const dup = await t.call('meera.hrbp', 'POST', '/employees', {
      firstName: 'Bad',
      employeeCode: 'EB-0002',
      email: 'bad1@elecbits.in',
      level: 'L2',
      reportsTo: t.ids['rahul.manager'],
    });
    assert.equal(dup.status, 409);
    const ghost = await t.call('meera.hrbp', 'POST', '/employees', {
      firstName: 'Bad',
      employeeCode: 'EB-9901',
      email: 'bad2@elecbits.in',
      level: 'L2',
      reportsTo: '00000000-0000-0000-0000-000000000000',
    });
    assert.ok(ghost.status >= 400 && ghost.status < 500);
    const loop = await t.call(
      'meera.hrbp',
      'PATCH',
      `/employees/${t.ids['rahul.manager']}`,
      {
        reportsTo: t.ids['asha.eng'],
      },
    );
    assert.ok(loop.status >= 400 && loop.status < 500);
  });

  it('L8: invite keeps the name parts; onboarding starts once a joining date is saved', async () => {
    const r = await t.call('admin', 'POST', '/employees/invite', {
      email: 'no.date@elecbits.in',
      name: 'Nodate Person',
      reportsTo: t.ids['rahul.manager'],
      level: 'L2',
      batchIds: [],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.firstName, 'Nodate');
    assert.equal(r.body.lastName, 'Person');
    // Task due dates count from the joining date, so no journey until there is one.
    const before = await t.call('meera.hrbp', 'GET', `/onboarding/employee/${r.body.id}`);
    assert.equal(before.status, 404, JSON.stringify(before.body));
    const set = await t.call('meera.hrbp', 'PATCH', `/employees/${r.body.id}`, {
      dateOfJoining: new Date().toISOString().slice(0, 10),
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const after = await t.call('meera.hrbp', 'GET', `/onboarding/employee/${r.body.id}`);
    assert.equal(after.status, 200, JSON.stringify(after.body));
  });

  it('records can only be created on the company email domain', async () => {
    const r = await t.call('admin', 'POST', '/employees/invite', {
      email: 'outsider@gmail.com',
      name: 'Out Sider',
      reportsTo: t.ids['rahul.manager'],
      level: 'L2',
      batchIds: [],
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error?.code, 'NOT_COMPANY_EMAIL');
  });
});

describe('roles & access', () => {
  it('HRBP can’t self-assign a batch; nobody approves their own access request', async () => {
    const batches = (await t.call('admin', 'GET', '/batches')).body as Array<{
      id: string;
      name: string;
    }>;
    const pr = batches.find((b) => b.name === 'PR')!;
    assert.equal(
      (
        await t.call('meera.hrbp', 'POST', `/batches/${pr.id}/assign`, {
          employeeId: t.ids['meera.hrbp'],
        })
      ).status,
      403,
    );
    const req = await t.call('rahul.manager', 'POST', '/grant-requests', {
      employeeId: t.ids['rahul.manager'],
      note: 'I want payroll for myself',
      items: [{ moduleKey: 'pr.payroll', action: 'read', scope: 'org' }],
    });
    if (req.status === 201) {
      const d = await t.call(
        'rahul.manager',
        'POST',
        `/grant-requests/${req.body.id}/decision`,
        {
          decision: 'approve',
        },
      );
      assert.equal(d.status, 403);
    }
  });

  it('audit log page size is capped', async () => {
    const r = await t.call('admin', 'GET', '/audit-log?pageSize=5000');
    assert.ok(r.status === 400 || (r.body?.entries?.length ?? 0) <= 200);
  });
});

describe('notifications and settings', () => {
  it('can’t mark another person’s bell item read', async () => {
    const theirs = (await t.call('vikram.eng', 'GET', '/notifications')).body;
    const item = (theirs?.items ?? theirs ?? [])[0];
    if (item) {
      const r = await t.call('asha.eng', 'POST', `/notifications/${item.id}/read`);
      assert.ok(r.status === 403 || r.status === 404);
    }
    assert.equal(
      (await t.call('asha.eng', 'GET', '/notifications/unread-count')).status,
      200,
    );
  });

  it('settings are validated and HR-only', async () => {
    assert.equal(
      (
        await t.call('asha.eng', 'PUT', '/settings/assistant.enabled', {
          value: { enabled: true },
        })
      ).status,
      403,
    );
    const bad = await t.call('meera.hrbp', 'PUT', '/settings/attendance.workHours', {
      value: { workStart: '25:99', workEnd: '18:30', graceMinutes: -5 },
    });
    assert.ok(bad.status === 400 || bad.status === 422);
    const unknown = await t.call('meera.hrbp', 'PUT', '/settings/no.such.key', {
      value: 1,
    });
    assert.ok(unknown.status === 404 || unknown.status === 400);
  });
});

describe('HR assistant (L7)', () => {
  it('a plain employee gets 403 ASSISTANT_NOT_ALLOWED, not a server error', async () => {
    await t.call('admin', 'PUT', '/settings/assistant.enabled', {
      value: { enabled: true },
    });
    const r = await t.call('asha.eng', 'POST', '/assistant/chat', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(errorCode(r), 'ASSISTANT_NOT_ALLOWED');
  });

  it('a manager with no server key gets a 503 that says why', async () => {
    const r = await t.call('rahul.manager', 'POST', '/assistant/chat', {
      messages: [{ role: 'user', content: 'who is out today?' }],
    });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.doesNotMatch(r.body?.error?.message ?? '', /internal server error/i);
    await t.call('admin', 'PUT', '/settings/assistant.enabled', {
      value: { enabled: false },
    });
  });
});

describe('probes (M11)', () => {
  it('/health, /ready and /health/ready', async () => {
    for (const path of ['/health', '/ready', '/health/ready']) {
      const r = await fetch(`${t.base}${path}`);
      assert.equal(r.status, 200, path);
    }
    const ready = (await (await fetch(`${t.base}/health/ready`)).json()) as {
      db: boolean;
    };
    assert.equal(ready.db, true);
  });
});
