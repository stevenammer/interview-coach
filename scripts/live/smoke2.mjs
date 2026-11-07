// Live check of slice 4-7 features on real Gemini/Vertex with a fictional candidate. Not part of npm test.
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from '../../src/db.js';
import { Repository } from '../../src/repository.js';
import { GeminiAdapter } from '../../src/model.js';
import { CoachService } from '../../src/service.js';

const db = new PGlite();
const dir = new URL('../../netlify/database/migrations/', import.meta.url);
for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(f, dir), 'utf8'));
const repo = new Repository(pgliteSql(db));
const s = new CoachService(repo, new GeminiAdapter({ repo }));
const owner = (await repo.createUser('smoke2', 'x')).id;
const step = async (name, fn) => { const t = Date.now(); try { const r = await fn(); console.log(`\n== ${name} (${Date.now() - t}ms)\n${JSON.stringify(r, null, 1).slice(0, 900)}`); return r; } catch (e) { console.log(`\n== ${name} FAILED: ${e.message}`); return null; } };

const resume = `Dana Okafor
Guest Services Manager, Bayfront Suites (2020 - present)
- Supervised 22 front desk and night audit staff
- Cut check-in wait from 11 to 4 minutes after redesigning shift overlap
- Rolled out a mobile key program across the property in 2022`;
const jd = `Director of Operations, Coastline Resorts (hybrid). Lead operations for 4 resorts. Requires multi-property leadership, labor management, guest satisfaction improvement, and P&L accountability.`;

const pasted = await step('paste', () => s.paste(owner, { resume, jd, jobLabel: 'Coastline DoO' }));
const ws = pasted.workspace.id;
for (const f of pasted.facts.filter((f) => f.domain === 'candidate')) await s.review(owner, { workspaceId: ws, factId: f.id, action: 'confirm' });
const dig = await step('startDig', () => s.startDig(owner, ws));
const digId = dig?.dig?.id ?? dig?.id;
const refl = await step('reflectDig', () => s.reflectDig(owner, digId, 'Last July two front desk agents quit the same week during a sold-out weekend. I moved our night auditor to evenings, cross-trained two bellmen on check-in over three days, and we got through with no walkouts. Wait times stayed under 6 minutes.'));
await step('confirmDig', () => s.confirmDig(owner, digId));
await step('buildDrills', () => s.buildDrills(owner, ws));
const due = await step('drills', () => s.drills(owner, ws));
const card = (due?.cards ?? due?.due ?? due)?.[0];
if (card) await step('reviewDrill', () => s.reviewDrill(owner, card.id, 'We cut check-in waits from 11 minutes to 4 by overlapping shifts at peak arrival.'));
await step('captureRealInterview', () => s.captureRealInterview(owner, ws, 'notes', 'They asked: tell me about yourself; how do you manage labor across properties; a time you handled an angry guest; why Coastline. I used the check-in wait story. I got stuck on the P&L question because I have not owned a full P&L.'));
await db.close();
