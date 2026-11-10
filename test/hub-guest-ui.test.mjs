import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guestVoiceLimits } from '../src/voice.js';
import { publicWorkspaceLabel } from '../public/sample-workspace.js';

const root = new URL('..', import.meta.url);
const file = (name) => readFile(new URL(name, root), 'utf8');

test('an empty job hub stays on the hub and exposes only its add-job state', async () => {
  const app = await file('public/app.js');
  const html = await file('public/index.html');
  const render = app.slice(app.indexOf('async function renderWorkspaces'), app.indexOf('function setWorkspaceHubEmptyState'));

  assert.match(html, /id="empty-workspace-state"[^>]*>\s*<p>You don't have a job saved yet\.<\/p><button[^>]*>Add a job<\/button>/);
  assert.doesNotMatch(render, /if \(!workspaces\.length\) \{ show\('paste'\); return; \}/);
  assert.match(render, /if \(!workspaces\.length\) \{\s*currentWorkspace = null;\s*setWorkspaceHubEmptyState\(true\);\s*return;/);
  assert.match(app, /function openWorkspaceHub\(\) \{\s*show\('workspaces'\);\s*[\s\S]*setWorkspaceHubEmptyState\(true\);/);
});

test('hub buttons always have a name, including static and generated buttons', async () => {
  const [html, app] = await Promise.all([file('public/index.html'), file('public/app.js')]);
  const blankStaticButtons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter((match) => !match[2].replace(/<[^>]+>/g, '').trim() && !/aria-label\s*=/.test(match[1]));
  assert.deepEqual(blankStaticButtons, []);
  assert.doesNotMatch(app, /node\('button',\s*''/);
  for (const match of app.matchAll(/document\.createElement\('button'\)/g)) {
    const setup = app.slice(match.index, match.index + 220);
    assert.match(setup, /(?:textContent\s*=|setAttribute\('aria-label')/,
      `generated button at ${match.index} needs a label`);
  }
});

test('every Back to my job hub control opens the hub on its first click', async () => {
  const [html, app] = await Promise.all([file('public/index.html'), file('public/app.js')]);
  const ids = [...html.matchAll(/<button\s+id="([^"]+)"[^>]*>Back to (?:my )?job hub<\/button>/g)].map((match) => match[1]);
  assert.ok(ids.length > 0);
  for (const id of ids) {
    assert.match(app, new RegExp(`\\$\\('${id}'\\)\\.addEventListener\\('click', \\(\\) => openWorkspaceHub\\(\\)`));
  }
});

test('guest voice copy gets its limits from the same configuration as enforcement', async () => {
  assert.deepEqual(guestVoiceLimits({}), { maxMinutes: 5, callsPerDay: 2 });
  assert.deepEqual(guestVoiceLimits({ GUEST_VOICE_MAX_MINUTES: '7', GUEST_VOICE_CALLS_PER_DAY: '3' }),
    { maxMinutes: 7, callsPerDay: 3 });
  const [api, app] = await Promise.all([file('netlify/functions/api.mjs'), file('public/app.js')]);
  assert.match(api, /guestVoiceLimits: guestVoiceLimits\(env\)/);
  assert.match(app, /Text practice is subject to daily usage limits\./);
  assert.doesNotMatch(app, /Typing has no limit/);
});

test('a shortened user-facing job label ends with an ellipsis', async () => {
  const app = await file('public/app.js');
  assert.match(app, /function truncateLabel[\s\S]*?value\.length > limit \? `\$\{value\.slice\(0, Math\.max\(0, limit - 1\)\)\}…`/);
  assert.equal(publicWorkspaceLabel('Sales Lead', 'Acme'), 'Sales Lead at Acme');
  const long = publicWorkspaceLabel('Sales Lead'.repeat(20), 'Acme');
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});
