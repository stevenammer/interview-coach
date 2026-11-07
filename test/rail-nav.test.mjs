import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('the rail has grouped, named routes and keeps private destinations available to signed-out visitors', async () => {
  const html = await read('public/index.html');
  assert.match(html, /<nav id="app-rail" aria-label="Interview Coach sections"/);
  for (const label of ['Start', 'Prepare', 'Practice']) assert.match(html, new RegExp(`>${label}</`));
  for (const route of ['start', 'story', 'jobs', 'facts', 'prep', 'writing', 'practice', 'immerser', 'review', 'drills']) {
    assert.match(html, new RegExp(`href="#/${route}"`));
  }
  assert.match(html, /href="#\/jobs" data-route="workspaces" data-private-route/);
  assert.match(html, /id="rail-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="app-rail"/);
});

test('navigation uses parent active states, start-first gating, hash routes, and a voice-call guard', async () => {
  const app = await read('public/app.js');
  assert.match(app, /const parentPanels = \{[\s\S]*voice-interview': 'practice'/);
  assert.match(app, /link\.toggleAttribute\('aria-current', link\.dataset\.route === panelRoutes\[active\]\)/);
  assert.match(app, /link\.toggleAttribute\('data-start-first', startFirst\)/);
  assert.match(app, /if \(!hasSession\(\) && !\['landing', 'start', 'auth'\]\.includes\(panel\)\) return show\('start'\)/);
  assert.match(app, /window\.addEventListener\('hashchange', routeFromHash\)/);
  assert.match(app, /if \(voiceClient && name !== 'voice-interview' && !confirm\('End the live voice call before leaving this screen\?'\)\) return false;/);
  assert.match(app, /if \(voiceClient && name !== 'voice-interview'\) stopVoice\(\);/);
});

test('the start page carries the approved steps and reuses the single fictional demo card', async () => {
  const html = await read('public/index.html');
  assert.match(html, /<section id="start" class="panel" hidden>/);
  assert.match(html, /<h1>How to use Interview Coach<\/h1>/);
  for (const text of ['Add a job.', 'Confirm your facts.', 'See how you match.', 'Practice the interview.', 'Read the debrief, then drill.', 'Walk in ready.']) {
    assert.match(html, new RegExp(text.replaceAll('.', '\\.')));
  }
  assert.equal((html.match(/id="demo-card"/g) ?? []).length, 1);
  assert.match(html, /id="start-own-resume"/);
});

test('the mobile rail is a focus-trapped drawer and reduced motion removes its transition', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/style.css')]);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /const focusable = \[\.\.\.rail\.querySelectorAll\('a\[href\], button:not\(\[disabled\]\)'\)\]/);
  assert.match(css, /@media \(max-width: 899px\)[\s\S]*#app-rail\.is-open/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ #app-rail \{ transition: none; \} \}/);
});
