import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterviewCache } from '../public/interview-cache.js';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { return map.get(key) ?? null; },
    setItem(key, value) { map.set(key, value); },
    removeItem(key) { map.delete(key); },
  };
}

test('interview cache is namespaced by owner and completion is explicit', () => {
  const storage = memoryStorage();
  const alice = createInterviewCache(storage, 'account:alice');
  const bob = createInterviewCache(storage, 'account:bob');
  alice.append('same-interview-id', { speaker: 'You', text: 'Private answer' });
  assert.equal(bob.read('same-interview-id'), null);
  assert.equal(alice.read('same-interview-id').finished, false);
  alice.markFinished('same-interview-id');
  assert.equal(alice.read('same-interview-id').finished, true);
  bob.append('another-interview', { speaker: 'You', text: 'Bob answer' });
  alice.clearNamespace();
  assert.equal(alice.read('same-interview-id'), null);
  assert.equal(bob.read('another-interview').turns[0].text, 'Bob answer');
});

test('corrupt data and unavailable or full session storage degrade without throwing', () => {
  const corrupt = memoryStorage();
  corrupt.setItem('interview-coach-turns:v2:account%3Atest:bad', '{');
  const cache = createInterviewCache(corrupt, 'account:test');
  assert.equal(cache.read('bad'), null);
  const unavailable = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('blocked'); },
    get length() { throw new Error('blocked'); },
  };
  const blocked = createInterviewCache(unavailable, 'guest:blocked');
  assert.equal(blocked.read('id'), null);
  assert.equal(blocked.append('id', { speaker: 'You', text: 'Answer' }), false);
  assert.equal(blocked.read('id').turns[0].text, 'Answer', 'the current page retains the answer when persistence fails');
  assert.equal(blocked.markFinished('id'), false);
  assert.doesNotThrow(() => blocked.clear('id'));
  assert.doesNotThrow(() => blocked.clearNamespace());
});
