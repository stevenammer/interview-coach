import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('job hub renders the recommendation reason and exposes it to assistive technology', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  assert.match(html, /id="next-step-action"[^>]*aria-describedby="next-step-reason"/);
  assert.match(html, /<p id="next-step-reason" class="next-step-reason"><\/p>/);
  assert.match(app, /\$\('next-step-reason'\)\.textContent = next\.reason/);
});

test('job hub passes the live guest session into next-step selection', () => {
  const app = read('public/app.js');
  assert.match(app, /const next = chooseNextStep\(\{[\s\S]{0,500}\bguest\s*\}\)/);
});
