import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('a new account goes straight to adding a job, while sign-in keeps the saved-jobs hub', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const handler = app.slice(app.indexOf("$('auth-form').addEventListener('submit'"), app.indexOf('// Shrink a screenshot'));
  assert.match(handler, /button\.value === 'signup'\) show\('paste'\)/);
  assert.match(handler, /else await openWorkspaceHub\(\)/);
});
