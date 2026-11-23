import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PDF, addDays, startApp, today, type TestApp } from './helpers/api.js';

let t: TestApp;
before(async () => {
  t = await startApp();
});
after(async () => {
  await t.stop();
});

type Category = { id: string; name: string; kind?: string; requiresGatePass?: boolean };

describe('assets', () => {
  let laptop: Category;
  let assetId = '';
  let zoneId = '';

  it('only OPS registers assets; cost and dates are validated', async () => {
    const setup = await t.call('kiran.ops', 'GET', '/asset-setup');
    assert.equal(setup.status, 200);
    const cats: Category[] = setup.body.categories ?? setup.body;
    laptop = cats.find((c) => /laptop/i.test(c.name)) ?? cats[0]!;
    // Assets live at a location (a punch zone).
    const zone = await t.call('admin', 'POST', '/attendance/zones', {
      name: 'Asset Store',
      lat: 28.45,
      lng: 77.02,
      radiusM: 200,
    });
    assert.equal(zone.status, 201, JSON.stringify(zone.body));
    zoneId = zone.body.id;
    assert.equal(
      (
        await t.call('asha.eng', 'POST', '/assets', {
          name: 'Hack',
          categoryId: laptop.id,
        })
      ).status,
      403,
    );
    const neg = await t.call('kiran.ops', 'POST', '/assets', {
      name: 'Test ThinkPad',
      categoryId: laptop.id,
      zoneId,
      serialNo: 'TEST-SN-NEG',
      purchaseCost: -100,
    });
    assert.equal(neg.status, 400);
    // L6: warranty can't end before the purchase.
    const warranty = await t.call('kiran.ops', 'POST', '/assets', {
      name: 'Test ThinkPad',
      categoryId: laptop.id,
      zoneId,
      serialNo: 'TEST-SN-W',
      purchasedOn: '2026-10-01',
      warrantyUntil: '2025-01-01',
    });
    assert.ok(
      warranty.status === 400 || warranty.status === 422,
      JSON.stringify(warranty.body),
    );
  });

  it('M6: a duplicate serial number is a 409', async () => {
    const r = await t.call('kiran.ops', 'POST', '/assets', {
      name: 'Test ThinkPad',
      categoryId: laptop.id,
      zoneId,
      serialNo: 'TEST-SN-1',
      purchaseCost: 85000,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assetId = r.body.id;
    const dup = await t.call('kiran.ops', 'POST', '/assets', {
      name: 'Test ThinkPad dup',
      categoryId: laptop.id,
      zoneId,
      serialNo: 'TEST-SN-1',
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
  });

  it('issues once; the holder sees it; only the holder reports incidents', async () => {
    assert.equal(
      (
        await t.call('kiran.ops', 'POST', `/assets/${assetId}/issue`, {
          employeeId: t.ids['asha.eng'],
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await t.call('kiran.ops', 'POST', `/assets/${assetId}/issue`, {
          employeeId: t.ids['vikram.eng'],
        })
      ).status,
      409,
    );
    const mine = await t.call('asha.eng', 'GET', '/my-assets');
    assert.equal(mine.status, 200);
    assert.match(JSON.stringify(mine.body), /Test ThinkPad/);
    const other = await t.call('vikram.eng', 'POST', `/my-assets/${assetId}/incidents`, {
      kind: 'damage',
      description: 'Reporting on someone else’s asset',
    });
    assert.ok(other.status === 403 || other.status === 404);
  });

  it('stock never goes negative', async () => {
    const item = await t.call('kiran.ops', 'POST', '/stock/items', {
      sku: 'TEST-RES-10K',
      name: '10k resistor',
      unit: 'pcs',
    });
    assert.ok(item.status === 201 || item.status === 200, JSON.stringify(item.body));
    let zones = (await t.call('admin', 'GET', '/attendance/zones')).body ?? [];
    if (!zones.length) {
      await t.call('admin', 'POST', '/attendance/zones', {
        name: 'Stock Lab',
        lat: 28.5,
        lng: 77.3,
        radiusM: 300,
      });
      zones = (await t.call('admin', 'GET', '/attendance/zones')).body;
    }
    const issue = await t.call('kiran.ops', 'POST', '/stock/movements', {
      kind: 'issue',
      itemId: item.body.id,
      zoneId: zones[0].id,
      qty: 5,
      employeeId: t.ids['asha.eng'],
    });
    assert.ok(issue.status >= 400 && issue.status < 500);
    const negIn = await t.call('kiran.ops', 'POST', '/stock/movements', {
      kind: 'in',
      itemId: item.body.id,
      zoneId: zones[0].id,
      qty: -10,
    });
    assert.equal(negIn.status, 400);
  });
});

describe('trainings', () => {
  let trainingId = '';

  it('the RM assigns to a report; past due dates are refused', async () => {
    const r = await t.call('rahul.manager', 'POST', '/trainings', {
      employeeIds: [t.ids['asha.eng']],
      title: 'Safety training',
      stream: 'compliance',
      dueOn: addDays(today(), 10),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.assigned, 1, JSON.stringify(r.body));
    // The reply is a count; the training itself is on the trainee's list.
    const mine = await t.call('asha.eng', 'GET', '/trainings/mine');
    trainingId = (mine.body as Array<{ id: string; title: string }>).find(
      (x) => x.title === 'Safety training',
    )!.id;
    const past = await t.call('rahul.manager', 'POST', '/trainings', {
      employeeIds: [t.ids['asha.eng']],
      title: 'Due in the past',
      stream: 'company',
      dueOn: '2020-01-01',
    });
    assert.ok(past.status >= 400 && past.status < 500);
  });

  it('only the trainee completes it; the certificate is private', async () => {
    const other = await t.call(
      'vikram.eng',
      'POST',
      `/trainings/${trainingId}/complete`,
      { note: 'This is not my training' },
    );
    assert.ok(
      other.status === 403 || other.status === 404,
      `complete by other: ${other.status}`,
    );
    const up = await t.call(
      'asha.eng',
      'PUT',
      `/trainings/${trainingId}/certificate?filename=c.pdf`,
      undefined,
      {
        raw: PDF,
        contentType: 'application/pdf',
      },
    );
    assert.ok(up.status < 300, JSON.stringify(up.body));
    assert.equal(
      (
        await t.call('asha.eng', 'POST', `/trainings/${trainingId}/complete`, {
          note: 'Finished the course',
        })
      ).status,
      200,
    );
    const own = await t.call('asha.eng', 'GET', `/trainings/${trainingId}/certificate`);
    assert.equal(own.status, 200);
    assert.ok(own.head.startsWith('%PDF'));
    const idor = await t.call(
      'vikram.eng',
      'GET',
      `/trainings/${trainingId}/certificate`,
    );
    assert.ok(
      idor.status === 403 || idor.status === 404,
      `certificate IDOR: ${idor.status}`,
    );
  });
});

describe('departments and policies', () => {
  it('department rules', async () => {
    assert.equal(
      (await t.call('asha.eng', 'POST', '/departments', { name: 'Hackers' })).status,
      403,
    );
    const r = await t.call('meera.hrbp', 'POST', '/departments', {
      name: 'Test Chapter',
      kind: 'chapter',
    });
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
    assert.equal(
      (
        await t.call('meera.hrbp', 'POST', '/departments', {
          name: 'Test Chapter',
          kind: 'chapter',
        })
      ).status,
      409,
    );
    const ownParent = await t.call('meera.hrbp', 'PATCH', `/departments/${r.body.id}`, {
      parentId: r.body.id,
    });
    assert.ok(ownParent.status >= 400 && ownParent.status < 500);
    const home = await t.call('meera.hrbp', 'PATCH', `/employees/${t.ids['asha.eng']}`, {
      departmentId: r.body.id,
    });
    assert.ok(home.status >= 400 && home.status < 500, 'a chapter is never a home unit');
  });

  it('policies: employees can’t create; javascript: links are refused', async () => {
    assert.equal(
      (
        await t.call('asha.eng', 'POST', '/policies', {
          code: 'HACK',
          title: 'hack',
          category: 'other',
          version: '1',
        })
      ).status,
      403,
    );
    const js = await t.call('meera.hrbp', 'POST', '/policies', {
      code: 'TEST-1',
      title: 'Test policy',
      category: 'other',
      version: '1.0',
      ackRequired: true,
      docUrl: 'javascript:alert(1)',
    });
    assert.equal(js.status, 400);
    assert.equal((await t.call('meera.hrbp', 'GET', '/policies/tracker')).status, 200);
  });
});
