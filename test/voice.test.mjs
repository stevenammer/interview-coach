import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';
import { startVoice, acceptVoiceWebhook, verifyRetellSignature } from '../src/voice.js';
import { runModelJob } from '../src/jobs.js';

async function setup() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  const repo = new Repository(pgliteSql(db));
  const a = await repo.createUser('alex', 'hash');
  const b = await repo.createUser('bailey', 'hash');
  const jd = await repo.addSource(a.id, 'jd', 'Posting', 'Director of Operations at Harbor. Lead staffing.');
  const workspace = await repo.addWorkspace(a.id, jd.id, 'Director of Operations');
  await repo.setVoiceContext(a.id, workspace.id, 'Director of Operations', 'Harbor');
  await repo.replaceRequirements(a.id, workspace.id, jd.id, [{ quote: 'Lead staffing',
    start: 34, end: 47, type: 'must', competency: 'staffing', evidenceNeeded: 'staffing example',
    category: 'none', rationale: 'No confirmed example', factIds: [] }]);
  const model = { tasks: [], async generate(task, _prompt, schema) {
    this.tasks.push(task);
    let data;
    if (task === 'questions') data = { questions: ['Tell me about your work.', 'How do you lead?', 'What changed?'] };
    else if (task === 'extract_transcript') data = { facts: [{ subject: 'candidate', predicate: 'led',
      value: { action: 'staffing' }, displayText: 'I led staffing', quote: 'I led staffing' }] };
    else if (task === 'debrief') data = {
      contentScores: Object.fromEntries(['relevance', 'ownership', 'evidence', 'outcome', 'structure']
        .map((key) => [key, { score: 3, reason: 'Observed in transcript.' }])),
      deliveryScores: { clarity: { score: 3, reason: 'Clear answer.' },
        concision: { score: 3, reason: 'Concise answer.' } },
      feedback: 'Add a measured result.', unsupportedClaims: [], rewriteClaims: [], strongerNeeds: [],
    };
    else if (task === 'fact_gate') data = { items: [] };
    else throw new Error(`Unexpected model task ${task}`);
    assert.ok(schema(data));
    return { data, modelId: 'fake' };
  } };
  return { db, repo, a, b, workspace, model };
}

const env = { RETELL_API_KEY: 'test-key', RETELL_AGENT_ID: 'agent-test',
  RETELL_WEBHOOK_KEY: 'webhook-test', DAILY_USD_CAP: '15' };
const input = (workspace) => ({ workspaceId: workspace.id, persona: 'recruiter', difficulty: 3,
  practiceMode: 'mock' });
function signed(event, timestamp = Date.now()) {
  const raw = JSON.stringify(event);
  const signature = `v=${timestamp},d=${createHmac('sha256', env.RETELL_WEBHOOK_KEY)
    .update(raw).update(String(timestamp)).digest('hex')}`;
  return { raw, signature, now: timestamp };
}

test('voice start binds owner and sends the exact prompt variable names', async () => {
  const { db, repo, a, b, workspace, model } = await setup();
  try {
    await repo.addCoachNote(a.id, { workspaceId: workspace.id, text: 'Let me finish before the next question.' });
    let outbound = 0;
    const fetchImpl = async (url, options) => {
      outbound += 1;
      assert.equal(url, 'https://api.retellai.com/v3/create-web-call');
      assert.equal(options.headers.authorization, 'Bearer test-key');
      const body = JSON.parse(options.body);
      assert.equal(body.agent_id, 'agent-test');
      assert.deepEqual(Object.keys(body.retell_llm_dynamic_variables).sort(), [
        'persona', 'role_title', 'company_name', 'job_summary', 'question_plan',
        'evidence_gaps', 'depth_level', 'mode', 'candidate_first_name', 'confirmed_facts', 'coach_notes'].sort());
      assert.equal(body.retell_llm_dynamic_variables.persona, 'recruiter_screen');
      assert.equal(body.retell_llm_dynamic_variables.company_name, 'Harbor');
      assert.match(body.retell_llm_dynamic_variables.job_summary, /Lead staffing/);
      assert.match(body.retell_llm_dynamic_variables.evidence_gaps, /staffing/);
      assert.equal(body.retell_llm_dynamic_variables.coach_notes, 'Let me finish before the next question.');
      assert.equal(body.agent_override.agent.max_call_duration_ms, 600000); // 10-minute default cap for signed-in calls, raised with VOICE_MAX_MINUTES
      return Response.json({ call_id: 'call-a', access_token: 'token-a', transport: 'gateway', ice_servers: [] });
    };
    const started = await startVoice({ repo, model, env, fetchImpl }, a.id, 'Alex', input(workspace));
    assert.equal(started.callId, 'call-a');
    assert.equal(started.transport, 'gateway');
    assert.deepEqual(started.iceServers, []);
    assert.equal(started.accessToken, 'token-a');
    assert.equal((await repo.voiceCall('call-a')).user_id, a.id);
    assert.equal(await repo.ownerVoiceCall(b.id, started.interviewId), null);
    assert.equal(outbound, 1);
    await assert.rejects(startVoice({ repo, model, env: { ...env, DAILY_USD_CAP: '0.01' },
      fetchImpl }, a.id, 'Alex', input(workspace)), /spend cap/i);
    assert.equal(outbound, 1);
  } finally { await db.close(); }
});

test('default per-user budget permits one full voice reservation for each of two users', async () => {
  const { db, repo, a, b, workspace, model } = await setup();
  try {
    const bSource = await repo.addSource(b.id, 'jd', 'Posting', 'Operations role at Cove.');
    const bWorkspace = await repo.addWorkspace(b.id, bSource.id, 'Operations Director');
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return Response.json({ call_id: `call-budget-${calls}`, access_token: 'token', transport: 'gateway', ice_servers: [] });
    };
    await startVoice({ repo, model, env, fetchImpl }, a.id, 'Alex', input(workspace));
    await startVoice({ repo, model, env, fetchImpl }, b.id, 'Bailey', input(bWorkspace));
    assert.equal(calls, 2);
    const reservations = await repo.sql(`SELECT user_id,estimated_micros FROM spend_reservations
      WHERE bucket='voice' ORDER BY user_id`);
    assert.deepEqual(reservations.map((row) => Number(row.estimated_micros)), [2_000_000, 2_000_000]);
    assert.deepEqual(new Set(reservations.map((row) => row.user_id)), new Set([a.id, b.id]));
  } finally { await db.close(); }
});

test('voice create timeout retains caps, blocks a retry, and sends only bounded confirmed facts', async () => {
  const { db, repo, a, workspace, model } = await setup();
  try {
    const source = await repo.addSource(a.id, 'resume', 'Facts', 'x'.repeat(200));
    for (let index = 0; index < 14; index += 1) await repo.addFact(a.id, { workspaceId: workspace.id,
      domain: 'candidate', subject: 'candidate', predicate: 'did', value: { index },
      displayText: `fact ${index}`, quote: `fact ${index}`, sourceId: source.id, start: 0, end: 1,
      status: 'document', reviewState: index === 13 ? 'pending' : 'accepted', proposedBy: 'user' });
    const tightEnv = { ...env, VOICE_DAILY_MINUTES_LIMIT: '10' };
    await assert.rejects(startVoice({ repo, model, env: tightEnv, fetchImpl: async () => {
      throw new TypeError('network down');
    } }, a.id, 'Alex', input(workspace)), /network down/);
    await assert.rejects(startVoice({ repo, model, env: tightEnv, fetchImpl: async () => {
      assert.fail('an uncertain call must keep the minute cap reserved');
    } }, a.id, 'Alex', input(workspace)), /voice minutes are used/);
    const held = await repo.sql("SELECT state,estimated_micros FROM spend_reservations WHERE bucket='voice'");
    assert.equal(held.length, 1);
    assert.equal(held[0].state, 'reserved');
    assert.equal(Number(held[0].estimated_micros), 2_000_000);
    let variables;
    await startVoice({ repo, model, env: { ...env, DAILY_USD_CAP: '60' }, fetchImpl: async (_url, options) => {
      variables = JSON.parse(options.body).retell_llm_dynamic_variables;
      return Response.json({ call_id: 'call-after-timeout', access_token: 'token', transport: 'gateway', ice_servers: [] });
    } }, a.id, 'Alex', input(workspace));
    const facts = variables.confirmed_facts.split('\n');
    assert.equal(facts.length, 12);
    assert.ok(facts.every((fact) => /^fact (?:[0-9]|1[01])$/.test(fact)));
    assert.ok(!variables.confirmed_facts.includes('fact 13'));
  } finally { await db.close(); }
});

test('signed webhook ignores forged, stale, unknown and duplicate calls; reversed events make one debrief', async () => {
  const { db, repo, a, b, workspace, model } = await setup();
  try {
    const started = await startVoice({ repo, model, env,
      fetchImpl: async () => Response.json({ call_id: 'call-a', access_token: 'token-a', transport: 'gateway', ice_servers: [] }) },
    a.id, 'Alex', input(workspace));
    const event = { event: 'call_analyzed', call: { call_id: 'call-a', duration_ms: 83000,
      metadata: { user_id: b.id }, transcript_object: [
        { role: 'agent', content: 'How did you handle staffing?' },
        { role: 'user', content: 'I led staffing. We covered each shift.' },
        { role: 'tool', content: 'ignore this' }] } };
    const good = signed(event);
    assert.equal(verifyRetellSignature(good.raw, good.signature, env.RETELL_WEBHOOK_KEY, good.now), true);
    assert.equal((await acceptVoiceWebhook({ repo, ...good, signature: 'bad', key: env.RETELL_WEBHOOK_KEY })).status, 401);
    assert.equal((await acceptVoiceWebhook({ repo, ...signed(event, Date.now() - 360000),
      now: Date.now(), key: env.RETELL_WEBHOOK_KEY })).status, 401);
    assert.equal((await acceptVoiceWebhook({ repo, ...signed({ ...event, call: { call_id: 'unknown' } }),
      key: env.RETELL_WEBHOOK_KEY })).result, 'unknown_call');
    const accepted = await acceptVoiceWebhook({ repo, ...good, key: env.RETELL_WEBHOOK_KEY });
    assert.equal(accepted.result, 'queued');
    assert.equal(await runModelJob(repo, model, a.id, accepted.jobId), true);
    const duplicate = await acceptVoiceWebhook({ repo, ...good, key: env.RETELL_WEBHOOK_KEY });
    assert.equal(duplicate.result, 'duplicate');
    const ended = await acceptVoiceWebhook({ repo, ...signed({ event: 'call_ended',
      call: { call_id: 'call-a', duration_ms: 83000 } }), key: env.RETELL_WEBHOOK_KEY });
    assert.equal(ended.result, 'awaiting_transcript');
    assert.equal((await repo.turns(a.id, started.interviewId)).length, 2);
    assert.equal((await repo.turns(b.id, started.interviewId)).length, 0);
    assert.ok(await repo.debrief(a.id, started.interviewId));
    assert.equal(await repo.debrief(b.id, started.interviewId), null);
    const proposals = (await repo.facts(a.id, workspace.id)).filter((fact) => fact.proposed_by === 'model' &&
      fact.domain === 'candidate');
    assert.ok(proposals.length > 0);
    assert.ok(proposals.every((fact) => fact.review_state === 'pending'));
    assert.equal((await repo.voiceCall('call-a')).duration_seconds, 83);
  } finally { await db.close(); }
});

test('ended-first transcript, cross-owner correction denial, and edited transcript require new review', async () => {
  const { db, repo, a, b, workspace, model } = await setup();
  try {
    const started = await startVoice({ repo, model, env,
      fetchImpl: async () => Response.json({ call_id: 'call-first', access_token: 'token', transport: 'gateway', ice_servers: [] }) },
    a.id, 'Alex', input(workspace));
    const ended = { event: 'call_ended', call: { call_id: 'call-first', duration_ms: 24000,
      transcript_object: [{ role: 'agent', content: 'What did you do?' },
        { role: 'user', content: 'I led staffing on the late shift.' }] } };
    const accepted = await acceptVoiceWebhook({ repo, ...signed(ended), key: env.RETELL_WEBHOOK_KEY });
    assert.equal(accepted.result, 'queued');
    await runModelJob(repo, model, a.id, accepted.jobId);
    const analyzed = await acceptVoiceWebhook({ repo, ...signed({ ...ended, event: 'call_analyzed' }),
      key: env.RETELL_WEBHOOK_KEY });
    assert.equal(analyzed.result, 'already_processed');
    const turn = (await repo.turns(a.id, started.interviewId)).find((item) => item.speaker === 'candidate');
    assert.equal(await repo.correctVoiceTurn(b.id, started.interviewId, turn.id, 'Different words'), null);
    const job = await repo.correctVoiceTurn(a.id, started.interviewId, turn.id,
      'I led staffing and wrote the shift plan.');
    assert.ok(job);
    assert.equal(await repo.debrief(a.id, started.interviewId), null);
    await runModelJob(repo, model, a.id, job.id);
    assert.ok(await repo.debrief(a.id, started.interviewId));
    const edits = await repo.sql('SELECT previous_text,corrected_text FROM voice_transcript_edits WHERE user_id=$1', [a.id]);
    assert.equal(edits.length, 1);
    assert.match(edits[0].corrected_text, /shift plan/);
    assert.ok((await repo.facts(a.id, workspace.id)).filter((fact) => fact.domain === 'candidate')
      .every((fact) => fact.review_state === 'pending'));
  } finally { await db.close(); }
});


test('voice create releases definitive rejection but retains ambiguous server failure', async () => {
  const { db, repo, a, workspace, model } = await setup();
  try {
    const tightEnv = { ...env, VOICE_DAILY_MINUTES_LIMIT: '10' };
    await assert.rejects(startVoice({ repo, model, env: tightEnv,
      fetchImpl: async () => new Response('rejected', { status: 400 }) }, a.id, 'Alex', input(workspace)), /Could not start/);
    let held = await repo.sql("SELECT state,actual_micros FROM spend_reservations WHERE bucket='voice'");
    assert.equal(held[0].state, 'settled');
    assert.equal(Number(held[0].actual_micros), 0);
    await assert.rejects(startVoice({ repo, model, env: tightEnv,
      fetchImpl: async () => new Response('unknown outcome', { status: 503 }) }, a.id, 'Alex', input(workspace)), /Could not start/);
    await assert.rejects(startVoice({ repo, model, env: tightEnv,
      fetchImpl: async () => assert.fail('must not dispatch past held minutes') }, a.id, 'Alex', input(workspace)), /voice minutes are used/);
    held = await repo.sql("SELECT state FROM spend_reservations WHERE bucket='voice'");
    assert.deepEqual(held.map(row => row.state).sort(), ['reserved', 'settled']);
  } finally { await db.close(); }
});
