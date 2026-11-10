import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { pgliteSql } from '../src/db.js';
import { GuestRepository } from '../src/guest.js';
import { CoachService } from '../src/service.js';
import { startGuestVoice } from '../src/voice.js';
import { createHandler, plainAdapter } from '../netlify/functions/api.mjs';
import { decodePlain, decodeTerms, DECODER_TERMS } from '../public/plain-decoder.js';
import { checkPlain, translatePlain, cachedPlain, plainCacheKey, sealPlain, openPlain,
  plainQuestionPlan, plainPrompt } from '../src/plain.js';
import { createPlainEnglish, bindPlainToggle, PLAIN_SETTING_KEY } from '../public/plain-ui.js';

async function setup() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}
const KEY = 'long-test-only-random-abuse-hmac-key';

// A model that records calls and answers with whatever the test hands it.
function fakePlainModel(answer) {
  const model = { calls: 0, async generate(task, prompt, schema) {
    model.calls += 1;
    model.last = { task, prompt };
    const plain = typeof answer === 'function' ? answer(prompt) : answer;
    if (plain instanceof Error) throw plain;
    const data = { plain };
    if (!schema(data)) throw new Error('bad shape');
    return { data, modelId: 'fake-free' };
  } };
  return model;
}
const memoryCache = () => { const map = new Map(); return { map,
  async get(key) { return map.get(key) ?? null; }, async set(key, value) { map.set(key, value); } }; };

const QUESTION = 'Walk me through how you would identify a bottleneck in a cross-functional process.';
const GOOD_QUESTION = 'In plain words: how would you find the spot where work piles up when a few teams are involved?';

// ---- decoder -----------------------------------------------------------------------
test('decoder explains the core corporate and interview words in everyday terms', () => {
  const probe = 'process workflow bottleneck KPI metric stakeholder cross-functional buy-in bandwidth escalation ' +
    'scalable leverage deliverable SOP STAR';
  const found = decodeTerms(probe).map((item) => item.term.toLowerCase());
  for (const term of ['process', 'workflow', 'bottleneck', 'kpi', 'metric', 'stakeholder', 'cross-functional',
    'buy-in', 'bandwidth', 'escalation', 'scalable', 'leverage', 'deliverable', 'sop', 'star']) {
    assert.ok(found.includes(term), `missing ${term}`);
  }
  assert.ok(DECODER_TERMS.length >= 40, 'about 25 more common terms');
  for (const entry of DECODER_TERMS) {
    assert.ok(entry.plain.length > 2 && !/[—–]/.test(entry.plain), entry.term);
  }
});

test('decoder gives a question shape and never invents facts or numbers', () => {
  const story = decodePlain('Tell me about a time you had to escalate a problem to a stakeholder.', 'question');
  assert.match(story.text, /^In plain words:/);
  assert.equal(story.source, 'decoder');
  assert.ok(story.glossary.length >= 2);
  const unknown = decodePlain('Describe your 12 years at Acme.', 'question');
  assert.equal(unknown.text, null, 'no guess when no rule matches');
  assert.equal(decodePlain('Great structure. Add one number.', 'debrief').text, null);
});

// ---- guardrails --------------------------------------------------------------------
test('guard accepts a faithful rewrite and normalizes the question prefix and dashes', () => {
  const ok = checkPlain(QUESTION, 'how would you find the spot where things pile up when a few teams — work together?', 'question');
  assert.equal(ok.ok, true);
  assert.match(ok.text, /^In plain words:/);
  assert.equal(/[—–]/.test(ok.text), false);
  assert.equal(checkPlain(QUESTION, GOOD_QUESTION, 'question').ok, true);
});

test('guard rejects dropped or added numbers, names, stacked questions, runaway length', () => {
  const q = 'Tell me about the 3 stores you led at Acme Hotels last year.';
  assert.equal(checkPlain(q, 'In plain words: what did you do with the stores you led at Acme Hotels?', 'question').reason, 'number_dropped');
  assert.equal(checkPlain(q, 'In plain words: what did you do with the 4 stores you led at Acme Hotels?', 'question').reason, 'number_dropped');
  assert.equal(checkPlain(q, 'In plain words: tell me about the 3 stores you led last year?', 'question').reason, 'name_dropped');
  assert.equal(checkPlain(q, 'In plain words: tell me about the 3 stores you led at Acme Hotels in Orlando?', 'question').reason, 'name_added');
  assert.equal(checkPlain(q, 'In plain words: what happened with the 3 stores at Acme Hotels? How did you lead them?', 'question').reason, 'stacked_questions');
  assert.equal(checkPlain('Did you lead the 3 stores at Acme Hotels?', 'In plain words: you led the 3 stores at Acme Hotels.', 'question').reason, 'not_a_question');
  assert.equal(checkPlain(q, `In plain words: ${'what about the 3 stores at Acme Hotels '.repeat(12)}?`, 'question').reason, 'too_long');
  assert.equal(checkPlain(q, '', 'question').reason, 'empty');
});

// ---- never-less-confident -----------------------------------------------------------
const DEBRIEFS = [
  { text: 'You answered the question well and your example was specific. Next time, add one number that shows the result.',
    good: 'You answered the question well, and your example was specific. Next time, add one number that shows the result.',
    bad: ['You failed to give a number, and your example was vague. Next time, add one number that shows the result.',
      'Your example was weak. Next time, add one number that shows the result.',
      'You answered the question well and your example was specific.'] },
  { text: 'Strong opening. You named your own part clearly. Try ending with what changed because of you.',
    good: 'Strong opening. You named your own part clearly. Try ending with what changed because of you.',
    bad: ['You rambled at the start. Try ending with what changed because of you.',
      'Strong opening. You never named your own part. Try ending with what changed because of you.'] },
  { text: 'Good, clear story about the Spa team. You could say how many people you led, for example 12.',
    good: 'A good, clear story about the Spa team. You can say how many people you led, for example 12.',
    bad: ['You did not say how many people you led at the Spa, for example 12.',
      'Good story about the team. You could say how many people you led, for example 14.'] },
];

test('never less confident: every strength stays first, the next step stays, nothing is harsher', () => {
  for (const sample of DEBRIEFS) {
    for (const kind of ['debrief', 'coaching']) {
      const ok = checkPlain(sample.text, sample.good, kind);
      assert.equal(ok.ok, true, `${kind}: ${sample.good} -> ${ok.reason}`);
      for (const bad of sample.bad) {
        assert.equal(checkPlain(sample.text, bad, kind).ok, false, `${kind} should reject: ${bad}`);
      }
    }
  }
});

test('never less confident end to end: a harsh model rewrite is thrown away for a safe fallback', async () => {
  for (const sample of DEBRIEFS) {
    const harsh = await translatePlain({ text: sample.text, kind: 'debrief', model: fakePlainModel(sample.bad[0]) });
    assert.equal(harsh.source, 'decoder');
    assert.equal(harsh.text, null, 'the original stays on screen');
    const kind = await translatePlain({ text: sample.text, kind: 'debrief', model: fakePlainModel(sample.good) });
    assert.equal(kind.source, 'model');
    assert.equal(kind.text, sample.good);
  }
});

// ---- translate, cache, fallback ----------------------------------------------------
test('translatePlain: model result is cached by text hash; a second ask costs no model call', async () => {
  const model = fakePlainModel(GOOD_QUESTION);
  const cache = memoryCache();
  const first = await translatePlain({ text: QUESTION, kind: 'question', model, cache, secret: KEY });
  assert.equal(first.source, 'model');
  assert.equal(model.calls, 1);
  assert.equal(cache.map.size, 1);
  const stored = [...cache.map.values()][0];
  assert.equal(stored.includes('pile up'), false, 'stored sealed, not readable');
  const hit = await cachedPlain(cache, QUESTION, 'question', KEY);
  assert.equal(hit.source, 'cache');
  assert.equal(hit.text, GOOD_QUESTION);
  assert.equal(await cachedPlain(cache, `${QUESTION} `, 'question', KEY), null, 'different text, different key');
  assert.notEqual(plainCacheKey(QUESTION, 'question', KEY), plainCacheKey(QUESTION, 'debrief', KEY));
  assert.equal(openPlain(sealPlain({ a: 1 }, 'x', 'question'), 'y', 'question'), null);
});

test('translatePlain falls back to the decoder when the model fails, errors, or is capped', async () => {
  const bad = await translatePlain({ text: QUESTION, kind: 'question', model: fakePlainModel('Tell me about 7 things?') });
  assert.equal(bad.source, 'decoder'); assert.match(bad.degraded, /number_added|name_/);
  assert.ok(bad.glossary.some((item) => /bottleneck/i.test(item.term)));
  const boom = await translatePlain({ text: QUESTION, kind: 'question', model: fakePlainModel(new Error('503')) });
  assert.equal(boom.source, 'decoder');
  const none = await translatePlain({ text: QUESTION, kind: 'question', model: null });
  assert.equal(none.source, 'decoder'); assert.equal(none.degraded, 'no_model');
  const capped = await translatePlain({ text: QUESTION, kind: 'question', model: fakePlainModel(GOOD_QUESTION), allowModel: false });
  assert.equal(capped.degraded, 'capped');
});

test('plain retries a guardrail failure once, then safely simplifies known terms without adding facts', async () => {
  let calls = 0;
  const retryModel = { async generate(_task, _prompt, schema) {
    calls += 1;
    const data = { plain: calls === 1 ? 'Tell me about 7 things?' : GOOD_QUESTION };
    assert.ok(schema(data)); return { data };
  } };
  const retried = await translatePlain({ text: QUESTION, kind: 'question', model: retryModel });
  assert.equal(retried.source, 'model');
  assert.equal(calls, 2);

  const source = 'The stakeholder needs a KPI before the escalation.';
  const fallback = await translatePlain({ text: source, kind: 'scenario', model: fakePlainModel(new Error('offline')) });
  assert.equal(fallback.source, 'decoder');
  assert.match(fallback.text, /people who care about the outcome/);
  assert.match(fallback.text, /numbers they watch/);
  assert.match(fallback.text, /problem passed up/);
});

test('prompt carries the voice rules and the kind rules', () => {
  const q = plainPrompt(QUESTION, 'question');
  assert.match(q, /In plain words:/); assert.match(q, /Never use em dashes/); assert.match(q, /Add no new facts/);
  assert.match(plainPrompt('x', 'debrief'), /strength first/);
});

test('same lane as the app: no key means no model, Vertex wins when set, lite model', () => {
  assert.equal(plainAdapter(null, {}), null);
  assert.equal(plainAdapter(null, { NETLIFY: 'true', GEMINI_API_KEY: 'local-only' }), null);
  const adapter = plainAdapter(null, { VERTEX_API_KEY: 'v', GEMINI_API_KEY: 'g' });
  assert.equal(adapter.env.VERTEX_API_KEY, 'v');
  assert.equal(adapter.env.GEMINI_MODEL_PRIMARY, 'gemini-3.5-flash-lite');
});

// ---- the API op --------------------------------------------------------------------
function request(op, body, cookie, method = 'POST') {
  return new Request(`http://localhost/api?op=${op}`, { method,
    headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-coach-csrf': '1', ...(cookie ? { cookie } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}

test('op=plain: needs a guest flag or a session, works for both, validates input', async () => {
  const { db, repo } = await setup();
  try {
    const plainModel = fakePlainModel(GOOD_QUESTION);
    const handler = createHandler({ repo, model: { generate: () => { throw new Error('main model must not run'); } },
      plainModel, plainCache: memoryCache(), env: { ABUSE_HMAC_KEY: KEY } });
    const body = { text: QUESTION, kind: 'question' };
    assert.equal((await handler(request('plain', body))).status, 401);

    const guest = await handler(request('plain', { ...body, guest: true }));
    assert.equal(guest.status, 200);
    const guestData = await guest.json();
    assert.equal(guestData.result.text, GOOD_QUESTION);
    assert.equal(guestData.state, undefined, 'no guest state goes back');

    const signup = await handler(request('signup', { username: 'plainuser', password: 'fictional-passphrase' }));
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    const signedIn = await handler(request('plain', { text: 'Tell me about a different thing?', kind: 'followup' }, cookie));
    assert.equal(signedIn.status, 200);

    assert.equal((await handler(request('plain', { text: QUESTION, kind: 'nonsense', guest: true }))).status, 400);
    assert.equal((await handler(request('plain', { text: '  ', kind: 'question', guest: true }))).status, 400);
    assert.equal((await handler(request('plain', {}, cookie, 'GET'))).status, 405);
    // Over the size limit: decoder only, no model call.
    const before = plainModel.calls;
    const huge = await (await handler(request('plain', { text: 'process '.repeat(1000), kind: 'scenario', guest: true }))).json();
    assert.equal(huge.result.source, 'decoder');
    assert.equal(plainModel.calls, before);
  } finally { await db.close(); }
});

test('op=plain: cache hit skips the model; per-person cap falls back to the decoder', async () => {
  const { db, repo } = await setup();
  try {
    const plainModel = fakePlainModel(GOOD_QUESTION);
    const handler = createHandler({ repo, model: null, plainModel, plainCache: memoryCache(), env: { ABUSE_HMAC_KEY: KEY } });
    const ask = async (text = QUESTION) => (await (await handler(request('plain', { text, kind: 'question', guest: true }))).json()).result;
    assert.equal((await ask()).source, 'model');
    assert.equal((await ask()).source, 'cache');
    assert.equal(plainModel.calls, 1);
    // Burn the hourly allowance with distinct texts, then confirm the model stops being called.
    for (let i = 0; i < 125; i += 1) await repo.abuse('plain', 'x', 1, 60); // unrelated subject, no effect
    let capped = null;
    for (let i = 0; i < 130 && !capped; i += 1) {
      const result = await ask(`Tell me about situation number ${i + 1}, ${i} times?`);
      if (result.degraded === 'capped') capped = result;
    }
    assert.ok(capped, 'cap reached');
    assert.equal(capped.source, 'decoder');
  } finally { await db.close(); }
});

test('the plain model never touches the paid spend ledger rows of the main model', async () => {
  const { db, repo } = await setup();
  try {
    const handler = createHandler({ repo, model: null, plainModel: fakePlainModel(GOOD_QUESTION),
      plainCache: null, env: { ABUSE_HMAC_KEY: KEY } });
    const res = await handler(request('plain', { text: QUESTION, kind: 'question', guest: true }));
    assert.equal(res.status, 200);
    assert.equal((await repo.sql('SELECT count(*)::int AS n FROM spend_days'))[0].n, 0);
  } finally { await db.close(); }
});

// ---- browser logic (toggle persistence, per-turn button) ----------------------------
function fakeDoc() {
  const make = (tag) => {
    const el = { tag, children: [], attrs: {}, dataset: {}, listeners: {}, className: '', hidden: false, disabled: false,
      _text: '', isConnected: true,
      set textContent(value) { this._text = String(value); this.children = []; },
      get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); },
      append(...kids) { this.children.push(...kids); },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); },
      click() { for (const fn of this.listeners.click ?? []) fn(); },
      classList: { toggle() {} } };
    return el;
  };
  return { createElement: make };
}
const storage = () => { const map = new Map(); return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };
const settle = async (ready) => {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, 'Plain English UI did not reach its completed state');
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const part = (wrap, cls) => wrap.children.find((child) => child.className.split(' ').includes(cls));

test('Plain English is OFF by default, remembered when turned on, and survives a reload', async () => {
  const local = storage();
  const make = () => createPlainEnglish({ fetchPlain: async () => ({ text: 'x', source: 'model', glossary: [] }),
    doc: fakeDoc(), session: storage(), local });
  const first = make();
  assert.equal(first.isOn(), false);
  const button = fakeDoc().createElement('button');
  bindPlainToggle(button, first);
  assert.equal(button.attrs['aria-checked'], 'false');
  assert.match(button.textContent, /Off/);
  button.click();
  assert.equal(first.isOn(), true);
  assert.equal(local.map.get(PLAIN_SETTING_KEY), 'on');
  assert.equal(make().isOn(), true, 'persisted');
  button.click();
  assert.equal(make().isOn(), false);
});

test('per-turn button toggles original and plain, fetches once, and remembers', async () => {
  let fetches = 0;
  const plain = createPlainEnglish({ doc: fakeDoc(), session: storage(), local: storage(),
    fetchPlain: async () => { fetches += 1; return { text: GOOD_QUESTION, source: 'model', glossary: [] }; } });
  const wrap = plain.plainSpan(QUESTION, 'question');
  const body = part(wrap, 'plain-text'); const button = part(wrap, 'plain-btn');
  assert.equal(body.textContent, QUESTION);
  button.click(); await settle(() => !button.disabled);
  assert.equal(body.textContent, GOOD_QUESTION.replace(/^In plain words: /, ''));
  assert.equal(button.textContent, 'Show original');
  button.click(); await settle(() => !button.disabled);
  assert.equal(body.textContent, QUESTION);
  assert.equal(button.textContent, 'Say it plain');
  button.click(); await settle(() => !button.disabled);
  assert.equal(body.textContent, GOOD_QUESTION.replace(/^In plain words: /, ''));
  assert.equal(fetches, 1, 'second press uses the remembered result');
});

test('global switch flips every message, shows the decoder hints on failure, and restores originals', async () => {
  const plain = createPlainEnglish({ doc: fakeDoc(), session: storage(), local: storage(),
    fetchPlain: async (text) => { if (/boom/.test(text)) throw new Error('offline');
      return { text: `plain ${text}`, source: 'model', glossary: [] }; } });
  const a = plain.plainSpan('Question A', 'question');
  const b = plain.plainSpan('Debrief B', 'debrief');
  const c = plain.plainSpan('Fix the boom bottleneck', 'scenario');
  plain.setOn(true); await settle(() => part(a, 'plain-text').textContent === 'plain Question A' && part(b, 'plain-text').textContent === 'plain Debrief B' && !part(c, 'plain-btn').disabled);
  assert.equal(part(a, 'plain-text').textContent, 'plain Question A');
  assert.equal(part(b, 'plain-text').textContent, 'plain Debrief B');
  assert.equal(part(c, 'plain-text').textContent, 'Fix the boom bottleneck', 'failure keeps the original');
  assert.match(part(c, 'plain-hints').textContent, /bottleneck/);
  assert.equal(part(a, 'plain-btn').textContent, 'Show original');
  part(a, 'plain-btn').click(); await settle(() => part(a, 'plain-text').textContent === 'Question A');
  assert.equal(part(a, 'plain-text').textContent, 'Question A', 'per-message Show original works while on');
  plain.setOn(false); await settle(() => part(b, 'plain-text').textContent === 'Debrief B');
  assert.equal(part(b, 'plain-text').textContent, 'Debrief B');
  assert.equal(part(c, 'plain-hints').hidden, true);
  assert.equal(part(b, 'plain-btn').textContent, 'Say it plain');
  // New messages render plain right away when the switch is on.
  plain.setOn(true);
  const d = plain.plainSpan('Later turn', 'question'); await settle(() => part(d, 'plain-text').textContent === 'plain Later turn');
  assert.equal(part(d, 'plain-text').textContent, 'plain Later turn');
});

// ---- voice ---------------------------------------------------------------------------
const planModel = { async generate(task, _p, schema) {
  const data = task === 'questions' ? { questions: ['Tell me about your work.', 'How do you lead?', 'What changed?'] } : null;
  if (!data) throw new Error(`unexpected ${task}`);
  return { data: schema(data) ? data : data, modelId: 'fake' };
} };
const voiceEnv = { RETELL_API_KEY: 'k', RETELL_GUEST_AGENT_ID: 'guest-agent', RETELL_AGENT_ID: 's', RETELL_WEBHOOK_KEY: 'w', DAILY_USD_CAP: '15' };

async function guestVoiceStart(plainEnglish, plainModel) {
  const { db, repo } = await setup();
  try {
    const guest = new GuestRepository();
    const jd = await guest.addSource('guest', 'jd', 'Posting', 'Regional Director of Operations. Lead studio GMs.');
    const workspace = await guest.addWorkspace('guest', jd.id, 'Regional Director');
    await guest.replaceRequirements('guest', workspace.id, jd.id, [{ quote: 'Lead studio GMs', start: 33, end: 48,
      type: 'must', competency: 'GM leadership', evidenceNeeded: 'example', category: 'none', rationale: 'none', factIds: [] }]);
    const calls = [];
    const fetchImpl = async (url, init = {}) => { calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ call_id: 'c1', access_token: 't1', transport: 'gateway', ice_servers: [] }) }; };
    await startGuestVoice({ repo, env: voiceEnv, fetchImpl, plainModel }, new CoachService(guest, planModel), 's',
      { workspaceId: workspace.id, ...(plainEnglish === undefined ? {} : { plainEnglish }) });
    return calls.find((call) => call.url.includes('create-web-call')).body.retell_llm_dynamic_variables;
  } finally { await db.close(); }
}

test('voice: Plain English interviewer is a per-call variable; off changes nothing', async () => {
  const off = await guestVoiceStart(undefined, fakePlainModel('x'));
  assert.equal(off.mode, 'mock');
  const lines = off.question_plan.split('\n');
  assert.ok(lines.includes('How do you lead?'));
  const stillOff = await guestVoiceStart(false, fakePlainModel('x'));
  assert.deepEqual(stillOff, off);

  const plainModel = fakePlainModel((prompt) => `In plain words: ${prompt.split('Text:\n')[1].replace('How do you lead?', 'how do you guide people?')}`);
  const on = await guestVoiceStart(true, plainModel);
  assert.match(on.mode, /^mock\. PLAIN ENGLISH INTERVIEWER IS ON/);
  assert.match(on.mode, /never rush/);
  assert.equal(on.question_plan, off.question_plan.replace('How do you lead?', 'how do you guide people?'));
  assert.equal(on.persona, off.persona);
});

test('voice: a question the guard rejects (or no free model) is asked as originally written', async () => {
  const unsafe = await plainQuestionPlan(['Tell me about the 3 stores you led.'], fakePlainModel('In plain words: tell me about stores?'));
  assert.deepEqual(unsafe, ['Tell me about the 3 stores you led.']);
  const none = await plainQuestionPlan(['How do you lead?'], null);
  assert.deepEqual(none, ['How do you lead?']);
  const off = await guestVoiceStart(undefined, null);
  const on = await guestVoiceStart(true, null);
  assert.match(on.mode, /PLAIN ENGLISH INTERVIEWER IS ON/);
  assert.equal(on.question_plan, off.question_plan);
});

test('session clearing cancels queued translations and rejects late private cache writes', async () => {
  const session = storage(), waiting = []; let dispatched = 0;
  const plain = createPlainEnglish({ doc: fakeDoc(), session, local: storage(),
    fetchPlain: async () => { dispatched++; return new Promise((resolve) => waiting.push(resolve)); } });
  const first = plain.translate('Private question A', 'question');
  const second = plain.translate('Private question B', 'question');
  const queued = plain.translate('Private question C', 'question');
  await settle(() => dispatched === 2);
  assert.equal(dispatched, 2);
  plain.clear();
  for (const resolve of waiting) resolve({ text: 'Private translated response', source: 'model', glossary: [] });
  await Promise.all([first, second, queued]);
  assert.equal(dispatched, 2, 'queued data never leaves the old session');
  assert.equal(session.map.size, 0, 'late provider results cannot repopulate a cleared browser cache');
});
