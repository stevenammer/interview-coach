import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { GuestRepository } from '../src/guest.js';
import { pgliteSql } from '../src/db.js';
import { CoachService, practiceFocus } from '../src/service.js';

async function database() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

async function workspace(repo, owner, label = 'Operations role') {
  const jd = await repo.addSource(owner, 'jd', 'Posting', 'Lead service recovery and coach a team.');
  return repo.addWorkspace(owner, jd.id, label);
}

const QUESTIONS = ['Walk me through leading your team?', 'How did you handle a service failure?', 'What would you change?'];

// Records every prompt. Debrief scores put evidence lowest so the drill focus is predictable.
function fakeModel(debriefFeedback = 'You explained the staffing change clearly. Next time: name the number.') {
  const calls = [];
  return {
    calls,
    async generate(task, prompt, schema) {
      calls.push({ task, prompt });
      let data;
      if (task === 'questions') data = { questions: QUESTIONS };
      else if (task === 'followup') data = { question: 'What part did you personally own?' };
      else if (task === 'coach_between_answers') data = { coaching: 'Name the team size first.' };
      else if (task === 'fact_gate') data = { items: [] };
      else if (task === 'debrief') {
        const score = (value) => ({ score: value, reason: 'The answer had a clear point.' });
        data = { contentScores: { relevance: score(4), ownership: score(4), evidence: score(2), outcome: score(3), structure: score(3) },
          deliveryScores: { clarity: score(4), concision: score(4) }, feedback: debriefFeedback,
          unsupportedClaims: [], rewriteClaims: [], strongerNeeds: [] };
      } else throw new Error(`Unexpected task ${task}`);
      assert.ok(schema(data), `${task} output must satisfy its schema`);
      return { data, modelId: 'offline-fake' };
    },
    promptsFor(task) { return calls.filter((call) => call.task === task).map((call) => call.prompt); },
  };
}

async function finishedInterview(service, repo, owner, workspaceId, options = {}) {
  const started = await service.start(owner, workspaceId, options.persona ?? 'recruiter', options.difficulty ?? 3,
    options.practiceMode ?? 'mock');
  await repo.addTurn(owner, started.interview.id, 'candidate', 'I led the staffing change and cut waits.');
  await repo.endInterview(owner, started.interview.id);
  await service.debrief(owner, started.interview.id);
  return started.interview.id;
}

test('drill this call copies the same plan, persona, depth and mode with no model call, and carries the focus into follow-ups', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('drill_owner', 'hash')).id;
    const job = await workspace(repo, owner);
    const model = fakeModel();
    const service = new CoachService(repo, model);
    const originalId = await finishedInterview(service, repo, owner, job.id, { persona: 'senior_exec', difficulty: 4, practiceMode: 'coach' });
    const callsBefore = model.calls.length;
    const drilled = await service.drillCall(owner, originalId);
    assert.equal(model.calls.length, callsBefore, 'drilling must not call the model');
    assert.notEqual(drilled.interview.id, originalId);
    assert.equal(drilled.interview.persona, 'senior_exec');
    assert.equal(drilled.interview.difficulty, 4);
    assert.equal(drilled.interview.practice_mode, 'coach');
    assert.equal(drilled.interview.status, 'active');
    assert.deepEqual(drilled.interview.plan_json, QUESTIONS);
    assert.equal(drilled.question, QUESTIONS[0]);
    assert.equal(drilled.focus, 'backing it up (scored 2 of 5). Next time: name the number');
    const stored = await repo.interview(owner, drilled.interview.id);
    assert.equal(stored.focus, drilled.focus);
    assert.equal((await repo.turns(owner, drilled.interview.id))[0].text, QUESTIONS[0]);
    await service.turn(owner, drilled.interview.id, 'I owned the schedule change myself.');
    const followUp = model.promptsFor('followup').at(-1);
    assert.match(followUp, /Practice focus for this round: backing it up \(scored 2 of 5\)\. Next time: name the number\. Probe it, but never invent facts\./);
  } finally { await db.close(); }
});

test('a new practice call without a drill has no focus in its follow-up prompt', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('plain_owner', 'hash')).id;
    const job = await workspace(repo, owner);
    const model = fakeModel();
    const service = new CoachService(repo, model);
    const started = await service.start(owner, job.id);
    await service.turn(owner, started.interview.id, 'I led the change.');
    assert.doesNotMatch(model.promptsFor('followup').at(-1), /Practice focus for this round/);
  } finally { await db.close(); }
});

test('drilling another user\'s interview is refused as not found', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('drill_owned', 'hash')).id;
    const other = (await repo.createUser('drill_intruder', 'hash')).id;
    const job = await workspace(repo, owner);
    const service = new CoachService(repo, fakeModel());
    const interviewId = await finishedInterview(service, repo, owner, job.id);
    await assert.rejects(service.drillCall(other, interviewId), (error) => error.status === 404);
  } finally { await db.close(); }
});

test('drilling an interview that has no finished debrief is refused', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('drill_unfinished', 'hash')).id;
    const job = await workspace(repo, owner);
    const service = new CoachService(repo, fakeModel());
    const started = await service.start(owner, job.id);
    await assert.rejects(service.drillCall(owner, started.interview.id), /Finish the interview first/);
    await repo.endInterview(owner, started.interview.id);
    await assert.rejects(service.drillCall(owner, started.interview.id), /Finish the coach review first/);
  } finally { await db.close(); }
});

test('the next debrief repeats the previous Next time step and asks whether it was done; the first debrief does not', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('lesson_owner', 'hash')).id;
    const job = await workspace(repo, owner);
    const model = fakeModel();
    const service = new CoachService(repo, model);
    await finishedInterview(service, repo, owner, job.id);
    assert.doesNotMatch(model.promptsFor('debrief')[0], /Last time you were asked to/);
    assert.doesNotMatch(model.promptsFor('debrief')[0], /Last time the coach asked/);
    await finishedInterview(service, repo, owner, job.id);
    const second = model.promptsFor('debrief')[1];
    assert.match(second, /Last time the coach asked for this step: "name the number\."/);
    assert.match(second, /Last time you were asked to name the number\. This time you did\."/);
    assert.match(second, /This time you didn't\."/);
  } finally { await db.close(); }
});

test('the last-lesson step never crosses into another workspace', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('lesson_scope', 'hash')).id;
    const first = await workspace(repo, owner, 'First role');
    const second = await workspace(repo, owner, 'Second role');
    const model = fakeModel();
    const service = new CoachService(repo, model);
    await finishedInterview(service, repo, owner, first.id);
    await finishedInterview(service, repo, owner, second.id);
    assert.doesNotMatch(model.promptsFor('debrief')[1], /Last time the coach asked/);
  } finally { await db.close(); }
});

test('coach mode adds the help-credit line to the debrief prompt, and mock mode does not', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('help_credit', 'hash')).id;
    const job = await workspace(repo, owner);
    const model = fakeModel();
    const service = new CoachService(repo, model);
    await finishedInterview(service, repo, owner, job.id, { practiceMode: 'mock' });
    assert.doesNotMatch(model.promptsFor('debrief')[0], /chose coach mode/);
    await finishedInterview(service, repo, owner, job.id, { practiceMode: 'coach' });
    const coached = model.promptsFor('debrief')[1];
    assert.match(coached, /The candidate chose coach mode/);
    assert.match(coached, /Never penalize using help\./);
  } finally { await db.close(); }
});

test('practiceFocus picks the weakest content dimension and its Next time step', () => {
  assert.equal(practiceFocus({ contentScores: { relevance: { score: 5 }, evidence: { score: 1 }, outcome: { score: 3 } },
    feedback: 'You were clear. Next time: add the baseline.' }), 'backing it up (scored 1 of 5). Next time: add the baseline');
  assert.equal(practiceFocus({ contentScores: { relevance: { score: 2 } }, feedback: 'No step here.' }),
    'staying on the question (scored 2 of 5)');
});

test('guest drill and previous-step lookup work on the in-session repository', async () => {
  const guest = new GuestRepository();
  const owner = 'guest';
  const jd = await guest.addSource(owner, 'jd', 'Posting', 'Lead service recovery and coach a team.');
  const workspaceRow = await guest.addWorkspace(owner, jd.id, 'Operations role');
  const model = fakeModel();
  const service = new CoachService(guest, model);
  const firstId = await finishedInterview(service, guest, owner, workspaceRow.id);
  assert.equal(await guest.previousDebrief(owner, workspaceRow.id, firstId), null);
  const secondId = await finishedInterview(service, guest, owner, workspaceRow.id);
  assert.match(model.promptsFor('debrief')[1], /Last time you were asked to name the number/);
  const drilled = await service.drillCall(owner, secondId);
  assert.equal(drilled.interview.focus, 'backing it up (scored 2 of 5). Next time: name the number');
  assert.deepEqual(drilled.interview.plan_json, QUESTIONS);
});
