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

test('unknown model and voice holds survive expiry on their UTC day and settle once after rollover', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('voice_owner', 'hash')).id;
    const start = new Date('2026-01-01T00:00:00Z');
    const model = await repo.reserve('model', 30, 100, 'unknown-model', start, owner, 100);
    const voice = await repo.reserve('voice', 60, 100, 'unknown-voice', start, owner, 100, { expiresMinutes: 120 });
    assert.ok(model && voice);
    assert.equal(await repo.reserve('model', 11, 100, 'same-day-blocked', new Date('2026-01-01T03:00:00Z')), null);
    let rows = await repo.sql('SELECT state FROM spend_reservations ORDER BY bucket');
    assert.deepEqual(rows.map((row) => row.state), ['reserved', 'reserved']);
    assert.ok(await repo.reserve('model', 10, 100, 'next-day', new Date('2026-01-02T00:01:00Z')));
    rows = await repo.sql('SELECT state FROM spend_reservations WHERE id IN ($1,$2) ORDER BY bucket', [model, voice]);
    assert.deepEqual(rows.map((row) => row.state), ['expired', 'expired']);
    await repo.settle(model, 20);
    await repo.settle(voice, 40);
    await repo.settle(voice, 40);
    const days = await repo.sql('SELECT utc_date::text,reserved_micros,settled_micros FROM spend_days ORDER BY utc_date');
    assert.equal(Number(days[0].reserved_micros), 0);
    assert.equal(Number(days[0].settled_micros), 60);
    assert.equal(Number(days[1].reserved_micros), 10);
    assert.equal(Number(days[1].settled_micros), 0);
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
