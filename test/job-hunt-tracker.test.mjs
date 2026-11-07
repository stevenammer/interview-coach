import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../src/repository.js';
import { GuestRepository } from '../src/guest.js';
import { pgliteSql } from '../src/db.js';
import { CoachService } from '../src/service.js';
import { jobHuntCsv, huntSummary, nextStepOverdue } from '../public/job-hunt.js';

async function database() {
  const db = new PGlite();
  for (let number = 1; number <= 19; number += 1) {
    const prefix = String(number).padStart(3, '0');
    const name = (await readdir(new URL('../netlify/database/migrations/', import.meta.url)))
      .find((item) => item.startsWith(`${prefix}_`));
    if (name) await db.exec(await readFile(new URL(`../netlify/database/migrations/${name}`, import.meta.url), 'utf8'));
  }
  await db.exec(await readFile(new URL('../netlify/database/migrations/021_security_hardening_3.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../netlify/database/migrations/023_resource_guard.sql', import.meta.url), 'utf8'));
  return { db, repo: new Repository(pgliteSql(db)) };
}

async function workspace(repo, name) {
  const owner = (await repo.createUser(name, 'hash')).id;
  const source = await repo.addSource(owner, 'jd', 'Role', 'A posting.');
  return { owner, workspace: await repo.addWorkspace(owner, source.id, `${name} role`) };
}

test('tracker migration, updates, history, validation, and owner scope work', async () => {
  const { db, repo } = await database();
  try {
    const a = await workspace(repo, 'tracker_a');
    const b = await workspace(repo, 'tracker_b');
    const service = new CoachService(repo, null);
    const saved = await service.updateJobHunt(a.owner, a.workspace.id, { status: 'applied', appliedOn: '2026-10-01',
      nextStep: 'Email recruiter', nextStepOn: '2026-10-10', notes: 'Asked about timing.', postingLink: 'https://example.test/job',
      happenedOn: '2026-10-01', note: 'Application sent' });
    assert.equal(saved.workspace.hunt_status, 'applied');
    assert.equal(saved.history.length, 3);
    assert.equal((await repo.workspaces(a.owner))[0].posting_link, 'https://example.test/job');
    await assert.rejects(service.updateJobHunt(a.owner, a.workspace.id, { status: 'maybe' }), /status/i);
    await assert.rejects(service.updateJobHunt(a.owner, a.workspace.id, { appliedOn: '2026-02-30' }), /date/i);
    await assert.rejects(service.updateJobHunt(a.owner, a.workspace.id, { notes: 'x'.repeat(2001) }), /Notes/i);
    assert.equal(await repo.updateJobHunt(b.owner, a.workspace.id, { status: 'rejected' }), null);
    assert.deepEqual(await repo.jobHuntHistory(b.owner, a.workspace.id), []);
    assert.equal(await repo.deleteJobHuntHistory(b.owner, saved.history[0].id), null);
    await repo.deleteAccount(a.owner);
    assert.equal((await repo.sql('SELECT count(*)::int AS count FROM job_hunt_history', []))[0].count, 0);
  } finally { await db.close(); }
});

test('guest tracker lives only in guest state and CSV quotes every field', async () => {
  const repo = new GuestRepository();
  const source = await repo.addSource('guest', 'jd', 'Role', 'Posting');
  const workspace = await repo.addWorkspace('guest', source.id, 'Role');
  const service = new CoachService(repo, null);
  await service.updateJobHunt('guest', workspace.id, { status: 'interviewing', nextStep: 'Call back',
    nextStepOn: '2000-01-01', notes: 'Asked, then wrote "thanks".', happenedOn: '2026-10-01' });
  await service.addJobHuntLog('guest', workspace.id, { action: 'Recruiter called', happenedOn: '2026-10-02' });
  assert.equal(repo.state.jobHuntHistory.length, 4);
  const row = (await repo.workspaces())[0];
  assert.equal(nextStepOverdue(row), true);
  assert.equal(huntSummary([row]), '1 interviewing');
  assert.match(jobHuntCsv([row]), /"Asked, then wrote ""thanks""\."/);
});

test('csv export neutralizes cells that would run as spreadsheet formulas', () => {
  const csv = jobHuntCsv([{ label: '=HYPERLINK("http://x")', hunt_status: 'saved', hunt_notes: '+1 call' }]);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(csv, /"'\+1 call"/);
});

test('CSV export also treats leading line breaks, whitespace and full-width formula prefixes as text', () => {
  for (const label of ['\n=1+1', '  =1+1', '\uFEFF@SUM(1)', '＝1+1', '＋1', '－1', '＠SUM(1)']) {
    const csv = jobHuntCsv([{ label, hunt_status: 'saved' }]);
    assert.ok(csv.includes(`"'${label.replaceAll('"', '""')}"`));
  }
});
