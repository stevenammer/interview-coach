import test from 'node:test';
import assert from 'node:assert/strict';
import { GuestRepository } from '../src/guest.js';
import { CoachService } from '../src/service.js';
import { unsupportedNumbers, WRITING_RULES } from '../src/writing.js';

async function workspaceWithFacts(count) {
  const repo = new GuestRepository();
  const resume = await repo.addSource('guest', 'resume', 'Resume', 'Ran a 45 person spa. Grew members from 0 to 100. Cut wait times.');
  const jd = await repo.addSource('guest', 'jd', 'Posting', 'Regional Director. Coach GMs. Grow membership.');
  const ws = await repo.addWorkspace('guest', jd.id, 'Regional Director');
  const quotes = ['Ran a 45 person spa', 'Grew members from 0 to 100', 'Cut wait times'].slice(0, count);
  const ids = [];
  for (const quote of quotes) {
    const start = resume.text.indexOf(quote);
    const fact = await repo.addFact('guest', { workspaceId: ws.id, domain: 'candidate', sourceId: resume.id,
      subject: 'candidate', predicate: 'did', value: { text: quote }, displayText: quote, quote, start,
      end: start + quote.length, status: 'document', reviewState: 'accepted', proposedBy: 'model' });
    ids.push(typeof fact === 'string' ? fact : fact.id);
  }
  return { repo, ws, ids };
}

test('writer uses confirmed facts, flags invented numbers and unknown fact ids, and strips em dashes', async () => {
  const { repo, ws, ids } = await workspaceWithFacts(3);
  const facts = await repo.facts('guest', ws.id);
  const [a, b] = facts.map((fact) => fact.id);
  let prompt = '';
  const model = { async generate(task, text, schema) {
    prompt = text;
    const data = { sections: [{ heading: 'Experience', lines: [
      { text: 'Ran a 45 person spa — with care', factIds: [a] },
      { text: 'Grew revenue 40% in a year', factIds: [b] },
      { text: 'Led 12 studios', factIds: ['not-a-real-id'] },
    ] }], gaps: ['multi-unit title'] };
    assert.ok(schema(data));
    return { data, modelId: 'fake' };
  } };
  const doc = await new CoachService(repo, model).writeDocument('guest', ws.id, 'resume');
  const lines = doc.sections[0].lines;
  assert.equal(lines[0].check, null);
  assert.ok(!lines[0].text.includes('—'));
  assert.match(lines[1].check, /40%/);
  assert.match(lines[2].check, /12|haven't confirmed/);
  assert.equal(doc.flagged, 2);
  assert.deepEqual(doc.gaps, ['multi-unit title']);
  assert.ok(prompt.includes('No em dashes'));
  assert.ok(ids.length === 3);
});

test('writer refuses until at least 3 facts are confirmed', async () => {
  const { repo, ws } = await workspaceWithFacts(2);
  const model = { async generate() { throw new Error('should not be called'); } };
  await assert.rejects(new CoachService(repo, model).writeDocument('guest', ws.id, 'cover_letter'), /Confirm at least 3/);
});

test('number check helper', () => {
  assert.deepEqual(unsupportedNumbers('Cut costs 18% and saved $40,000', ['cut costs 18%']), ['$40,000']);
  assert.ok(WRITING_RULES.includes('Never invent'));
});


test('number evidence ignores sentence punctuation and preserves whole numeric values', () => {
  assert.deepEqual(unsupportedNumbers('From 2020 to 2026, I trained 18 reps.', ['2020-2026', '18 reps']), []);
  assert.deepEqual(unsupportedNumbers('Saved $40,000.', ['Saved 40000']), []);
  assert.deepEqual(unsupportedNumbers('Trained 18 reps.', ['Trained 118 reps']), ['18']);
  assert.deepEqual(unsupportedNumbers('Improved 18%.', ['Improved 18']), ['18%']);
});

test('résumé uses the header shape, honors the lane, and keeps gaps', async () => {
  const { repo, ws } = await workspaceWithFacts(3);
  const facts = await repo.facts('guest', ws.id);
  let calls = 0;
  let prompt = '';
  const model = { async generate(_task, text) {
    calls += 1;
    prompt = text;
    return { data: { sections: [{ heading: 'Header', lines: [
      { type: 'name', text: 'Ada Example', factIds: [facts[0].id] },
      { type: 'contact', text: 'ada@example.com | 555 0100 | Orlando, FL', factIds: [facts[0].id] },
      { type: 'links', text: 'linkedin.com/in/ada', factIds: [facts[0].id] },
    ] }, { heading: 'Summary', lines: [
      { type: 'summary', text: 'Built training that grew members from 0 to 100.', factIds: [facts[1].id] },
    ] }, { heading: 'Experience', lines: [
      { type: 'role', text: 'Training Supervisor', factIds: [facts[0].id] },
      { type: 'bullet', text: 'Ran a 45 person spa.', factIds: [facts[0].id] },
      { type: 'bullet', text: 'Grew members from 0 to 100.', factIds: [facts[1].id] },
    ] }], gaps: ['enterprise sales'] } };
  } };
  const doc = await new CoachService(repo, model).writeDocument('guest', ws.id, 'resume', 'training_enablement');
  assert.equal(calls, 1);
  assert.match(prompt, /Lean toward training and enablement/);
  assert.ok(!doc.text.includes('Contact Information'));
  assert.ok(!doc.text.includes('• Training Supervisor'));
  assert.match(doc.text, /• Ran a 45 person spa/);
  assert.deepEqual(doc.gaps, ['enterprise sales']);
});

test('résumé drops least-relevant extra bullets to keep the export one-page word cap', async () => {
  const { repo, ws } = await workspaceWithFacts(3);
  const facts = await repo.facts('guest', ws.id);
  const long = (word) => Array.from({ length: 150 }, () => word).join(' ');
  const model = { async generate() { return { data: { sections: [{ heading: 'Experience', lines: [
    { type: 'role', text: 'Supervisor', factIds: [facts[0].id] },
    { type: 'bullet', text: long('first'), factIds: [facts[0].id] },
    { type: 'bullet', text: long('second'), factIds: [facts[1].id] },
    { type: 'bullet', text: long('third'), factIds: [facts[2].id] },
  ] }], gaps: [] } }; } };
  const doc = await new CoachService(repo, model).writeDocument('guest', ws.id, 'resume');
  assert.ok(doc.text.trim().split(/\s+/).length <= 420);
  assert.ok(!doc.text.includes('third third'));
  assert.match(doc.text, /• first/);
  assert.match(doc.text, /• second/);
});


test('résumé bullet lines the model skipped become their own facts, without duplicating covered ones', async () => {
  const { resumeLineFacts } = await import('../src/service.js');
  const text = 'Pat Rivera\npat@example.com | 555 0100\nTrainer | Acme | 2019 - 2024\n- Built a week 4 curriculum for 40 new hires.\n- Ran weekly coaching clinics for supervisors across two shifts.\nEducation\nA.A., Valencia College';
  const covered = [{ quote: 'Built a week 4 curriculum for 40 new hires.' }];
  const added = resumeLineFacts(text, covered);
  assert.deepEqual(added.map((fact) => fact.quote), ['Pat Rivera', 'pat@example.com | 555 0100', 'Ran weekly coaching clinics for supervisors across two shifts.']);
  assert.deepEqual(added.map((fact) => fact.predicate), ['name', 'contact', 'did']);
});

test('a résumé header never carries an email or link that no confirmed fact contains', async () => {
  const { repo, ws, ids } = await workspaceWithFacts(3);
  const model = { async generate() {
    return { data: { sections: [{ heading: 'Header', lines: [
      { type: 'contact', text: 'invented@example.com | 555 010 0199', factIds: [ids[0]] },
      { type: 'links', text: 'linkedin.com/in/invented', factIds: [] },
    ] }, { heading: 'Experience', lines: [
      { type: 'role', text: 'Spa Director', factIds: [ids[0]] },
      { type: 'bullet', text: 'Ran a 45 person spa.', factIds: [ids[0]] },
    ] }], gaps: [] } };
  } };
  const doc = await new CoachService(repo, model).writeDocument('guest', ws.id, 'resume');
  assert.ok(!/invented/.test(doc.text), doc.text);
  assert.match(doc.text, /Ran a 45 person spa/);
});

test('résumé fallback facts skip section titles, accept other bullet glyphs, and never repeat a line', async () => {
  const { resumeLineFacts } = await import('../src/service.js');
  const text = 'PROFESSIONAL SUMMARY\nPat Rivera\n▪ Led a 20 person team through two hospital units\n◦ Trained new nurses\n▪ Led a 20 person team through two hospital units';
  const quotes = resumeLineFacts(text, []).map((fact) => fact.quote);
  assert.ok(!quotes.includes('PROFESSIONAL SUMMARY'));
  assert.deepEqual(quotes.filter((quote) => quote === 'Led a 20 person team through two hospital units').length, 1);
  assert.ok(quotes.includes('Trained new nurses'));
});
