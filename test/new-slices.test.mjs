import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';
import { CoachService, SKIP_ANSWER } from '../src/service.js';
import { GuestRepository } from '../src/guest.js';
import { GeminiAdapter } from '../src/model.js';

const migrations = ['001_core.sql', '002_jobs.sql', '003_ingestion.sql', '004_workspaces.sql',
  '005_rewrites.sql', '006_interviewer.sql', '007_story_dig.sql', '008_drills.sql', '009_real_interviews.sql', '010_fact_gate.sql', '011_immerser.sql', '012_voice.sql', '013_guest_voice.sql', '015_debrief_input_hash.sql', '016_job_comparison.sql', '020_security_audit.sql', '021_security_hardening_3.sql', '022_fact_conflict_reviews.sql', '023_resource_guard.sql'];

async function database() {
  const db = new PGlite();
  for (const file of migrations) await db.exec(await readFile(new URL(`../netlify/database/migrations/${file}`, import.meta.url), 'utf8'));
  return { db, repo: new Repository(pgliteSql(db)) };
}

class PracticeModel {
  constructor(quote) { this.quote = quote; this.tasks = []; this.bad = false; }
  async generate(task, prompt, validate) {
    this.tasks.push({ task, prompt });
    if (this.bad && task === 'story_dig_reflection') throw Object.assign(new Error('Malformed output'), { code: 'invalid_model_output' });
    const id = [...prompt.matchAll(/"id":"([^"]+)"/g)][0]?.[1];
    let data;
    if (task === 'debrief') {
      const score = (reason) => ({ score: 3, reason });
      data = { contentScores: Object.fromEntries(['relevance', 'ownership', 'evidence', 'outcome', 'structure']
        .map((key) => [key, score(`Observed ${key} in the transcript.`)])),
      deliveryScores: { clarity: score('Clear wording.'), concision: score('Some extra detail.') },
      feedback: 'Give the baseline if you know it.', unsupportedClaims: [],
      rewriteClaims: [{ factIds: [id] }], strongerNeeds: ['baseline'] };
    } else if (task === 'fact_gate') {
      data = { items: [
        { lane: 'under_claim', answerQuote: 'a few people', note: 'The record names a team size', factIds: [id] },
        { lane: 'gap', answerQuote: 'improved the process', note: 'A timeframe would help', factIds: [] },
        { lane: 'over_claim', answerQuote: '80 people', note: 'Check the scope', factIds: [id] },
        { lane: 'over_claim', answerQuote: '80 people', note: 'Invented citation', factIds: ['other-user-id'] },
      ] };
    } else if (task === 'questions') {
      data = { questions: ['Tell me about the team.', 'How did you decide?', 'What changed?'] };
    } else if (task === 'followup') data = { question: 'What was your part compared with the team?' };
    else if (task === 'coach_between_answers') data = { coaching: 'Name your own decision, then stop.' };
    else if (task === 'story_dig_reflection') data = { reflection: `You were there when ${this.quote}. Did I get that right?` };
    else if (task === 'grade_beats') {
      data = { hitIds: this.miss ? [] : [id], missedIds: [], note: 'Keep the decision beat.' };
    } else if (task === 'drill_story_title') data = { title: this.quote };
    else if (task === 'real_interview_capture') {
      data = { questions: ['What changed?'], storyFactIds: [id, 'other-user-id'],
        stumped: ['What changed?'], matchedQuestionIndices: [0, 0] };
    } else if (task === 'requirements') {
      const jd = prompt.split('JD:\n')[1].split('\nConfirmed candidate facts:')[0];
      data = { requirements: [{ quote: jd, type: 'must', competency: 'team leadership',
        evidenceNeeded: 'A confirmed example', category: 'none', rationale: 'No mapped story yet', factIds: [] }] };
    } else if (task.startsWith('extract_')) {
      const source = prompt.split('Source:\n')[1];
      data = { facts: [{ subject: 'candidate', predicate: 'handled', value: { text: source }, quote: source }] };
    }
    assert.ok(validate(data), `${task} fake output must meet the requested schema`);
    return { data, modelId: 'offline-varied-fake' };
  }
}

async function setup(repo, name, quote) {
  const owner = (await repo.createUser(name, 'fake-hash')).id;
  const jd = await repo.addSource(owner, 'jd', 'Fictional role', 'Must lead a team.');
  const workspace = await repo.addWorkspace(owner, jd.id, `${name} role`);
  const source = await repo.addSource(owner, 'resume', 'Fictional resume', quote);
  const factId = await repo.addFact(owner, { workspaceId: workspace.id, sourceId: source.id,
    subject: 'candidate', predicate: 'led', value: { text: quote }, displayText: quote,
    quote, start: 0, end: quote.length, status: 'document', reviewState: 'pending', proposedBy: 'model' });
  await repo.review(owner, factId, 'confirm');
  return { owner, workspaceId: workspace.id, factId };
}

test('rewrite blanks, three fact lanes, depth, coach, and optional dig are owner scoped', async () => {
  const { db, repo } = await database();
  try {
    for (const [name, quote] of [['alder', 'Led 8 colleagues at Alder Inn'],
      ['mesa', 'Coached 14 agents at Mesa Center']]) {
      const account = await setup(repo, name, quote);
      const model = new PracticeModel(quote);
      const service = new CoachService(repo, model);
      const interview = await repo.createInterview(account.owner, account.workspaceId,
        ['What did you do?', 'What changed?', 'How measured?'], 'hiring_manager', 3, 'coach');
      await repo.addTurn(account.owner, interview.id, 'interviewer', 'What did you do?');
      await repo.addTurn(account.owner, interview.id, 'candidate', 'I led a few people and improved the process, perhaps 80 people.');
      await repo.endInterview(account.owner, interview.id);
      const report = await service.debrief(account.owner, interview.id);
      assert.equal(report.factGate.length, 3);
      const range = await service.decideFactGate(account.owner, interview.id, 1, 'use_range', 'About 5–7 weeks');
      assert.ok(range.proposalId);
      assert.equal((await repo.fact(account.owner, range.proposalId)).review_state, 'pending');
      assert.equal((await service.decideFactGate(account.owner, interview.id, 1, 'use_range', 'Different range')).proposalId,
        range.proposalId);
      const dropped = await service.decideFactGate(account.owner, interview.id, 2, 'drop');
      assert.equal(dropped.decision.choice, 'drop');
      assert.equal(report.stronger.ready, false);
      assert.match(report.stronger.text, /\[NEEDS: baseline\]/);
      const slot = report.stronger.slots[0];
      const other = await repo.createUser(`${name}_other`, 'fake-hash');
      await assert.rejects(service.resolveStrongerSlot(other.id, slot.id, 'waive', null, 'No baseline'), /not found/i);
      const filled = await service.resolveStrongerSlot(account.owner, slot.id, 'fill', 'Usually 8 people');
      assert.equal(filled.ready, false);
      const proposal = await repo.fact(account.owner, filled.slots[0].proposal_fact_id);
      assert.equal(proposal.review_state, 'pending');
      await repo.review(account.owner, proposal.id, 'confirm');
      assert.equal((await service.strongerDraft(account.owner, interview.id)).ready, true);
      const refreshed = await service.debrief(account.owner, interview.id);
      const waived = await service.resolveStrongerSlot(account.owner, refreshed.stronger.slots[0].id,
        'waive', null, 'The baseline was not tracked.');
      assert.equal(waived.ready, true);
      assert.equal(waived.slots[0].reason, 'The baseline was not tracked.');
      const another = await service.start(account.owner, account.workspaceId, 'panel', 4, 'coach');
      assert.equal(another.interview.difficulty, 4);
      assert.match(model.tasks.findLast((call) => call.task === 'questions').prompt, /what failed first/);
      assert.ok(!model.tasks.some((call) => call.task === 'coach_between_answers'));
      const coached = await service.turn(account.owner, another.interview.id, 'I made the staffing decision.');
      assert.match(coached.coaching, /Name your own decision/);
      const mock = await service.start(account.owner, account.workspaceId, 'hiring_manager', 2, 'mock');
      const plain = await service.turn(account.owner, mock.interview.id, 'I made the staffing decision.');
      assert.equal(plain.coaching, null);
      const dig = await service.startDig(account.owner, account.workspaceId);
      model.bad = true;
      await assert.rejects(service.reflectDig(account.owner, dig.dig.id, quote), /Malformed/);
      model.bad = false;
      const reflected = await service.reflectDig(account.owner, dig.dig.id, quote);
      assert.match(reflected.reflection, /Did I get that right\?/);
      const confirmed = await service.confirmDig(account.owner, dig.dig.id, quote);
      assert.ok(confirmed.proposals.length);
      assert.equal((await repo.fact(account.owner, confirmed.proposals[0])).review_state, 'pending');
      await repo.supersede(account.owner, account.factId, null, 'Replaced by a correction');
      assert.equal((await service.strongerDraft(account.owner, interview.id)).ready, false);
      const uncoveredJd = await repo.addSource(account.owner, 'jd', 'Uncovered role', 'Must lead a team.');
      const uncovered = await repo.addWorkspace(account.owner, uncoveredJd.id, 'Uncovered role');
      await repo.replaceRequirements(account.owner, uncovered.id, uncoveredJd.id, [{
        quote: 'Must lead a team', type: 'must', competency: 'team leadership', evidenceNeeded: 'A story',
        category: 'none', rationale: 'No accepted story', factIds: [], start: 0, end: 16,
      }]);
      const noStory = await service.start(account.owner, uncovered.id);
      assert.match(noStory.question, /I don't have a story from your résumé for team leadership yet, and that's okay/);
      const approach = await service.turn(account.owner, noStory.interview.id, 'I would ask the team what happened.');
      assert.match(approach.question, /No need to invent an example/);
      // Skipping a planned question asks another one now and brings the skipped one back.
      const skipRun = await service.start(account.owner, account.workspaceId, 'hiring_manager', 2, 'mock');
      const plan = skipRun.interview.plan_json;
      assert.ok(plan.length >= 2);
      const skipped = await service.turn(account.owner, skipRun.interview.id, SKIP_ANSWER);
      assert.equal(skipped.question, plan[1]);
      assert.equal(skipped.done, false);
      const comeBack = await service.turn(account.owner, skipRun.interview.id, 'I ran the schedule myself.');
      assert.equal(comeBack.question, plan[0]);
    }
  } finally { await db.close(); }
});

test('beat scheduling and real interview feed use confirmed facts and actual questions', async () => {
  const { db, repo } = await database();
  try {
    const { owner, workspaceId, factId } = await setup(repo, 'fable', 'Led 8 colleagues at Fable Inn');
    const model = new PracticeModel('Led 8 colleagues at Fable Inn');
    const service = new CoachService(repo, model);
    const cards = await service.buildDrills(owner, workspaceId);
    assert.equal(cards.cards.length, 4);
    const intro = cards.cards.filter((card) => card.kind === 'intro').map((card) => card.targetSeconds);
    assert.deepEqual(intro, [45, 90, 150]);
    assert.equal(cards.cards.find((card) => card.targetSeconds === 90).prompt,
      'Tell me about yourself. About 90 seconds.');
    model.miss = true;
    const forgotten = await service.reviewDrill(owner, cards.cards[0].id, 'I lost the detail.');
    assert.equal(forgotten.rating, 'again');
    assert.equal((await service.drills(owner, workspaceId, forgotten.due + 1)).cards[0].id, cards.cards[0].id);
    model.miss = false;
    const reviewed = await service.reviewDrill(owner, cards.cards[0].id, 'I led eight colleagues.', forgotten.due + 1);
    assert.equal(reviewed.rating, 'good');
    assert.ok(reviewed.due > Date.now());
    await service.setInterviewDate(owner, workspaceId, new Date(Date.now() + 24 * 3600000).toISOString());
    assert.equal((await service.drills(owner, workspaceId)).cram, true);
    const interview = await repo.createInterview(owner, workspaceId, ['What changed?', 'How did you lead?', 'What failed?']);
    assert.ok(interview.id);
    const saved = await service.captureRealInterview(owner, workspaceId, 'notes',
      'They asked: What changed? I used the Fable story. What changed? stumped me.');
    assert.equal(saved.feed.prediction.matched, 1);
    assert.equal(saved.feed.prediction.asked, 1);
    assert.deepEqual(saved.feed.usedStoryFactIds, [factId]);
    assert.ok(saved.feed.drillPriorities.includes('What changed?'));
    assert.ok((await service.drills(owner, workspaceId)).cards.some((card) =>
      card.prompt.includes('Recover from the real question: What changed?')));
    const other = await repo.createUser('fable_other', 'fake-hash');
    await assert.rejects(service.realInterviewFeed(other.id, workspaceId), /not found/i);
    await repo.supersede(owner, factId, null, 'corrected');
    assert.equal((await service.drills(owner, workspaceId)).cards.length, 0);
  } finally { await db.close(); }
});

test('guest dig and drill data remain in browser-provided state only', async () => {
  const { db, repo } = await database();
  try {
    const guest = new GuestRepository();
    const source = await guest.addSource('guest', 'jd', 'Role', 'Lead operations.');
    const workspace = await guest.addWorkspace('guest', source.id, 'Role');
    const service = new CoachService(guest, new PracticeModel('Led the shift'));
    const dig = await service.startDig('guest', workspace.id);
    await service.reflectDig('guest', dig.dig.id, 'Led the shift');
    const confirmed = await service.confirmDig('guest', dig.dig.id, 'Led the shift');
    await guest.review('guest', confirmed.proposals[0], 'confirm');
    await service.captureRealInterview('guest', workspace.id, 'notes', 'What changed?');
    assert.equal((await repo.sql('SELECT count(*)::int AS count FROM story_digs'))[0].count, 0);
    assert.equal((await repo.sql('SELECT count(*)::int AS count FROM sources'))[0].count, 0);
    assert.equal((await repo.sql('SELECT count(*)::int AS count FROM real_interviews'))[0].count, 0);
    assert.equal((await repo.sql('SELECT count(*)::int AS count FROM drill_cards'))[0].count, 0);
    assert.equal(new GuestRepository().state.storyDigs.length, 0);
  } finally { await db.close(); }
});

test('voice transcription goes through the costed adapter with bounded offline audio', async () => {
  const calls = [];
  const cost = { reserve: async () => 'reserved', settle: async () => {} };
  const adapter = new GeminiAdapter({ repo: cost, env: { GEMINI_API_KEY: 'fictional-test-key' },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { text: JSON.stringify({ text: 'What changed during the shift?' }) },
      ] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 12 } }));
    } });
  const text = await adapter.transcribe(Buffer.from('fictional-audio').toString('base64'), 'audio/webm');
  assert.equal(text, 'What changed during the shift?');
  assert.equal(calls[0].contents[0].parts[1].inlineData.mimeType, 'audio/webm');
  await assert.rejects(adapter.transcribe('audio', 'text/plain'), /Unsupported/);
  const malformed = new GeminiAdapter({ repo: cost, env: { GEMINI_API_KEY: 'fictional-test-key' },
    fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] })) });
  await assert.rejects(malformed.transcribe(Buffer.from('fictional-audio').toString('base64'), 'audio/webm'),
    /Invalid transcribe_voice/);
});

test('screenshots of a posting are read through the costed adapter, images only', async () => {
  const calls = [];
  const cost = { reserve: async () => 'reserved', settle: async () => {} };
  const adapter = new GeminiAdapter({ repo: cost, env: { GEMINI_API_KEY: 'fictional-test-key' },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { text: JSON.stringify({ text: ' Regional Director of Operations\n- Lead 12 sites ' }) },
      ] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 } }));
    } });
  const text = await adapter.readImage(Buffer.from('fictional-image').toString('base64'), 'image/jpeg');
  assert.equal(text, 'Regional Director of Operations\n- Lead 12 sites');
  assert.equal(calls[0].contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
  await assert.rejects(adapter.readImage('x', 'application/pdf'), /Unsupported/);
});
