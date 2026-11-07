import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';
import { CoachService } from '../src/service.js';
import { gateRewrite } from '../src/truth.js';
import { GeminiAdapter, MODEL_CONFIG, ModelOutputError, usageMicros } from '../src/model.js';
import { GuestRepository } from '../src/guest.js';
import { createHandler } from '../netlify/functions/api.mjs';

test('Vertex Flash spend accounting includes thought tokens and the introductory-price end', () => {
  const usage = { promptTokenCount: 1000, candidatesTokenCount: 1000, thoughtsTokenCount: 200 };
  assert.equal(usageMicros('gemini-3.8-flash', usage, Date.UTC(2026, 9, 9)), 5250);
  assert.equal(usageMicros('gemini-3.8-flash', usage, Date.UTC(2027, 0, 1)), 10500);
});

async function database() {
  const db = new PGlite();
  for (const file of ['001_core.sql', '002_jobs.sql', '003_ingestion.sql', '004_workspaces.sql', '005_rewrites.sql', '006_interviewer.sql', '007_story_dig.sql', '008_drills.sql', '009_real_interviews.sql', '010_fact_gate.sql', '011_immerser.sql', '012_voice.sql', '013_guest_voice.sql', '015_debrief_input_hash.sql', '016_job_comparison.sql', '019_job_hunt_tracker.sql', '020_security_audit.sql', '021_security_hardening_3.sql', '022_fact_conflict_reviews.sql', '023_resource_guard.sql']) {
    await db.exec(await readFile(new URL(`../netlify/database/migrations/${file}`, import.meta.url), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

function proposal(text, quote, subject, predicate, value) {
  const start = text.indexOf(quote);
  return { subject, predicate, value, displayText: quote, quote, start, end: start + quote.length };
}

const scores = (rewriteClaims, unsupportedClaims = []) => ({
  contentScores: Object.fromEntries(['relevance', 'ownership', 'evidence', 'outcome', 'structure']
    .map((name, index) => [name, { score: index + 1, reason: `Observed ${name} in the answer.` }])),
  deliveryScores: {
    clarity: { score: 5, reason: 'The answer was easy to follow.' },
    concision: { score: 4, reason: 'One detail could be shorter.' },
  },
  feedback: 'Give one concrete baseline and explain your own decision.',
  unsupportedClaims,
  rewriteClaims,
});

class FakeModel {
  constructor(repo, fixture) {
    this.repo = repo;
    this.fixture = fixture;
    this.tasks = [];
    this.includePending = false;
  }

  async generate(task, prompt, schema) {
    this.tasks.push(task);
    let data;
    if (task.startsWith('extract_')) {
      const text = prompt.split('Source:\n')[1];
      const spec = task === 'extract_resume' ? this.fixture.resumeFact :
        task === 'extract_jd' ? this.fixture.jdFact : this.fixture.transcriptFact;
      const facts = [proposal(text, spec.quote, spec.subject, spec.predicate, spec.value)];
      if (task === 'extract_resume') facts.push({ ...facts[0], quote: 'fabricated source quote' });
      data = { facts };
    } else if (task === 'questions') {
      data = { questions: ['Tell me about your relevant operations experience.',
        'How do you make a difficult staffing decision?', 'How do you assess results?'] };
    } else if (task === 'followup') {
      data = { question: `What was your baseline, what did you decide, and how did you measure it? (${this.tasks.filter((item) => item === 'followup').length})` };
    } else if (task === 'fact_gate') {
      data = { items: [] };
    } else if (task === 'debrief') {
      const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]);
      const facts = await this.repo.facts(this.fixture.owner, this.fixture.workspaceId);
      const chosen = this.includePending ? facts.find((fact) => fact.status === 'draft') :
        facts.find((fact) => fact.domain === 'candidate' && fact.review_state === 'accepted' && fact.lifecycle === 'active');
      if (this.includePending) assert.ok(!ids.includes(chosen.id));
      data = scores([{ factIds: [chosen.id], subject: chosen.subject, predicate: chosen.predicate,
        value: chosen.value_json }], ['Led 80 staff and increased revenue 30% is unsupported.']);
    }
    assert.ok(schema(data), `${task} fake response must satisfy the model schema`);
    return { data, modelId: 'fake-gemini' };
  }
}

const fixtures = [
  {
    resume: 'At Harbor Lodge, supervised 8 staff during seasonal operations.',
    jd: 'Director role: lead property staffing and manage service recovery.',
    label: 'Hotel Director',
    resumeFact: { quote: 'supervised 8 staff', subject: 'candidate', predicate: 'supervised', value: { count: 8, unit: 'staff' } },
    jdFact: { quote: 'lead property staffing', subject: 'role', predicate: 'requires', value: { responsibility: 'property staffing' } },
    transcriptFact: { quote: 'reduced wait time by 12 minutes', subject: 'candidate', predicate: 'reduced', value: { count: 12, unit: 'minutes', measure: 'wait time' } },
  },
  {
    resume: 'At Copperline, trained 14 contact center coaches across three shifts.',
    jd: 'Enablement manager: develop coaching programs and audit call quality.',
    label: 'Enablement Manager',
    resumeFact: { quote: 'trained 14 contact center coaches', subject: 'candidate', predicate: 'trained', value: { count: 14, unit: 'coaches' } },
    jdFact: { quote: 'develop coaching programs', subject: 'role', predicate: 'requires', value: { responsibility: 'coaching programs' } },
    transcriptFact: { quote: 'improved onboarding completion', subject: 'candidate', predicate: 'improved', value: { measure: 'onboarding completion' } },
  },
];

test('slice 1 acceptance loop, exact quotes, correction history, grounding, and owner isolation', async () => {
  const { db, repo } = await database();
  try {
    const userA = await repo.createUser('fictional_a', 'test-hash');
    const userB = await repo.createUser('fictional_b', 'test-hash');
    const fixture = { ...fixtures[0], owner: userA.id };
    const model = new FakeModel(repo, fixture);
    const service = new CoachService(repo, model);
    const pasted = await service.paste(userA.id, { resume: fixture.resume, jd: fixture.jd, jobLabel: fixture.label });
    fixture.workspaceId = pasted.workspace.id;
    assert.equal(pasted.resume.dropped.length, 1);
    const original = pasted.facts.find((fact) => fact.domain === 'candidate');
    assert.equal(original.verbatim_quote, 'supervised 8 staff');
    assert.equal(fixture.resume.slice(original.start_offset, original.end_offset), original.verbatim_quote);
    await service.review(userA.id, { workspaceId: fixture.workspaceId, factId: original.id, action: 'confirm' });
    const corrected = await service.review(userA.id, {
      workspaceId: fixture.workspaceId, factId: original.id, action: 'correct',
      correction: 'I was the manager of 8 staff.', reason: 'My resume used supervisor wording.',
    });
    assert.equal(corrected.find((fact) => fact.id === original.id).lifecycle, 'superseded');
    const replacement = corrected.find((fact) => fact.supersedes_fact_id === original.id);
    assert.equal(replacement.review_state, 'accepted');
    assert.equal(replacement.discrepancy_note, 'My resume used supervisor wording.');
    assert.ok((await repo.events(userA.id, original.id)).some((event) => event.event_type === 'superseded'));
    assert.equal(await repo.fact(userB.id, original.id), null);
    await assert.rejects(service.review(userB.id, { workspaceId: fixture.workspaceId, factId: original.id, action: 'reject' }), /Workspace not found/);
    assert.equal(await repo.interview(userB.id, (await service.start(userA.id, fixture.workspaceId)).interview.id), null);
    const interview = (await repo.sql('SELECT id FROM interviews WHERE user_id=$1', [userA.id]))[0];
    for (let i = 0; i < 6; i += 1) {
      const answer = i === 5 ? 'I reduced wait time by 12 minutes.' :
        i === 0 ? 'I led 80 staff and increased revenue 30%.' : 'I made a staffing decision and checked the result.';
      const turn = await service.turn(userA.id, interview.id, answer);
      assert.equal(turn.done, i === 5);
    }
    const after = await repo.facts(userA.id, fixture.workspaceId);
    const outcome = after.find((fact) => fact.status === 'draft');
    assert.equal(outcome.review_state, 'pending');
    model.includePending = true;
    const firstDebrief = await service.debrief(userA.id, interview.id);
    assert.equal(firstDebrief.rewrite.ready, false);
    assert.equal(firstDebrief.deliveryScores.clarity.score, 5);
    assert.match(firstDebrief.unsupportedClaims[0], /80 staff/);
    await service.review(userA.id, { workspaceId: fixture.workspaceId, factId: outcome.id, action: 'confirm' });
    model.includePending = false;
    const secondDebrief = await service.debrief(userA.id, interview.id);
    assert.equal(secondDebrief.rewrite.ready, true);
    assert.equal(secondDebrief.rewrite.text, replacement.display_text);
    const callsAfterEvidenceChange = model.tasks.length;
    const retryDebrief = await service.debrief(userA.id, interview.id);
    assert.equal(retryDebrief.rewrite.text, secondDebrief.rewrite.text);
    assert.equal(model.tasks.length, callsAfterEvidenceChange, 'same transcript and confirmed facts reuse the saved debrief');
    assert.equal((await repo.debrief(userB.id, interview.id)), null);
    assert.deepEqual(model.tasks.filter((task) => task === 'followup').length, 3);
    assert.ok(model.tasks.includes('extract_transcript'));
    await service.deleteSource(userA.id, fixture.workspaceId, pasted.resume.source.id);
    assert.equal(await repo.source(userA.id, pasted.resume.source.id), null);
    assert.equal(await repo.fact(userA.id, original.id), null);
    assert.equal(await repo.fact(userA.id, replacement.id), null);
    assert.equal((await repo.sql(`SELECT count(*)::int AS n FROM artifacts
      WHERE user_id=$1 AND status='validated'`, [userA.id]))[0].n, 0);
    await repo.deleteAccount(userA.id);
    assert.equal(await repo.userByName('fictional_a'), null);
    assert.ok(await repo.userByName('fictional_b'));
  } finally { await db.close(); }
});

test('second fictional industry follows the same extraction and practice path', async () => {
  const { db, repo } = await database();
  try {
    const user = await repo.createUser('fictional_c', 'test-hash');
    const fixture = { ...fixtures[1], owner: user.id };
    const model = new FakeModel(repo, fixture);
    const service = new CoachService(repo, model);
    const pasted = await service.paste(user.id, { resume: fixture.resume, jd: fixture.jd, jobLabel: fixture.label });
    fixture.workspaceId = pasted.workspace.id;
    assert.equal(pasted.facts.find((fact) => fact.domain === 'candidate').verbatim_quote, fixture.resumeFact.quote);
    assert.equal(pasted.facts.find((fact) => fact.domain === 'job').verbatim_quote, fixture.jdFact.quote);
    assert.match((await service.start(user.id, fixture.workspaceId)).question, /operations experience/);
  } finally { await db.close(); }
});

test('truth gate rejects a polished unsupported claim with a misleading fact citation', () => {
  const fact = { id: 'a', domain: 'candidate', lifecycle: 'active', review_state: 'accepted',
    status: 'user_confirmed', subject: 'candidate', predicate: 'supervised',
    value_json: { count: 8, unit: 'staff' }, display_text: 'supervised 8 staff',
    verbatim_quote: 'supervised 8 staff', source_title: 'Resume' };
  const artifact = gateRewrite([{ factIds: ['a'], subject: 'candidate', predicate: 'supervised',
    value: { count: 80, unit: 'staff', revenueIncrease: '30%' } }], [fact]);
  assert.equal(artifact.ready, false);
  assert.equal(artifact.claims[0].reason, 'claim_changes_fact');
  assert.equal(artifact.text, '');
});

test('guest state is session supplied and creates no profile rows', async () => {
  const { db, repo } = await database();
  try {
    const fixture = { ...fixtures[1], owner: 'guest' };
    const guest = new GuestRepository();
    const service = new CoachService(guest, new FakeModel(guest, fixture));
    const result = await service.paste('guest', { resume: fixture.resume, jd: fixture.jd, jobLabel: fixture.label });
    fixture.workspaceId = result.workspace.id;
    assert.ok(result.facts.length);
    const firstFact = result.facts.find((fact) => fact.domain === 'candidate');
    await service.review('guest', { workspaceId: fixture.workspaceId, factId: firstFact.id, action: 'confirm' });
    const interview = (await service.start('guest', fixture.workspaceId)).interview;
    for (let i = 0; i < 6; i += 1) {
      await service.turn('guest', interview.id, i === 5 ?
        'I improved onboarding completion.' : 'I assessed the program with the team.');
    }
    assert.equal((await service.debrief('guest', interview.id)).rewrite.ready, true);
    assert.equal((await repo.sql('SELECT count(*)::int AS n FROM sources'))[0].n, 0);
    assert.equal((await repo.sql('SELECT count(*)::int AS n FROM interviews'))[0].n, 0);
    assert.equal((await new GuestRepository().facts('guest', result.workspace.id)).length, 0);
  } finally { await db.close(); }
});

test('atomic spend reservations cannot oversubscribe and invalid cap denies paid call', async () => {
  const { db, repo } = await database();
  try {
    const attempts = await Promise.all([repo.reserve('x', 60000, 100000, 'a'), repo.reserve('x', 60000, 100000, 'b')]);
    assert.equal(attempts.filter(Boolean).length, 1);
    const model = new GeminiAdapter({ repo, env: { GEMINI_API_KEY: 'fake', DAILY_USD_CAP: 'bad' },
      fetchImpl: () => { throw new Error('Network should not be called'); } });
    await assert.rejects(model.generate('questions', 'x', () => true), { code: 'spend_cap_reached' });
  } finally { await db.close(); }
});

test('malformed model JSON gets exactly one repair; transport fallback is bounded', async () => {
  const { db, repo } = await database();
  try {
    let calls = 0;
    const model = new GeminiAdapter({ repo, env: { GEMINI_API_KEY: 'fake' }, fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{oops' }] } }] }) };
    } });
    await assert.rejects(model.generate('questions', 'prompt', () => true), ModelOutputError);
    assert.equal(calls, 2);
    const models = [];
    const fallback = new GeminiAdapter({ repo, env: { GEMINI_API_KEY: 'fake' }, fetchImpl: async (url) => {
      models.push(url);
      if (models.length === 1) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }) };
    } });
    assert.deepEqual((await fallback.generate('questions', 'prompt', (value) => value.ok)).data, { ok: true });
    assert.match(models[1], new RegExp(MODEL_CONFIG.fallback));
  } finally { await db.close(); }
});

test('reported Gemini usage settles a reservation; unknown usage retains it', async () => {
  const { db, repo } = await database();
  try {
    const model = new GeminiAdapter({ repo, env: { GEMINI_API_KEY: 'fake' }, fetchImpl: async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 } }),
    }) });
    await model.generate('metered', 'prompt', (value) => value.ok);
    const day = (await repo.sql('SELECT * FROM spend_days'))[0];
    assert.equal(Number(day.reserved_micros), 0);
    assert.equal(Number(day.settled_micros), usageMicros(MODEL_CONFIG.primary,
      { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 }));
    const unknown = new GeminiAdapter({ repo, env: { GEMINI_API_KEY: 'fake' }, fetchImpl: async () => ({
      ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
    }) });
    await unknown.generate('unmetered', 'prompt', (value) => value.ok);
    const afterUnknown = (await repo.sql('SELECT * FROM spend_days'))[0];
    assert.equal(Number(afterUnknown.reserved_micros), 250000);
  } finally { await db.close(); }
});

test('HTTP auth uses same-origin CSRF and owner derived from cookie', async () => {
  const { db, repo } = await database();
  try {
    const handler = createHandler({ repo, model: { generate: () => { throw new Error('not called'); } },
      env: { ABUSE_HMAC_KEY: 'long-test-only-random-abuse-hmac-key' } });
    const url = 'http://localhost/api?op=signup';
    const payload = JSON.stringify({ username: 'sampleuser', password: 'fictional-passphrase' });
    const rejected = await handler(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }));
    assert.equal(rejected.status, 403);
    const accepted = await handler(new Request(url, { method: 'POST', headers: {
      origin: 'http://localhost', 'content-type': 'application/json', 'x-coach-csrf': '1',
    }, body: payload }));
    assert.equal(accepted.status, 200);
    const cookie = accepted.headers.get('set-cookie').split(';')[0];
    assert.ok(cookie.startsWith('ic_session='));
    const session = await handler(new Request('http://localhost/api?op=session', { headers: { cookie } }));
    assert.equal((await session.json()).user.username, 'sampleuser');
  } finally { await db.close(); }
});

test('HTTP guest flow returns browser state and stores no personal rows', async () => {
  const { db, repo } = await database();
  try {
    const fixture = { ...fixtures[0], owner: 'guest' };
    const guestModel = new FakeModel(new GuestRepository(), fixture);
    const handler = createHandler({ repo, model: guestModel,
      env: { ABUSE_HMAC_KEY: 'long-test-only-random-abuse-hmac-key' } });
    const request = (op, body) => new Request(`http://localhost/api?op=${op}`, {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-coach-csrf': '1' },
      body: JSON.stringify({ ...body, guest: true }),
    });
    const response = await handler(request('paste', { state: {}, resume: fixture.resume,
      jd: fixture.jd, jobLabel: fixture.label }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.state.sources.length, 2);
    assert.equal((await repo.sql('SELECT count(*)::int AS n FROM sources'))[0].n, 0);
    const empty = await handler(request('ledger', { state: {}, workspaceId: data.result.workspace.id }));
    assert.equal(empty.status, 404);
  } finally { await db.close(); }
});

test('provider: Vertex key wins over Gemini key; Gemini API is the fallback', async () => {
  const { providerFor } = await import('../src/model.js');
  assert.match(providerFor({ VERTEX_API_KEY: 'v', GEMINI_API_KEY: 'g' }).endpoint, /aiplatform\.googleapis\.com/);
  assert.equal(providerFor({ VERTEX_API_KEY: 'v', GEMINI_API_KEY: 'g' }).key, 'v');
  assert.match(providerFor({ GEMINI_API_KEY: 'g' }).endpoint, /generativelanguage\.googleapis\.com/);
  assert.equal(providerFor({}).key, undefined);
});

test('thinking config: 3.x models get a level, 2.5 models get budget 0', async () => {
  const { thinkingConfigFor } = await import('../src/model.js');
  assert.deepEqual(thinkingConfigFor('gemini-3.8-flash'), { thinkingLevel: 'low' });
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash'), { thinkingBudget: 0 });
});

test('deployed model requests stay on Vertex, including retry and missing-key failures', async () => {
  const { providerFor } = await import('../src/model.js');
  for (const deployment of [{ NETLIFY: 'true' }, { CONTEXT: 'production' }]) {
    assert.equal(providerFor({ ...deployment, GEMINI_API_KEY: 'local-only' }).key, undefined);
  }
  const calls = [];
  const repo = { reserve: async () => 'reservation', settle: async () => {} };
  const adapter = new GeminiAdapter({ repo,
    env: { VERTEX_API_KEY: 'vertex-test', GEMINI_API_KEY: 'must-not-be-used', NETLIFY: 'true' },
    fetchImpl: async (url, init) => {
      calls.push({ url, key: init.headers['x-goog-api-key'] });
      return { ok: false, status: 503, text: async () => 'provider down' };
    } });
  await assert.rejects(adapter.generate('test', 'prompt', () => true), { code: 'model_unavailable' });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.url, /^https:\/\/aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\//);
    assert.equal(call.key, 'vertex-test');
  }
  const missing = new GeminiAdapter({ repo, env: { NETLIFY: 'true', GEMINI_API_KEY: 'local-only' },
    fetchImpl: async () => { throw new Error('Missing Vertex must not call another provider'); } });
  await assert.rejects(missing.call(MODEL_CONFIG.primary, 'test', 'prompt'), {
    code: 'model_unavailable', message: 'Vertex is unavailable: configure VERTEX_API_KEY. Your saved work is unchanged.',
  });
});
