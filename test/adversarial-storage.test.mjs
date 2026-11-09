import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from '../src/db.js';
import { Repository, UPLOAD_LIMITS, JOB_STORAGE_LIMITS, SOURCE_STORAGE_LIMITS } from '../src/repository.js';
import { issueSession } from '../src/auth.js';
import { createHandler } from '../netlify/functions/api.mjs';

async function fixture() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const name of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(name, dir), 'utf8'));
  const repo = new Repository(pgliteSql(db));
  const user = await repo.createUser('resource_owner', 'hash');
  return { db, repo, user };
}

async function source(repo, owner, n = 0) { return repo.addSource(owner, 'resume', `Resume ${n}`, `resume ${n}`); }
const init = (repo, owner, original, bytes = 10_000_000) => repo.initUpload(owner, original.id, 'resume.pdf', 'application/pdf', bytes, Math.ceil(bytes / 1_400_000));

test('concurrent initializations cannot exceed pending quota and ready files remain charged', async () => {
  const { db, repo, user } = await fixture();
  try {
    const originals = await Promise.all([0, 1, 2].map((n) => source(repo, user.id, n)));
    const attempts = await Promise.allSettled(originals.map((s) => init(repo, user.id, s)));
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 2);
    assert.equal(attempts.find((r) => r.status === 'rejected').reason.status, 429);
    assert.equal(await repo.pendingUploadBytes(user.id), UPLOAD_LIMITS.pendingBytes);
    await repo.sql("UPDATE uploads SET status='ready' WHERE user_id=$1", [user.id]);
    for (let n = 2; n < 10; n++) {
      const s = await source(repo, user.id, n + 10);
      await init(repo, user.id, s);
      await repo.sql("UPDATE uploads SET status='ready' WHERE user_id=$1", [user.id]);
    }
    const extra = await source(repo, user.id, 99);
    await assert.rejects(init(repo, user.id, extra, 1), { code: 'upload_storage_full', status: 429 });
    assert.equal(Number((await repo.sql('SELECT sum(byte_size) AS n FROM uploads WHERE user_id=$1', [user.id]))[0].n), UPLOAD_LIMITS.accountBytes);
  } finally { await db.close(); }
});

test('site storage and tiny-upload metadata counts are bounded across accounts', async () => {
  const { db, repo, user } = await fixture();
  try {
    const s = await source(repo, user.id);
    for (let n = 0; n < UPLOAD_LIMITS.accountFiles; n++) await init(repo, user.id, s, 1);
    await assert.rejects(init(repo, user.id, s, 1), { code: 'upload_storage_full' });
    await repo.sql('DELETE FROM uploads');
    // Seed completed reservations directly: no gigabyte allocation is needed to test accounting.
    for (let n = 0; n < 10; n++) {
      const owner = await repo.createUser(`site_owner_${n}`, 'hash');
      const original = await source(repo, owner.id);
      await repo.sql(`INSERT INTO uploads(id,user_id,source_id,chunk_count,byte_size,mime_type,status)
        SELECT gen_random_uuid(),$1,$2,8,10000000,'application/pdf','ready' FROM generate_series(1,10)`, [owner.id, original.id]);
    }
    await assert.rejects(init(repo, user.id, s, 1), { code: 'upload_storage_full' });
  } finally { await db.close(); }
});

test('spend reservations serialize idempotency and per-user ceilings; live voice holds last 120 minutes', async () => {
  const { db, repo, user } = await fixture();
  try {
    const now = new Date('2026-01-01T00:00:00Z');
    const same = await Promise.all([1, 2, 3].map(() => repo.reserve('model', 60, 1000, 'same', now, user.id, 100)));
    assert.ok(same[0]); assert.equal(new Set(same).size, 1);
    assert.equal(Number((await repo.sql('SELECT reserved_micros FROM spend_days'))[0].reserved_micros), 60);
    const race = await Promise.all(['second', 'third'].map((key) => repo.reserve('model', 30, 1000, key, now, user.id, 100)));
    assert.equal(race.filter(Boolean).length, 1);
    await assert.rejects(repo.reserve('model', -1, 100, 'negative', now));
    const voiceDay = new Date('2026-01-02T00:00:00Z');
    assert.ok(await repo.reserve('voice', 60, 100, 'voice', voiceDay, null, null, { expiresMinutes: 120 }));
    assert.equal(await repo.reserve('model', 50, 100, 'after-fifteen', new Date('2026-01-02T00:16:00Z')), null);
    assert.ok(await repo.reserve('model', 100, 100, 'tomorrow', new Date('2026-01-03T00:00:00Z')));
    assert.equal(await repo.claimGuestVoicePool(6, 5), null);
    assert.equal((await repo.sql('SELECT * FROM guest_voice_pool')).length, 0);
  } finally { await db.close(); }
});

test('API accepts all supported document MIME types and serializes blob writes with deletion', async () => {
  const { db, repo, user } = await fixture();
  try {
    const blobs = new Map(); let entered, release;
    const started = new Promise((resolve) => { entered = resolve; });
    const unblock = new Promise((resolve) => { release = resolve; });
    let pauseWrite = false;
    const store = { async set(key, bytes) { if (pauseWrite) { entered(); await unblock; } blobs.set(key, bytes); }, async delete(key) { blobs.delete(key); } };
    const handler = createHandler({ repo, model: null, blobStore: store, env: { ABUSE_HMAC_KEY: 'resource-test-only-long-key' } });
    const issued = await issueSession(repo, user, false);
    const call = (op, data) => handler(new Request(`http://localhost/api?op=${op}`, { method: 'POST', headers: {
      origin: 'http://localhost', 'x-coach-csrf': '1', 'content-type': 'application/json', cookie: issued.cookie.split(';')[0],
    }, body: JSON.stringify(data) }));
    for (const mimeType of ['text/plain', 'text/markdown', 'application/rtf', 'application/vnd.oasis.opendocument.text']) {
      const s = await source(repo, user.id, mimeType);
      const response = await call('upload_init', { sourceId: s.id, extractedText: s.text, name: 'document', mimeType, byteSize: 1, chunkCount: 1 });
      assert.equal(response.status, 200, mimeType);
    }
    const s = await source(repo, user.id, 'race');
    const work = await repo.addWorkspace(user.id, s.id, 'Race role');
    const upload = await init(repo, user.id, s, 1);
    pauseWrite = true;
    const write = call('upload_chunk', { uploadId: upload.id, part: 0, base64: 'AQ==' });
    await started;
    const remove = call('delete_source', { sourceId: s.id, workspaceId: work.id });
    release();
    assert.equal((await write).status, 200);
    assert.equal((await remove).status, 200);
    assert.equal(await repo.source(user.id, s.id), null);
    assert.equal([...blobs.keys()].some((key) => key.includes(upload.id)), false, 'no orphan blob survives deletion');
    assert.equal((await call('upload_chunk', { uploadId: upload.id, part: 0, base64: 'AQ==' })).status, 400);
  } finally { await db.close(); }
});

test('failed stale-blob cleanup retains the reservation so retries can find and remove it', async () => {
  const { db, repo, user } = await fixture();
  try {
    const s = await source(repo, user.id);
    const upload = await init(repo, user.id, s, 1);
    await repo.sql("UPDATE uploads SET created_at=now()-interval '2 hours' WHERE id=$1", [upload.id]);
    await assert.rejects(repo.expirePendingUploads(user.id, new Date(), { async delete() { throw new Error('offline'); } }));
    assert.ok(await repo.upload(user.id, upload.id));
    const removed = [];
    await repo.expirePendingUploads(user.id, new Date(), { async delete(key) { removed.push(key); } });
    assert.deepEqual(removed, [`${user.id}/${upload.id}/0`]);
    assert.equal(await repo.upload(user.id, upload.id), null);
  } finally { await db.close(); }
});

test('queued jobs deduplicate atomically, terminal work can repeat, and outstanding storage is bounded', async () => {
  const { db, repo, user } = await fixture();
  try {
    const same = await Promise.all([0, 1, 2].map(() => repo.createJob(user.id, 'paste', { resume: 'same', jd: 'same' })));
    assert.equal(new Set(same.map((job) => job.id)).size, 1);
    await repo.claimJob(user.id, same[0].id);
    await repo.finishJob(user.id, same[0].id, { text: 'done' });
    const repeat = await repo.createJob(user.id, 'paste', { resume: 'same', jd: 'same' });
    assert.notEqual(repeat.id, same[0].id, 'completed practice can be deliberately repeated');
    await repo.sql(`INSERT INTO model_jobs(id,user_id,kind,input_json)
      SELECT gen_random_uuid(),$1,'paste',jsonb_build_object('n',n) FROM generate_series(1,$2) n`, [user.id, JOB_STORAGE_LIMITS.accountActive - 1]);
    await assert.rejects(repo.createJob(user.id, 'paste', { resume: 'extra' }), { code: 'job_storage_full', status: 429 });
    await repo.claimJob(user.id, repeat.id);
    await repo.clearDerivedText(user.id);
    await repo.finishJob(user.id, repeat.id, { text: 'deleted material must not return' });
    const canceled = await repo.job(user.id, repeat.id);
    assert.equal(canceled.status, 'failed'); assert.equal(canceled.result_json, null);
    await repo.deleteAccount(user.id);
    assert.equal((await repo.sql('SELECT * FROM model_jobs')).length, 0, 'account deletion reclaims job records and payloads');
  } finally { await db.close(); }
});

test('free source storage cannot grow without bound and source deletion reclaims quota', async () => {
  const { db, repo, user } = await fixture();
  try {
    await repo.sql(`INSERT INTO sources(id,user_id,kind,title,text,content_hash)
      SELECT gen_random_uuid(),$1,'resume','Resume','text','hash' FROM generate_series(1,$2)`, [user.id, SOURCE_STORAGE_LIMITS.accountRecords]);
    await assert.rejects(source(repo, user.id), { code: 'source_storage_full' });
    const oldest = (await repo.sql('SELECT id FROM sources WHERE user_id=$1 LIMIT 1', [user.id]))[0];
    await repo.deleteSource(user.id, oldest.id);
    assert.ok(await source(repo, user.id));
  } finally { await db.close(); }
});

test('source deletion between a completed model check and persistence cannot resurrect private text', async () => {
  const { runModelJob } = await import('../src/jobs.js');
  const { db, repo, user } = await fixture();
  try {
    const old = await source(repo, user.id, 'delete-me');
    const job = await repo.createJob(user.id, 'ingest', { kind: 'jd', title: 'Private pending source', text: 'Private pending source text.' });
    const originalJob = repo.job.bind(repo);
    let responseReady = false, deleted = false;
    repo.job = async (...args) => {
      const snapshot = await originalJob(...args);
      if (responseReady && !deleted) {
        deleted = true;
        await repo.deleteSource(user.id, old.id);
      }
      return snapshot; // deliberately stale running snapshot, after deletion committed
    };
    const model = { async generate() { responseReady = true; return { data: { facts: [] }, modelId: 'offline' }; } };
    assert.equal(await runModelJob(repo, model, user.id, job.id), true);
    assert.equal(deleted, true);
    assert.equal((await repo.sql('SELECT * FROM sources WHERE user_id=$1', [user.id])).length, 0);
    const saved = await originalJob(user.id, job.id);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.error_code, 'source_deleted');
    assert.equal(saved.result_json, null);
  } finally { await db.close(); }
});
