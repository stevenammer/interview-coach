import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';
import { CoachService } from '../src/service.js';
import { runModelJob } from '../src/jobs.js';
import { extractDocument } from '../public/documents.js';
import { createHandler } from '../netlify/functions/api.mjs';
import { createBackgroundHandler } from '../netlify/functions/model-job-background.mjs';
import { issueSession } from '../src/auth.js';
import { gateRewrite } from '../src/truth.js';
import { ModelOutputError } from '../src/model.js';

async function database() {
  const db = new PGlite();
  for (const file of ['001_core.sql', '002_jobs.sql', '003_ingestion.sql', '004_workspaces.sql', '005_rewrites.sql', '006_interviewer.sql', '007_story_dig.sql', '008_drills.sql', '009_real_interviews.sql', '010_fact_gate.sql', '011_immerser.sql', '012_voice.sql', '013_guest_voice.sql', '015_debrief_input_hash.sql', '016_job_comparison.sql', '020_security_audit.sql', '021_security_hardening_3.sql', '022_fact_conflict_reviews.sql']) {
    await db.exec(await readFile(new URL(`../netlify/database/migrations/${file}`, import.meta.url), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

const examples = [
  { name: 'harbor', resume: 'At Harbor Lodge, managed staffing for 8 colleagues.',
    jd: 'Must manage staffing. Prefer P&L oversight. Responsible for vendor escalation.',
    job: 'Hospitality director', quote: 'managed staffing for 8 colleagues',
    requirements: ['Must manage staffing', 'Prefer P&L oversight', 'Responsible for vendor escalation'] },
  { name: 'copper', resume: 'At Copperline, built coaching programs for 14 colleagues.',
    jd: 'Must build coaching programs. Prefer AI analytics. Responsible for quality audits.',
    job: 'Enablement lead', quote: 'built coaching programs for 14 colleagues',
    requirements: ['Must build coaching programs', 'Prefer AI analytics', 'Responsible for quality audits'] },
];

class VariedModel {
  constructor() { this.calls = []; }

  async generate(task, prompt, schema) {
    this.calls.push({ task, prompt });
    const example = examples.find((item) => prompt.includes(item.resume) || prompt.includes(item.jd)) ?? examples[0];
    let data;
    if (task.startsWith('extract_')) {
      const source = prompt.split('Source:\n')[1];
      const quote = source.includes(example.quote) ? example.quote :
        example.requirements.find((part) => source.includes(part)) ?? source.slice(0, 20);
      data = { facts: [{ subject: 'candidate', predicate: 'performed',
        value: { text: quote }, quote, displayText: quote }] };
    } else if (task === 'requirements') {
      const factId = [...prompt.matchAll(/"id":"([^"]+)"/g)][0]?.[1] ?? 'missing';
      data = { requirements: example.requirements.map((quote, index) => ({
        quote, type: ['must', 'preferred', 'responsibility'][index],
        competency: index === 0 ? quote.split(' ').slice(2).join(' ') : quote,
        evidenceNeeded: `Evidence for ${quote}`, category: index === 0 ? 'direct' : index === 1 ? 'adjacent' : 'direct',
        rationale: `Model proposes ${quote}`, factIds: index < 2 ? [factId] : ['invented-id'],
      })) };
    } else if (task === 'questions') {
      const persona = ['recruiter', 'hiring_manager', 'panel', 'senior_exec']
        .find((item) => prompt.includes(`${item} interview`)) ?? 'hiring_manager';
      data = { questions: [1, 2, 3].map((index) => `${persona} question ${index} about ${example.job}?`) };
    } else if (task === 'followup') {
      data = { question: 'What was your baseline, your own decision, and how did you measure it?' };
    } else if (task === 'fact_gate') {
      data = { items: [] };
    } else if (task === 'debrief') {
      const factId = [...prompt.matchAll(/"id":"([^"]+)"/g)][0]?.[1];
      const score = (name) => ({ score: name === 'outcome' ? 2 : 4, reason: `Observed ${name} in this response.` });
      data = { contentScores: Object.fromEntries(['relevance', 'ownership', 'evidence', 'outcome', 'structure']
        .map((name) => [name, score(name)])),
      deliveryScores: { clarity: score('clarity'), concision: score('concision') },
      feedback: prompt.includes('Writing samples (style only') ?
        'You kept it clear and warm. Next time: add the baseline and measurement.' :
        'You explained the work plainly. Next time: give the baseline and a concrete measurement.', unsupportedClaims: [],
      rewriteClaims: factId ? [{ factIds: [factId] }] : [], };
    }
    assert.ok(schema(data), `${task} fake output must satisfy schema`);
    return { data, modelId: 'varied-fake' };
  }
}

test('background jobs, mapped workspaces, personas, ID-only rewrite, and account isolation', async () => {
  const { db, repo } = await database();
  try {
    const model = new VariedModel();
    const users = await Promise.all([repo.createUser('fictional_harbor', 'hash'), repo.createUser('fictional_copper', 'hash')]);
    const workspaces = [];
    for (let index = 0; index < examples.length; index += 1) {
      const item = examples[index];
      const owner = users[index].id;
      const job = await repo.createJob(owner, 'paste', { resume: item.resume, jd: item.jd, jobLabel: item.job });
      assert.equal((await repo.job(users[1 - index].id, job.id)), null);
      assert.equal(await runModelJob(repo, model, users[1 - index].id, job.id), false);
      assert.equal(await runModelJob(repo, model, owner, job.id), true);
      const completed = await repo.job(owner, job.id);
      assert.equal(completed.status, 'done');
      assert.deepEqual((await repo.sql('SELECT input_json FROM model_jobs WHERE id=$1', [job.id]))[0].input_json, {});
      workspaces.push(completed.result_json.workspace.id);
      const service = new CoachService(repo, model);
      const fact = completed.result_json.facts.find((candidate) => candidate.domain === 'candidate');
      await service.review(owner, { workspaceId: workspaces[index], factId: fact.id, action: 'confirm' });
      const mapJob = await repo.createJob(owner, 'workspace_map', { workspaceId: workspaces[index] });
      await runModelJob(repo, model, owner, mapJob.id);
      assert.equal((await repo.job(owner, mapJob.id)).status, 'done');
      const map = await service.requirements(owner, workspaces[index]);
      assert.deepEqual(map.map((entry) => entry.type), ['must', 'preferred', 'responsibility']);
      assert.deepEqual(map.map((entry) => entry.category), ['direct', 'adjacent', 'none']);
      assert.equal(item.jd.slice(map[0].start_offset, map[0].end_offset), map[0].text);
      assert.equal(map[2].fact_ids.length, 0);
      assert.equal((await repo.workspace(owner, workspaces[index])).listing_work_mode, null);
      await repo.setWorkspacePreferences(owner, workspaces[index], 'remote', 'unspecified');
      assert.equal((await repo.workspace(owner, workspaces[index])).remote_preference, 'remote');
      assert.equal(await repo.setWorkspacePreferences(users[1 - index].id, workspaces[index], 'onsite', 'onsite'), null);
      await assert.rejects(service.requirements(users[1 - index].id, workspaces[index]), /Workspace not found/);
    }
    const owner = users[0].id;
    const service = new CoachService(repo, model);
    for (const persona of ['recruiter', 'hiring_manager', 'panel', 'senior_exec']) {
      const started = await service.start(owner, workspaces[0], persona);
      assert.equal(started.interview.persona, persona);
      assert.match(started.question, new RegExp(persona === 'panel' ? 'Operations interviewer' : persona));
      const followup = await service.turn(owner, started.interview.id, 'I organized our real staffing plan.');
      assert.match(followup.question, /baseline/);
      if (persona === 'panel') assert.match(followup.question, /Operations interviewer/);
      if (persona === 'senior_exec') {
        for (let index = 0; index < 5; index += 1) {
          const result = await service.turn(owner, started.interview.id, 'I checked the outcome with colleagues.', true);
          if (index === 4) assert.equal(result.extractionPending, true);
        }
        const repJob = await repo.createJob(owner, 'rep_extract', { interviewId: started.interview.id });
        await runModelJob(repo, model, owner, repJob.id);
        const debriefJob = await repo.createJob(owner, 'debrief', { interviewId: started.interview.id });
        await runModelJob(repo, model, owner, debriefJob.id);
        const report = (await repo.job(owner, debriefJob.id)).result_json;
        assert.equal(report.rewrite.ready, true);
        assert.equal(report.rewrite.text, examples[0].quote);
        assert.equal(report.contentScores.outcome.score, 2);
        assert.equal((await repo.job(users[1].id, debriefJob.id)), null);
      }
    }
    assert.equal((await service.start(users[1].id, workspaces[1])).interview.workspace_id, workspaces[1]);
    const firstWorkspace = await repo.workspace(owner, workspaces[0]);
    await service.deleteSource(owner, workspaces[0], firstWorkspace.jd_source_id);
    assert.equal(await repo.workspace(owner, workspaces[0]), null);
    assert.ok(await repo.workspace(users[1].id, workspaces[1]));
  } finally { await db.close(); }
});

test('browser PDF/DOCX and LinkedIn export parsing', async () => {
  const pdf = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 2,
    getPage: async (page) => ({ getTextContent: async () => ({ items: [{ str: page === 1 ?
      'At Alder Inn, managed shifts.' : 'Reduced wait time with a new queue.' }] }) }),
  }) }) };
  const file = { name: 'resume.pdf', size: 100, arrayBuffer: async () => new ArrayBuffer(4) };
  const parsed = await extractDocument(file, { pdfModule: pdf });
  assert.deepEqual(parsed.pageOffsets, [0, parsed.text.indexOf('Reduced')]);
  const docx = await extractDocument({ ...file, name: 'resume.docx' },
    { mammoth: { extractRawText: async () => ({ value: 'At Mesa Center, coached new hires.' }) } });
  assert.equal(docx.text, 'At Mesa Center, coached new hires.');
  assert.deepEqual(docx.pageOffsets, []);
  assert.equal(docx.sectionLabel, 'DOCX body');
  await assert.rejects(extractDocument({ ...file, size: 10000001 }, { pdfModule: pdf }), /10 MB/);
  const csv = 'Company,Title,Description\r\n"Harbor, Inc.",Director,"Led teams, then coached."\r\n';
  const parsedCsv = await extractDocument({ name: 'Positions.csv', size: csv.length,
    arrayBuffer: async () => new TextEncoder().encode(csv).buffer });
  assert.match(parsedCsv.text, /Company: Harbor, Inc.; Title: Director/);
  assert.equal(parsedCsv.sectionLabel, 'positions.csv');
  await assert.rejects(extractDocument({ name: 'Other.csv', size: csv.length,
    arrayBuffer: async () => new TextEncoder().encode(csv).buffer }), /Profile.csv or Positions.csv/);
});

test('facts from one source line group together and a misread number needs correction', async () => {
  const { db, repo } = await database();
  try {
    const user = await repo.createUser('fictional_misread', 'hash');
    const source = 'At Finch Hotel, managed 8 shifts and reduced wait time by 12 minutes.';
    const model = { generate: async (_task, _prompt, schema) => {
      const data = { facts: [
        { subject: 'candidate', predicate: 'managed', value: { count: 80, unit: 'shifts' },
          quote: 'managed 8 shifts', displayText: 'managed 8 shifts' },
        { subject: 'candidate', predicate: 'reduced', value: { count: 12, unit: 'minutes' },
          quote: 'reduced wait time by 12 minutes', displayText: 'reduced wait time by 12 minutes' },
      ] };
      assert.ok(schema(data));
      return { data, modelId: 'misread-fake' };
    } };
    const service = new CoachService(repo, model);
    const result = await service.extract(user.id, 'resume', 'Fictional resume', source);
    const facts = await repo.facts(user.id);
    assert.equal(facts.length, 2);
    assert.equal(facts[0].line_quote, facts[1].line_quote);
    assert.equal(facts[0].line_start, facts[1].line_start);
    assert.equal(facts[0].status, 'draft');
    assert.equal(gateRewrite([{ factIds: [facts[0].id] }], facts).ready, false);
    const workspace = await repo.addWorkspace(user.id, (await repo.addSource(user.id, 'jd', 'Job', 'Job description')).id, 'Job');
    await assert.rejects(service.review(user.id, { workspaceId: workspace.id, factId: facts[0].id, action: 'confirm' }), /Correct it/);
    const reviewed = await service.review(user.id, { workspaceId: workspace.id, factId: facts[0].id,
      action: 'correct', correction: 'I managed 8 shifts.', reason: 'The parser read 8 as 80.' });
    const correction = reviewed.find((fact) => fact.supersedes_fact_id === facts[0].id);
    assert.ok(correction);
    assert.equal(gateRewrite([{ factIds: [correction.id] }], reviewed).ready, true);
    assert.equal(result.factIds.length, 2);
  } finally { await db.close(); }
});

test('writing samples remain style-only; Blob chunks are owner-scoped and removed with source', async () => {
  const { db, repo } = await database();
  try {
    const model = new VariedModel();
    const user = await repo.createUser('fictional_writer', 'hash');
    const other = await repo.createUser('fictional_reader', 'hash');
    const service = new CoachService(repo, model);
    const pasted = await service.paste(user.id, { resume: examples[0].resume, jd: examples[0].jd, jobLabel: examples[0].job });
    const candidate = pasted.facts.find((fact) => fact.domain === 'candidate');
    await service.review(user.id, { workspaceId: pasted.workspace.id, factId: candidate.id, action: 'confirm' });
    const interview = await repo.createInterview(user.id, pasted.workspace.id, ['Question 1', 'Question 2', 'Question 3']);
    await repo.addTurn(user.id, interview.id, 'interviewer', 'Tell me about your work.');
    await repo.addTurn(user.id, interview.id, 'candidate', 'I planned shifts with the team.');
    await repo.endInterview(user.id, interview.id);
    const neutral = await service.debrief(user.id, interview.id);
    await assert.rejects(service.setWritingProfile(user.id, 'Direct and warm.'), /2–3/);
    await service.writingSample(user.id, 'Email', 'Hello team, here is the plan for next week.');
    await service.writingSample(user.id, 'Note', 'I want to make this clear and useful for everyone.');
    await service.writingSample(user.id, 'Text', 'Thanks for checking on the team today.');
    await assert.rejects(service.writingSample(user.id, 'Fourth', 'This should not be stored.'), /three/);
    const profile = await service.setWritingProfile(user.id, 'Direct and warm.');
    assert.equal(profile.enabled, true);
    const styled = await service.debrief(user.id, interview.id);
    assert.equal(styled.styleApplied, true);
    assert.equal(styled.rewrite.text, neutral.rewrite.text);
    assert.notEqual(styled.feedback, neutral.feedback);
    assert.ok(model.calls.findLast((call) => call.task === 'debrief').prompt.includes('Direct and warm.'));
    assert.equal((await repo.facts(user.id, pasted.workspace.id)).filter((fact) => fact.source_title === 'Email').length, 0);
    const store = new Map();
    const blobStore = { set: async (key, value) => store.set(key, value),
      get: async (key) => store.get(key).buffer,
      delete: async (key) => store.delete(key) };
    const handler = createHandler({ repo, model, blobStore,
      env: { ABUSE_HMAC_KEY: 'fictional-long-test-only-abuse-key' } });
    const session = await issueSession(repo, user, false);
    const otherSession = await issueSession(repo, other, false);
    const request = (op, body, cookie) => new Request(`http://localhost/api?op=${op}`, {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json',
        'x-coach-csrf': '1', cookie }, body: JSON.stringify(body),
    });
    const sourceId = pasted.resume.source.id;
    const init = await handler(request('upload_init', { sourceId, extractedText: examples[0].resume, name: 'resume.pdf',
      mimeType: 'application/pdf', byteSize: 4, chunkCount: 1 }, session.cookie));
    assert.equal(init.status, 200);
    const upload = (await init.json()).result;
    const denied = await handler(request('download_chunk', { uploadId: upload.id, part: 0 }, otherSession.cookie));
    assert.equal(denied.status, 404);
    assert.equal((await handler(request('upload_chunk', { uploadId: upload.id, part: 0,
      base64: Buffer.from('data').toString('base64') }, session.cookie))).status, 200);
    assert.equal((await handler(request('upload_finish', { uploadId: upload.id }, session.cookie))).status, 200);
    assert.equal((await handler(request('download_chunk', { uploadId: upload.id, part: 0 }, session.cookie))).status, 200);
    assert.equal((await handler(request('delete_source', { workspaceId: pasted.workspace.id, sourceId }, session.cookie))).status, 200);
    assert.equal(store.size, 0);
    assert.equal(await repo.source(user.id, sourceId), null);
    assert.equal((await repo.writingProfile(other.id)).samples.length, 0);
  } finally { await db.close(); }
});

test('background HTTP worker requires owner session and clears finished job payload', async () => {
  const { db, repo } = await database();
  try {
    const model = new VariedModel();
    const owner = await repo.createUser('fictional_job_owner', 'hash');
    const other = await repo.createUser('fictional_job_other', 'hash');
    const job = await repo.createJob(owner.id, 'paste', {
      resume: examples[1].resume, jd: examples[1].jd, jobLabel: examples[1].job,
    });
    const handler = createBackgroundHandler({ repo, model });
    const ownerCookie = (await issueSession(repo, owner, false)).cookie;
    const otherCookie = (await issueSession(repo, other, false)).cookie;
    const request = (cookie) => new Request('http://localhost/.netlify/functions/model-job-background', {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json',
        'x-coach-csrf': '1', cookie }, body: JSON.stringify({ jobId: job.id }),
    });
    assert.equal((await handler(request(otherCookie))).status, 404);
    assert.equal((await repo.job(owner.id, job.id)).status, 'queued');
    assert.equal((await handler(request(ownerCookie))).status, 200);
    assert.equal((await repo.job(owner.id, job.id)).status, 'done');
    assert.equal((await handler(request(ownerCookie))).status, 404);
  } finally { await db.close(); }
});

test('retryable malformed model output keeps signed-in inputs without partial sources', async () => {
  const { db, repo } = await database();
  try {
    const user = await repo.createUser('fictional_retry', 'hash');
    const working = new VariedModel();
    let fail = true;
    const model = { generate: (...args) => {
      if (fail) { fail = false; throw new ModelOutputError(args[0]); }
      return working.generate(...args);
    } };
    const job = await repo.createJob(user.id, 'paste', { resume: examples[0].resume,
      jd: examples[0].jd, jobLabel: examples[0].job });
    await runModelJob(repo, model, user.id, job.id);
    assert.equal((await repo.job(user.id, job.id)).status, 'failed');
    assert.equal((await repo.sql('SELECT count(*)::int AS count FROM sources'))[0].count, 0);
    assert.equal((await repo.sql('SELECT input_json FROM model_jobs WHERE id=$1', [job.id]))[0].input_json.resume,
      examples[0].resume);
    assert.equal((await repo.retryJob(user.id, job.id)).status, 'queued');
    await runModelJob(repo, model, user.id, job.id);
    assert.equal((await repo.job(user.id, job.id)).status, 'done');
    assert.equal((await repo.sql('SELECT count(*)::int AS count FROM sources'))[0].count, 2);
  } finally { await db.close(); }
});

test('guest document ingestion keeps profile, uploads, and jobs out of Postgres', async () => {
  const { db, repo } = await database();
  try {
    const model = new VariedModel();
    const handler = createHandler({ repo, model,
      blobStore: { set: () => { throw new Error('Guest must not write a Blob'); } },
      env: { ABUSE_HMAC_KEY: 'fictional-long-test-only-abuse-key' } });
    const request = (op, body) => new Request(`http://localhost/api?op=${op}`, {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json',
        'x-coach-csrf': '1' }, body: JSON.stringify({ ...body, guest: true }),
    });
    const pasted = await handler(request('paste', { state: {}, resume: examples[0].resume,
      jd: examples[0].jd, jobLabel: examples[0].job }));
    const first = await pasted.json();
    const added = await handler(request('ingest', { state: first.state, kind: 'background',
      title: 'Notes', text: 'At Harbor Lodge, managed staffing for 8 colleagues.',
      workspaceId: first.result.workspace.id, pageOffsets: [0] }));
    assert.equal(added.status, 200);
    assert.equal((await added.json()).state.sources.length, 3);
    for (const table of ['sources', 'uploads', 'model_jobs']) {
      assert.equal((await repo.sql(`SELECT count(*)::int AS count FROM ${table}`))[0].count, 0);
    }
  } finally { await db.close(); }
});
