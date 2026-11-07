// Offline browser regressions. No model calls, account changes, or external requests.
// PLAYWRIGHT_DIR=/path/to/playwright node scripts/e2e/adversarial-browser.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_DIR ? pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`) : 'playwright');
const root = fileURLToPath(new URL('../../public/', import.meta.url));
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root)) { res.writeHead(404); res.end(); return; }
  try {
    const body = await readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.ttf': 'font/ttf' }[extname(file)];
    res.writeHead(200, { 'content-type': type ?? 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errors = [];
async function newPage({ user = null, seed = {}, logoutFails = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const calls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((seed) => { for (const [key, value] of Object.entries(seed)) sessionStorage.setItem(key, value); }, seed);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname !== '/api') return route.continue();
    const op = url.searchParams.get('op'); calls.push(op);
    if (op === 'session') return route.fulfill({ json: { user, voiceAvailable: false } });
    if (op === 'logout') {
      if (logoutFails) return route.fulfill({ status: 503, json: { message: 'Sign-out unavailable. Please retry.' } });
      user = null; return route.fulfill({ json: { result: { ok: true } } });
    }
    const results = { ledger: [], fact_conflicts: [], workspaces: [],
      real_feed: { prediction: { asked: 0 }, drillPriorities: [], digTargets: [], captures: [] } };
    if (!Object.hasOwn(results, op)) throw Error(`Unexpected API operation ${op}`);
    return route.fulfill({ json: { result: results[op] } });
  });
  await page.goto(base);
  return { context, page, calls };
}
try {
  for (const bad of ['{', '{"workspaces":{}}', '{"facts":[null]}', '[]']) {
    const { context, page } = await newPage({ seed: { 'interview-coach-guest': bad, 'interview-coach-job': '{' } });
    await page.waitForSelector('#landing:not([hidden])');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('interview-coach-guest')), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('interview-coach-job')), null);
    await context.close();
  }
  {
    const { context, page } = await newPage({ user: { id: 'owner-a', username: 'owner-a' }, logoutFails: true });
    await page.waitForSelector('#paste:not([hidden])');
    await page.locator('#end-session').click();
    await page.waitForFunction(() => document.querySelector('#message').textContent.includes('Sign-out unavailable'));
    assert.equal(await page.locator('#identity').textContent(), 'owner-a');
    assert.equal(await page.locator('#end-session').isVisible(), true);
    await context.close();
  }
  {
    const { context, page, calls } = await newPage({ user: { id: 'owner-a', username: 'owner-a' }, seed: { 'interview-coach-workspace': 'workspace-a' } });
    await page.waitForSelector('#ledger:not([hidden])');
    await page.locator('#app-rail a[href="#/review"]').click();
    await page.waitForSelector('#real-capture:not([hidden])');
    await page.evaluate(() => {
      window.__stoppedTracks = 0;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => ({ getTracks: () => [{ stop() { window.__stoppedTracks++; } }] }) });
      window.MediaRecorder = class {
        static isTypeSupported() { return true; }
        constructor() { this.state = 'inactive'; window.__recorder = this; }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; const callback = this.onstop; setTimeout(() => callback?.(), 0); }
      };
    });
    await page.locator('#capture-speak').click();
    await page.waitForFunction(() => window.__recorder?.state === 'recording');
    await page.locator('#end-session').click();
    await page.waitForSelector('#landing:not([hidden])');
    assert.equal(await page.evaluate(() => window.__recorder.state), 'inactive');
    assert.equal(await page.evaluate(() => window.__stoppedTracks), 1);
    assert.equal(calls.includes('transcribe_voice'), false, 'previous account audio must not reach transcription after logout');
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: corrupted storage recovery, failed logout stays honest, logout stops microphone and discards stale audio; no page errors.');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
