// The scene graph is a short, bounded week. Choices carry a consequence into the next scene.
export function initialImmersion(plan) {
  return { sceneId: plan.scenes[0].id, carry: null, history: [], complete: false };
}

export function chooseImmersion(plan, state, choiceId, response, proposalIds = [], honesty = null) {
  if (state.complete) throw new Error('This week is complete.');
  const scene = plan.scenes.find((item) => item.id === state.sceneId);
  const choice = scene?.choices.find((item) => item.id === choiceId);
  if (!choice) throw new Error('Choose an option in the current scene.');
  const history = [...state.history, { sceneId: scene.id, choiceId, response,
    consequence: choice.consequence, tradeoff: choice.tradeoff, proposalIds, honesty }];
  const next = choice.nextSceneId === 'end' ? null : plan.scenes.find((item) => item.id === choice.nextSceneId);
  return { sceneId: next?.id ?? null, carry: choice.consequence, history, complete: !next };
}

export function specificEmployerAsk(response) {
  if (!/\?/.test(response) || !/\b(company|employer|their|hotel|plant|organization|policy|budget|system)\b/i.test(response)) return null;
  const subject = response.match(/\b(policy|budget|system|staffing|process|structure)\b/i)?.[0]?.toLowerCase();
  return subject || 'company detail';
}

export function immersionDebrief(state) {
  if (!state.complete) return null;
  return { tradeoffs: state.history.map((item) => item.tradeoff),
    first90Days: 'Use these decisions to explain what you would learn first, who you would involve, and how you would measure progress in your first 90 days.',
    caseQuestion: 'For a case question, name the constraint, the people you would consult, the decision, and the trade-off you accepted.' };
}

const short = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const slug = (value, fallback) => (String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').replace(/^(\d)/, 's-$1').slice(0, 40)) || fallback;

// Shape check only. Live Gemini runs showed the old check rejecting good weeks (it banned
// every digit while the prompt asks for a "first 90 days" scene). Provenance is enforced
// per detail in normalizeImmersion, and every scene is labeled "typical for this role".
export function immersionSchema(value) {
  if (!value || !Array.isArray(value.scenes) || value.scenes.length < 3 || value.scenes.length > 7) return false;
  return value.scenes.every((scene) => scene && short(scene.title, 200) && short(scene.situation, 1500) &&
    Array.isArray(scene.choices) && scene.choices.length >= 2 && scene.choices.length <= 4 &&
    scene.choices.every((choice) => choice && short(choice.label, 400) && short(choice.consequence, 800)));
}

// Makes a model-written week safe to run: stable ids, linear links, bounded text, and only
// details whose provenance can be proven. Unprovable jd/company details are dropped, never shown.
export function normalizeImmersion(raw, { jdId, jdText, companyFacts = [] }) {
  const scenes = raw.scenes.slice(0, 6).map((scene, index) => ({
    id: slug(scene.id, `scene-${index + 1}`) + (index ? '' : ''),
    day: short(scene.day, 60) ? scene.day : `Scene ${index + 1}`,
    title: scene.title.slice(0, 200),
    situation: scene.situation.slice(0, 1500),
    ask: short(scene.ask, 400) ? scene.ask : 'What do you do?',
    provenance: 'typical',
    details: (Array.isArray(scene.details) ? scene.details : []).filter((detail) => detail && short(detail.text, 400))
      .flatMap((detail) => {
        if (detail.provenance === 'jd') return jdText.includes(detail.text) ? [{ text: detail.text, provenance: 'jd', sourceId: jdId }] : [];
        if (detail.provenance === 'company') {
          const fact = companyFacts.find((item) => item.id === detail.sourceId && item.quote === detail.text);
          return fact ? [{ text: detail.text, provenance: 'company', sourceId: fact.id }] : [];
        }
        return [{ text: detail.text, provenance: 'typical', sourceId: null }];
      }).slice(0, 6),
    choices: scene.choices.slice(0, 4).map((choice, choiceIndex) => ({
      id: slug(choice.id, `choice-${choiceIndex + 1}`),
      label: choice.label.slice(0, 400),
      consequence: choice.consequence.slice(0, 800),
      tradeoff: short(choice.tradeoff, 400) ? choice.tradeoff : '',
      provenance: 'typical',
    })),
  }));
  const seen = new Set();
  scenes.forEach((scene, index) => { while (seen.has(scene.id)) scene.id = `${scene.id}-${index + 1}`; seen.add(scene.id); });
  scenes.forEach((scene, index) => {
    const ids = new Set();
    scene.choices.forEach((choice) => {
      const base = choice.id; let suffix = 2;
      while (ids.has(choice.id)) choice.id = `${base}-${suffix++}`;
      ids.add(choice.id);
      choice.nextSceneId = index === scenes.length - 1 ? 'end' : scenes[index + 1].id; });
  });
  return { scenes };
}

export function pastProposalSchema(value) {
  return value && Array.isArray(value.quotes) && value.quotes.length <= 4 &&
    value.quotes.every((quote) => short(quote, 500));
}
