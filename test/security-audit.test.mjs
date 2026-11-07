import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';

async function database() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

test('password changes revoke every other session but keep the current session', async () => {
  const { db, repo } = await database();
  try {
    const user = await repo.createUser('session-user', 'old');
    await repo.createSession(user.id, 'current', new Date(Date.now() + 60_000));
    await repo.createSession(user.id, 'other', new Date(Date.now() + 60_000));
    await repo.setPasswordHash(user.id, 'new', 'current');
    assert.ok(await repo.session('current'));
    assert.equal(await repo.session('other'), null);
  } finally { await db.close(); }
});

test('expired spend holds are released and a reservation key is idempotent', async () => {
  const { db, repo } = await database();
  try {
    const first = await repo.reserve('voice', 60, 100, 'first', new Date('2026-01-01T00:00:00Z'));
    const same = await repo.reserve('voice', 60, 100, 'first', new Date('2026-01-01T00:00:00Z'));
    assert.equal(same, first);
    const restored = await repo.reserve('voice', 100, 100, 'after-expiry', new Date('2026-01-01T00:16:00Z'));
    assert.ok(restored);
  } finally { await db.close(); }
});

test('an identical queued paste maps to one model job', async () => {
  const { db, repo } = await database();
  try {
    const user = await repo.createUser('job-user', 'hash');
    const input = { resume: 'resume', jd: 'posting', jobLabel: 'role' };
    const first = await repo.createJob(user.id, 'paste', input);
    const repeat = await repo.createJob(user.id, 'paste', input);
    assert.equal(repeat.id, first.id);
  } finally { await db.close(); }
});

test('no page script imports from an external host, and a CSP reports violations', async () => {
  const [app, toml] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../netlify.toml', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(app, /import\(\s*['"]https?:\/\//);
  assert.match(app, /import\('\/vendor\/retell-client\.js'\)/);
  assert.match(toml, /Content-Security-Policy-Report-Only\s*=\s*"[^"\n]*script-src 'self'/);
});

test('ending a session and deleting an account clear Interview Coach browser drafts', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function clearInterviewCoachLocalStorage\(\)/);
  assert.equal((app.match(/clearInterviewCoachLocalStorage\(\);/g) ?? []).length, 2);
});
