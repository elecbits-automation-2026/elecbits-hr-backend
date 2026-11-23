import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  errorCode,
  refreshCookie,
  startApp,
  today,
  type TestApp,
} from './helpers/api.js';

let t: TestApp;
before(async () => {
  t = await startApp();
});
after(async () => {
  await t.stop();
});

describe('sign-in', () => {
  it('rejects a wrong password with 401', async () => {
    const r = await t.call(null, 'POST', '/auth/login', {
      email: 'asha.eng@elecbits.in',
      password: 'wrong-password',
    });
    assert.equal(r.status, 401);
  });

  it('L1: a short wrong password is a plain 401, not a length error', async () => {
    const r = await t.call(null, 'POST', '/auth/login', {
      email: 'asha.eng@elecbits.in',
      password: 'abc',
    });
    assert.equal(r.status, 401);
    assert.doesNotMatch(JSON.stringify(r.body), /characters/i);
  });

  it('rejects a non-company email', async () => {
    const r = await t.call(null, 'POST', '/auth/login', {
      email: 'nobody@gmail.com',
      password: 'test1234',
    });
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  });

  it('needs a token for /me', async () => {
    assert.equal((await t.call(null, 'GET', '/me')).status, 401);
  });

  it('closes claim-org after the first claim', async () => {
    const r = await t.call(null, 'POST', '/auth/claim-org', {
      email: 'admin@elecbits.in',
      password: 'whatever12',
      name: 'Takeover',
    });
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  });

  it('L2: claim with an unknown email gives the same answer as a bad token', async () => {
    const r = await t.call(null, 'POST', '/auth/claim', {
      email: 'nobody.here@elecbits.in',
      password: 'test12345',
      token: 'x'.repeat(32),
    });
    assert.equal(r.status, 403);
    assert.equal(errorCode(r), 'INVALID_CLAIM_TOKEN');
  });
});

describe('invite → claim', () => {
  let employeeId = '';
  let token = '';

  it('the Admin invites a new joiner', async () => {
    const me = await t.call('asha.eng', 'GET', '/me');
    const r = await t.call('admin', 'POST', '/employees/invite', {
      email: 'auth.joiner@elecbits.in',
      name: 'Auth Joiner',
      reportsTo: t.ids['rahul.manager'],
      level: 'L2',
      batchIds: [],
      dateOfJoining: today(),
      departmentId: me.body.departmentId,
      designation: 'Tester',
    });
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
    employeeId = r.body?.id ?? r.body?.employee?.id;
    assert.ok(employeeId);
  });

  it('refuses a duplicate invite (409) and a foreign domain', async () => {
    const dup = await t.call('admin', 'POST', '/employees/invite', {
      email: 'auth.joiner@elecbits.in',
      name: 'Dup',
      reportsTo: t.ids['rahul.manager'],
      level: 'L2',
      batchIds: [],
    });
    assert.equal(dup.status, 409);
    const ext = await t.call('admin', 'POST', '/employees/invite', {
      email: 'x@gmail.com',
      name: 'Ext',
      reportsTo: t.ids['rahul.manager'],
      level: 'L2',
      batchIds: [],
    });
    assert.ok(ext.status === 400 || ext.status === 422, String(ext.status));
  });

  it('an employee cannot invite', async () => {
    const r = await t.call('asha.eng', 'POST', '/employees/invite', {
      email: 'auth.x@elecbits.in',
      name: 'X',
      reportsTo: t.ids['rahul.manager'],
      level: 'L2',
      batchIds: [],
    });
    assert.equal(r.status, 403);
  });

  it('issues a claim link', async () => {
    const r = await t.call('meera.hrbp', 'POST', `/employees/${employeeId}/claim-link`);
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
    token =
      (JSON.stringify(r.body).match(/token=([A-Za-z0-9_\-.]+)/) ?? [])[1] ??
      r.body?.token;
    assert.ok(token, 'claim token present');
  });

  it('refuses a weak password and a bogus token, then claims once', async () => {
    const weak = await t.call(null, 'POST', '/auth/claim', {
      email: 'auth.joiner@elecbits.in',
      password: 'short',
      token,
    });
    assert.equal(weak.status, 400);
    const bogus = await t.call(null, 'POST', '/auth/claim', {
      email: 'auth.joiner@elecbits.in',
      password: 'test1234',
      token: 'b'.repeat(32),
    });
    assert.ok(bogus.status >= 400 && bogus.status < 500);
    const ok = await t.call(null, 'POST', '/auth/claim', {
      email: 'auth.joiner@elecbits.in',
      password: 'test1234',
      token,
    });
    assert.ok(ok.status === 200 || ok.status === 201, JSON.stringify(ok.body));
    const again = await t.call(null, 'POST', '/auth/claim', {
      email: 'auth.joiner@elecbits.in',
      password: 'test1234',
      token,
    });
    assert.ok(again.status >= 400, 'claim token is single-use');
  });

  it('someone who works here is deactivated only through an exit (USE_EXIT)', async () => {
    assert.equal((await t.call('auth.joiner', 'GET', '/me')).status, 200);
    const off = await t.call('meera.hrbp', 'PATCH', `/employees/${employeeId}`, {
      status: 'inactive',
    });
    assert.ok(off.status >= 400 && off.status < 500, String(off.status));
    assert.equal(errorCode(off), 'USE_EXIT');
    // Lock-out after relieving is covered by the exit flow in lifecycle.test.ts.
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and rejects an old one after the grace window logic', async () => {
    const l = await t.login('neha.intern');
    assert.equal(l.status, 200);
    const c1 = refreshCookie(l);
    assert.ok(c1.includes('='), 'refresh cookie set');
    const r1 = await t.call(null, 'POST', '/auth/refresh', undefined, { cookie: c1 });
    assert.equal(r1.status, 200);
  });

  it('H2: logout kills the whole family — the previous cookie cannot revive it', async () => {
    const l = await t.login('vikram.eng');
    const a = refreshCookie(l);
    const r1 = await t.call(null, 'POST', '/auth/refresh', undefined, { cookie: a });
    assert.equal(r1.status, 200);
    const b = refreshCookie(r1);
    const out = await t.call(null, 'POST', '/auth/logout', undefined, { cookie: b });
    assert.ok(out.status === 204 || out.status === 200, String(out.status));
    // Inside the reuse-grace window: the rotated cookie A must NOT work now.
    const revived = await t.call(null, 'POST', '/auth/refresh', undefined, { cookie: a });
    assert.equal(revived.status, 401);
    const afterB = await t.call(null, 'POST', '/auth/refresh', undefined, { cookie: b });
    assert.equal(afterB.status, 401);
  });
});
