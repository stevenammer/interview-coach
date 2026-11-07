import test from 'node:test';
import assert from 'node:assert/strict';
import { CoachService } from '../src/service.js';
import { GuestRepository } from '../src/guest.js';
import { GeminiAdapter, extractionSchema } from '../src/model.js';
import { documentSchema } from '../src/writing.js';
import { normalizeImmersion, chooseImmersion, initialImmersion } from '../src/immerser.js';
import { createCard } from '../src/fsrs.js';

async function fixture() {
  const repo = new GuestRepository();
  const jd = await repo.addSource('guest', 'jd', 'Role', 'Train the team.');
  const ws = await repo.addWorkspace('guest', jd.id, 'Trainer');
  const source = await repo.addSource('guest', 'resume', 'Resume', 'I trained 12 people.');
  const id = await repo.addFact('guest', { workspaceId: ws.id, domain: 'candidate', sourceId: source.id,
    subject: 'candidate', predicate: 'trained', value: { text: source.text }, quote: source.text,
    displayText: source.text, start: 0, end: source.text.length, status: 'document',
    reviewState: 'accepted', proposedBy: 'user' });
  return { repo, ws, source, id };
}

test('extraction ignores injected persistence fields while preserving source spans and review gate', async () => {
  const { repo, ws, source } = await fixture();
  const otherSource = await repo.addSource('guest', 'background', 'Wrong provenance', source.text);
  const payload = { subject: 'candidate', predicate: 'trained', value: { text: source.text }, quote: source.text,
    workspaceId: null, domain: 'job', sourceId: otherSource.id, supersedes: 'invented-id',
    reviewState: 'accepted', proposedBy: 'user', discrepancyNote: 'Injected', relation: 'user_assertion' };
  assert.ok(extractionSchema({ facts: [payload] }), 'the model envelope permits extra JSON fields');
  const service = new CoachService(repo, null);
  const result = await service.extract('guest', 'resume', 'Resume', source.text, ws.id, source, [],
    { data: { facts: [payload] } });
  const fact = await repo.fact('guest', result.factIds[0]);
  assert.equal(fact.workspace_id, ws.id);
  assert.equal(fact.domain, 'candidate');
  assert.equal(fact.source_id, source.id);
  assert.equal(fact.verbatim_quote, source.text.slice(fact.start_offset, fact.end_offset));
  assert.equal(fact.review_state, 'pending');
  assert.equal(fact.proposed_by, 'model');
  assert.equal(fact.supersedes_fact_id, null);
  assert.equal(fact.discrepancy_note, null);
});

test('a newly reported conflict withholds existing drill cards, grading and cached stronger wording', async () => {
  const { repo, ws, source, id } = await fixture();
  const other = await repo.addSource('guest', 'background', 'Correction', 'I did not train people.');
  const conflictId = await repo.addFact('guest', { workspaceId: ws.id, domain: 'candidate', sourceId: other.id,
    subject: 'candidate', predicate: 'trained', value: { text: other.text }, quote: other.text,
    displayText: other.text, start: 0, end: other.text.length, status: 'document', reviewState: 'accepted', proposedBy: 'user' });
  const model = { async generate() { throw new Error('conflicted grading must not call a provider'); } };
  const service = new CoachService(repo, model);
  const card = await repo.addDrillCard('guest', ws.id, 'story', null, source.text, [id], createCard('story'));
  const interview = await repo.createInterview('guest', ws.id, ['Question?'], 'hiring_manager', 2, 'mock');
  const rewrite = { ready: true, claims: [{ factIds: [id], valid: true }], text: source.text };
  await repo.saveDebrief('guest', interview, {}, rewrite);
  assert.equal((await service.drills('guest', ws.id)).cards.length, 1);
  assert.equal((await service.strongerDraft('guest', interview.id)).ready, true);
  const [pair] = await service.reportFactConflict('guest', { workspaceId: ws.id, factAId: id,
    factBId: conflictId, reason: 'These claims appear inconsistent.' });
  assert.equal((await service.drills('guest', ws.id)).cards.length, 0);
  await assert.rejects(service.reviewDrill('guest', card.id, 'I trained people.'), /refreshed evidence/);
  const held = await service.strongerDraft('guest', interview.id);
  assert.equal(held.ready, false);
  assert.equal(held.text, '');
  await service.updateFactConflictReview('guest', { workspaceId: ws.id, reviewId: pair.reviewId,
    action: 'resolved', reason: 'Different periods, explicitly checked.' });
  assert.equal((await service.drills('guest', ws.id)).cards.length, 1);
  assert.equal((await service.strongerDraft('guest', interview.id)).ready, true);
});

test('multimodal calls preserve owner identity for the shared spend guard', async () => {
  const adapter = new GeminiAdapter({ env: {} });
  const owners = [];
  adapter.call = async (...args) => { owners.push(args[5]); return { text: '{"text":"A note"}' }; };
  assert.equal(await adapter.transcribe('AQ==', 'audio/webm', 'owner-a'), 'A note');
  assert.equal(await adapter.readImage('AQ==', 'image/png', 'owner-b'), 'A note');
  assert.deepEqual(owners, ['owner-a', 'owner-b']);
});

test('invalid model output diagnostics do not log model-controlled property names', async () => {
  const adapter = new GeminiAdapter({ env: {} });
  const sentinel = 'PRIVATE_TEST_SENTINEL_NOT_REAL_DATA';
  adapter.call = async () => ({ text: JSON.stringify({ [sentinel]: 'ignored' }) });
  const previous = console.error, logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try { await assert.rejects(adapter.generate('test', 'prompt', () => false, { passes: 1 })); }
  finally { console.error = previous; }
  assert.equal(logs.some((line) => line.includes(sentinel)), false);
  assert.ok(logs.some((line) => line.includes('keyCount')));
});

test('writer flags uncited invented experience even when it contains no digits', async () => {
  const { repo, ws, source } = await fixture();
  for (const quote of ['Built a curriculum.', 'Coached new hires.']) {
    const src = await repo.addSource('guest', 'resume', 'More evidence', quote);
    await repo.addFact('guest', { workspaceId: ws.id, domain: 'candidate', sourceId: src.id,
      subject: 'candidate', predicate: 'did', value: { text: quote }, quote, displayText: quote,
      start: 0, end: quote.length, status: 'document', reviewState: 'accepted', proposedBy: 'user' });
  }
  const model = { async generate() { return { data: { sections: [{ heading: '', lines: [
    { text: 'Dear Hiring Team,', factIds: [] },
    { text: 'I led global engineering organizations.', factIds: [] },
  ] }], gaps: [] } }; } };
  const doc = await new CoachService(repo, model).writeDocument('guest', ws.id, 'cover_letter');
  assert.equal(doc.sections[0].lines[0].check, null);
  assert.match(doc.sections[0].lines[1].check, /no confirmed source/);
  assert.equal(doc.flagged, 1);
});

test('malformed document citations and gaps fail schema validation before rendering', () => {
  const valid = { sections: [{ heading: 'Experience', lines: [{ text: 'A real line.', factIds: ['fact-a'] }] }], gaps: ['Outcome'] };
  assert.ok(documentSchema(valid));
  assert.equal(documentSchema({ ...valid, gaps: [{ secret: 'not a displayable gap' }] }), false);
  assert.equal(documentSchema({ ...valid, sections: [{ heading: 'X', lines: [{ text: 'Line', factIds: [{}] }] }] }), false);
});

test('immersion choices remain unambiguous even when proposed IDs collide with generated suffixes', () => {
  const scene = { title: 'Decide', situation: 'Choose what to do.', choices: ['x', 'x-3', 'x', 'x-2'].map((id, i) =>
    ({ id, label: `Choice ${i}`, consequence: `Consequence ${i}` })) };
  const plan = normalizeImmersion({ scenes: [scene, scene, scene] }, { jdId: 'jd', jdText: '', companyFacts: [] });
  const ids = plan.scenes[0].choices.map((choice) => choice.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const choice of plan.scenes[0].choices) {
    const next = chooseImmersion(plan, initialImmersion(plan), choice.id, 'My choice');
    assert.equal(next.carry, choice.consequence);
  }
});

test('a cancelled background extraction cannot persist a late provider response', async () => {
  const { runModelJob } = await import('../src/jobs.js');
  let status = 'running', sourceWrites = 0, finish;
  const repo = {
    async claimJob() { return { kind: 'ingest', input_json: { kind: 'jd', title: 'Role', text: 'Train people.' } }; },
    async job() { return { status }; },
    async addSource() { sourceWrites += 1; throw new Error('late content must not be stored'); },
    async finishJob(_owner, _id, result, code) { finish = { result, code }; },
  };
  const model = { async generate() {
    status = 'failed'; // deletion invalidated the job while its model request was in flight
    return { data: { facts: [] }, modelId: 'offline' };
  } };
  assert.equal(await runModelJob(repo, model, 'owner', 'job'), true);
  assert.equal(sourceWrites, 0);
  assert.deepEqual(finish, { result: null, code: 'source_deleted' });
});

test('large known-price model inputs reserve their conservative full cost before dispatch', async () => {
  let reserved = 0, dispatched = 0;
  const repo = { async reserve(_bucket, micros, cap) { reserved = micros; return micros <= cap ? 'hold' : null; } };
  const adapter = new GeminiAdapter({ repo, env: { GEMINI_API_KEY: 'offline-test', DAILY_USD_CAP: '1' },
    fetchImpl: async () => { dispatched += 1; throw new Error('over-budget request reached provider'); } });
  await assert.rejects(adapter.call('gemini-3.1-pro-preview', 'long_prompt', 'x'.repeat(1_000_000)), { code: 'spend_cap_reached' });
  assert.ok(reserved > 1_000_000, 'the old fixed quarter-dollar reservation cannot cover this input');
  assert.equal(dispatched, 0);
});

test('unknown prices and oversized payloads fail closed before reserve or network activity', async () => {
  let reserved = 0, dispatched = 0;
  const adapter = new GeminiAdapter({ repo: { async reserve() { reserved += 1; } }, env: { GEMINI_API_KEY: 'offline-test' },
    fetchImpl: async () => { dispatched += 1; } });
  await assert.rejects(adapter.call('operator-custom-rate-not-configured', 'test', 'prompt'), { code: 'model_pricing_unavailable' });
  await assert.rejects(adapter.call('gemini-3.8-flash', 'test', 'x'.repeat(4_000_000)), { code: 'model_input_too_large' });
  assert.equal(reserved, 0);
  assert.equal(dispatched, 0);
});

test('a successful response without usage keeps the enlarged reservation', async () => {
  let reserved = 0, settled = 0;
  const adapter = new GeminiAdapter({ repo: { async reserve(_bucket, micros) { reserved = micros; return 'hold'; },
    async settle() { settled += 1; } }, env: { GEMINI_API_KEY: 'offline-test', DAILY_USD_CAP: '15' },
    fetchImpl: async () => ({ ok: true, async json() { return { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }; } }) });
  assert.equal((await adapter.call('gemini-3.1-pro-preview', 'test', 'x'.repeat(1_000_000))).text, '{"ok":true}');
  assert.ok(reserved > 2_000_000);
  assert.equal(settled, 0);
});

test('uncertain provider failures retain their holds without exposing response bodies', async () => {
  for (const status of [408, 500, 503, 429, 400]) {
    const settled = []; let bodyRead = false;
    const adapter = new GeminiAdapter({ repo: { async reserve() { return 'hold'; }, async settle(_id, amount) { settled.push(amount); } },
      env: { GEMINI_API_KEY: 'offline-test' }, fetchImpl: async () => ({ ok: false, status,
        async text() { bodyRead = true; return 'PRIVATE_ERROR_BODY_TEST_SENTINEL'; } }) });
    await assert.rejects(adapter.call('gemini-3.8-flash', 'test', 'A prompt'), (error) =>
      error.message === `Gemini request failed (${status})`);
    assert.equal(bodyRead, false);
    assert.deepEqual(settled, [429, 400].includes(status) ? [0] : []);
  }
});
