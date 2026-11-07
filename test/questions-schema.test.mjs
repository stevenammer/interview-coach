import test from 'node:test';
import assert from 'node:assert/strict';
import { questionsSchema } from '../src/model.js';

// Live bug 2026-09-29: Gemini wrote a ~360-character question and every practice start failed.
test('questions schema accepts realistic long questions and extra ones', () => {
  const long = 'When you inherit a multi-unit portfolio where studios hit lead targets but conversion slips, '.repeat(4);
  assert.ok(long.length > 350 && long.length < 700);
  assert.ok(questionsSchema({ questions: [long, 'b', 'c'] }));
  assert.ok(questionsSchema({ questions: ['a', 'b', 'c', 'd'] }));
  assert.ok(!questionsSchema({ questions: ['a', 'b'] }));
  assert.ok(!questionsSchema({ questions: ['a', 'b', 'x'.repeat(701)] }));
});

import { locateQuote } from '../src/service.js';
// Observed live: one real posting map kept 3 of ~15 requirements because quotes differed by whitespace or punctuation.
test('locateQuote tolerates whitespace, quotes, dashes, case, trailing period, and rejects invented text', () => {
  const text = 'Must Have: 5+ years of multi-unit\noperations — ideally in “regional” retail.';
  const hit = locateQuote(text, '5+ years of multi-unit operations - ideally in "regional" retail.');
  assert.ok(hit);
  assert.equal(text.slice(hit.start, hit.end), '5+ years of multi-unit\noperations — ideally in “regional” retail');
  assert.equal(locateQuote(text, '10 years of regional leadership experience'), null);
  assert.equal(locateQuote(text, 'must have'), null); // too short to trust a fuzzy match
});
