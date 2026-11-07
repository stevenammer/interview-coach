import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import mammoth from 'mammoth';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';
import { CoachService, PREP_SECTIONS, validatePrepSection } from '../src/service.js';
import { runModelJob } from '../src/jobs.js';
import { createDocx } from '../public/document-export.js';
import { prepPackText } from '../public/prep-pack.js';
import { chooseNextStep } from '../public/next-step.js';

async function database() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

async function setup(repo, name = 'prep_owner') {
  const owner = (await repo.createUser(name, 'hash')).id;
  const posting = 'Must lead regional teams. Salary range $90,000 to $110,000. Two interview stages.';
  const jd = await repo.addSource(owner, 'jd', 'Regional role', posting);
  const workspace = await repo.addWorkspace(owner, jd.id, 'Regional role');
  const source = await repo.addSource(owner, 'resume', 'Resume',
    'Led 12 managers and improved service scores by 18%. Does not claim full P&L ownership.');
  const add = async (quote, predicate) => {
    const start = source.text.indexOf(quote);
    const factId = await repo.addFact(owner, { workspaceId: workspace.id, sourceId: source.id,
      subject: 'candidate', predicate, value: { text: quote }, displayText: quote, quote,
      start, end: start + quote.length, status: 'document', reviewState: 'pending', proposedBy: 'model' });
    await repo.review(owner, factId, 'confirm');
    return factId;
  };
  return { owner, workspace, posting, evidenceId: await add('Led 12 managers and improved service scores by 18%.', 'measured_result'),
    boundaryId: await add('Does not claim full P&L ownership.', 'financial ownership scope') };
}

class PrepModel {
  constructor(evidenceId, fail = null) { this.evidenceId = evidenceId; this.fail = fail; this.calls = []; }
  async generate(task, prompt, schema) {
    this.calls.push({ task, prompt });
    if (task === `prep_${this.fail}`) throw Object.assign(new Error('offline failure'), { code: 'model_unavailable' });
    const data = { lines: [{ text: 'You led 12 managers and improved service scores by 18%.',
      factIds: [this.evidenceId], source: 'candidate', bridge: false }], nextStep: 'Practice this line out loud.' };
    assert.ok(schema(data));
    return { data, modelId: 'offline-prep' };
  }
}

test('Prep Pack validation rejects unsafe citations and numbers and honors a confirmed boundary', () => {
  const mine = { id: 'mine', domain: 'candidate', review_state: 'accepted', lifecycle: 'active',
    display_text: 'Led 12 managers.', verbatim_quote: 'Led 12 managers.', predicate: 'led' };
  const pending = { ...mine, id: 'pending', review_state: 'pending' };
  const boundary = { ...mine, id: 'boundary', display_text: 'Does not claim full P&L ownership.',
    verbatim_quote: 'Does not claim full P&L ownership.', predicate: 'financial ownership scope' };
  const result = validatePrepSection({ lines: [
    { text: 'Led 12 managers.', factIds: ['mine'], source: 'candidate' },
    { text: 'Led 30 managers.', factIds: ['mine'], source: 'candidate' },
    { text: 'Owned the full P&L.', factIds: ['boundary'], source: 'candidate' },
    { text: 'Pending claim.', factIds: ['pending'], source: 'candidate' },
    { text: 'Another owner.', factIds: ['other-owner-id'], source: 'candidate' },
  ], nextStep: 'Practice.' }, [mine, pending, boundary], 'Must lead teams.', 'tmay');
  assert.deepEqual(result.lines.map((line) => line.text), ['Led 12 managers.']);
  assert.deepEqual(result.validationErrors.map((error) => error.reason),
    ['unsupported_number', 'boundary_conflict', 'unknown_or_unconfirmed_fact', 'unknown_or_unconfirmed_fact']);
});

test('Prep Pack builds progressively, isolates a failed section, marks changed inputs stale, and stays owner scoped', async () => {
  const { db, repo } = await database();
  try {
    const account = await setup(repo);
    const model = new PrepModel(account.evidenceId, 'hard_ones');
    const service = new CoachService(repo, model);
    const initial = await service.prepPack(account.owner, account.workspace.id);
    assert.equal(initial.sections.filter((section) => section.status === 'ready').length, 5);
    assert.equal(initial.jobs.length, 6);
    for (const job of initial.jobs) await runModelJob(repo, model, account.owner, job.id);
    const built = await service.prepPack(account.owner, account.workspace.id);
    assert.equal(built.sections.filter((section) => section.status === 'ready').length, 10);
    assert.equal(built.sections.find((section) => section.section_key === 'hard_ones').status, 'failed');
    assert.ok(built.sections.find((section) => section.section_key === 'likely_questions').content_json.lines.length);
    const other = await repo.createUser('prep_other', 'hash');
    assert.equal(await repo.prepPack(other.id, account.workspace.id), null);
    await repo.supersede(account.owner, account.evidenceId, null, 'corrected');
    const stale = await service.prepPack(account.owner, account.workspace.id);
    assert.equal(stale.sections.find((section) => section.section_key === 'tmay').status, 'stale');
    const refreshed = await service.prepPack(account.owner, account.workspace.id, { refreshKey: 'tmay' });
    await runModelJob(repo, model, account.owner, refreshed.jobs[0].id);
    await repo.sql('UPDATE sources SET text=$3 WHERE user_id=$1 AND id=$2',
      [account.owner, account.workspace.jd_source_id, `${account.posting} Added travel requirement.`]);
    const postingStale = await service.prepPack(account.owner, account.workspace.id);
    assert.equal(postingStale.sections.find((section) => section.section_key === 'tmay').status, 'stale');
  } finally { await db.close(); }
});

test('Prep Pack DOCX includes every ready section title', async () => {
  const sections = PREP_SECTIONS.map((section) => ({ section_key: section.key, title: section.title, status: 'ready',
    content_json: { lines: [{ text: 'Safe line.' }], nextStep: 'Practice.' } }));
  const blob = await createDocx(prepPackText(sections), { title: 'Prep Pack' });
  const extracted = await mammoth.extractRawText({ buffer: Buffer.from(await blob.arrayBuffer()) });
  for (const section of PREP_SECTIONS) assert.match(extracted.value, new RegExp(section.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('next-step logic returns one action with a matching reason in state order', () => {
  const soon = new Date(Date.UTC(2026, 9, 13)).toISOString();
  const now = Date.UTC(2026, 9, 12);
  const cases = [
    [{ pendingFacts: 3 }, 'facts', /Review these details/],
    [{ pendingFacts: 0, hasPrepPack: false }, 'prep', /job posting and any details you have confirmed/],
    [{ guest: true, pendingFacts: 0, hasPrepPack: false, hasPractice: false }, 'practice', /short practice interview/],
    [{ guest: true, pendingFacts: 2, hasPrepPack: false, hasPractice: false }, 'facts', /Review these details/],
    [{ hasPrepPack: true, hasPractice: false }, 'practice', /confirmed stories/],
    [{ hasPrepPack: true, hasPractice: true, debriefWaiting: true }, 'debrief', /Feedback from your last practice/],
    [{ hasPrepPack: true, hasPractice: true, interviewDate: soon }, 'cram', /within 48 hours/],
    [{ hasPrepPack: true, hasPractice: true }, 'practice', /another practice/],
  ];
  for (const [state, key, reason] of cases) {
    const next = chooseNextStep(state, now);
    assert.equal(next.key, key);
    assert.match(next.reason, reason);
    assert.ok(next.reason.length > 0);
  }
  const guestWithHistory = chooseNextStep({ guest: true, pendingFacts: 0, hasPrepPack: true,
    hasPractice: true, interviewDate: soon }, now);
  assert.equal(guestWithHistory.key, 'practice');
  assert.match(guestWithHistory.reason, /short practice interview/);
});

const mineFact = { id: 'mine', domain: 'candidate', review_state: 'accepted', lifecycle: 'active',
  display_text: 'Led 12 managers.', verbatim_quote: 'Led 12 managers.', predicate: 'led' };
const boundaryFact = { ...mineFact, id: 'boundary', display_text: 'Does not claim full P&L ownership.',
  verbatim_quote: 'Does not claim full P&L ownership.', predicate: 'financial ownership scope' };

test('validation repairs clear intent instead of dropping good lines', () => {
  const result = validatePrepSection({ lines: [
    { text: 'What would your first month look like?', factIds: ['mine'], source: 'guidance' },
    { text: 'Tell me about leading managers. Answer with: Led 12 managers.', factIds: ['mine'], source: 'candidate', missingStory: true },
    { text: 'Tell me about a P&L review.', factIds: [], source: 'guidance' },
    { text: 'You led managers, which is related to leading GMs.', factIds: ['mine'], source: 'candidate' },
  ], nextStep: 'Practice one.' }, [mineFact, boundaryFact], 'Posting text.', 'hard_ones');
  assert.equal(result.validationErrors.length, 0);
  assert.deepEqual(result.lines[0].factIds, []);
  assert.match(result.lines[3].text, /Adjacent, not direct/);
  const q = validatePrepSection({ lines: [
    { text: 'Tell me about leading managers.', factIds: ['mine'], source: 'candidate', missingStory: true },
    { text: 'Tell me about a P&L review.', factIds: [], source: 'guidance' }], nextStep: 'Practice.' },
  [mineFact, boundaryFact], 'Posting.', 'likely_questions');
  assert.equal(q.lines[0].missingStory, false);
  assert.equal(q.lines[1].missingStory, true);
});

test('boundary check rejects an asserted denial but not a line that merely shares words', () => {
  const run = (text) => validatePrepSection({ lines: [{ text, factIds: ['mine'], source: 'candidate' }], nextStep: 'x' },
    [mineFact, boundaryFact], 'Posting.', 'story_map');
  assert.equal(run('You owned the P&L for the whole spa.').validationErrors[0]?.reason, 'boundary_conflict');
  assert.equal(run('You led 12 managers and kept the full team ownership of daily coverage.').validationErrors.length, 0);
});

test('Prep Pack deterministic sections stay honest: no job-vs-job conflicts, grouped pending, real numbers only, short company facts', async () => {
  const { db, repo } = await database();
  try {
    const { owner, workspace } = await setup(repo, 'prep_honest');
    const source = await repo.addSource(owner, 'resume', 'More', 'Director | The Spa Oct 2016 – Jan 2023. Orlando, FL. Manager | Diner Jan 2015 – Apr 2016. Raised rating 4.1 to 4.6.');
    const add = async (quote, predicate, state = 'pending') => {
      const start = source.text.indexOf(quote);
      const factId = await repo.addFact(owner, { workspaceId: workspace.id, sourceId: source.id, subject: 'candidate',
        predicate, value: { text: quote }, displayText: quote, quote, start, end: start + quote.length,
        status: 'document', reviewState: 'pending', proposedBy: 'model' });
      if (state === 'accepted') await repo.review(owner, factId, 'confirm');
    };
    await add('Director | The Spa Oct 2016 – Jan 2023', 'workHistory', 'accepted');
    await add('Manager | Diner Jan 2015 – Apr 2016', 'workHistory', 'accepted');
    await add('Raised rating 4.1 to 4.6', 'quality improvement', 'accepted');
    await add('Orlando, FL', 'location');
    const service = new CoachService(repo, new PrepModel('x'));
    const pack = await service.prepPack(owner, workspace.id);
    const by = Object.fromEntries(pack.sections.map((section) => [section.section_key, section.content_json]));
    assert.ok(!by.fix.lines.some((line) => /compared with|conflict/i.test(line.text)), 'jobs are not conflicts with each other');
    assert.ok(!by.fix.lines.some((line) => /Orlando/.test(line.text)), 'contact details are never listed');
    assert.ok(by.numbers.lines.some((line) => /4\.1 to 4\.6/.test(line.text)));
    assert.ok(!by.numbers.lines.some((line) => /Oct 2016|Jan 2015/.test(line.text)), 'dates are not numbers to know');
    assert.ok(by.company_facts.lines.length <= 8 && !by.company_facts.lines.some((line) => line.text.length > 400));
  } finally { await db.close(); }
});

test('the hub opens on the job with the nearest upcoming interview, not the oldest job', async () => {
  const { pickDefaultWorkspace } = await import('../public/default-workspace.js');
  const now = Date.parse('2026-10-12T20:00:00Z');
  const past = { id: 'job-a', interview_date: '2026-10-05T00:00:00Z', updated_at: '2026-10-04T00:00:00Z' };
  const soon = { id: 'job-b', interview_date: '2026-10-21T21:00:00Z', updated_at: '2026-09-29T00:00:00Z' };
  const later = { id: 'later', interview_date: '2026-11-30T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' };
  assert.equal(pickDefaultWorkspace([past, later, soon], now).id, 'job-b');
  assert.equal(pickDefaultWorkspace([past, { id: 'undated', interview_date: null, updated_at: '2026-10-10T00:00:00Z' }], now).id, 'undated');
  assert.equal(pickDefaultWorkspace([past], now).id, 'job-a');
});

test('a requirement about passion for wellness is not shown as benefits', async () => {
  const { postingDetails } = await import('../public/posting-details.js');
  const text = 'Passion for health, wellness, and the brand.\nBenefits include medical, dental, and a 401(k) match.';
  assert.deepEqual(postingDetails(text, 'benefits'), ['Benefits include medical, dental, and a 401(k) match.']);
  assert.deepEqual(postingDetails('Passion for health, wellness, and the brand.', 'benefits'), []);
});
