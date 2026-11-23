/**
 * H1 / L9: this file's app runs with the limiter ON (the runner turns it off
 * for every other file so repeated sign-ins don't trip it). Each test file is
 * its own process, so setting the env here affects only this app instance.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { errorCode, startApp, type TestApp } from './helpers/api.js';

process.env.AUTH_RATE_LIMIT = 'on';
process.env.AUTH_RATE_LIMIT_PER_EMAIL = '5';

let t: TestApp;
before(async () => {
  t = await startApp();
});
after(async () => {
  await t.stop();
});

describe('login rate limit (H1)', () => {
  it('answers 429 TOO_MANY_ATTEMPTS after repeated wrong passwords for one email', async () => {
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 8; i += 1) {
      last = await t.call(null, 'POST', '/auth/login', {
        email: 'sanjay.sales@elecbits.in',
        password: `wrong-${i}-password`,
      });
      codes.push(last.status);
    }
    assert.ok(codes.includes(429), `codes: ${codes.join(',')}`);
    assert.equal(errorCode(last!), 'TOO_MANY_ATTEMPTS');
    // Locked for that email even with the right password, within the window.
    const right = await t.login('sanjay.sales');
    assert.equal(right.status, 429);
  });

  it('does not lock other people out', async () => {
    assert.equal((await t.login('asha.eng')).status, 200);
  });
});

describe('anonymous concern follow-up by code + key (L9)', () => {
  it('rate-limits key guessing', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const r = await t.call('rohan.lab', 'POST', '/concerns/follow-up', {
        code: 'CMP-2026-999',
        key: `guess-${i}-xxxxxxxxxxxxxxxxxxxxxxxx`,
      });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), `codes: ${codes.join(',')}`);
  });
});
