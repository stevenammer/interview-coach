import test from 'node:test';
import assert from 'node:assert/strict';
import { readStoredObject, readGuestState, originalExtension, dateTimeInputValue } from '../public/browser-state.js';

function store(value) {
  const entries = new Map([['state', value], ['other', 'keep']]);
  return { getItem: (k) => entries.get(k), removeItem: (k) => entries.delete(k), entries };
}
test('invalid saved JSON cannot block startup and only the broken record is removed', () => {
  for (const broken of ['{', 'null', '42', '[]', '"text"']) {
    const storage = store(broken);
    assert.equal(readStoredObject(storage, 'state'), null);
    assert.equal(storage.getItem('state'), undefined);
    assert.equal(storage.getItem('other'), 'keep');
  }
  assert.deepEqual(readStoredObject(store('{"id":"job1"}'), 'state'), { id: 'job1' });
  assert.deepEqual(readStoredObject({ getItem() { throw Error('denied'); }, removeItem() { throw Error('denied'); } }, 'state', {}), {});
});
test('guest recovery rejects broken collection shapes and preserves a valid practice workspace', () => {
  for (const value of [{ workspaces: {} }, { facts: [null] }, { sources: ['bad'] }]) {
    assert.equal(readGuestState(store(JSON.stringify(value)), 'state'), null);
  }
  const state = { workspaces: [{ id: 'ws1' }], facts: [], sources: [] };
  assert.deepEqual(readGuestState(store(JSON.stringify(state)), 'state'), state);
});
test('downloaded originals keep their actual file type', () => {
  for (const [mime, ext] of [['text/csv', 'csv'], ['text/plain', 'txt'], ['text/markdown', 'md'],
    ['application/rtf', 'rtf'], ['application/vnd.oasis.opendocument.text', 'odt'], ['application/pdf', 'pdf']]) {
    assert.equal(originalExtension(mime), ext);
  }
  assert.equal(originalExtension('unknown'), 'bin');
});

test('interview datetime input restores the local clock, including daylight saving', () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    assert.equal(dateTimeInputValue('2026-11-07T15:45:00.000Z'), '2026-11-07T10:45');
    assert.equal(dateTimeInputValue('2026-07-07T15:45:00.000Z'), '2026-07-07T11:45');
    assert.equal(dateTimeInputValue('invalid'), '');
    assert.equal(dateTimeInputValue(null), '');
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
