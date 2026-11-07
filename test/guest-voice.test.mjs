import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';
import { GuestRepository } from '../src/guest.js';
import { CoachService } from '../src/service.js';
import { startGuestVoice, guestVoiceStatus, acceptVoiceWebhook } from '../src/voice.js';
import { createHmac } from 'node:crypto';

async function setup() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

const model = { async generate(task, _prompt, schema) {
  let data;
  if (task === 'questions') data = { questions: ['Tell me about your work.', 'How do you lead?', 'What changed?'] };
  else if (task === 'debrief') data = {
    contentScores: Object.fromEntries(['relevance', 'ownership', 'evidence', 'outcome', 'structure']
      .map((key) => [key, { score: 3, reason: 'Observed in transcript.' }])),
    deliveryScores: { clarity: { score: 3, reason: 'Clear.' }, concision: { score: 3, reason: 'Concise.' } },
    feedback: 'Add a measured result.', unsupportedClaims: [], rewriteClaims: [], strongerNeeds: [],
  };
  else if (task === 'fact_gate') data = { items: [] };
  else if (task.startsWith('extract_')) data = { facts: [] };
  else if (task === 'stronger_draft') data = { rewrite: '', slots: [] };
  else throw new Error(`Unexpected model task ${task}`);
  return { data: schema ? (schema(data) ? data : data) : data, modelId: 'fake' };
} };

async function guestWithWorkspace() {
  const guest = new GuestRepository();
  const jd = await guest.addSource('guest', 'jd', 'Posting', 'Regional Director of Operations. Lead studio GMs.');
  const workspace = await guest.addWorkspace('guest', jd.id, 'Regional Director');
  await guest.replaceRequirements('guest', workspace.id, jd.id, [{ quote: 'Lead studio GMs', start: 33, end: 48,
    type: 'must', competency: 'GM leadership', evidenceNeeded: 'example', category: 'none', rationale: 'none', factIds: [] }]);
  return { guest, workspace };
}

const env = { RETELL_API_KEY: 'k', RETELL_GUEST_AGENT_ID: 'guest-agent', RETELL_AGENT_ID: 'signed-agent',
  RETELL_WEBHOOK_KEY: 'w', DAILY_USD_CAP: '15' };

function fakeRetell(calls) {
  let n = 0;
  return async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('create-web-call')) {
      n += 1;
      return { ok: true, json: async () => ({ call_id: `call-${n}`, access_token: `tok-${n}`, transport: 'gateway', ice_servers: [] }) };
    }
    if (url.includes('get-call')) {
      return { ok: true, json: async () => ({ call_status: 'ended', duration_ms: 125_000,
        transcript_object: [{ role: 'agent', content: 'Tell me about your work.' },
          { role: 'user', content: 'I coached four studio managers through a slow summer.' }] }) };
    }
    throw new Error(`unexpected ${url}`);
  };
}

test('guest voice uses the guest agent with a 5-minute cap and returns a debrief without storing content', async () => {
  const { db, repo } = await setup();
  try {
    const { guest, workspace } = await guestWithWorkspace();
    const service = new CoachService(guest, model);
    const calls = [];
    const fetchImpl = fakeRetell(calls);
    const started = await startGuestVoice({ repo, env, fetchImpl }, service, 'subject-a', { workspaceId: workspace.id });
    const create = calls.find((c) => c.url.includes('create-web-call')).body;
    assert.equal(create.agent_id, 'guest-agent');
    assert.equal(create.agent_override.agent.max_call_duration_ms, 5 * 60_000);
    assert.ok(started.guestToken && started.accessToken);
    assert.equal(started.transport, 'gateway');
    assert.deepEqual(started.iceServers, []);
    assert.equal(calls.find((c) => c.url.includes('create-web-call')).url, 'https://api.retellai.com/v3/create-web-call');

    const status = await guestVoiceStatus({ repo, env, fetchImpl }, service,
      { callId: started.callId, guestToken: started.guestToken, interviewId: started.interviewId });
    assert.equal(status.status, 'ended');
    assert.ok(status.report);
    assert.ok(guest.state.turns.some((turn) => /studio managers/.test(turn.text)));

    // Nothing the guest said reaches the database.
    const dump = JSON.stringify(await repo.sql('SELECT * FROM guest_voice_calls'));
    assert.equal(dump.includes('studio managers'), false);
    for (const table of ['sources', 'interviews', 'facts']) {
      assert.equal((await repo.sql(`SELECT count(*)::int AS n FROM ${table}`))[0].n, 0);
    }
    const row = (await repo.sql('SELECT * FROM guest_voice_calls'))[0];
    assert.equal(row.status, 'settled');
    assert.equal(row.duration_seconds, 125);
  } finally { await db.close(); }
});

test('guest voice caps: 2 calls per browser per day, then refused with no outbound call', async () => {
  const { db, repo } = await setup();
  try {
    const { guest, workspace } = await guestWithWorkspace();
    const service = new CoachService(guest, model);
    const calls = [];
    const fetchImpl = fakeRetell(calls);
    await startGuestVoice({ repo, env, fetchImpl }, service, 'same-browser', { workspaceId: workspace.id });
    await startGuestVoice({ repo, env, fetchImpl }, service, 'same-browser', { workspaceId: workspace.id });
    const before = calls.length;
    await assert.rejects(startGuestVoice({ repo, env, fetchImpl }, service, 'same-browser', { workspaceId: workspace.id }), /2 voice calls a day/);
    assert.equal(calls.length, before);
  } finally { await db.close(); }
});

test('guest voice pool: all guests share a daily minute pool', async () => {
  const { db, repo } = await setup();
  try {
    const { guest, workspace } = await guestWithWorkspace();
    const service = new CoachService(guest, model);
    const calls = [];
    const fetchImpl = fakeRetell(calls);
    const pooled = { ...env, GUEST_VOICE_DAILY_MINUTES: '10' };
    await startGuestVoice({ repo, env: pooled, fetchImpl }, service, 'browser-1', { workspaceId: workspace.id });
    await startGuestVoice({ repo, env: pooled, fetchImpl }, service, 'browser-2', { workspaceId: workspace.id });
    const before = calls.length;
    await assert.rejects(startGuestVoice({ repo, env: pooled, fetchImpl }, service, 'browser-3', { workspaceId: workspace.id }), /used up for today/);
    assert.equal(calls.length, before);
  } finally { await db.close(); }
});

test('one guest cannot read another guest call with a wrong token', async () => {
  const { db, repo } = await setup();
  try {
    const { guest, workspace } = await guestWithWorkspace();
    const service = new CoachService(guest, model);
    const fetchImpl = fakeRetell([]);
    const started = await startGuestVoice({ repo, env, fetchImpl }, service, 'subject-x', { workspaceId: workspace.id });
    await assert.rejects(guestVoiceStatus({ repo, env, fetchImpl }, service,
      { callId: started.callId, guestToken: 'wrong-token', interviewId: started.interviewId }), /not found/);
  } finally { await db.close(); }
});

test('webhook for a guest call only settles spend, never stores a transcript', async () => {
  const { db, repo } = await setup();
  try {
    const { guest, workspace } = await guestWithWorkspace();
    const service = new CoachService(guest, model);
    const started = await startGuestVoice({ repo, env, fetchImpl: fakeRetell([]) }, service, 's', { workspaceId: workspace.id });
    const raw = JSON.stringify({ event: 'call_analyzed', call: { call_id: started.callId, duration_ms: 61_000,
      transcript_object: [{ role: 'user', content: 'secret guest words' }] } });
    const now = Date.now();
    const signature = `v=${now},d=${createHmac('sha256', 'w').update(raw).update(String(now)).digest('hex')}`;
    const result = await acceptVoiceWebhook({ repo, raw, signature, key: 'w', now });
    assert.equal(result.result, 'guest_settled');
    const everything = JSON.stringify(await repo.sql('SELECT * FROM guest_voice_calls'));
    assert.equal(everything.includes('secret guest words'), false);
  } finally { await db.close(); }
});
