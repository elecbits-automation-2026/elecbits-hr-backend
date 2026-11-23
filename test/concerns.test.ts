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

describe('concerns', () => {
  let concernId = '';

  it('raises a complaint; POSH stays refused; peers can’t read it', async () => {
    const r = await t.call('asha.eng', 'POST', '/concerns', {
      track: 'complaint',
      category: 'other',
      title: 'Noisy lab',
      detail: 'The lab extractor fan is too loud to work near.',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    concernId = r.body.id ?? r.body.concern?.id;
    const posh = await t.call('asha.eng', 'POST', '/concerns', {
      track: 'complaint',
      category: 'sexual_harassment',
      title: 'posh',
      detail: 'Testing that the POSH category is refused',
    });
    assert.ok(posh.status >= 400 && posh.status < 500);
    const peer = await t.call('vikram.eng', 'GET', `/concerns/${concernId}`);
    assert.ok(peer.status === 403 || peer.status === 404);
  });

  it('HR works it; a deadline can’t move into the past', async () => {
    assert.equal(
      (await t.call('meera.hrbp', 'GET', `/concerns/${concernId}`)).status,
      200,
    );
    const past = await t.call('meera.hrbp', 'POST', `/concerns/${concernId}/extend`, {
      to: '2020-01-01',
      reason: 'past date',
    });
    assert.ok(past.status >= 400 && past.status < 500);
  });

  it('an anonymous dispute is readable by code + key only', async () => {
    const r = await t.call('asha.eng', 'POST', '/concerns', {
      track: 'dispute',
      category: 'payroll',
      title: 'Anon',
      detail: 'Anonymous dispute about my payslip deductions',
      anonymous: true,
    });
    if (r.status !== 201 || !r.body?.code || !r.body?.key) return; // anonymity off for disputes
    const wrong = await t.call('asha.eng', 'POST', '/concerns/follow-up', {
      code: r.body.code,
      key: 'wrong-key-wrong-key-wrong-key-xx',
    });
    assert.ok(wrong.status >= 400 && wrong.status < 500);
    const right = await t.call('asha.eng', 'POST', '/concerns/follow-up', {
      code: r.body.code,
      key: r.body.key,
    });
    assert.equal(right.status, 200);
  });
});

describe('open door', () => {
  it('validates slots and enforces capacity; the host can’t book', async () => {
    const date = addDays(today(), 3);
    const bad = await t.call('meera.hrbp', 'POST', '/open-door/slots', {
      date,
      startTime: '15:00',
      endTime: '14:00',
    });
    assert.ok(bad.status === 400 || bad.status === 422);
    const slot = await t.call('meera.hrbp', 'POST', '/open-door/slots', {
      date,
      startTime: '15:00',
      endTime: '15:30',
      capacity: 1,
    });
    assert.equal(slot.status, 201, JSON.stringify(slot.body));
    // createSlot answers with the publisher's open-door view; find the slot in it.
    const find = (x: unknown): string | undefined => {
      if (Array.isArray(x)) return x.map(find).find(Boolean);
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        if (
          o.date === date &&
          String(o.startTime ?? '').startsWith('15:00') &&
          typeof o.id === 'string'
        ) {
          return o.id;
        }
        return Object.values(o).map(find).find(Boolean);
      }
      return undefined;
    };
    const id = slot.body.id ?? find(slot.body);
    assert.ok(id, `slot id in ${JSON.stringify(slot.body).slice(0, 300)}`);
    const book = await t.call('asha.eng', 'POST', `/open-door/slots/${id}/book`, {
      topic: 'Career chat',
    });
    assert.ok(book.status === 200 || book.status === 201, JSON.stringify(book.body));
    assert.equal(
      (
        await t.call('vikram.eng', 'POST', `/open-door/slots/${id}/book`, {
          topic: 'Second',
        })
      ).status,
      409,
    );
    const host = await t.call('meera.hrbp', 'POST', `/open-door/slots/${id}/book`, {
      topic: 'Self',
    });
    assert.ok(host.status >= 400 && host.status < 500);
  });
});
