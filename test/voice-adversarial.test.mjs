import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { acceptVoiceWebhook, normalizeRetellTurns } from '../src/voice.js';
import { createVoiceBackgroundHandler } from '../netlify/functions/voice-process-background.mjs';
import { createWebhookHandler } from '../netlify/functions/retell-webhook.mjs';

const key = 'test-webhook-signing-key';
function signed(raw, now = Date.now()) {
  return { raw, now, signature: `v=${now},d=${createHmac('sha256', key).update(raw).update(String(now)).digest('hex')}` };
}

test('signed malformed webhook JSON values fail closed without database work', async () => {
  const repo = new Proxy({}, { get() { assert.fail('invalid event must not access the repository'); } });
  for (const raw of ['null', '42', 'true', '[]', '"event"']) {
    const result = await acceptVoiceWebhook({ repo, key, ...signed(raw) });
    assert.equal(result.status, 400);
  }
});

test('webhook stream rejects oversized byte payload before signature or database work', async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode('é'.repeat(76000));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
  const handler = createWebhookHandler({ repo: {}, env: { RETELL_WEBHOOK_KEY: key } });
  const result = await handler(new Request('https://example.test/webhook', { method: 'POST', body: stream, duplex: 'half' }));
  assert.equal(result.status, 413);
  assert.equal(cancelled, true);
});

test('bounded valid webhook body reaches signature validation unchanged', async () => {
  const event = signed('{"event":"other"}');
  const handler = createWebhookHandler({ repo: {}, env: { RETELL_WEBHOOK_KEY: key }, now: () => event.now });
  const result = await handler(new Request('https://example.test/webhook', { method: 'POST', body: event.raw,
    headers: { 'x-retell-signature': event.signature } }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { result: 'ignored' });
});

test('plain-text transcript normalization has the same turn bound as structured transcripts', () => {
  const turns = normalizeRetellTurns({ transcript: 'User: bounded answer\n'.repeat(1000) });
  assert.equal(turns.length, 200);
});


test('Retell provisioning rejects invalid caps and webhook URLs before any remote request', () => {
  const script = new URL('../scripts/retell/create-agent.mjs', import.meta.url);
  for (const [extraEnv, args, message] of [
    [{ SIGNED_IN_MAX_CALL_MINUTES: '-1' }, [], /minute limits/],
    [{ GUEST_MAX_CALL_MINUTES: 'NaN' }, [], /minute limits/],
    [{ SIGNED_IN_MAX_CALL_MINUTES: '1.5' }, [], /minute limits/],
    [{}, ['--webhook'], /HTTPS URL/],
    [{}, ['--webhook', 'http://example.test/hook'], /HTTPS URL/],
    [{}, ['--webhook', 'https://user:secret@example.test/hook'], /HTTPS URL/],
  ]) {
    const result = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8', timeout: 3000,
      env: { PATH: process.env.PATH, RETELL_API_KEY: 'synthetic-key-never-sent', ...extraEnv } });
    assert.equal(result.status, 1, String(result.error ?? result.stderr));
    assert.match(result.stderr, message);
    assert.equal(result.stderr.includes('user:secret'), false);
  }
});


test('voice background rejects oversized and primitive unauthenticated payloads before database access', async () => {
  const handler = createVoiceBackgroundHandler({ repo: new Proxy({}, { get() { assert.fail('must not access DB'); } }), model: null, key });
  for (const [body, expected] of [['null', 400], ['[]', 400], [' '.repeat(1025), 413]]) {
    const result = await handler(new Request('https://example.test/background', { method: 'POST', body }));
    assert.equal(result.status, expected);
  }
});
