import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiAdapter, modelUserCapMicros } from '../src/model.js';
import { perUserDailyCapMicros } from '../src/repository.js';

test('at a low daily cap an account still gets only half for ordinary AI calls', () => {
  assert.equal(modelUserCapMicros(5_000_000, 250_000), 2_500_000);
  assert.equal(modelUserCapMicros(15_000_000, 250_000), 7_500_000);
});

test('the voice-sized minimum no longer hands one account the whole cap', () => {
  // The old call used a 30 minute voice reservation ($6) as the floor, so a $5 cap
  // meant an account could spend all $5 on ordinary AI calls.
  assert.equal(perUserDailyCapMicros(5_000_000), 5_000_000);
  assert.notEqual(modelUserCapMicros(5_000_000, 250_000), perUserDailyCapMicros(5_000_000));
});

test('the adapter uses the $15 default and passes its half-of-cap account limit to the ledger', async () => {
  const seen = [];
  const repo = {
    async reserve(task, micros, cap, key, now, owner, userCap) { seen.push({ cap, owner, userCap }); return 'r1'; },
    async settle() {},
  };
  const env = { GEMINI_API_KEY: 'key' };
  const body = { candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: {} };
  const adapter = new GeminiAdapter({ repo, env, fetchImpl: async () => new Response(JSON.stringify(body)) });
  await adapter.call('gemini-3.8-flash', 'test', 'hello', null, undefined, 'user-1');
  assert.equal(seen[0].cap, 15_000_000);
  assert.equal(seen[0].userCap, 7_500_000);
});
