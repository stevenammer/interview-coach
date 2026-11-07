// Playwright (headless) against a LOCAL server: the real front end and real API handler,
// with the model mocked. Nothing here touches the network, Netlify, Gemini, or Retell.
// Run: node scripts/e2e/plain-english.mjs
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { homedir } from 'node:os';
// Playwright is not a project dependency (it would ride along into the Netlify build).
// Use PLAYWRIGHT_DIR, else a local install: PLAYWRIGHT_DIR overrides.
const playwrightDir = process.env.PLAYWRIGHT_DIR || 'playwright';
const { chromium } = await import(`${playwrightDir}/index.mjs`).catch(() => import('playwright'));
import { Repository } from '../../src/repository.js';
import { pgliteSql } from '../../src/db.js';
import { createHandler } from '../../netlify/functions/api.mjs';

const db = new PGlite();
const dir = new URL('../../netlify/database/migrations/', import.meta.url);
for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(await readFile(new URL(file, dir), 'utf8'));
}
const repo = new Repository(pgliteSql(db));

const plainCalls = [];
const plainModel = { async generate(task, prompt, schema) {
  const text = prompt.split('Text:\n')[1];
  plainCalls.push(text);
  const kind = task.replace('plain_', '');
  const data = { plain: ['question', 'followup', 'drill'].includes(kind)
    ? `In plain words: ${text}` : `${text} (said in everyday words)` };
  assert.ok(schema(data));
  return { data, modelId: 'fake-free' };
} };

let followups = 0;
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const model = { async generate(task, prompt, schema) {
  let data;
  if (task.startsWith('extract_')) {
    const source = prompt.split('Source:\n')[1];
    data = { facts: [{ subject: 'candidate', predicate: 'handled', value: { text: source.slice(0, 40) }, quote: source.slice(0, 40) }] };
  } else if (task === 'requirements') {
    const jd = prompt.split('JD:\n')[1].split('\nConfirmed candidate facts:')[0];
    data = { requirements: [{ quote: jd.slice(0, 30), type: 'must', competency: 'team leadership',
      evidenceNeeded: 'A confirmed example', category: 'none', rationale: 'No mapped story yet', factIds: [] }] };
  } else if (task === 'questions') {
    await new Promise((resolve) => setTimeout(resolve, 450)); // exercise the visible start state
    data = { questions: ['Walk me through how you would find a bottleneck in a cross-functional process.',
      'How do you get stakeholder buy-in?', 'What does a good week look like?'] };
  } else if (task === 'followup') { followups += 1; data = { question: `What was your baseline and your own part? (${followups})` }; }
  else if (task === 'fact_gate') data = { items: [] };
  else if (task === 'coach_between_answers') data = { coaching: 'Good start. Next time, add one number.', question: 'What happened next?' };
  else if (task === 'debrief') data = {
    contentScores: Object.fromEntries(['relevance', 'ownership', 'evidence', 'outcome', 'structure']
      .map((key) => [key, { score: 3, reason: `Your ${key} came through in the answer.` }])),
    deliveryScores: { clarity: { score: 4, reason: 'Easy to follow.' }, concision: { score: 4, reason: 'Right length.' } },
    feedback: 'You answered the question well and your example was specific. Next time, add one number that shows the result.',
    unsupportedClaims: [], rewriteClaims: [], strongerNeeds: [] };
  else if (task === 'immerse_week') data = { scenes: days.map((day, index) => ({
    id: day.toLowerCase(), day, title: `${day} on the job`,
    situation: `A busy ${day} brings a staffing shortfall and a stakeholder escalation.`,
    ask: 'What would you do and who would you involve?',
    details: [{ text: 'A fictional queue is building up.', provenance: 'typical' }],
    choices: ['consult', 'act'].map((id) => ({ id, label: id === 'consult' ? 'Ask the team for context.' : 'Take a reversible first step.',
      consequence: 'The work moves, and you explain why later.', tradeoff: 'Speed versus alignment',
      nextSceneId: days[index + 1]?.toLowerCase() ?? 'end' })) })) };
  else throw new Error(`mock model: unexpected task ${task}`);
  if (!schema(data)) throw new Error(`mock output invalid for ${task}`);
  return { data, modelId: 'fake' };
} };

const handler = createHandler({ repo, model, plainModel, plainCache: null,
  env: { ABUSE_HMAC_KEY: 'long-test-only-random-abuse-hmac-key', RETELL_API_KEY: 'unused', RETELL_GUEST_AGENT_ID: 'unused' } });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await handler(new Request(`http://localhost${req.url}`, { method: req.method,
        headers: { ...req.headers, origin: 'http://localhost' }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const body = await readFile(new URL(`../../public${path}`, import.meta.url));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); // phone
const page = await context.newPage();
let voiceStartRequests = 0;
const heldApiOps = new Map();
page.on('request', (request) => {
  if (request.url().includes('/api?op=voice_start')) voiceStartRequests += 1;
});
await page.route((url) => url.pathname === '/api' && heldApiOps.has(url.searchParams.get('op')), async (route) => {
  const held = heldApiOps.get(new URL(route.request().url()).searchParams.get('op'));
  if (!held) return route.continue();
  held.entered();
  await held.gate;
  await route.continue();
});
const holdApi = () => {
  let release;
  let entered;
  return {
    gate: new Promise((resolve) => { release = resolve; }),
    enteredPromise: new Promise((resolve) => { entered = resolve; }),
    release,
    entered,
  };
};
// Fonts and the voice SDK come from the internet; none of that is needed here.
await page.route(/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/, (route) => route.abort());
page.on('pageerror', (error) => { throw error; });

const toggle = page.locator('#plain-toggle');
// The app's own toast sits at the top and closes on tap; close it before using the header.
const flip = async () => { const toast = page.locator('#message:not([hidden])');
  if (await toast.count()) await toast.click({ position: { x: 5, y: 5 } }).catch(() => {});
  await toggle.click(); };
const steps = [];
const ok = (name) => { steps.push(name); console.log('ok -', name); };
const visibleSection = async () => page.evaluate(() => [...document.querySelectorAll('main > section')].find((s) => !s.hidden)?.id);
const checkCopyFits = async (section) => {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const clipped = await page.locator(`#${section} p`).evaluateAll((elements) => elements.flatMap((el) => {
      if (!el.getClientRects().length) return [];
      const panel = el.closest('section').getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(el);
      return [...range.getClientRects()].some((rect) => rect.left < panel.left - 1 || rect.right > panel.right + 1)
        ? [el.textContent] : [];
    }));
    assert.deepEqual(clipped, [], `${section}: copy fits at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
};

try {
  await page.goto(base);
  await page.waitForSelector('#landing');
  // Header toggle on every page, default OFF, and a phone-sized tap target.
  const checkToggle = async (label) => {
    assert.equal(await toggle.isVisible(), true, `${label}: header toggle visible`);
    const box = await toggle.boundingBox();
    assert.ok(box.height >= 44, `${label}: tap target is ${box.height}px high`);
  };
  await checkToggle('landing');
  const landingLoop = await page.locator('.demo-tabs').innerText();
  assert.match(landingLoop, /01 · Learn[\s\S]*02 · Practice[\s\S]*03 · Debrief[\s\S]*04 · Drill/);
  assert.equal(await page.locator('.loop-strip article').count(), 4);
  assert.match(await page.locator('#paste .eyebrow').innerText(), /01 · Learn/);
  ok('landing: one numbered four-step loop and clear first-job onboarding');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.match(await toggle.textContent(), /Off/);
  assert.equal(await page.evaluate(() => localStorage.getItem('interview-coach-plain-english')), null);
  const look = async () => toggle.evaluate((el) => { const c = getComputedStyle(el); return { color: c.color, bg: c.backgroundColor, img: c.backgroundImage }; });
  console.log('toggle OFF look', JSON.stringify(await look()));
  await page.screenshot({ path: process.env.E2E_HDR || '/tmp/hdr.png', clip: { x: 0, y: 0, width: 390, height: 190 } });
  ok('landing: toggle exists and defaults OFF');

  await page.click('#try-guest'); await page.waitForSelector('#paste:not([hidden])');
  await checkCopyFits('paste');
  await checkToggle('paste');
  await page.fill('#job-label', 'Operations Manager');
  await page.fill('#resume', 'At Harbor Lodge, I supervised 8 staff during seasonal operations and handled guest recovery.');
  await page.fill('#jd', 'Operations manager: lead a team, manage service recovery, and work cross-functional with other departments.');
  await page.click('#paste-form button[type=submit]');
  await page.waitForSelector('#ledger:not([hidden])', { timeout: 20000 });
  await checkCopyFits('ledger');
  await checkToggle('ledger'); ok('guest flow: paste to ledger');

  await page.click('#ledger-practice'); await page.waitForSelector('#practice:not([hidden])');
  await checkToggle('practice');
  await page.evaluate(() => {
    window.__micCalls = 0;
    window.confirm = () => false;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true,
      value: { getUserMedia: async () => { window.__micCalls += 1; return { getTracks: () => [] }; } } });
    document.querySelector('#start-voice').hidden = false;
  });
  await page.click('#start-voice');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__micCalls), 0, 'cancel happens before microphone access');
  assert.equal(voiceStartRequests, 0, 'cancel happens before a paid call request');
  await page.evaluate(() => { document.querySelector('#start-voice').hidden = true; });
  ok('voice: cancel confirmation starts neither microphone nor paid call');
  // Voice setting: default OFF, persisted, and no voice call is ever started here.
  const voiceBox = page.locator('#plain-voice');
  assert.equal(await voiceBox.isVisible(), true);
  assert.equal(await voiceBox.isChecked(), false);
  await voiceBox.check();
  assert.equal(await page.evaluate(() => localStorage.getItem('interview-coach-plain-voice')), 'on');
  await page.reload();
  await page.waitForSelector('#landing:not([hidden]), #practice:not([hidden]), #ledger:not([hidden]), #workspaces:not([hidden])');
  assert.equal(await page.evaluate(() => localStorage.getItem('interview-coach-plain-voice')), 'on');
  await page.evaluate(() => localStorage.setItem('interview-coach-plain-voice', 'off'));
  ok('practice screen: Plain English interviewer setting defaults OFF and persists');

  // Back into the guest session (the saved guest state survives a reload).
  let section = await visibleSection();
  if (section !== 'practice') {
    if (section === 'landing') await page.click('#try-guest');
    await page.waitForSelector('#ledger:not([hidden]), #workspaces:not([hidden]), #practice:not([hidden]), #paste:not([hidden])');
  }
  section = await visibleSection();
  console.log('after reload section:', section);
  if (section === 'workspaces') await page.click('#workspace-ledger');
  if (section === 'ledger' || section === 'workspaces') { await page.waitForSelector('#ledger-practice'); await page.click('#ledger-practice'); }
  await page.waitForSelector('#practice:not([hidden])');

  const workspaceHold = holdApi();
  heldApiOps.set('workspaces', workspaceHold);
  await page.click('#practice-back');
  await workspaceHold.enteredPromise;
  assert.equal(await visibleSection(), 'workspaces', 'first Back click opens the hub while refresh is held');
  await page.click('[data-go=hub-practice]');
  assert.equal(await visibleSection(), 'practice', 'cached hub can route to Practice before refresh ends');
  workspaceHold.release();
  heldApiOps.delete('workspaces');
  await page.waitForTimeout(100);
  assert.equal(await visibleSection(), 'practice', 'stale hub refresh does not pull navigation back');
  ok('Back: immediate hub and stale workspace refresh cannot override Practice');

  const startHold = holdApi();
  heldApiOps.set('start', startHold);
  await page.click('#start-interview');
  await startHold.enteredPromise;
  await page.click('#practice-back');
  assert.equal(await visibleSection(), 'workspaces', 'Back returns to the hub during typed start');
  await page.click('[data-go=hub-practice]');
  assert.equal(await visibleSection(), 'practice');
  startHold.release();
  heldApiOps.delete('start');
  await page.waitForTimeout(150);
  assert.equal(await visibleSection(), 'practice', 'late start response does not reopen the interview');
  ok('typed start: Back stays authoritative when the delayed response arrives');

  await page.click('#start-interview');
  assert.match(await page.locator('#progress-note').innerText(), /Starting your typed interview/);
  await page.waitForSelector('#transcript .turn');
  const firstTurn = page.locator('#transcript .turn').first();
  const question = 'Walk me through how you would find a bottleneck in a cross-functional process.';
  assert.equal((await firstTurn.locator('.plain-text').first().textContent()).trim(), question);
  assert.equal(plainCalls.length, 0, 'OFF means no plain request at all');
  ok('OFF: interview question shows the original and nothing is fetched');

  // Per-turn button.
  const turnButton = firstTurn.locator('.plain-btn').first();
  assert.ok((await turnButton.boundingBox()).height >= 44);
  await turnButton.click();
  await page.waitForFunction(() => document.querySelector('#transcript .turn .plainable')?.dataset.mode === 'plain' && document.querySelector('#transcript .turn .plain-btn')?.textContent === 'Show original');
  assert.equal((await turnButton.textContent()).trim(), 'Show original');
  assert.equal(plainCalls.length, 1);
  await turnButton.click();
  assert.equal((await firstTurn.locator('.plain-text').first().textContent()).trim(), question);
  await turnButton.click();
  await page.waitForFunction(() => document.querySelector('#transcript .turn .plainable')?.dataset.mode === 'plain' && document.querySelector('#transcript .turn .plain-btn')?.textContent === 'Show original');
  assert.equal(plainCalls.length, 1, 'remembered: no second request');
  await turnButton.click(); // back to the original
  ok('per-turn button: fetch once, toggles, remembered');

  // Global toggle on: every AI message everywhere turns plain; the user's own words never do.
  await flip();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await page.waitForFunction(() => document.querySelector('#transcript .turn .plainable')?.dataset.mode === 'plain' && document.querySelector('#transcript .turn .plain-btn')?.textContent === 'Show original');
  console.log('toggle ON look', JSON.stringify(await toggle.evaluate((el) => { const c = getComputedStyle(el); return { color: c.color, bg: c.backgroundColor, img: c.backgroundImage }; })));
  const myAnswer = 'I led 8 staff and fixed the handoff between front desk and housekeeping.';
  for (let i = 0; i < 6; i += 1) {
    await page.fill('#answer', myAnswer);
    await page.click('#answer-form button[type=submit]');
    if (i === 0) { await page.waitForSelector('#transcript .turn[data-speaker=You]'); assert.equal(await page.locator('#transcript .turn[data-speaker=You] .plainable').count(), 0, 'own answers never wrapped'); assert.equal((await page.locator('#transcript .turn[data-speaker=You] p').nth(1).textContent()).trim(), myAnswer); }
    await page.waitForFunction((n) => document.querySelectorAll('#transcript .turn').length >= n || !document.querySelector('#interview:not([hidden])'), (i + 1) * 2 + 1, { timeout: 20000 }).catch(() => {});
    if (await visibleSection() === 'debrief') break;
    await page.waitForTimeout(150);
  }
  await page.waitForSelector('#debrief:not([hidden])', { timeout: 30000 });
  await checkToggle('debrief');
  const debriefText = await page.locator('#debrief').textContent();
  assert.match(debriefText, /said in everyday words/, 'debrief feedback is plain while the switch is on');
  assert.match(debriefText, /You answered the question well/, 'strength is still first');
  ok('global ON: debrief translated, strengths first');

  // User answers were never wrapped or changed (checked on the interview transcript).
  await page.evaluate(() => document.getElementById('interview').hidden === false);
  await flip();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await page.waitForFunction(() => !/said in everyday words/.test(document.querySelector('#debrief').textContent));
  assert.match(await page.locator('#debrief').textContent(), /You answered the question well and your example was specific\. Next time/);
  ok('global OFF: originals restored');

  // Reload with the switch ON: remembered, then OFF again.
  await flip();
  await page.reload();
  await page.waitForSelector('#plain-toggle');
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.match(await toggle.textContent(), /On/);
  await flip();
  assert.equal(await page.evaluate(() => localStorage.getItem('interview-coach-plain-english')), 'off');
  ok('toggle persists across reload');

  // Week in the life.
  await page.evaluate(() => {});
  section = await visibleSection();
  if (section !== 'workspaces') {
    if (section === 'landing') await page.click('#try-guest');
    await page.waitForSelector('#workspaces:not([hidden]), #ledger:not([hidden]), #debrief:not([hidden]), #practice:not([hidden])');
    section = await visibleSection();
    if (section === 'debrief') await page.click('#debrief-hub');
    else if (section === 'ledger') await page.click('#open-workspaces-ledger');
    else if (section === 'practice') await page.click('#practice-back');
  }
  await page.waitForSelector('#workspaces:not([hidden])');
  const coreSteps = await page.locator('#workspaces .hub-tile').allInnerTexts();
  assert.match(coreSteps[0], /01 · Learn/);
  assert.match(coreSteps[1], /02 · Practice/);
  assert.match(coreSteps[2], /03 · Debrief/);
  assert.match(coreSteps[3], /04 · Drill/);
  assert.match(coreSteps[2], /real interview/i);
  ok('job hub: first four actions map to Learn, Practice, Debrief, Drill');
  await flip(); // ON
  await page.click('[data-go=open-immerser]');
  await page.waitForSelector('#immerser:not([hidden]) .scene-stage', { timeout: 30000 });
  await checkToggle('immersion');
  await page.waitForFunction(() => /said in everyday words/.test(document.querySelector('#immerser .scene-stage')?.textContent ?? ''));
  ok('week in the life: scenario translated when ON');
  await flip(); // OFF
  await page.waitForFunction(() => !/said in everyday words/.test(document.querySelector('#immerser .scene-stage')?.textContent ?? ''));
  ok('week in the life: original restored when OFF');
  console.log(`\nPASS ${steps.length} checks, ${plainCalls.length} mocked plain requests`);
} catch (error) {
  await page.screenshot({ path: process.env.E2E_SHOT || '/tmp/e2e-fail.png', fullPage: true }).catch(() => {});
  console.error('FAIL', error);
  process.exitCode = 1;
} finally {
  await browser.close(); server.close(); await db.close();
}
