import test from 'node:test';
import assert from 'node:assert/strict';
import { readJsonObject } from '../src/request-body.js';
import { verifyPassword } from '../src/auth.js';
import { GuestRepository } from '../src/guest.js';

test('JSON reader limits actual streamed bytes without trusting a forged Content-Length', async () => {
  let canceled = false;
  const request = { body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"value":"'));
    controller.enqueue(new Uint8Array(100));
  }, cancel() { canceled = true; } }), headers: new Headers({ 'content-length': '1' }) };
  await assert.rejects(readJsonObject(request, 20), { status: 413 });
  assert.equal(canceled, true);
});

test('JSON reader rejects malformed JSON, arrays, null and primitives but accepts an exact byte boundary', async () => {
  const body = '{"text":"é"}';
  const request = () => new Request('http://localhost/api', { method: 'POST', body });
  assert.deepEqual(await readJsonObject(request(), Buffer.byteLength(body)), { text: 'é' });
  await assert.rejects(readJsonObject(request(), Buffer.byteLength(body) - 1), { status: 413 });
  for (const value of ['null', '[]', '1', '"text"', '{broken']) {
    await assert.rejects(readJsonObject(new Request('http://localhost/api', { method: 'POST', body: value }), 100), { status: 400 });
  }
});

test('guest collections and password verification refuse malformed shapes before work', async () => {
  for (const value of [null, [], { facts: {} }, { turns: [null] }, { writingProfile: [] }]) {
    assert.throws(() => new GuestRepository(value), { status: 400 });
  }
  assert.equal(await verifyPassword({}, 'scrypt-v1:salt:hash'), false);
  assert.equal(await verifyPassword('x'.repeat(201), 'scrypt-v1:salt:hash'), false);
});
