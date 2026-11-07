import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { GuestRepository } from '../src/guest.js';
import { pgliteSql } from '../src/db.js';
import { CoachService } from '../src/service.js';
import { runModelJob } from '../src/jobs.js';

const migrations = ['001_core.sql', '002_jobs.sql', '003_ingestion.sql', '004_workspaces.sql',
  '005_rewrites.sql', '006_interviewer.sql', '007_story_dig.sql', '008_drills.sql',
  '009_real_interviews.sql', '010_fact_gate.sql', '011_immerser.sql', '012_voice.sql', '013_guest_voice.sql', '015_debrief_input_hash.sql', '016_job_comparison.sql', '020_security_audit.sql', '021_security_hardening_3.sql', '022_fact_conflict_reviews.sql'];
async function database() {
  const db = new PGlite();
  for (const name of migrations) await db.exec(await readFile(new URL(`../netlify/database/migrations/${name}`, import.meta.url), 'utf8'));
  return { db, repo: new Repository(pgliteSql(db)) };
}
function variedModel(jd, industry, company = null) {
  const calls = [];
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const situations = industry === 'hotel operations' ? [
    ['Arrival standup', 'The desk lead says arrivals and room readiness are drifting apart.'],
    ['Owner variance call', 'An owner asks which operating cost you would investigate first.'],
    ['Guest recovery', 'A guest escalation reaches you after the first response fell short.'],
    ['Shift coverage', 'A supervisor reports a shortfall before a busy shift.'],
    ['First months conversation', 'A senior leader asks how you would learn the properties before changing standards.'],
  ] : industry === 'manufacturing' ? [
    ['Production standup', 'The line lead reports uneven handoffs between shifts.'],
    ['Quality variance call', 'Finance asks whether a quality rework pattern needs immediate spending.'],
    ['Customer escalation', 'A customer asks how a delayed order will be recovered.'],
    ['Line capacity', 'A supervisor reports a capacity gap before the next run.'],
    ['First months conversation', 'A plant leader asks what you would measure before changing the process.'],
  ] : [
    ['Outreach standup', 'A coordinator reports that volunteer assignments are unclear.'],
    ['Funding trade-off', 'A donor asks which program constraint you would address first.'],
    ['Community escalation', 'A partner asks how an unmet need will be handled.'],
    ['Volunteer capacity', 'A team lead reports a gap in coverage.'],
    ['First months conversation', 'A director asks what you would learn before revising outreach.'],
  ];
  return { calls, async generate(task, prompt, schema) {
    calls.push({ task, prompt });
    let data;
    if (task === 'immerse_week') data = { scenes: days.map((day, index) => ({
      id: day.toLowerCase(), day, title: situations[index][0],
      situation: situations[index][1],
      ask: 'What would you do and who would you involve?',
      details: [{ text: jd, provenance: 'jd', sourceId: this.jdId },
        { text: `A fictional ${industry} queue has 17 (seventeen) items.`, provenance: 'typical' },
        ...(company && index === 0 ? [{ text: company.quote, provenance: 'company', sourceId: company.id }] : [])],
      choices: ['consult', 'act'].map((action) => ({ id: action,
        label: action === 'consult' ? 'Ask the relevant team for context.' : 'Take a reversible first step.',
        consequence: action === 'consult' ? 'The team shares context, while the decision takes longer.' :
          'Work moves sooner, while you must explain the assumption later.',
        tradeoff: action === 'consult' ? 'Context versus speed' : 'Speed versus alignment',
        nextSceneId: days[index + 1]?.toLowerCase() ?? 'end' })) })) };
    else if (task === 'immerse_past_proposals') {
      const response = prompt.split('Typed response:\n')[1];
      data = { quotes: /I previously|At Bayfront I did/.test(response) ? [response] : [] };
    } else throw new Error(`Unexpected model task ${task}`);
    assert.ok(schema(data), `${task} output validates`);
    return { data };
  } };
}

for (const [name, jd, industry] of [
  ['harbor', 'Coordinate guest recovery across properties.', 'hotel operations'],
  ['circuit', 'Coordinate production quality across plants.', 'manufacturing'],
]) test(`${industry} week branches, cites origins, and proposes only real past work`, async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser(name, 'hash')).id;
    const other = (await repo.createUser(`${name}_other`, 'hash')).id;
    const jdSource = await repo.addSource(owner, 'jd', `${industry} director`, jd);
    const workspace = await repo.addWorkspace(owner, jdSource.id, `${industry} director`);
    const company = { id: 'c10ccfaf-0f83-40ab-bad8-ac6899066c42', quote: 'Founded in a fictional coastal town.' };
    await repo.sql(`INSERT INTO verified_company_facts(id,user_id,workspace_id,quote,source_url,checked_at)
      VALUES($1,$2,$3,$4,$5,now())`, [company.id, owner, workspace.id, company.quote, 'https://example.test/source']);
    const model = variedModel(jd, industry, company); model.jdId = jdSource.id;
    const service = new CoachService(repo, model);
    let run = await service.startImmersion(owner, workspace.id);
    assert.equal(run.plan.scenes.length, 5);
    assert.match(run.plan.scenes[1].title, industry === 'hotel operations' ? /Owner/ : /Quality/);
    assert.equal(run.plan.scenes[0].provenance, 'typical');
    assert.ok(run.plan.scenes[0].choices.every((choice) => choice.provenance === 'typical'));
    assert.equal(run.companySources[company.id], 'https://example.test/source');
    assert.deepEqual(run.plan.scenes[0].details.map((detail) => detail.provenance), ['jd', 'typical', 'company']);
    assert.equal(await service.immersion(other, workspace.id, run.id).catch(() => null), null);
    assert.match(model.calls[0].prompt, new RegExp(jd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (let index = 0; index < 5; index++) {
      const response = index === 1 ? 'At Bayfront I did something similar when check-in waits spiked.' :
        'I would discuss the 17-item fictional queue before deciding.';
      run = await service.actImmersion(owner, run.id, index % 2 ? 'act' : 'consult', response);
      if (index === 1) {
        const proposalId = run.state.history.at(-1).proposalIds[0];
        assert.equal((await repo.fact(owner, proposalId)).review_state, 'pending');
        assert.equal(await repo.fact(other, proposalId), null);
      } else assert.deepEqual(run.state.history.at(-1).proposalIds, []);
    }
    assert.equal(run.state.complete, true);
    assert.equal(run.debrief.tradeoffs.length, 5);
    assert.match(run.debrief.first90Days, /90 days/);
    assert.equal((await service.immersion(owner, workspace.id)).state.history.length, 5);
    await repo.deleteFact(owner, run.state.history[1].proposalIds[0]);
    assert.equal(await service.immersion(owner, workspace.id), null);
    const job = await repo.createJob(owner, 'immerse_week', { workspaceId: workspace.id });
    assert.equal(await runModelJob(repo, model, owner, job.id), true);
    assert.equal((await repo.job(owner, job.id)).status, 'done');
    assert.equal(await repo.job(other, job.id), null);
    await repo.sql("UPDATE verified_company_facts SET status='retired' WHERE user_id=$1 AND id=$2", [owner, company.id]);
    const revised = await service.immersion(owner, workspace.id);
    assert.ok(revised.plan.scenes.every((scene) => scene.details.every((detail) => detail.provenance !== 'company')));
  } finally { await db.close(); }
});

test('guest immersion stays in browser-provided state and invalid company claims are rejected', async () => {
  const { db, repo } = await database();
  try {
    const guest = new GuestRepository();
    const jd = await guest.addSource(null, 'jd', 'Planning role', 'Plan nonprofit outreach.');
    const workspace = await guest.addWorkspace(null, jd.id, 'Planning role');
    const model = variedModel(jd.text, 'nonprofit'); model.jdId = jd.id;
    const service = new CoachService(guest, model);
    const run = await service.startImmersion('guest', workspace.id);
    assert.equal(guest.state.immersions.length, 1);
    assert.equal((await repo.sql('SELECT count(*)::int AS count FROM immersions'))[0].count, 0);
    const mistaken = variedModel(jd.text, 'nonprofit'); mistaken.jdId = jd.id;
    mistaken.generate = async (task, prompt, schema) => {
      assert.equal(task, 'immerse_past_proposals');
      const quote = prompt.split('Typed response:\n')[1];
      const data = { quotes: [quote] };
      assert.ok(schema(data)); return { data };
    };
    const acted = await new CoachService(guest, mistaken).actImmersion('guest', run.id, 'consult',
      'I would inspect the fictional 17-item queue.');
    assert.deepEqual(acted.state.history[0].proposalIds, []);
    const asked = await new CoachService(guest, mistaken).actImmersion('guest', run.id, 'act',
      'What is their staffing policy?');
    assert.match(asked.state.history[1].honesty, /don't have a verified staffing answer/);
    assert.deepEqual(asked.state.history[1].proposalIds, []);
    const repeated = await new CoachService(guest, mistaken).actImmersion('guest', run.id, 'consult',
      'I previously handled seventeen items in a queue.');
    assert.deepEqual(repeated.state.history[2].proposalIds, []);
    assert.equal(guest.state.facts.length, 0);
    const restored = new CoachService(new GuestRepository(guest.state), model);
    assert.equal((await restored.immersion('guest', workspace.id, run.id)).id, run.id);
    const bad = variedModel(jd.text, 'nonprofit'); bad.jdId = jd.id;
    const generate = bad.generate.bind(bad);
    bad.generate = async (...args) => {
      const output = await generate(...args);
      output.data.scenes[0].details[0].text = 'Invented employer policy';
      return output;
    };
    // An unprovable detail is dropped from the week instead of failing the whole run,
    // and it never reaches the page under any provenance.
    const cleaned = await new CoachService(guest, bad).startImmersion('guest', workspace.id);
    const shown = JSON.stringify(cleaned);
    assert.equal(shown.includes('Invented employer policy'), false);
    for (const scene of cleaned.plan?.scenes ?? cleaned.scenes ?? []) {
      for (const detail of scene.details) {
        if (detail.provenance === 'jd') assert.ok(jd.text.includes(detail.text));
      }
    }
  } finally { await db.close(); }
});
