import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSampleGuest } from '../public/sample-workspace.js';
import { roleContext } from '../src/role-packs.js';

const profile = JSON.parse(await readFile(new URL('../public/sample-profile.json', import.meta.url), 'utf8'));

test('the public example is the real practice workspace with marked drafts and placeholders', () => {
  assert.equal(profile.name, 'Steven Ammer');
  assert.equal(profile.defaultRole.role, 'Sales Training Academy team lead');
  assert.equal(profile.draftAnswers.length, 6);
  for (const item of profile.draftAnswers) {
    assert.match(item.answer, /^Draft, still practicing\./);
    assert.match(item.answer, /\[add a real example|\[add what I'd track/);
  }
});

test('example text has no dashes, no inflated numbers, no private subjects', () => {
  const text = JSON.stringify(profile);
  assert.doesNotMatch(text, /[–—]/);
  const banned = ['Next' + 'Call', 'Floor' + 'Coach', 'EFF' + 'ORT', 'Britt' + 'any', 'wi' + 'fe'];
  for (const word of banned) assert.equal(text.toLowerCase().includes(word.toLowerCase()), false, word);
  assert.doesNotMatch(text, /%|\$\d/);
});

test('the sample seeds facts, a draft-answers source, and requirements linked to facts', () => {
  const { state } = createSampleGuest(profile);
  assert.equal(state.facts.length, profile.facts.length);
  assert.ok(state.sources.some((s) => /Draft answers/.test(s.title) && /still practicing/.test(s.text)));
  assert.ok(state.requirements.every((r) => r.fact_ids.length > 0));
  assert.equal(state.workspaces[0].company_name, 'Travel + Leisure Co.');
});

test('the sales training role pack applies to coaching roles and credits public frameworks', () => {
  const context = roleContext('Sales Training Academy team lead: teach and coach new sales agents.');
  assert.match(context, /Sales training and coaching/);
  assert.match(context, /Kirkpatrick/);
  assert.doesNotMatch(context, /studio|fitness/i);
});
