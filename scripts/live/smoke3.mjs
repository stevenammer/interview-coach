// Live check: Job Immerser + drill/dig fixes on real Gemini/Vertex. Fictional candidate, public JD excerpt.
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
const owner = (await repo.createUser('smoke3', 'x')).id;
const show = (n, r) => console.log(`\n== ${n}\n${JSON.stringify(r, null, 1).slice(0, 1400)}`);
const resume = `Dana Okafor
Guest Services Manager, Bayfront Suites (2020 - present)
- Supervised 22 front desk and night audit staff
- Cut check-in wait from 11 to 4 minutes after redesigning shift overlap
- Grew spa membership sales 30% in one year through a referral program`;
const jd = `Regional Operations Manager, a regional chain of auto service centers (hybrid). Directly lead and coach store managers across the region; hold managers accountable for revenue, service quality, retention, staffing and customer experience. Coach managers on upselling, lead conversion and local partnerships. Review store performance indicators. Support new store openings. Must have 5+ years multi-unit operations.`;
const p = await s.paste(owner, { resume, jd, jobLabel: 'Regional Ops Manager' });
const ws = p.workspace.id;
for (const f of p.facts.filter((f) => f.domain === 'candidate')) await s.review(owner, { workspaceId: ws, factId: f.id, action: 'confirm' });
const dig = await s.startDig(owner, ws); show('startDig (should target a gap)', { competency: dig.dig?.competency, prompt: dig.prompt });
const r = await s.reflectDig(owner, dig.dig.id, 'Last spring our spa referral push stalled, so I had front desk ask every member at checkout who they would bring for a free class. Referrals doubled in six weeks.');
show('confirmDig (no correction)', await s.confirmDig(owner, dig.dig.id).then((x) => ({ ok: true, status: x.status ?? x.dig?.status })).catch((e) => ({ ok: false, err: e.message })));
const drills = await s.buildDrills(owner, ws); show('drill prompts (should be human, grouped)', drills.cards.map((c) => c.prompt));
const t = Date.now(); const im = await s.startImmersion(owner, ws); show(`startImmersion ${Date.now() - t}ms`, im);
const sceneChoices = im?.scene?.choices ?? im?.plan?.scenes?.[0]?.choices;
const imId = im?.immersion?.id ?? im?.id ?? im?.view?.id;
if (imId && sceneChoices?.[0]) {
  const acted = await s.actImmersion(owner, imId, sceneChoices[0].id, 'I would ask the GM to walk me through last month numbers first, then set a two-week plan. At Bayfront I did something similar when check-in waits spiked.');
  console.log('\n== ACT', JSON.stringify({ history: acted.state?.history, now: acted.scene?.title ?? acted.state?.sceneId, proposals: acted.proposals }, null, 1).slice(0, 1600));
}
await db.close();
