import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { GeminiAdapter } from '../src/model.js';
import { confidenceFeedback, confidenceFeedbackValid, confidenceFallback, numberSupported } from '../src/service.js';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';

test('definitive model failures release their reservation, but an unknown timeout does not', async () => {
  const settled = [];
  const repo = { async reserve() { return `r${settled.length}`; }, async settle(id, amount) { settled.push([id, amount]); } };
  const env = { GEMINI_API_KEY: 'key' };
  for (const status of [400, 500, 429]) {
    const adapter = new GeminiAdapter({ repo, env, fetchImpl: async () => new Response('no', { status }) });
    await assert.rejects(adapter.call('gemini-3.8-flash', 'test', 'hello'));
  }
  assert.deepEqual(settled.map(([, amount]) => amount), [0, 0, 0]);
  const adapter = new GeminiAdapter({ repo, env, fetchImpl: async () => { throw new TypeError('network down'); } });
  await assert.rejects(adapter.call('gemini-3.8-flash', 'test', 'hello'));
  assert.equal(settled.length, 3);
});

test('confidence feedback requires a specific opening and exactly one next step, with a safe fallback', () => {
  assert.equal(confidenceFeedbackValid('Add a number.'), false);
  assert.equal(confidenceFeedbackValid('You explained your staffing decision clearly. Next time: name the weekly coverage number.'), true);
  assert.equal(confidenceFeedbackValid('You did well. Next time: add a number. Next time: add a date.'), false);
  const fallback = confidenceFallback({ contentScores: {
    relevance: { score: 5, reason: 'you answered the question directly' },
    evidence: { score: 1, reason: 'name the result you measured' },
  } });
  assert.match(fallback, /^You answered the question directly\. /);
  assert.match(fallback, /Next time: name the result you measured\.$/);
});

test('numeric support compares whole normalized number tokens', () => {
  assert.equal(numberSupported('5', 'We served 15 clients.'), false);
  assert.equal(numberSupported('1,000', 'We served 1000 clients.'), true);
  assert.equal(numberSupported('40%', 'The rate was 40.'), true);
  assert.equal(numberSupported('40', 'The rate was 40%.'), true);
});

test('debrief rendering leads with confidence and exposes plain controls for previously missed lines', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('function renderDebrief'), app.indexOf('function renderStronger'));
  assert.ok(body.indexOf("'What worked'") < body.indexOf("renderScores('What you said'"));
  assert.ok(body.indexOf("'Next time'") < body.indexOf("renderScores('What you said'"));
  assert.match(app, /plain\.plainNode\('p', requirement\.rationale/);
  assert.match(app, /plain\.plainSpan\(gap, 'debrief'\)/);
  assert.match(app, /\$\('plain-voice'\)\.checked = plain\.isOn\(\)/);
});

async function database() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

test('a stale debrief becomes retryable when it is read', async () => {
  const { db, repo } = await database();
  try {
    const user = await repo.createUser('stale-user', 'hash');
    const job = await repo.createJob(user.id, 'debrief', { interviewId: 'x' });
    await repo.claimJob(user.id, job.id);
    const old = new Date('2026-01-01T00:00:00Z');
    await repo.sql('UPDATE model_jobs SET started_at=$2 WHERE id=$1', [job.id, old]);
    // This is the same fake clock boundary used by a poll/read, ten minutes after start.
    await repo.expireStaleJobs(user.id, new Date('2026-01-01T00:10:01Z'));
    const stale = await repo.job(user.id, job.id);
    assert.equal(stale.status, 'failed');
    assert.equal(stale.error_code, 'timed_out');
    assert.equal((await repo.retryJob(user.id, job.id)).status, 'queued');
  } finally { await db.close(); }
});

test('a failed feedback repair never fails the debrief', async () => {
  const model = { async generate() { throw new Error('invalid_model_output'); } };
  const data = { feedback: 'Add a number.', contentScores: {
    relevance: { score: 4, reason: 'kept it on the question' },
    evidence: { score: 2, reason: 'name the result you measured' } } };
  const result = await confidenceFeedback(model, data, [{ speaker: 'candidate', text: 'I did things.' }]);
  assert.match(result.feedback, /^You did well at staying on the question\. Next time: name the result you measured\.$/);
  const reasoned = confidenceFallback({ contentScores: { structure: { score: 5, reason: 'You opened with the result. Next time, say it in one line.' }, evidence: { score: 1, reason: 'You stated strong numbers early. Next time, map each response to the prompt asked.' } } });
  assert.equal(reasoned, 'You opened with the result. Next time: map each response to the prompt asked.');
});
