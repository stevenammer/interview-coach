import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';
import { CoachService } from '../src/service.js';

const migrations = ['001_core.sql', '002_jobs.sql', '003_ingestion.sql', '004_workspaces.sql',
  '005_rewrites.sql', '006_interviewer.sql', '007_story_dig.sql', '008_drills.sql',
  '009_real_interviews.sql', '010_fact_gate.sql', '011_immerser.sql', '012_voice.sql', '013_guest_voice.sql', '015_debrief_input_hash.sql', '016_job_comparison.sql', '021_security_hardening_3.sql', '022_fact_conflict_reviews.sql', '023_resource_guard.sql', '024_spend_guard_subject.sql'];
async function fixture() {
  const db = new PGlite();
  for (const name of migrations) await db.exec(await readFile(new URL(`../netlify/database/migrations/${name}`, import.meta.url), 'utf8'));
  const repo = new Repository(pgliteSql(db));
  const owner = (await repo.createUser('story_candidate', 'hash')).id;
  const jd = await repo.addSource(owner, 'jd', 'Operations role', 'Lead service recovery and staffing.');
  const workspace = await repo.addWorkspace(owner, jd.id, 'Operations role');
  return { db, repo, owner, workspace };
}

test('related atomic facts make one story card with a grounded human title and varied prompts', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const source = await repo.addSource(owner, 'resume', 'Check-in wait turnaround',
      'Cut check-in wait from 20 to 8 minutes by changing the arrival roster.');
    const ids = [];
    for (const predicate of ['held_role', 'changed_process', 'measured_result']) {
      const quote = source.text;
      const id = await repo.addFact(owner, { workspaceId: workspace.id, sourceId: source.id,
        subject: 'check_in_wait_story', predicate, value: { text: quote }, displayText: quote,
        quote, start: 0, end: quote.length, status: 'document', reviewState: 'pending', proposedBy: 'model' });
      await repo.review(owner, id, 'confirm'); ids.push(id);
    }
    const service = new CoachService(repo, { async generate(task, prompt, schema) {
      assert.equal(task, 'drill_story_title');
      assert.match(prompt, /Cut check-in wait from 20 to 8 minutes/);
      const data = { title: 'Cut check-in wait' };
      assert.ok(schema(data)); return { data };
    } });
    const built = await service.buildDrills(owner, workspace.id);
    const stories = built.cards.filter((card) => card.kind === 'story');
    assert.equal(stories.length, 1);
    assert.deepEqual((await repo.drillCard(owner, stories[0].id)).fact_ids, ids);
    assert.match(stories[0].prompt, /check-in wait/i);
    assert.doesNotMatch(stories[0].prompt, /held_role|changed_process|measured_result|check_in_wait_story/);
    const saved = await repo.drillCard(owner, stories[0].id);
    saved.schedule_json.reps = 1;
    assert.match(service.drillPrompt(saved), /Start from the decision/);
    await service.buildDrills(owner, workspace.id);
    assert.equal((await repo.drillCards(owner, workspace.id)).filter((card) => card.kind === 'story').length, 1);
  } finally { await db.close(); }
});

test('story-title validation rejects invented claims and falls back to a full source clause', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const quote = 'Grew spa membership sales 30% in one year through a referral program; coached the front desk.';
    const source = await repo.addSource(owner, 'resume', 'Resume', quote);
    const factId = await repo.addFact(owner, { workspaceId: workspace.id, sourceId: source.id,
      subject: 'candidate', predicate: 'measured_result', value: { text: quote }, displayText: quote,
      quote, start: 0, end: quote.length, status: 'document', reviewState: 'pending', proposedBy: 'model' });
    await repo.review(owner, factId, 'confirm');
    const service = new CoachService(repo, { async generate(task, _prompt, schema) {
      assert.equal(task, 'drill_story_title');
      const data = { title: 'Doubled sales by 99%' };
      assert.ok(schema(data)); return { data };
    } });
    const card = (await service.buildDrills(owner, workspace.id)).cards.find((item) => item.kind === 'story');
    assert.match(card.prompt, /^Tell me about Grew spa membership sales 30% in one year through a referral program\./);
    assert.doesNotMatch(card.prompt, /Doubled|99%/);
  } finally { await db.close(); }
});

test('drill builds reuse saved evidence cards and survive an individual title-provider failure', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const add = async (text) => {
      const source = await repo.addSource(owner, 'resume', 'Resume', text);
      const factId = await repo.addFact(owner, { workspaceId: workspace.id, sourceId: source.id,
        subject: 'candidate', predicate: 'did_work', value: { text }, displayText: text, quote: text,
        start: 0, end: text.length, status: 'document', reviewState: 'pending', proposedBy: 'model' });
      await repo.review(owner, factId, 'confirm');
      return { factId, sourceId: source.id };
    };
    const firstEvidence = await add('Cut the lobby line by moving the morning schedule.');
    let calls = 0;
    const service = new CoachService(repo, { async generate(task, _prompt, schema) {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error('provider hiccup'), { code: 'model_unavailable' });
      const data = { title: 'Cut the lobby line' };
      assert.equal(task, 'drill_story_title'); assert.ok(schema(data)); return { data };
    } });
    const first = await service.buildDrills(owner, workspace.id);
    const card = first.cards.find((item) => item.kind === 'story');
    const saved = await repo.drillCard(owner, card.id);
    await repo.sql('UPDATE drill_cards SET schedule_json=$3::jsonb WHERE user_id=$1 AND id=$2',
      [owner, card.id, JSON.stringify({ ...saved.schedule_json, reps: 3 })]);
    await service.buildDrills(owner, workspace.id);
    assert.equal(calls, 1, 'unchanged evidence skips the provider entirely');
    assert.equal((await repo.drillCard(owner, card.id)).schedule_json.reps, 3, 'practice progress stays put');
    const originalHash = (await repo.drillCard(owner, card.id)).schedule_json.evidence_hash;
    await repo.sql('UPDATE source_spans SET verbatim_quote=$3 WHERE user_id=$1 AND source_id=$2',
      [owner, firstEvidence.sourceId, 'Changed the morning lobby schedule.']);
    await service.buildDrills(owner, workspace.id);
    assert.equal(calls, 2, 'changed evidence under the same fact ID refreshes the cue');
    assert.notEqual((await repo.drillCard(owner, card.id)).schedule_json.evidence_hash, originalHash);
    await add('Coached the night team through a guest recovery.');
    const rebuilt = await service.buildDrills(owner, workspace.id);
    assert.equal(calls, 3, 'only the new evidence needs a title');
    assert.ok(rebuilt.cards.some((item) => /Coached the night team/.test(item.prompt)), 'failed title uses confirmed source words');
  } finally { await db.close(); }
});

test('a cited fact stays transferable when its text cannot directly prove the stated requirement', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const quote = 'Led the evening shift and coached two new supervisors.';
    const source = await repo.addSource(owner, 'resume', 'Resume', quote);
    const factId = await repo.addFact(owner, { workspaceId: workspace.id, sourceId: source.id,
      subject: 'candidate', predicate: 'led_shift', value: { text: quote }, displayText: quote, quote,
      start: 0, end: quote.length, status: 'document', reviewState: 'pending', proposedBy: 'model' });
    await repo.review(owner, factId, 'confirm');
    const service = new CoachService(repo, { async generate(_task, _prompt, schema) {
      const data = { requirements: [{ quote: 'staffing', type: 'must', competency: 'people leadership',
        evidenceNeeded: 'A leadership example', category: 'direct', rationale: 'She led the shift.', factIds: [factId] }] };
      assert.ok(schema(data)); return { data };
    } });
    const mapped = await service.mapWorkspace(owner, workspace.id);
    assert.equal(mapped[0].category, 'adjacent');
    assert.deepEqual(mapped[0].fact_ids, [factId]);
  } finally { await db.close(); }
});

test('clear shared evidence may be direct, while initial card titles are bounded to six calls in pairs', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const source = await repo.addSource(owner, 'resume', 'Resume', 'Managed staffing for the evening shift.');
    const factId = await repo.addFact(owner, { workspaceId: workspace.id, sourceId: source.id,
      subject: 'candidate', predicate: 'staffing', value: { text: source.text }, displayText: source.text,
      quote: source.text, start: 0, end: source.text.length, status: 'document', reviewState: 'pending', proposedBy: 'model' });
    await repo.review(owner, factId, 'confirm');
    const mapService = new CoachService(repo, { async generate(_task, _prompt, schema) {
      const data = { requirements: [{ quote: 'staffing', type: 'must', competency: 'staffing leadership',
        evidenceNeeded: 'A staffing example', category: 'direct', rationale: 'Managed staffing.', factIds: [factId] }] };
      assert.ok(schema(data)); return { data };
    } });
    assert.equal((await mapService.mapWorkspace(owner, workspace.id))[0].category, 'direct');

    for (let index = 0; index < 7; index += 1) {
      const text = `Reduced wait time in location ${index}.`;
      const line = await repo.addSource(owner, 'resume', `Resume ${index}`, text);
      const id = await repo.addFact(owner, { workspaceId: workspace.id, sourceId: line.id,
        subject: 'candidate', predicate: 'result', value: { text }, displayText: text, quote: text,
        start: 0, end: text.length, status: 'document', reviewState: 'pending', proposedBy: 'model' });
      await repo.review(owner, id, 'confirm');
    }
    let calls = 0; let active = 0; let peak = 0;
    const drillService = new CoachService(repo, { async generate(_task, _prompt, schema) {
      calls += 1; active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1;
      const data = { title: 'Reduced wait time' }; assert.ok(schema(data)); return { data };
    } });
    await drillService.buildDrills(owner, workspace.id);
    assert.equal(calls, 6);
    assert.ok(peak <= 2, `at most two title calls run at once, saw ${peak}`);
  } finally { await db.close(); }
});

test('confirming a reflected dig without a correction extracts its original scene', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const scene = 'I moved the morning check-in team and the queue cleared.';
    const service = new CoachService(repo, { async generate(task, prompt, schema) {
      const data = task === 'story_dig_reflection' ? { reflection: `${scene} Did I get that right?` } :
        { facts: [{ subject: 'candidate', predicate: 'acted', value: { text: scene }, quote: scene }] };
      assert.ok(schema(data)); return { data };
    } });
    const dig = await repo.startDig(owner, workspace.id, 'service recovery');
    await service.reflectDig(owner, dig.id, scene);
    const result = await service.confirmDig(owner, dig.id);
    assert.equal(result.dig.scene_text, scene);
    assert.equal((await repo.source(owner, (await repo.facts(owner, workspace.id)).find((fact) => fact.id === result.proposals[0]).source_id)).text, scene);
  } finally { await db.close(); }
});

test('dig maps an unmapped workspace and targets its actual uncovered requirement', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const service = new CoachService(repo, { async generate(task, _prompt, schema) {
      assert.equal(task, 'requirements');
      const data = { requirements: [{ quote: 'service recovery', type: 'must', competency: 'service recovery',
        evidenceNeeded: 'A real example', category: 'none', rationale: 'No story', factIds: [] }] };
      assert.ok(schema(data)); return { data };
    } });
    const result = await service.startDig(owner, workspace.id);
    assert.equal(result.dig.competency, 'service recovery');
    assert.match(result.prompt, /service recovery/);
  } finally { await db.close(); }
});


test('failed follow-up leaves the original question waiting and accepts a single retry', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const interview = await repo.createInterview(owner, workspace.id, ['Opening question', 'Second question', 'Third question'], 'hiring_manager', 2, 'mock');
    await repo.addTurn(owner, interview.id, 'interviewer', 'Opening question');
    let fail = true;
    const service = new CoachService(repo, { async generate(task, prompt, schema) {
      assert.equal(task, 'followup');
      assert.match(prompt, /at most 350 characters/);
      assert.match(prompt, /candidate: I led the call reviews/);
      if (fail) throw Object.assign(new Error('Invalid output'), { code: 'invalid_model_output' });
      const data = { question: 'What changed after those reviews?' };
      assert.ok(schema(data));
      return { data };
    } });
    await assert.rejects(service.turn(owner, interview.id, 'I led the call reviews'), { code: 'invalid_model_output' });
    assert.equal((await repo.turns(owner, interview.id)).length, 1);
    fail = false;
    const result = await service.turn(owner, interview.id, 'I led the call reviews');
    assert.equal(result.question, 'What changed after those reviews?');
    const turns = await repo.turns(owner, interview.id);
    assert.deepEqual(turns.map(t => t.speaker), ['interviewer', 'candidate', 'interviewer']);
  } finally { await db.close(); }
});

test('follow-ups remove prompt scaffolding and do not repeat the current question', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const interview = await repo.createInterview(owner, workspace.id, ['Opening question', 'Second question', 'Third question'], 'hiring_manager', 2, 'mock');
    await repo.addTurn(owner, interview.id, 'interviewer', 'Opening question');
    const service = new CoachService(repo, { async generate(_task, _prompt, schema) {
      const data = { question: 'Follow-up: Opening question. Say it plain.' };
      assert.ok(schema(data));
      return { data };
    } });
    const result = await service.turn(owner, interview.id, 'I led the call reviews');
    assert.equal(result.question, 'What one specific detail or example can you support from what you just shared?');
    assert.doesNotMatch(result.question, /follow-up|say it plain/i);
  } finally { await db.close(); }
});

test('a failed optional evidence cross-check preserves scores and transcript-grounded report', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const interview = await repo.createInterview(owner, workspace.id, ['Question'], 'hiring_manager', 2, 'mock');
    await repo.addTurn(owner, interview.id, 'interviewer', 'Question');
    await repo.addTurn(owner, interview.id, 'candidate', 'I planned the staffing change.');
    await repo.endInterview(owner, interview.id);
    const seen = [];
    const model = { async generate(task, _prompt, schema) {
      seen.push(task);
      if (task === 'fact_gate') throw Object.assign(new Error('temporary outage'), { code: 'model_unavailable' });
      const data = { contentScores: Object.fromEntries(['relevance', 'ownership', 'evidence', 'outcome', 'structure']
        .map((name) => [name, { score: 3, reason: `${name} observed.` }])),
      deliveryScores: { clarity: { score: 4, reason: 'Clear.' }, concision: { score: 3, reason: 'Could shorten.' } },
      feedback: 'Name the decision and its result.', unsupportedClaims: [], rewriteClaims: [], strongerNeeds: [] };
      assert.ok(schema(data));
      return { data, modelId: 'fixture' };
    } };
    const service = new CoachService(repo, model);
    const report = await service.debrief(owner, interview.id);
    assert.equal(report.contentScores.evidence.score, 3);
    assert.equal(report.factGateUnavailable, true);
    assert.deepEqual((await repo.turns(owner, interview.id)).map((turn) => turn.text),
      ['Question', 'I planned the staffing change.']);
    const tasksAfterFirst = seen.length;
    assert.equal((await service.debrief(owner, interview.id)).factGateUnavailable, true);
    assert.equal(seen.length, tasksAfterFirst, 'retry uses the saved score instead of charging blindly');
  } finally { await db.close(); }
});

test('missing numbers receive a gentle concrete follow-up without a harder model question', async () => {
  const { db, repo, owner, workspace } = await fixture();
  try {
    const service = new CoachService(repo, { async generate() { throw new Error('No model call expected'); } });
    for (const answer of ["Honestly I'm not sure. I don't have a number.", "I don't remember the baseline.", 'No exact numbers, but I changed the shift handoff.']) {
      const interview = await repo.createInterview(owner, workspace.id, ['Opening', 'Second', 'Third']);
      await repo.addTurn(owner, interview.id, 'interviewer', 'How did you measure that change?');
      const result = await service.turn(owner, interview.id, answer);
      assert.match(result.question, /Walk me through what you changed/);
      assert.deepEqual((await repo.turns(owner, interview.id)).map((turn) => turn.speaker), ['interviewer', 'candidate', 'interviewer']);
    }
  } finally { await db.close(); }
});

test('a second job can reuse the résumé already on file', async () => {
  const { CoachService } = await import('../src/service.js');
  const seen = [];
  const repo = { latestResume: async () => 'Ran twelve spas for six years.' };
  const service = new CoachService(repo, {});
  service.proposeExtraction = async (kind, text) => { seen.push([kind, text]); throw new Error('stop');};
  await assert.rejects(service.paste('u', { resume: '', jd: 'Regional Director posting text', jobLabel: 'Job two' }), /stop/);
  assert.deepEqual(seen.find(([k]) => k === 'resume'), ['resume', 'Ran twelve spas for six years.']);
});
