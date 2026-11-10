import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_DAILY_USD_CAP } from '../src/spend-limits.js';

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('every public default-cap statement matches the code default', async () => {
  const [readme, envExample, spendGuards] = await Promise.all([
    text('../README.md'), text('../.env.example'), text('../docs/SPEND_GUARDS.md'),
  ]);
  const cap = String(DEFAULT_DAILY_USD_CAP);
  assert.match(readme, new RegExp('\\| `DAILY_USD_CAP` \\| No \\(default ' + cap + '\\) \\|'));
  assert.match(envExample, new RegExp('daily spend cap in USD for model calls \\(default ' + cap + ';'));
  assert.match(spendGuards, new RegExp('\\| Entire model and voice ledger \\| `DAILY_USD_CAP` \\| `' + cap + '` \\|'));
  assert.match(spendGuards, new RegExp('The daily ledger is `\\$' + cap + '` \\(`DAILY_USD_CAP`\\)\\.'));
});
