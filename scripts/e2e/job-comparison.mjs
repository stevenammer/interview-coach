// Real UI and API integration; only a local PGlite DB and fake model are used.
// Run: node scripts/e2e/job-comparison.mjs
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { homedir } from 'node:os';
const playwrightDir = process.env.PLAYWRIGHT_DIR || 'playwright';
const { chromium } = await import(`${playwrightDir}/index.mjs`).catch(() => import('playwright'));
import { Repository } from '../../src/repository.js';
import { pgliteSql } from '../../src/db.js';
import { issueSession } from '../../src/auth.js';
import { createHandler } from '../../netlify/functions/api.mjs';

const db = new PGlite();
const migrations = new URL('../../netlify/database/migrations/', import.meta.url);
for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
  await db.exec(await readFile(new URL(file, migrations), 'utf8'));
}
const repo = new Repository(pgliteSql(db));
const user = await repo.createUser('comparison_browser', 'not-used');
const jdA = await repo.addSource(user.id, 'jd', 'Regional Director posting',
  'Regional Director\nBase salary is $80,000 to $95,000 plus annual bonus.\nMedical, dental and vision coverage.\nHybrid schedule.');
const jdB = await repo.addSource(user.id, 'jd', 'Studio Manager posting',
  'Studio Manager\nLead daily operations and coach a team.\nPaid time off and health coverage.');
const jobA = await repo.addWorkspace(user.id, jdA.id, 'Regional Director');
const jobB = await repo.addWorkspace(user.id, jdB.id, 'Studio Manager');
await repo.setVoiceContext(user.id, jobA.id, 'Regional Director', 'Example Studios');
await repo.setVoiceContext(user.id, jobB.id, 'Studio Manager', 'Studio North');
await repo.setWorkspacePreferences(user.id, jobA.id, 'remote', 'hybrid');
await repo.setInterviewDate(user.id, jobA.id, '2026-10-15T18:30:00.000Z');
await repo.replaceRequirements(user.id, jobA.id, jdA.id, [{ quote: 'coach a team', type: 'must',
  competency: 'leadership', evidenceNeeded: 'A confirmed example', category: 'none',
  rationale: 'No story yet', factIds: [], start: jdA.text.indexOf('Hybrid'), end: jdA.text.length }]);
await repo.replaceRequirements(user.id, jobB.id, jdB.id, [{ quote: 'coach a team', type: 'must',
  competency: 'leadership', evidenceNeeded: 'A confirmed example', category: 'none',
  rationale: 'No story yet', factIds: [], start: jdB.text.indexOf('coach a team'), end: jdB.text.indexOf('coach a team') + 'coach a team'.length }]);

const handler = createHandler({ repo, model: { generate: async (task) => { throw new Error(`Unexpected model call: ${task}`); } },
  env: { ABUSE_HMAC_KEY: 'local-browser-test-abuse-key-with-enough-length' } });
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await handler(new Request(`http://localhost${req.url}`, { method: req.method,
        headers: { ...req.headers, origin: 'http://localhost' },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    res.writeHead(200, { 'content-type': contentTypes[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(new URL(`../../public${path}`, import.meta.url)));
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const session = await issueSession(repo, user, false);
const cookie = session.cookie.split(';')[0].split('=');
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 950 } });
await context.addCookies([{ name: cookie[0], value: cookie.slice(1).join('='), url: base }]);
const page = await context.newPage();
page.on('pageerror', (error) => { throw error; });
await page.route(/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/, (route) => route.abort());
await page.addInitScript((id) => sessionStorage.setItem('interview-coach-workspace', id), jobA.id);
try {
  await page.goto(base);
  await page.waitForSelector('#ledger:not([hidden])');
  await page.click('#open-workspaces-ledger');
  await page.waitForSelector('#workspaces:not([hidden])');
  const comparison = page.locator('#job-comparison-table');
  await assert.doesNotReject(() => comparison.getByText('Base salary is $80,000 to $95,000 plus annual bonus.').waitFor());
  await assert.doesNotReject(() => comparison.getByText('Medical, dental and vision coverage.').waitFor());
  assert.match(await comparison.innerText(), /From job posting/);
  assert.match(await comparison.innerText(), /Not known yet/);
  assert.match(await comparison.innerText(), /Hybrid/);
  assert.match(await comparison.innerText(), /Oct 15, 2026/);

  await page.locator('#workspaces details:has(#job-comparison-form) > summary').click();
  await page.fill('#pay-details', '$92,000 plus a confirmed annual bonus');
  await page.fill('#benefits-details', 'Confirmed medical and dental');
  await page.fill('#learned-details', 'The team is opening two new studios.');
  await page.click('#job-comparison-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#job-comparison-table')?.innerText.includes('The team is opening two new studios.'));
  assert.match(await comparison.innerText(), /You added/);
  assert.match(await comparison.innerText(), /Confirmed medical and dental/);
  assert.doesNotMatch(await comparison.innerText(), /Base salary is \$80,000/);

  await page.locator('#workspace-list button').filter({ hasText: 'Studio Manager' }).click();
  await page.waitForFunction(() => document.querySelector('#hub-intro')?.textContent.includes('Studio Manager'));
  assert.match(await comparison.innerText(), /Not known yet/);
  assert.match(await comparison.innerText(), /Paid time off and health coverage\./);
  assert.equal(await page.inputValue('#pay-details'), '');
  await page.locator('#workspace-list button').filter({ hasText: 'Regional Director' }).click();
  await page.waitForFunction(() => document.querySelector('#hub-intro')?.textContent.includes('Regional Director'));
  await page.waitForFunction(() => document.querySelector('#pay-details')?.value.includes('$92,000'));
  assert.match(await comparison.innerText(), /The team is opening two new studios\./);
  await page.reload();
  await page.waitForSelector('#ledger:not([hidden])');
  await page.click('#open-workspaces-ledger');
  await page.waitForSelector('#workspaces:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#pay-details')?.value.includes('$92,000'));
  assert.match(await comparison.innerText(), /Paid time off and health coverage\./);
  assert.match(await comparison.innerText(), /\$92,000 plus a confirmed annual bonus/);
  assert.match(await comparison.innerText(), /The team is opening two new studios\./);
  console.log('ok - saved values and original posting quotes restore after reload');
  console.log('ok - source quotes, manual overrides, job switching, and saved values use the real app and API');

  await page.locator('#workspaces details:has(#job-comparison-form)').evaluate((el) => { el.open = false; });
  await page.locator('#message:not([hidden])').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.locator('.job-comparison').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -20));

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 1200 });
    const widths = await comparison.evaluate((el) => ({ client: el.clientWidth, content: el.scrollWidth }));
    assert.ok(widths.content <= widths.client + 1, `comparison fits ${width}px: ${JSON.stringify(widths)}`);
    await page.locator('.job-comparison').screenshot({ path: `/tmp/interview-coach-comparison-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.locator('.job-comparison').screenshot({ path: '/tmp/interview-coach-comparison-1440.png' });
  console.log('ok - actual app comparison layout captured at 320px, 390px, and 1440px');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await db.close();
}
