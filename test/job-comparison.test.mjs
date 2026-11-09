import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { GuestRepository } from '../src/guest.js';
import { pgliteSql } from '../src/db.js';
import { issueSession } from '../src/auth.js';
import { createHandler } from '../netlify/functions/api.mjs';
import { postingDetails } from '../public/posting-details.js';

const migrationFiles = ['001_core.sql', '002_jobs.sql', '003_ingestion.sql', '004_workspaces.sql',
  '005_rewrites.sql', '006_interviewer.sql', '007_story_dig.sql', '008_drills.sql',
  '009_real_interviews.sql', '010_fact_gate.sql', '011_immerser.sql', '012_voice.sql',
  '013_guest_voice.sql', '015_debrief_input_hash.sql', '016_job_comparison.sql', '021_security_hardening_3.sql', '022_fact_conflict_reviews.sql', '023_resource_guard.sql', '024_spend_guard_subject.sql'];

async function database() {
  const db = new PGlite();
  for (const name of migrationFiles) {
    await db.exec(await readFile(new URL(`../netlify/database/migrations/${name}`, import.meta.url), 'utf8'));
  }
  return { db, repo: new Repository(pgliteSql(db)) };
}

test('job pay, benefits, and learned details persist per owner and workspace', async () => {
  const { db, repo } = await database();
  try {
    const ownerA = (await repo.createUser('compare_a', 'hash')).id;
    const ownerB = (await repo.createUser('compare_b', 'hash')).id;
    const source = await repo.addSource(ownerA, 'jd', 'Studio manager', 'Manage the studio.');
    const workspace = await repo.addWorkspace(ownerA, source.id, 'Studio manager');
    assert.equal(workspace.pay_details, null, 'unsupplied facts remain unknown');
    assert.equal((await repo.workspaces(ownerA))[0].jd_text, 'Manage the studio.');
    const saved = await repo.setJobComparison(ownerA, workspace.id, {
      payDetails: '$80,000–$95,000', benefitsDetails: 'Medical and 401(k)',
      learnedDetails: 'Regional manager says the team is growing.',
    });
    assert.equal(saved.pay_details, '$80,000–$95,000');
    assert.equal((await repo.workspace(ownerA, workspace.id)).learned_details,
      'Regional manager says the team is growing.');
    assert.equal(await repo.setJobComparison(ownerB, workspace.id, {
      payDetails: 'private', benefitsDetails: '', learnedDetails: '',
    }), null, 'another account cannot update this workspace');
    assert.equal((await repo.workspace(ownerA, workspace.id)).benefits_details, 'Medical and 401(k)');
  } finally {
    await db.close();
  }
});

test('guest job comparison fields survive through guest state', async () => {
  const repo = new GuestRepository();
  const source = await repo.addSource('guest', 'jd', 'Role', 'Posting.');
  const workspace = await repo.addWorkspace('guest', source.id, 'Role');
  await repo.setJobComparison('guest', workspace.id,
    { payDetails: '', benefitsDetails: 'Paid leave', learnedDetails: 'Two interview rounds.' });
  assert.equal((await repo.workspaces())[0].benefits_details, 'Paid leave');
  assert.equal((await repo.workspace('guest', workspace.id)).learned_details, 'Two interview rounds.');
});

test('posting extraction only returns source wording for pay and benefits', () => {
  const jd = 'Base salary is $82,000 to $96,000 plus annual bonus.\nMedical, dental and vision coverage begins on day one.\nWe offer a supportive team.';
  assert.deepEqual(postingDetails(jd, 'pay'), ['Base salary is $82,000 to $96,000 plus annual bonus.']);
  assert.deepEqual(postingDetails(jd, 'benefits'), ['Medical, dental and vision coverage begins on day one.']);
  assert.deepEqual(postingDetails('$80k–100k', 'pay'), ['$80k–100k'], 'a standalone compensation range is useful');
  assert.deepEqual(postingDetails('Medical, dental, vision', 'benefits'), ['Medical, dental, vision'],
    'a compact coverage list can omit the word benefits');
  assert.deepEqual(postingDetails('Manage healthcare customers and insurance sales. Require a medical degree.', 'benefits'), [],
    'healthcare industry and job qualifications are not benefits');
  assert.deepEqual(postingDetails('Own a $5 million revenue budget.', 'pay'), [],
    'a budget amount alone is not compensation');
  assert.deepEqual(postingDetails('Manage the team and provide excellent service.', 'pay'), []);
});

test('workspace settings API rejects oversized input and enforces account ownership', async () => {
  const { db, repo } = await database();
  try {
    const owner = await repo.createUser('comparison_owner', 'hash');
    const other = await repo.createUser('comparison_other', 'hash');
    const jd = await repo.addSource(owner.id, 'jd', 'Role', 'Listing.');
    const workspace = await repo.addWorkspace(owner.id, jd.id, 'Role');
    const handler = createHandler({ repo, model: { generate: async () => { throw new Error('unexpected model call'); } },
      env: { ABUSE_HMAC_KEY: 'a-long-fictional-test-key-for-abuse-controls' } });
    const ownerCookie = (await issueSession(repo, owner, false)).cookie;
    const otherCookie = (await issueSession(repo, other, false)).cookie;
    const request = (cookie, details) => new Request('http://localhost/api?op=workspace_settings', {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json',
        'x-coach-csrf': '1', cookie },
      body: JSON.stringify({ workspaceId: workspace.id, remotePreference: 'unspecified',
        listingWorkMode: 'unspecified', ...details }),
    });
    assert.equal((await handler(request(ownerCookie, { payDetails: 'x'.repeat(5001) }))).status, 400);
    assert.equal((await handler(request(ownerCookie, { payDetails: 70000 }))).status, 400);
    assert.equal((await handler(request(otherCookie, { payDetails: 'private', benefitsDetails: '', learnedDetails: '' }))).status, 404);
    const untouched = await repo.workspace(owner.id, workspace.id);
    assert.equal(untouched.pay_details, null);
    assert.equal(untouched.remote_preference, null, 'invalid comparison input must not partially update preferences');
    assert.equal((await handler(request(ownerCookie, { payDetails: '$90,000', benefitsDetails: '', learnedDetails: '' }))).status, 200);
    assert.equal((await repo.workspace(owner.id, workspace.id)).pay_details, '$90,000');
  } finally {
    await db.close();
  }
});
