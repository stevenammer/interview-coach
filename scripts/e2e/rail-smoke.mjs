// Static browser smoke check. It never calls the app API or an external service.
// Run: PLAYWRIGHT_DIR=/path/to/playwright CHROME_PATH=/usr/bin/google-chrome node scripts/e2e/rail-smoke.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const candidates = [process.env.PLAYWRIGHT_DIR, 'playwright'].filter(Boolean);
let chromium;
for (const directory of candidates) {
  try { ({ chromium } = await import(pathToFileURL(`${directory}/index.mjs`))); break; } catch {}
}
if (!chromium) ({ chromium } = await import('playwright').catch(() => {
  throw Error('Set PLAYWRIGHT_DIR to an existing Playwright installation. This script never installs dependencies.');
}));

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const target = resolve(`${root}/public`, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(`${root}/public/`)) { res.writeHead(404); res.end(); return; }
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': contentTypes[extname(target)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const errors = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  // Offline harness: the font CDN is aborted on purpose and the static server has no /api, so ignore those two sources only.
  const harnessNoise = (url = '') => url.startsWith('https://fonts.googleapis.com/') || url.startsWith(`${base}/api`);
  page.on('console', (message) => { if (message.type() === 'error' && !harnessNoise(message.location().url)) errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.goto(base);
  await page.waitForSelector('#landing:not([hidden])');
  assert.ok(await page.locator('#app-rail').isVisible(), 'rail renders');
  for (const route of ['start', 'story']) {
    await page.locator(`#app-rail a[href="#/${route}"]`).first().click();
    await page.waitForSelector(route === 'start' ? '#start:not([hidden])' : '#landing:not([hidden])');
  }
  for (const route of ['jobs', 'facts', 'prep', 'writing', 'practice', 'immerser', 'review', 'drills']) {
    await page.locator(`#app-rail a[href="#/${route}"]`).click();
    await page.waitForSelector('#start:not([hidden])');
  }
  // A mobile drawer must scroll inside the viewport, including short landscape screens.
  for (const viewport of [{ width: 390, height: 640 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.locator('#rail-toggle').click();
    const rail = page.locator('#app-rail');
    const bounds = await rail.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
    }));
    assert.ok(bounds.height <= viewport.height, 'mobile menu fits the viewport');
    assert.ok(bounds.scrollHeight > bounds.clientHeight, 'short mobile menu has scrollable content');
    await rail.hover();
    await page.mouse.wheel(0, 2000);
    await page.waitForFunction(() => document.getElementById('app-rail').scrollTop > 0);
    const last = rail.locator('a[data-route]').last();
    const rect = await last.boundingBox();
    assert.ok(rect.y >= 0 && rect.y + rect.height <= viewport.height, 'last menu option is visible after scrolling');
    await last.click();
    await page.waitForSelector('#start:not([hidden])');
    assert.equal(await page.locator('#rail-toggle').getAttribute('aria-expanded'), 'false');
  }
  assert.deepEqual(errors, [], `console errors:\n${errors.join('\n')}`);
  console.log('PASS rail renders, public navigation works, private routes start at the guide, mobile menu scrolls to its last option, no console errors');
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
