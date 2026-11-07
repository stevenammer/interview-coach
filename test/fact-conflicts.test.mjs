import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { CoachService } from '../src/service.js';
import { detectPotentialFactConflicts, factPairFingerprint } from '../src/fact-conflicts.js';

const base = (id, value, overrides = {}) => ({ id, domain: 'candidate', lifecycle: 'active', review_state: 'accepted',
  workspace_id: 'workspace-a', subject: 'candidate', predicate: 'work mode', value_json: value,
  qualifiers_json: { claim_scope: 'Acme Corp, June 2026' }, verbatim_quote: String(value), ...overrides });

test('automatic detector only flags changed values under the same explicit claim scope', () => {
  const a = base('a', 'remote');
  const b = base('b', 'hybrid');
  assert.equal(detectPotentialFactConflicts([a, b]).length, 1);
  assert.equal(detectPotentialFactConflicts([a, { ...b, qualifiers_json: {} }]).length, 0);
  assert.equal(detectPotentialFactConflicts([a, { ...b, qualifiers_json: { claim_scope: 'Globex, 2018' } }]).length, 0);
  assert.equal(detectPotentialFactConflicts([a, { ...b, workspace_id: 'workspace-b' }]).length, 0);
  assert.equal(detectPotentialFactConflicts([a, { ...b, domain: 'job' }]).length, 0);
  assert.equal(detectPotentialFactConflicts([a, { ...b, subject: '' }]).length, 0);
  assert.equal(detectPotentialFactConflicts([a, { ...b, predicate: '' }]).length, 0);
  assert.equal(detectPotentialFactConflicts([a, { ...b, value_json: 'remote' }]).length, 0);
  assert.notEqual(factPairFingerprint(a, b), factPairFingerprint(a, { ...b, verbatim_quote: 'Updated source wording' }));
});

async function database() {
  const db = new PGlite();
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

test('reported pair is owner scoped, reasoned, content-bound, and reopenable', async () => {
  const { db, repo } = await database();
  try {
    const owner = (await repo.createUser('conflict_owner', 'hash')).id;
    const otherOwner = (await repo.createUser('conflict_other', 'hash')).id;
    const jd = await repo.addSource(owner, 'jd', 'Role', 'Role description');
    const workspace = await repo.addWorkspace(owner, jd.id, 'Role');
    const sourceA = await repo.addSource(owner, 'resume', 'Resume A', 'I managed the sales group.');
    const sourceB = await repo.addSource(owner, 'resume', 'Review B', 'I did not manage the sales group.');
    const add = async (source, quote, value, qualifiers = {}) => {
      const id = await repo.addFact(owner, { workspaceId: workspace.id, sourceId: source.id,
        subject: 'candidate', predicate: 'management claim', value: { text: value }, qualifiers, displayText: quote, quote,
        start: 0, end: quote.length, status: 'document', reviewState: 'accepted', proposedBy: 'user' });
      return id;
    };
    const a = await add(sourceA, sourceA.text, 'managed');
    const b = await add(sourceB, sourceB.text, 'not managed');
    const service = new CoachService(repo, null);
    assert.equal((await service.factConflicts(owner, workspace.id)).length, 0, 'scope-absent claims are not auto-compared');
    const before = await service.prepPack(owner, workspace.id);
    await repo.savePrepSection(owner, before.pack.id, { key: 'tmay', title: 'Tell me about yourself', kind: 'model',
      inputHash: before.inputHash, status: 'ready', content: { lines: [{ text: sourceA.text, factIds: [a], source: 'candidate' }], nextStep: 'Practice.' } });
    await assert.rejects(service.reportFactConflict(owner, { workspaceId: workspace.id, factAId: a, factBId: b, reason: '  ' }));
    const pair = (await service.reportFactConflict(owner, { workspaceId: workspace.id, factAId: a, factBId: b,
      reason: 'These may describe different roles.' })).find((item) => item.factAId === a || item.factBId === a);
    assert.equal(pair.status, 'open');
    assert.deepEqual(new Set([pair.factA.source_title, pair.factB.source_title]), new Set(['Resume A', 'Review B']));
    const pack = await service.prepPack(owner, workspace.id);
    assert.notEqual(pack.inputHash, before.inputHash, 'reporting a pair invalidates cached generation input');
    assert.equal((await repo.prepSection(owner, before.pack.id, 'tmay')).status, 'stale');
    assert.deepEqual(await service.buildPrepSection(owner, workspace.id, 'tmay', before.inputHash), { stale: true, sectionKey: 'tmay' });
    const fixBeforeReview = (await repo.prepSections(owner, pack.pack.id)).find((section) => section.section_key === 'fix');
    assert.ok(fixBeforeReview.content_json.lines.some((line) => line.factIds.includes(a) && line.factIds.includes(b) &&
      line.text.includes('Resume A') && line.text.includes('Review B')));
    let capturedPrompt = '';
    const prepModel = { async generate(_task, prompt, validate) {
      capturedPrompt = prompt;
      const data = { lines: [{ text: 'Practice one clear story.', factIds: [], source: 'guidance' }], nextStep: 'Practice.' };
      assert.ok(validate(data));
      return { data, modelId: 'offline-test' };
    } };
    const promptService = new CoachService(repo, prepModel);
    const context = (await service.updateFactConflictReview(owner, { workspaceId: workspace.id,
      reviewId: pair.reviewId, action: 'context_review', reason: 'The claims refer to different roles.' }))
      .find((item) => item.factAId === a || item.factBId === a);
    assert.equal(context.status, 'context_review');
    const contextualPack = await service.prepPack(owner, workspace.id);
    const racingModel = { async generate(_task, _prompt, validate) {
      const data = { lines: [{ text: 'Practice one clear story.', factIds: [], source: 'guidance' }], nextStep: 'Practice.' };
      assert.ok(validate(data));
      await service.updateFactConflictReview(owner, { workspaceId: workspace.id, reviewId: pair.reviewId,
        action: 'resolved', reason: 'Both source claims apply in their recorded contexts.' });
      return { data, modelId: 'offline-race-test' };
    } };
    const raceResult = await new CoachService(repo, racingModel).buildPrepSection(owner, workspace.id, 'tmay', contextualPack.inputHash);
    assert.deepEqual(raceResult, { stale: true, sectionKey: 'tmay' }, 'a conflict change during generation blocks stale publication');
    const resolvedPair = (await service.factConflicts(owner, workspace.id)).find((item) => item.reviewId === pair.reviewId);
    assert.equal(resolvedPair.status, 'resolved');
    assert.equal(resolvedPair.contextNote, 'The claims refer to different roles.');
    assert.equal(resolvedPair.history.length, 3, 'report, context, and resolution actions remain auditable');
    const resolvedPack = await service.prepPack(owner, workspace.id);
    const promptServiceCurrent = new CoachService(repo, prepModel);
    await promptServiceCurrent.buildPrepSection(owner, workspace.id, 'tmay', resolvedPack.inputHash);
    assert.ok(capturedPrompt.includes('The owner reviewed these as context-dependent'));
    assert.ok(capturedPrompt.includes(sourceA.text));
    await assert.rejects(service.updateFactConflictReview(otherOwner, { workspaceId: workspace.id,
      reviewId: pair.reviewId, action: 'resolved', reason: 'wrong owner' }));
    const reopenedByOwner = (await service.updateFactConflictReview(owner, { workspaceId: workspace.id,
      reviewId: pair.reviewId, action: 'open', reason: 'A new comparison is needed.' }))
      .find((item) => item.factAId === a || item.factBId === a);
    assert.equal(reopenedByOwner.status, 'open');
    await repo.sql(`UPDATE facts SET value_json=$3::jsonb,display_text=$4 WHERE user_id=$1 AND id=$2`,
      [owner, a, JSON.stringify({ text: 'managed and trained' }), 'Updated claim wording.']);
    const reopened = (await service.factConflicts(owner, workspace.id)).find((item) => item.factAId === a || item.factBId === a);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.stale, true);
    assert.equal(reopened.reviewId, null, 'changed content cannot reuse an old disposition');
    const fresh = (await service.reportFactConflict(owner, { workspaceId: workspace.id, factAId: a, factBId: b,
      reason: 'Review the updated wording.' })).find((item) => item.factAId === a || item.factBId === a);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.status, 'open');
  } finally { await db.close(); }
});
