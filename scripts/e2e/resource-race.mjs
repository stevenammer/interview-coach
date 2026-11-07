// Optional real PostgreSQL race check. Use only an explicitly disposable database.
// ALLOW_DISPOSABLE_DB=1 DATABASE_URL=... node scripts/e2e/resource-race.mjs
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Repository } from '../../src/repository.js';
if (process.env.ALLOW_DISPOSABLE_DB !== '1' || !process.env.DATABASE_URL) throw Error('An explicitly disposable DATABASE_URL is required.');
const schema = `ic_audit_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let pool;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8,
    options: `-c search_path=${schema},public -c statement_timeout=10000` });
  const sql = async (query, values = []) => (await pool.query(query, values)).rows;
  sql.transaction = async (work) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const out = await work(async (q, values = []) => (await client.query(q, values)).rows); await client.query('COMMIT'); return out; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const migrations = new URL('../../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort()) await sql(await readFile(new URL(file, migrations), 'utf8'));
  const repo = new Repository(sql);
  const owner = (await repo.createUser('postgres_race_owner', 'test-only-hash')).id;
  const sources = await Promise.all([1, 2, 3, 4].map((n) => repo.addSource(owner, 'resume', `Resume ${n}`, `Source ${n}`)));
  const uploads = await Promise.allSettled(sources.map((s) => repo.initUpload(owner, s.id, 'resume.pdf', 'application/pdf', 10_000_000, 8)));
  assert.equal(uploads.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(await repo.pendingUploadBytes(owner), 20_000_000);
  const now = new Date('2026-01-01T00:00:00Z');
  const same = await Promise.all(Array.from({ length: 8 }, () => repo.reserve('model', 60, 1000, 'same-key', now, owner, 100)));
  assert.equal(new Set(same).size, 1);
  assert.ok(same[0]);
  assert.equal(Number((await sql('SELECT reserved_micros FROM spend_days'))[0].reserved_micros), 60);
  const competing = await Promise.all(['other-a', 'other-b', 'other-c'].map((key) => repo.reserve('model', 30, 1000, key, now, owner, 100)));
  assert.equal(competing.filter(Boolean).length, 1, 'per-account ceiling holds across independent pool clients');
  const jobs = await Promise.all(Array.from({ length: 8 }, () => repo.createJob(owner, 'paste', { resume: 'Same input', jd: 'Same job' })));
  assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
  assert.equal(Number((await sql('SELECT count(*) AS n FROM model_jobs'))[0].n), 1);
  console.log('PASS: PostgreSQL independent-client races enforce upload quota, same-key charging, per-user spend and queued-job deduplication.');
} finally {
  await pool?.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
