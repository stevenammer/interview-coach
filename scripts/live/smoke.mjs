// Live smoke test: real Gemini, in-process Postgres (PGlite), fictional candidate. Not part of npm test.
if (process.env.ALLOW_LIVE_MODEL_CALLS !== '1') throw new Error('Live provider calls require ALLOW_LIVE_MODEL_CALLS=1. Use npm test for offline checks.');
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from '../../src/db.js';
import { Repository } from '../../src/repository.js';
import { GeminiAdapter } from '../../src/model.js';
import { CoachService } from '../../src/service.js';

const db = new PGlite();
const migrations = new URL('../../netlify/database/migrations/', import.meta.url);
for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(await readFile(new URL(file, migrations), 'utf8'));
}
const repo = new Repository(pgliteSql(db));
const service = new CoachService(repo, new GeminiAdapter({ repo }));
const user = await repo.createUser('smoke_user', 'x');
const owner = user.id ?? user;

const resume = `Jordan Rivera
Hotel Operations Manager, Lakeside Resort (2019 - present)
- Supervised 45 front desk, housekeeping, and F&B staff across two shifts
- Cut overtime spend 18% in 2023 by rebuilding the weekly labor forecast
- Led service recovery program; guest satisfaction rose from 82 to 89 over 12 months
Assistant Manager, Palm Inn (2015 - 2019)
- Opened a 120-room property; hired and trained 30 staff in 6 weeks`;
const jd = `Director of Operations, Harbor Hospitality Group (remote, travel 30%)
Own operations across 6 select-service hotels. Must have 5+ years multi-department leadership,
P&L accountability, labor management, and a record of improving guest satisfaction. Preferred: new-property openings.`;

const t0 = Date.now();
const pasted = await service.paste(owner, { resume, jd, jobLabel: 'Harbor Director Ops' });
console.log('extract ms', Date.now() - t0);
console.log('resume facts kept', pasted.resume.factIds.length, 'dropped', pasted.resume.dropped.length, pasted.resume.dropped.map((d) => d.quote).slice(0, 5));
console.log('jd facts kept', pasted.jd.factIds.length, 'dropped', pasted.jd.dropped.length);
for (const f of pasted.facts.filter((f) => f.domain === 'candidate')) {
  console.log('  ', f.display_text);
  await service.review(owner, { workspaceId: pasted.workspace.id, factId: f.id, action: 'confirm' });
}
const started = await service.start(owner, pasted.workspace.id);
console.log('Q1:', started.question);
const answers = [
  'At Lakeside I supervised 45 people across front desk, housekeeping and F&B. I rebuilt our weekly labor forecast and overtime dropped 18%.',
  'Before, managers scheduled off last year\'s numbers. I personally pulled group-block and arrival data every Monday and set shifts from it.',
  'Our guest satisfaction went from 82 to 89 in a year after I started a service recovery program. I also grew revenue 40% across the region.',
  'I trained leads to fix issues on the spot and tracked every complaint to close.',
  'Opening Palm Inn, I hired and trained 30 staff in six weeks.',
  'We opened on schedule and the first month reviews were strong.',
];
let r = { done: false, question: started.question };
for (const a of answers) {
  if (r.done) break;
  try { r = await service.turn(owner, started.interview.id, a); } catch (e) { console.log("TURN ERROR", e.message, String(e.cause?.message).slice(0, 300)); throw e; }
  console.log(r.done ? 'DONE, proposals kept ' + r.proposals.factIds.length + ' dropped ' + r.proposals.dropped.length : 'Q: ' + r.question);
}
await new Promise((r) => setTimeout(r, 5000));
const report = await service.debrief(owner, started.interview.id);
console.log(JSON.stringify({ content: report.contentScores, delivery: report.deliveryScores, unsupported: report.unsupportedClaims, rewrite: report.rewrite }, null, 1).slice(0, 3500));
await db.close();
