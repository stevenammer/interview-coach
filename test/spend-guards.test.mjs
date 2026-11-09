import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';
import { abuseSubject, issueSession } from '../src/auth.js';
import { createHandler } from '../netlify/functions/api.mjs';

const KEY = 'long-test-only-random-abuse-hmac-key';
async function database() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

function request(op, body, cookie = null) {
  return new Request(`http://localhost/api?op=${op}`, { method: 'POST', headers: {
    origin: 'http://localhost', 'content-type': 'application/json', 'x-coach-csrf': '1', ...(cookie ? { cookie } : {}),
  }, body: JSON.stringify(body) });
}

test('IPv6 /64 and IPv4-mapped IPv4 addresses share abuse buckets', () => {
  const req = new Request('https://app.test');
  assert.equal(abuseSubject(req, KEY, '2001:db8:1:2::1'), abuseSubject(req, KEY, '2001:db8:1:2:ffff::2'));
  assert.equal(abuseSubject(req, KEY, '::ffff:192.0.2.4'), abuseSubject(req, KEY, '192.0.2.4'));
});

test('live voice holds remain reserved for 120 minutes and late settlement records them', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('voice_owner', 'hash')).id;
    const start = new Date('2026-01-01T00:00:00Z');
    const reservation = await repo.reserve('voice', 60, 100, 'long-voice', start, owner, 100, { expiresMinutes: 120 });
    assert.equal(await repo.reserve('model', 41, 100, 'after-16-minutes', new Date('2026-01-01T00:16:00Z')), null);
    await repo.reserve('model', 1, 100, 'after-expiry', new Date('2026-01-01T02:01:00Z'));
    await repo.settle(reservation, 60);
    const day = (await repo.sql('SELECT reserved_micros,settled_micros FROM spend_days'))[0];
    assert.equal(Number(day.reserved_micros), 1);
    assert.equal(Number(day.settled_micros), 60);
  } finally { await db.close(); }
});

test('serialized reservations enforce account, guest-pool, and guest-IP caps', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('race_owner', 'hash')).id;
    const own = await Promise.all([1, 2].map((n) => repo.reserve('model', 60, 200, `own-${n}`, new Date(), owner, 100)));
    assert.equal(own.filter(Boolean).length, 1);
    const guest = await Promise.all([1, 2].map((n) => repo.reserve('model', 60, 200, `guest-${n}`, new Date(), null, null,
      { guestBudgetMicros: 80, guestSubject: 'same-ip', guestSubjectCapMicros: 70 })));
    assert.equal(guest.filter(Boolean).length, 1);
  } finally { await db.close(); }
});

test('signup, guest, and voice kill switches return 503', async () => {
  const { db, repo } = await database();
  try {
    const signup = createHandler({ repo, model: null, env: { ABUSE_HMAC_KEY: KEY, SIGNUP_ENABLED: 'false' } });
    assert.equal((await signup(request('signup', { username: 'new_user', password: 'fictional-passphrase' }))).status, 503);
    const guests = createHandler({ repo, model: null, env: { ABUSE_HMAC_KEY: KEY, GUESTS_ENABLED: '0' } });
    assert.equal((await guests(request('ledger', { guest: true, state: {} }))).status, 503);
    const user = await repo.createUser('voice_switch', 'hash');
    const session = await issueSession(repo, user, false);
    const voice = createHandler({ repo, model: null, env: { ABUSE_HMAC_KEY: KEY, VOICE_ENABLED: 'false' } });
    assert.equal((await voice(request('voice_start', {}, session.cookie.split(';')[0]))).status, 503);
  } finally { await db.close(); }
});

test('the shared signup cap and signed-in model rate limit apply', async () => {
  const { db, repo } = await database();
  try {
    const signup = createHandler({ repo, model: null, env: { ABUSE_HMAC_KEY: KEY, SIGNUP_DAILY_CAP: '1' } });
    const attempts = await Promise.all(['first_user', 'second_user'].map((username) =>
      signup(request('signup', { username, password: 'fictional-passphrase' }))));
    assert.equal(attempts.filter((response) => response.status === 200).length, 1);
    const user = await repo.createUser('model_switch', 'hash');
    const session = await issueSession(repo, user, false);
    const model = { async readImage() { return 'text'; } };
    const limited = createHandler({ repo, model, env: { ABUSE_HMAC_KEY: KEY, MODEL_OPS_PER_HOUR_PER_ACCOUNT: '1' } });
    const body = { base64: Buffer.from('x').toString('base64'), mimeType: 'image/png' };
    assert.equal((await limited(request('read_image', body, session.cookie.split(';')[0]))).status, 200);
    assert.equal((await limited(request('read_image', body, session.cookie.split(';')[0]))).status, 429);
  } finally { await db.close(); }
});
