import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';
import { cachedPlain, plainCacheKey, sealPlain } from '../src/plain.js';
import { createHandler } from '../netlify/functions/api.mjs';
import { issueSession } from '../src/auth.js';

const KEY = 'long-test-only-random-abuse-hmac-key';
async function database() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

async function workspace(repo, owner) {
  const source = await repo.addSource(owner, 'jd', 'Posting', 'Secret source text');
  return { source, workspace: await repo.addWorkspace(owner, source.id, 'Role') };
}

test('source and fact deletion clear unlinked derived text conservatively', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('deletion_owner', 'hash')).id;
    const { source, workspace: work } = await workspace(repo, owner);
    const fact = await repo.addFact(owner, { workspaceId: work.id, sourceId: source.id, subject: 'candidate', predicate: 'did',
      value: { text: 'Secret source text' }, displayText: 'Secret source text', quote: 'Secret source text', start: 0, end: 18,
      status: 'document', reviewState: 'pending', proposedBy: 'model' });
    const job = await repo.createJob(owner, 'paste', { sourceText: 'Secret source text' });
    await repo.sql(`UPDATE model_jobs SET result_json=$2::jsonb WHERE user_id=$1 AND id=$3`, [owner, JSON.stringify({ text: 'Secret source text' }), job.id]);
    const pack = await repo.savePrepPack(owner, work.id, 'hash');
    await repo.savePrepSection(owner, pack.id, { key: 'story_map', title: 'Map', kind: 'model', inputHash: 'hash', status: 'ready', content: { text: 'Secret source text' } });
    const dig = await repo.startDig(owner, work.id, 'leadership');
    await repo.reflectDig(owner, dig.id, 'Secret source text', 'Secret source text');
    await repo.deleteFact(owner, fact);
    assert.equal((await repo.sql('SELECT result_json FROM model_jobs WHERE id=$1', [job.id]))[0].result_json, null);
    assert.equal((await repo.sql('SELECT content_json FROM prep_pack_sections WHERE user_id=$1', [owner]))[0].content_json, null);
    assert.equal((await repo.sql('SELECT scene_text FROM story_digs WHERE id=$1', [dig.id]))[0].scene_text, null);
    await repo.deleteSource(owner, source.id);
    assert.equal(await repo.source(owner, source.id), null);
  } finally { await db.close(); }
});

test('plain cache expires after seven days and deletes stale sealed blobs', async () => {
  const oldNow = Date.now;
  const cache = { deleted: null, async get() { return this.value; }, async delete(key) { this.deleted = key; } };
  try {
    Date.now = () => 1;
    cache.value = sealPlain({ text: 'old wording', glossary: [], source: 'model' }, 'original', 'question');
  } finally { Date.now = oldNow; }
  const hit = await cachedPlain(cache, 'original', 'question', KEY);
  assert.equal(hit, null);
  assert.equal(cache.deleted, plainCacheKey('original', 'question', KEY));
});

test('signed-in reservations are capped per account while guests remain under only the global cap', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('budget_owner', 'hash')).id;
    assert.ok(await repo.reserve('model', 25, 100, 'owned-25', new Date('2026-01-01T00:00:00Z'), owner, 25));
    assert.equal(await repo.reserve('model', 1, 100, 'owned-over', new Date('2026-01-01T00:00:00Z'), owner, 25), null);
    assert.ok(await repo.reserve('voice', 25, 100, 'guest-25', new Date('2026-01-01T00:00:00Z')));
  } finally { await db.close(); }
});

test('account deletion leaves no row in any schema table with a user_id column', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('delete_everything', 'hash')).id;
    const { source, workspace: work } = await workspace(repo, owner);
    await repo.createJob(owner, 'paste', { sourceId: source.id });
    await repo.startDig(owner, work.id, 'leadership');
    await repo.reserve('model', 1, 100, 'owner-spend', new Date('2026-01-01T00:00:00Z'), owner, 25);
    const tables = await repo.sql(`SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
      WHERE c.column_name='user_id' AND c.table_schema='public' AND t.table_type='BASE TABLE' ORDER BY c.table_name`);
    assert.ok(tables.length > 10, 'schema-driven coverage found owner-scoped tables');
    await repo.deleteAccount(owner);
    for (const { table_name: table } of tables) {
      const row = await repo.sql(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [owner]);
      assert.equal(row[0].n, 0, `${table} retained deleted-account data`);
    }
  } finally { await db.close(); }
});

test('HTTPS ignores the non-host session cookie, supports configured origins, and throttles login per account', async () => {
  const { db, repo } = await database();
  try {
    const handler = createHandler({ repo, model: null, env: { ABUSE_HMAC_KEY: KEY, ALLOWED_ORIGINS: 'https://app.example' } });
    const user = await repo.createUser('throttle_user', 'scrypt-v1:bad:bad');
    const issued = await issueSession(repo, user, true);
    const bare = issued.cookie.replace('__Host-ic_session', 'ic_session').split(';')[0];
    assert.equal((await handler(new Request('https://app.example/api?op=session', { headers: { cookie: bare } }))).status, 200);
    const body = JSON.stringify({ username: 'throttle_user', password: 'fictional-passphrase' });
    for (let i = 0; i < 8; i += 1) {
      const response = await handler(new Request('https://api.example/api?op=login', { method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/json', 'x-coach-csrf': '1' }, body }));
      assert.equal(response.status, 401);
    }
    const limited = await handler(new Request('https://api.example/api?op=login', { method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/json', 'x-coach-csrf': '1' }, body }));
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'rate_limited' });
  } finally { await db.close(); }
});

test('all stale background job kinds time out', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('timeout_owner', 'hash')).id;
    const job = await repo.createJob(owner, 'paste', { x: 1 });
    await repo.claimJob(owner, job.id);
    await repo.sql(`UPDATE model_jobs SET started_at=$2 WHERE user_id=$1 AND id=$3`, [owner, new Date('2026-01-01T00:00:00Z'), job.id]);
    await repo.expireStaleJobs(owner, new Date('2026-01-01T00:11:00Z'));
    assert.equal((await repo.job(owner, job.id)).error_code, 'timed_out');
  } finally { await db.close(); }
});

test('pending uploads are swept after an hour and cannot exceed the per-user pending byte cap', async () => {
  const { db, repo } = await database();
  try {
    const owner = await repo.createUser('upload_owner', 'hash');
    const sources = await Promise.all([1, 2, 3].map((n) => repo.addSource(owner.id, 'resume', `Resume ${n}`, `resume ${n}`)));
    const deleted = [];
    const blobStore = { async delete(key) { deleted.push(key); } };
    const handler = createHandler({ repo, model: null, blobStore, env: { ABUSE_HMAC_KEY: KEY } });
    const issued = await issueSession(repo, owner, false);
    const request = (source, bytes = 10_000_000) => new Request('http://localhost/api?op=upload_init', {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-coach-csrf': '1', cookie: issued.cookie.split(';')[0] },
      body: JSON.stringify({ sourceId: source.id, extractedText: source.text, name: 'resume.pdf', mimeType: 'application/pdf', byteSize: bytes, chunkCount: Math.ceil(bytes / 1_400_000) }),
    });
    assert.equal((await handler(request(sources[0]))).status, 200);
    const stale = (await repo.sourceUploads(owner.id, sources[0].id))[0];
    await repo.sql(`UPDATE uploads SET created_at=$2 WHERE id=$1`, [stale.id, new Date(Date.now() - 61 * 60 * 1000)]);
    assert.equal((await handler(request(sources[1]))).status, 200);
    assert.ok(deleted.includes(`${owner.id}/${stale.id}/0`), 'expired upload blob is removed during the next init');
    assert.equal((await handler(request(sources[2]))).status, 200, 'one replacement upload fits after expiry cleanup');
    const fourth = await repo.addSource(owner.id, 'resume', 'Resume 4', 'resume 4');
    assert.equal((await handler(request(fourth))).status, 429, 'third concurrent 10MB pending upload exceeds 20MB');
  } finally { await db.close(); }
});

test('upload storage is bounded by declared bytes through invalid chunks, concurrent parts and replays', async () => {
  const { db, repo } = await database();
  try {
    const user = await repo.createUser('upload_storage_owner', 'hash');
    const source = await repo.addSource(user.id, 'resume', 'Resume', 'My resume');
    const blobs = new Map();
    const blobStore = { async set(key, bytes) { blobs.set(key, Buffer.from(bytes)); }, async delete(key) { blobs.delete(key); } };
    const handler = createHandler({ repo, model: null, blobStore, env: { ABUSE_HMAC_KEY: KEY } });
    const issued = await issueSession(repo, user, false);
    const request = (op, data) => handler(new Request(`http://localhost/api?op=${op}`, {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json',
        'x-coach-csrf': '1', cookie: issued.cookie.split(';')[0] }, body: JSON.stringify(data),
    }));
    const metadata = { sourceId: source.id, extractedText: source.text, name: 'resume.pdf', mimeType: 'application/pdf' };
    assert.equal((await request('upload_init', { ...metadata, byteSize: 1, chunkCount: 8 })).status, 400,
      'a one-byte reservation cannot allocate eight storage keys');
    const init = await request('upload_init', { ...metadata, byteSize: 1_400_003, chunkCount: 2 });
    assert.equal(init.status, 200);
    const uploadId = (await init.json()).result.id;
    const send = (part, bytes) => request('upload_chunk', { uploadId, part, base64: bytes.toString('base64') });
    assert.equal((await send(1, Buffer.alloc(4))).status, 400, 'tail cannot exceed its reserved three bytes');
    assert.equal((await send(0, Buffer.alloc(1))).status, 400, 'short first part cannot be accepted');
    assert.equal((await request('upload_chunk', { uploadId, part: 1, base64: 'AQI=' })).status, 400,
      'decoded length, not encoded length, must match the reservation');
    assert.equal((await request('upload_finish', { uploadId })).status, 400);
    const full = Buffer.alloc(1_400_000, 1), tail = Buffer.from([2, 3, 4]);
    const concurrent = await Promise.all([send(0, full), send(1, tail), send(0, full)]);
    assert.deepEqual(concurrent.map((response) => response.status), [200, 200, 200]);
    assert.equal(blobs.size, 2, 'replay overwrites its fixed key');
    assert.equal([...blobs.values()].reduce((sum, bytes) => sum + bytes.length, 0), 1_400_003);
    const chunks = await repo.sql('SELECT count(*)::int AS n,sum(byte_size)::int AS bytes FROM upload_chunks WHERE upload_id=$1', [uploadId]);
    assert.deepEqual(chunks[0], { n: 2, bytes: 1_400_003 });
    assert.equal((await request('upload_finish', { uploadId })).status, 200);
    assert.equal((await request('upload_finish', { uploadId })).status, 200, 'finish replay is idempotent');
    assert.equal((await send(1, tail)).status, 400, 'completed uploads reject later writes');
  } finally { await db.close(); }
});
